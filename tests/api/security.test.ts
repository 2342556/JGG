// Security / stream / recovery tests. Run: node --test 'tests/api/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, q1, run } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import { startServer } from '../../apps/api/src/server.ts';
import { tickOnce } from '../../apps/workers/src/worker.ts';
import { runSkill } from '../../apps/api/src/tools.ts';
import { fixtureTokens, priceAt, demoNow, num } from '../../packages/test-fixtures/src/index.ts';

const NOW = demoNow();
const tok = fixtureTokens('solana').find(t => t.createdAt < NOW - 3_600_000 && priceAt(t, NOW) !== null && t.liquidityBase !== null)!;

async function withServer(fn: (base: string, srv: ReturnType<typeof startServer>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jggs-')); const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<!doctype html><title>JGG</title>');
  const port = 20000 + Math.floor(Math.random() * 5000);
  const srv = startServer({ port, dbPath: join(dir, 's.db'), webDir: web, env: { JGG_ENV: 'test', JGG_ORIGIN: `http://localhost:${port}` } });
  try { await fn(`http://localhost:${port}`, srv); } finally { await srv.close(); }
}
async function demo(base: string) {
  const r = await fetch(`${base}/api/v1/auth/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '); const { csrf, userId } = await r.json();
  const h = (extra: Record<string, string> = {}) => ({ cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', ...extra });
  return { cookie, csrf, userId, h };
}
/** Read an SSE stream for `ms` and return parsed events. */
async function readSse(url: string, headers: Record<string, string>, ms: number) {
  const ac = new AbortController(); const res = await fetch(url, { headers, signal: ac.signal });
  const out: any[] = []; let buf = ''; const dec = new TextDecoder(); setTimeout(() => ac.abort(), ms);
  try { for await (const chunk of res.body as any) { buf += dec.decode(chunk); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const d = blk.split('\n').find(l => l.startsWith('data: ')); if (d && blk.includes('event: jgg')) out.push(JSON.parse(d.slice(6))); } } } catch { /* aborted */ }
  return { status: res.status, events: out };
}

test('T43: request hardening — size, content-type, malformed JSON, path traversal, https-only links', async () => {
  await withServer(async (base) => {
    const { h } = await demo(base);
    assert.equal((await fetch(`${base}/api/v1/watchlists`, { method: 'POST', headers: h(), body: JSON.stringify({ name: 'x'.repeat(300_000) }) })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/watchlists`, { method: 'POST', headers: h({ 'content-type': 'text/plain' }), body: 'name=x' })).status, 415);
    assert.equal((await fetch(`${base}/api/v1/watchlists`, { method: 'POST', headers: h(), body: '{bad' })).status, 400);
    for (const p of ['/../../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fpackage.json']) {
      const r = await fetch(base + p); const t = await r.text();
      assert.ok(!t.includes('root:') && !t.includes('"name": "jgg'), `no file disclosure for ${p}`);
    }
    const w = (await (await fetch(`${base}/api/v1/wallets`, { headers: h() })).json()).find((x: any) => x.chain === 'solana');
    const bad = await (await fetch(`${base}/api/v1/launch-intents`, { method: 'POST', headers: h(), body: JSON.stringify({ launchpad: 'pumpfun', name: 'A', symbol: 'A', description: '', website: 'javascript:alert(1)', walletId: w.id }) })).json();
    assert.equal(bad.error.code, 'VALIDATION_FAILED');
    // Stored text is returned as JSON data, never as HTML
    const wl = await (await fetch(`${base}/api/v1/watchlists`, { method: 'POST', headers: h(), body: JSON.stringify({ name: '<img src=x onerror=alert(1)>' }) })).json();
    const r = await fetch(`${base}/api/v1/watchlists`, { headers: h() });
    assert.match(r.headers.get('content-type') ?? '', /application\/json/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await r.json()).some((l: any) => l.id === wl.id));
  });
});

test('T43 (SSRF surface): only operator-configured clients make outbound requests; request handlers never do', () => {
  // Allow-list: clients whose URLs come exclusively from operator env (JGG_SOLANA_RPC_*, JGG_JUPITER_*), never from request data.
  const ALLOWED = new Set(['packages/providers/src/solana/rpc.ts', 'packages/providers/src/solana/jupiter.ts', 'packages/providers/src/fomo.ts', 'packages/providers/src/solana/jupiterSwap.ts']);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e: any) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of ['apps/api/src', 'apps/workers/src', 'packages/providers/src'].flatMap(walk)) {
    const t = readFileSync(f, 'utf8');
    const outbound = /\bfetch\(|http\.request\(|https\.request\(|new WebSocket\(/.test(t);
    if (ALLOWED.has(f)) { assert.ok(!/req\.|c\.body|c\.query/.test(t), `${f} must not read request data`); continue; }
    assert.ok(!outbound, `${f} performs outbound requests`);
  }
});

test('T44/T14 over HTTP: user B cannot read or change user A resources by id', async () => {
  await withServer(async (base) => {
    const a = await demo(base); const b = await demo(base);
    const wl = await (await fetch(`${base}/api/v1/watchlists`, { method: 'POST', headers: a.h(), body: JSON.stringify({ name: 'secret' }) })).json();
    assert.equal((await fetch(`${base}/api/v1/watchlists/${wl.id}`, { method: 'DELETE', headers: b.h() })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/watchlists/${wl.id}/items`, { method: 'POST', headers: b.h(), body: JSON.stringify({ chain: 'solana', address: tok.address }) })).status, 404);
    const al = await (await fetch(`${base}/api/v1/alerts`, { method: 'POST', headers: a.h(), body: JSON.stringify({ name: 'n', chain: 'solana', kind: 'surge', thresholdBps: 1000, windowSec: 300, cooldownSec: 60, destination: 'in_app' }) })).json();
    assert.equal((await fetch(`${base}/api/v1/alerts/${al.id}`, { method: 'PATCH', headers: b.h(), body: JSON.stringify({ enabled: false }) })).status, 404);
    const tg = await (await fetch(`${base}/api/v1/alerts`, { method: 'POST', headers: a.h(), body: JSON.stringify({ name: 'n', chain: 'solana', kind: 'surge', thresholdBps: 1000, windowSec: 300, cooldownSec: 60, destination: 'telegram' }) })).json();
    assert.equal(tg.error.code, 'CAPABILITY_BLOCKED', 'external channels cannot be bound without a verified bot');
    assert.equal((await (await fetch(`${base}/api/v1/notifications`, { headers: b.h() })).json()).length, 0);
  });
});

test('T50: revoked API key stops working immediately', async () => {
  await withServer(async (base) => {
    const a = await demo(base);
    const k = await (await fetch(`${base}/api/v1/api-keys`, { method: 'POST', headers: a.h(), body: JSON.stringify({ name: 'k', scopes: ['market:read'] }) })).json();
    const auth = { authorization: `Bearer ${k.secret}` };
    assert.equal((await fetch(`${base}/api/v1/wallets`, { headers: auth })).status, 200);
    await fetch(`${base}/api/v1/api-keys/${k.id}`, { method: 'DELETE', headers: a.h() });
    assert.equal((await fetch(`${base}/api/v1/wallets`, { headers: auth })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/mode`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) })).status, 401);
  });
});

