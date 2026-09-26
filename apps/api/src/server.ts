// JGG API server (node:http). Serves /api/v1, the SSE stream, and the built web app.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, q1, qa, run, type DB } from './db.ts';
import { ApiError, parseCookies, readBody, sendError, sendJson, SECURITY_HEADERS, type Ctx } from './http.ts';
import { resolveSession, resolveApiKey, csrfMatches } from './auth.ts';
import { buildRouter, type AppCfg } from './routes.ts';
import { createLiveSource, liveTrending } from './live.ts';
import { liveGateFor, liveConfig } from './custody.ts';
import { setLiveGate, setLiveLimits } from './trading.ts';
import { afterLiveFill } from './strategies.ts';
import { createRpc } from '../../../packages/providers/src/solana/rpc.ts';
import { setMarketSource, getMarketSource } from '../../../packages/providers/src/execution.ts';
import * as M from '../../../packages/providers/src/market.ts';
import { demoNow, setDemoAnchor, FIXTURE_SOURCE } from '../../../packages/test-fixtures/src/index.ts';
import { CHAINS, type Chain } from '../../../packages/contracts/src/index.ts';

export function ensureDemoAnchor(db: DB) {
  run(db, `INSERT OR IGNORE INTO worker_state (key, value, updated_at) VALUES ('demo_anchor', ?, ?)`, String(Date.now()), Date.now());
  const a = Number(q1(db, `SELECT value FROM worker_state WHERE key = 'demo_anchor'`).value); setDemoAnchor(a); return a;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };

// Simple fixed-window limiter (per IP + route class). Production: Redis-backed (see docs/DECISIONS.md).
const buckets = new Map<string, { n: number; reset: number }>();
function limit(key: string, max: number, windowMs: number) {
  const now = Date.now(); const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); if (buckets.size > 50_000) buckets.clear(); return; }
  if (++b.n > max) throw new ApiError('RATE_LIMITED', 'Too many requests; slow down', 429, true, { retryAfterMs: b.reset - now });
}