test('T52: SSE envelope, per-topic ordered sequence, auth + server-side private filtering', async () => {
  await withServer(async (base, srv) => {
    const a = await demo(base); const b = await demo(base);
    const unauth = await fetch(`${base}/api/v1/stream?topics=private:me`); assert.equal(unauth.status, 401); await unauth.body?.cancel();
    const bad = await fetch(`${base}/api/v1/stream?topics=market:dogechain`); assert.equal(bad.status, 400); await bad.body?.cancel();
    const pending = readSse(`${base}/api/v1/stream?topics=market:solana,private:me`, { cookie: b.cookie }, 3500);
    await new Promise(r => setTimeout(r, 300));
    run(srv.db, `INSERT INTO outbox_events (user_id, topic, payload, created_at) VALUES (?, 'orders:x', '{"secret":"A-only"}', ?)`, a.userId, Date.now()); // A's private event
    run(srv.db, `INSERT INTO outbox_events (user_id, topic, payload, created_at) VALUES (?, 'orders:y', '{"mine":true}', ?)`, b.userId, Date.now());
    const { events } = await pending;
    const market = events.filter(e => e.topic === 'market:solana');
    assert.ok(market.length >= 2, 'market ticks streamed');
    for (let i = 1; i < market.length; i++) assert.equal(BigInt(market[i].sequence), BigInt(market[i - 1].sequence) + 1n, 'gap-free per-topic sequence');
    for (const e of events) { assert.equal(e.schemaVersion, 1); assert.ok(e.eventId && e.occurredAt && e.receivedAt && e.status && e.source); }
    const priv = events.filter(e => e.topic === 'private:me');
    assert.ok(priv.some(e => e.data.mine === true), 'own private event delivered');
    assert.ok(!JSON.stringify(events).includes('A-only'), "another user's private event never streamed");
  });
});

test('T53/T54: automation waits while a submission is unresolved; worker reconciles without a second trade', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id;
  S.setRiskPolicy(db, u, { maxPerTrade: '1', maxPerAssetExposure: '3', maxDailyGrossBuy: '5', maxRealizedDailyLoss: '2', maxOpenPositions: 10, maxSlippageBps: 1000, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false }, undefined);
  // simulate a crash right after dispatch: order is uncertain
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, 'crash-key-001'); T.approveIntent(db, u, i.id, {}, NOW);
  const o = T.executeIntent(db, u, i.id, NOW, 'crash-exec-001', 'timeout_after_dispatch'); assert.equal(o.state, 'reconciliation_required');
  const s = S.createStrategy(db, u, { kind: 'limit_buy', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { targetPrice: num(priceAt(tok, NOW)! * 2), amount: '0.1' } }, NOW);
  assert.equal(S.evaluateAll(db, 'w', NOW).find(r => r.id === s.id)?.outcome, 'awaiting_reconciliation');
  const summary = tickOnce(db, 'w', NOW + 10_000); // worker: reconcile first
  assert.equal(summary.reconciled, 1);
  assert.equal(T.orderView(db, u, o.id).state, 'finalized');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM order_attempts WHERE order_id = ?`, o.id).n, 1, 'no re-dispatch');
  assert.equal(S.evaluateAll(db, 'w', NOW + 11_000).find(r => r.id === s.id)?.outcome, 'filled', 'automation resumes after reconciliation');
});

test('T50: skills via API key create strategy DRAFTS only (no unattended activation)', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW);
  S.setRiskPolicy(db, u, { maxPerTrade: '1', maxPerAssetExposure: '3', maxDailyGrossBuy: '5', maxRealizedDailyLoss: '2', maxOpenPositions: 10, maxSlippageBps: 1000, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false }, undefined);
  const r = runSkill(db, u, 'C52', { chain: 'solana', address: tok.address, targetPrice: '0.0000001', amount: '0.1' }, NOW, 'api_key', new Set(['strategy:manage']));
  assert.equal(r.status, 'succeeded'); assert.equal((r.data as any).lifecycle, 'draft');
  const ui = runSkill(db, u, 'C52', { chain: 'solana', address: tok.address, targetPrice: '0.0000001', amount: '0.1' }, NOW, 'user', null);
  assert.equal((ui.data as any).lifecycle, 'active', 'interactive owner may activate directly');
});