export function startServer(opts: { port: number; dbPath: string; webDir: string; env?: Record<string, string | undefined> }) {
  const env = opts.env ?? process.env;
  const db = openDb(opts.dbPath);
  ensureDemoAnchor(db);
  // Data source: fixture (Demo) by default; the standalone Solana indexer when JGG_DATA_SOURCE=solana_live.
  if (env.JGG_DATA_SOURCE === 'solana_live') setMarketSource(createLiveSource(db)); else setMarketSource(null);
  const origin = env.JGG_ORIGIN ?? `http://localhost:${opts.port}`;
  const cfg: AppCfg = { env, domain: new URL(origin).host, origin, secureCookies: origin.startsWith('https://'), testMode: env.JGG_ENV === 'test', version: '0.1.0', startedAt: Date.now() };
  // Live execution (custody) — only when fully configured; otherwise every live path explains what is missing.
  setLiveGate(liveGateFor(db, env)); { const lc = liveConfig(env); setLiveLimits({ maxTradeSol: lc.maxTradeSol, maxDailySol: lc.maxDailySol }); }
  const liveRpc = env.JGG_SOLANA_RPC_HTTP ? createRpc(env.JGG_SOLANA_RPC_HTTP) : null;
  const live = liveRpc ? { rpc: liveRpc, deps: { rpc: liveRpc, env, onFill: afterLiveFill } } : null;
  const router = buildRouter(db, cfg, live);
  const streams = new Set<ServerResponse>();

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, correlationId: string) {
    // Behind a trusted proxy (Netlify / Caddy) the client IP comes from the proxy headers; never trust them otherwise.
    const ip = env.JGG_TRUST_PROXY === '1' ? String(req.headers['x-nf-client-connection-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]).trim() || (req.socket.remoteAddress ?? 'x') : (req.socket.remoteAddress ?? 'x');
    if (url.pathname.startsWith('/api/v1/auth/')) limit(`auth:${ip}`, cfg.testMode ? 1000 : 20, 60_000); else limit(`api:${ip}`, cfg.testMode ? 100_000 : 600, 60_000);
    const cookies = parseCookies(req.headers.cookie);
    let userId: string | null = null; let authKind: Ctx['authKind'] = null; let scopes: Set<string> | null = null; let csrfOk = false; let sid: string | undefined;
    const bearer = (req.headers.authorization ?? '').startsWith('Bearer ') ? (req.headers.authorization as string).slice(7).trim() : null;
    if (bearer) { const k = resolveApiKey(db, bearer, Date.now()); if (!k) throw new ApiError('AUTH_REQUIRED', 'Invalid or revoked API key', 401); userId = k.userId; authKind = 'api_key'; scopes = k.scopes; csrfOk = true; }
    else if (cookies.jgg_sid) { const s = resolveSession(db, cookies.jgg_sid, Date.now()); if (s) { userId = s.userId; authKind = 'session'; sid = cookies.jgg_sid; csrfOk = csrfMatches(req.headers['x-csrf-token'] as string | undefined, s.csrf); } }

    if (url.pathname === '/api/v1/stream') return stream(req, res, url, userId);
    const m = router.match(req.method ?? 'GET', url.pathname);
    if (!m) throw new ApiError('NOT_FOUND', 'No such endpoint', 404);
    if (m.route.auth && !userId) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);
    // CSRF: every cookie-authenticated state change needs the double-submit header (SameSite=Strict is defence in depth).
    if (m.route.write && authKind === 'session' && !csrfOk) throw new ApiError('FORBIDDEN', 'CSRF token missing or invalid', 403);
    if (m.route.scope && scopes && !scopes.has(m.route.scope)) throw new ApiError('FORBIDDEN', `API key lacks scope ${m.route.scope}`, 403);
    if (m.route.write && userId) limit(`w:${userId}`, cfg.testMode ? 100_000 : 120, 60_000);
    const body = await readBody(req);
    const ctx: Ctx & { sid?: string } = { req, res, params: m.params, query: url.searchParams, body, correlationId, userId, authKind, scopes, csrfOk, now: Date.now(), sid };
    const out = await m.route.handler(ctx);
    if (!res.headersSent) sendJson(res, 200, out, { 'x-correlation-id': correlationId });
  }

  // ---------------- SSE stream (spec §10.1) ----------------
  function stream(req: IncomingMessage, res: ServerResponse, url: URL, userId: string | null) {
    const topics = (url.searchParams.get('topics') ?? '').split(',').filter(Boolean).slice(0, 8);
    for (const t of topics) {
      const [kind, arg] = t.split(':');
      if (kind === 'market') { if (!CHAINS.includes(arg as Chain)) throw new ApiError('VALIDATION_FAILED', `Bad topic ${t}`, 400); }
      else if (kind === 'private') { if (!userId) throw new ApiError('AUTH_REQUIRED', 'Private topics need a session', 401); }
      else throw new ApiError('VALIDATION_FAILED', `Unknown topic ${t}`, 400);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...SECURITY_HEADERS });
    const seq = new Map<string, bigint>();
    let cursor = Number(url.searchParams.get('cursor') ?? (userId ? (q1(db, `SELECT MAX(id) m FROM outbox_events WHERE user_id = ?`, userId)?.m ?? 0) : 0));
    const send = (topic: string, entityId: string, data: unknown, chain?: string, live = false) => {
      if (res.writableLength > 512 * 1024) { res.write(`event: resync\ndata: {"reason":"slow_client"}\n\n`); res.end(); return; } // bounded buffer
      const n = (seq.get(topic) ?? 0n) + 1n; seq.set(topic, n);
      const now = new Date().toISOString();
      res.write(`id: ${topic}:${n}\nevent: jgg\ndata: ${JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), topic, sequence: n.toString(), occurredAt: new Date(live ? Date.now() : demoNow()).toISOString(), receivedAt: now, chain, entityId, status: live ? 'live' : 'simulated', source: live ? 'jgg-indexer' : FIXTURE_SOURCE, data })}\n\n`);
    };
    streams.add(res);
    const tick = () => {
      if (userId && !q1(db, `SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`, userId, Date.now()) && !q1(db, `SELECT 1 FROM api_keys WHERE user_id = ? AND revoked_at IS NULL`, userId)) { res.write(`event: revoked\ndata: {}\n\n`); res.end(); return; }
      const now = demoNow();
      for (const t of topics) {
        const [kind, arg] = t.split(':');
        if (kind === 'market') {
          const live = getMarketSource()?.kind === 'solana_live';
          if (live && arg !== 'solana') continue;
          const src: any[] = live ? liveTrending(db, Date.now(), '1h').rows.slice(0, 40) : M.trending(arg as Chain, now, '1h', 'trending').rows.slice(0, 40);
          const rows = src.map(r => ({ a: r.address, p: r.priceUsd, mc: r.mcUsd, v1h: r.vol['1h'], c5m: r.change['5m'], c1h: r.change['1h'], tx: r.txs, h: r.holders }));
          send(t, `ticks:${arg}`, { ticks: rows }, arg, live);
        } else if (kind === 'private' && userId) {
          // Only this user's rows: private topic filtering is server-side.
          const evs = qa(db, `SELECT id, topic, payload FROM outbox_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT 100`, userId, cursor);
          for (const e of evs) { cursor = e.id; send(t, e.topic, { topic: e.topic, cursor: e.id, ...JSON.parse(e.payload) }); }
        }
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    const hb = setInterval(() => res.write(`: hb\n\n`), 15_000);
    const close = () => { clearInterval(iv); clearInterval(hb); streams.delete(res); };
    req.on('close', close); res.on('close', close);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (safe.includes('..')) { res.writeHead(400); res.end(); return; }
    let file = join(opts.webDir, safe);
    if (!safe || !existsSync(file) || statSync(file).isDirectory()) file = join(opts.webDir, 'index.html'); // SPA deep links
    if (!existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Web bundle not built. Run: node scripts/build-web.mjs'); return; }
    const ext = extname(file); const immutable = /\/assets\//.test(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  }

  const server = createServer(async (req, res) => {
    const correlationId = (req.headers['x-correlation-id'] as string)?.slice(0, 64) || randomUUID();
    let url: URL; try { url = new URL(req.url ?? '/', 'http://x'); } catch { res.writeHead(400); res.end(); return; }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, correlationId);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else throw new ApiError('NOT_FOUND', 'Not found', 404);
    } catch (e) { if (!res.headersSent) sendError(res, e, correlationId); else res.end(); }
  });
  server.listen(opts.port);
  const close = () => new Promise<void>(r => { for (const s of streams) s.end(); server.close(() => { db.close(); r(); }); });
  return { server, db, close, cfg };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  const s = startServer({ port, dbPath: process.env.JGG_DB ?? join(process.cwd(), 'data', 'jgg.db'), webDir: process.env.JGG_WEB_DIR ?? join(process.cwd(), 'apps', 'web', 'dist') });
  console.log(`JGG API listening on http://localhost:${port} (env=${process.env.JGG_ENV ?? 'development'})`);
  const stop = async () => { console.log('shutting down'); await s.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
