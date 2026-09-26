// JGG API v1 routes (spec §10). JGG's own API — not GMGN endpoints.
import { type DB, tx, q1, qa, run } from './db.ts';
import { ApiError, Router, validate, newId, type Ctx } from './http.ts';
import * as A from './auth.ts';
import * as T from './trading.ts';
import * as S from './strategies.ts';
import * as Tools from './tools.ts';
import * as G from '../../../packages/providers/src/gmgn.ts';
import * as L from './live.ts';
import * as K from './custody.ts';
import type { Rpc } from '../../../packages/providers/src/solana/rpc.ts';
import { jupOrder } from '../../../packages/providers/src/solana/jupiterSwap.ts';
import { WSOL_MINT } from '../../../packages/providers/src/solana/pump.ts';
import * as M from '../../../packages/providers/src/market.ts';
import * as D from '../../../packages/domain/src/index.ts';
import { providerRegistry, PAPER_MODEL, JGG_FEE_BPS, getMarketSource } from '../../../packages/providers/src/execution.ts';
import { SKILLS, SKILL_CATEGORIES } from '../../../packages/catalog/src/index.ts';
import * as C from '../../../packages/contracts/src/index.ts';
import { demoNow, FIXTURE_SOURCE, fixtureTrades, fixtureWallets } from '../../../packages/test-fixtures/src/index.ts';

export type AppCfg = { env: Record<string, string | undefined>; domain: string; origin: string; secureCookies: boolean; testMode: boolean; version: string; startedAt: number };

const chainOf = (s: string | null | undefined): C.Chain => { if (!s) return 'solana'; if (!(C.CHAINS as readonly string[]).includes(s)) throw new ApiError('CHAIN_UNSUPPORTED', `Unsupported chain ${s}`, 400); return s as C.Chain; };
const envl = <T>(data: T, now: number, extra: Partial<C.Provenance> = {}) => ({ data, meta: M.meta(now, extra) });
const uid = (c: Ctx) => { if (!c.userId) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401); return c.userId; };
const idem = (c: Ctx) => (c.req.headers['idempotency-key'] as string | undefined);
const fault = (c: Ctx, cfg: AppCfg) => (cfg.testMode ? (c.req.headers['x-jgg-test-fault'] as any) : undefined) ?? 'none';

/** In live_readonly/live modes there is no verified live data provider: surface that instead of fixtures. */
function marketGuard(db: DB, c: Ctx) {
  if (!c.userId) return; const { mode } = T.getMode(db, c.userId);
  if (mode === 'live_readonly' || mode === 'live') throw new ApiError('PROVIDER_UNAVAILABLE', `${C.MODE_LABEL[mode]}: no verified live market-data provider configured (set GMGN/RPC credentials; see /status). JGG does not show fixture data as live.`, 503);
}

export function buildRouter(db: DB, cfg: AppCfg, live?: { rpc: Rpc; deps: Parameters<typeof K.dispatchLive>[1] } | null) {
  const r = new Router();
  /** Manual live quotes come from Jupiter itself (the venue), shaped like every other quote. */
  const liveJupQuote = async (b: { chain: string; tokenAddress: string; side: 'buy' | 'sell'; amount: string; slippageBps: number }) => {
    if (b.chain !== 'solana') throw new ApiError('CHAIN_UNSUPPORTED', 'Live trading is Solana-only', 400);
    const info = await live!.rpc.getAccountInfoParsed(b.tokenAddress).catch(() => null);
    const decimals = info?.value?.data?.parsed?.info?.decimals; if (!Number.isInteger(decimals)) throw new ApiError('NOT_FOUND', 'Not a token mint', 404);
    const inDec = b.side === 'buy' ? 9 : decimals, outDec = b.side === 'buy' ? decimals : 9;
    let amount: string; try { amount = D.decToRaw(b.amount, inDec).toString(); } catch { throw new ApiError('VALIDATION_FAILED', 'Too many decimals', 400); }
    const o = await jupOrder({ inputMint: b.side === 'buy' ? WSOL_MINT : b.tokenAddress, outputMint: b.side === 'buy' ? b.tokenAddress : WSOL_MINT, amount, apiKey: cfg.env.JGG_JUPITER_API_KEY ?? '' })
      .catch(e => { throw new ApiError('PROVIDER_UNAVAILABLE', `Jupiter: ${(e as Error).message}`, 503, true); });
    if (!o.outAmount) throw new ApiError('PROVIDER_UNAVAILABLE', 'Jupiter returned no output amount', 503, true);
    const now = Date.now();
    return { chain: 'solana' as const, token: b.tokenAddress, side: b.side, amountIn: b.amount, assetIn: b.side === 'buy' ? 'SOL' : 'TOKEN', expectedOut: D.str(D.rawToDec(o.outAmount, outDec)), assetOut: b.side === 'buy' ? 'TOKEN' : 'SOL',
      minOut: D.str(D.rawToDec(D.minimumOutRaw(o.outAmount, b.slippageBps), outDec)), slippageBps: b.slippageBps, priceImpactBps: 0, executionPriceUsd: '0', route: 'jupiter-swap-v2 (live)',
      fees: [{ kind: 'network' as const, amount: '0.000005', asset: 'SOL', includedInQuotedOutput: false, note: 'Base fee; Jupiter sets priority fees at execution' }], quotedAt: now, expiresAt: now + 15_000, model: 'jupiter-order-v2', decimalsOut: outDec };
  };
  const src = () => getMarketSource();
  const isLive = () => src()?.kind === 'solana_live';
  const dn = () => src()?.now() ?? demoNow();
  const liveMeta = { status: 'live' as const, source: 'jgg-indexer (Solana RPC + pump.fun events)', coverage: 'pump.fun bonding-curve coins seen by this indexer' };
  const liveEnv = <T>(data: T) => ({ data, meta: { ...M.meta(Date.now(), {}), ...liveMeta, asOf: new Date().toISOString() } });
  const notInLive = (what: string) => { if (isLive()) throw new ApiError('PROVIDER_UNAVAILABLE', `${what} is not available in JGG standalone v1 yet (Solana pump.fun data only). Nothing is shown rather than fixture data.`, 503); };
  const liveSol = (chain: string) => { if (isLive() && chain !== 'solana') throw new ApiError('CHAIN_UNSUPPORTED', 'Standalone v1 indexes Solana only', 400); };

  // ---------------- Health / capabilities / status ----------------
  r.add('GET', '/api/v1/health', () => ({ ok: true }));
  r.add('GET', '/api/v1/capabilities', () => ({
    modes: C.MODES.map(m => ({ mode: m, label: C.MODE_LABEL[m], available: m === 'demo' || m === 'paper' || m === 'live_readonly', note: m === 'live' ? 'Blocked: no verified execution provider/signer; funded test not authorized (T59).' : m === 'live_readonly' ? 'Selectable; data provider not configured so views show provider status instead of data.' : 'Simulated data/execution.' })),
    chains: C.CHAINS.map(ch => ({ chain: ch, ...C.CHAIN_META[ch], demo: 'implemented_demo', paper: 'implemented_paper', liveRead: 'blocked_external', liveTrade: 'blocked_external' })),
    providers: providerRegistry(cfg.env, false), paperModel: PAPER_MODEL, jggFeeBps: JGG_FEE_BPS,
  }));
  r.add('GET', '/api/v1/status', () => {
    const w = q1(db, `SELECT value, updated_at FROM worker_state WHERE key = 'heartbeat'`);
    const lag = w ? Date.now() - w.updated_at : null;
    const backlog = q1(db, `SELECT COUNT(*) n FROM outbox_events WHERE published_at IS NULL`).n;
    const uncertain = q1(db, `SELECT COUNT(*) n FROM orders WHERE state = 'reconciliation_required'`).n;
    return { version: cfg.version, uptimeSec: Math.floor((Date.now() - cfg.startedAt) / 1000), demoClock: new Date(dn()).toISOString(),
      services: [
        { id: 'api', status: 'up' },
        { id: 'worker', status: lag === null ? 'down' : lag < 10_000 ? 'up' : 'degraded', lastHeartbeatMsAgo: lag, detail: w ? JSON.parse(w.value) : null },
        { id: 'database', status: 'up', engine: 'sqlite (dev); PostgreSQL contract in infra/postgres' },
        { id: 'fixture-market-data', status: 'simulated', source: FIXTURE_SOURCE },
      ],
      queues: { outboxBacklog: backlog, uncertainOrders: uncertain },
      dataSource: src()?.kind ?? 'fixture', live: isLive() ? L.liveStatus(db, Date.now()) : null,
      providers: providerRegistry(cfg.env, false).map(p => ({ id: p.id, status: p.status, reason: p.reason })),
      incidents: [] };
  });

  // ---------------- Auth ----------------
  r.add('POST', '/api/v1/auth/demo', (c) => {
    const id = A.createUser(db, 'demo', Date.now(), 'Demo trader');
    const s = A.createSession(db, id, Date.now());
    c.res.setHeader('set-cookie', A.sessionCookies(s.sid, s.csrf, cfg.secureCookies));
    return { userId: id, csrf: s.csrf, mode: 'demo' };
  });
  r.add('POST', '/api/v1/auth/challenge', (c) => {
    const b = c.body ?? {}; if (typeof b.address !== 'string' || typeof b.chain !== 'string') throw new ApiError('VALIDATION_FAILED', 'chain and address required', 400);
    return A.createChallenge(db, b.chain, b.address, cfg.domain, cfg.origin, Date.now());
  });
  r.add('POST', '/api/v1/auth/verify', (c) => {
    const b = c.body ?? {};
    const userId = A.verifyChallenge(db, { nonce: String(b.nonce ?? ''), address: String(b.address ?? ''), signature: String(b.signature ?? ''), domain: String(b.domain ?? cfg.domain) }, Date.now());
    const s = A.createSession(db, userId, Date.now());
    c.res.setHeader('set-cookie', A.sessionCookies(s.sid, s.csrf, cfg.secureCookies));
    T.audit(db, userId, 'user', 'auth.signin', { method: 'siws' });
    return { userId, csrf: s.csrf };
  });
  r.add('DELETE', '/api/v1/session', (c) => {
    const sid = (c as any).sid as string | undefined; if (sid) A.revokeSession(db, sid, Date.now());
    c.res.setHeader('set-cookie', A.clearCookies());
    return { signedOut: true, note: 'Session revoked. Strategy authority is separate: active paper strategies keep running until paused or the kill switch is used.' };
  }, { auth: true });
  r.add('GET', '/api/v1/me', (c) => {
    if (!c.userId) return { user: null, dataSource: src()?.kind ?? 'fixture' }; // signed-out is a normal state, not an error (avoids noisy 401s)
    const id = uid(c); const u = q1(db, `SELECT id, kind, display, referral_code, created_at FROM users WHERE id = ?`, id);
    const s = q1(db, `SELECT mode, mode_version, chain, display, layout, version FROM settings WHERE user_id = ?`, id);
    const ids = qa(db, `SELECT chain, address, verified_at FROM identities WHERE user_id = ?`, id);
    const unread = q1(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL`, id).n;
    return { dataSource: src()?.kind ?? 'fixture', user: u, settings: { ...s, display: JSON.parse(s.display), layout: JSON.parse(s.layout) }, identities: ids, unreadNotifications: unread, killSwitch: S.getRiskPolicy(db, id).policy.killSwitch, authKind: c.authKind };
  });

  // ---------------- Settings / mode / presets / risk ----------------
  r.add('PATCH', '/api/v1/settings', (c) => {
    const id = uid(c); const b = c.body ?? {};
    const cur = q1(db, `SELECT * FROM settings WHERE user_id = ?`, id);
    if (b.version !== undefined && b.version !== cur.version) throw new ApiError('VERSION_CONFLICT', 'Settings changed in another tab; reload', 409, true);
    if (b.chain !== undefined) chainOf(b.chain);
    const display = b.display !== undefined ? JSON.stringify(b.display) : cur.display;
    const layout = b.layout !== undefined ? JSON.stringify(b.layout) : cur.layout;
    // Reject oversize instead of truncating (truncated JSON would corrupt the row).
    if (display.length > 4000 || layout.length > 8000) throw new ApiError('VALIDATION_FAILED', 'display/layout too large', 400);
    if (/"(?:secret|password|privateKey|mnemonic|apiKey)"/i.test(layout + display)) throw new ApiError('VALIDATION_FAILED', 'Layout/display preferences must not contain secrets', 400);
    run(db, `UPDATE settings SET chain = ?, display = ?, layout = ?, version = version + 1 WHERE user_id = ?`, b.chain ?? cur.chain, display, layout, id);
    return { version: cur.version + 1 };
  }, { auth: true });
  r.add('POST', '/api/v1/mode', (c) => {
    const id = uid(c); const mode = c.body?.mode;
    if (!(C.MODES as readonly string[]).includes(mode)) throw new ApiError('VALIDATION_FAILED', 'Unknown mode', 400);
    if (mode === 'live') { const g = T.liveAllowed(id); if (!g.ok) throw new ApiError('CAPABILITY_BLOCKED', `Live trading unavailable: ${g.reasons.join(', ')}`, 409, false, { reasons: g.reasons });
      if (!isLive()) throw new ApiError('CAPABILITY_BLOCKED', 'Live trading needs the live data source (JGG_DATA_SOURCE=solana_live)', 409); }
    if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Mode changes require an interactive session', 403);
    return T.setMode(db, id, mode, dn());
  }, { auth: true });
  r.add('GET', '/api/v1/presets', (c) => qa(db, `SELECT slot, chain, config, version FROM presets WHERE user_id = ? ORDER BY chain, slot`, uid(c)).map(p => ({ ...p, config: JSON.parse(p.config) })), { auth: true });
  r.add('PUT', '/api/v1/presets', (c) => {
    const id = uid(c); const p = validate(C.presetSchema, c.body?.preset);
    D.validateSlippageBps(p.slippageBps, p.slippageBps > 1500 && c.body?.explicitHighSlippage === true);
    const cur = q1(db, `SELECT version FROM presets WHERE user_id = ? AND slot = ? AND chain = ?`, id, p.slot, p.chain);
    if (c.body?.version !== undefined && cur && c.body.version !== cur.version) throw new ApiError('VERSION_CONFLICT', 'Preset changed elsewhere', 409, true);
    const { slot, chain, ...config } = p;
    run(db, `UPDATE presets SET config = ?, version = version + 1 WHERE user_id = ? AND slot = ? AND chain = ?`, JSON.stringify(config), id, slot, chain);
    return { slot, chain, config, version: (cur?.version ?? 0) + 1 };
  }, { auth: true });
  r.add('GET', '/api/v1/risk-policy', (c) => S.getRiskPolicy(db, uid(c)), { auth: true });
  r.add('PUT', '/api/v1/risk-policy', (c) => { if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Risk policy changes require an interactive session', 403); return S.setRiskPolicy(db, uid(c), c.body?.policy ?? {}, c.body?.version); }, { auth: true });
  r.add('POST', '/api/v1/automation/stop', (c) => {
    const id = uid(c); const res = S.setKillSwitch(db, id, true, dn());
    return { ...res, unresolved: qa(db, `SELECT id, token, side FROM orders WHERE user_id = ? AND state = 'reconciliation_required'`, id) };
  }, { auth: true });
  r.add('POST', '/api/v1/automation/resume', (c) => { if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Interactive session required', 403); return S.setKillSwitch(db, uid(c), false, dn()); }, { auth: true });

  // ---------------- Market data ----------------
  r.add('GET', '/api/v1/search', (c) => { marketGuard(db, c); const q = (c.query.get('q') ?? '').slice(0, 100); if (isLive()) return liveEnv(L.liveSearch(db, q, dn())); return envl(M.search(q, dn(), c.query.get('chain') as C.Chain | undefined), dn()); });
  r.add('GET', '/api/v1/markets/:view', (c) => {
    marketGuard(db, c);
    const chain = chainOf(c.query.get('chain')); const now = dn();
    const f: M.MarketFilter = { keyword: c.query.get('keyword') ?? undefined, launchpad: c.query.get('launchpad') ?? undefined, minLiquidityUsd: c.query.get('minLiq') ?? undefined,
      minMarketCapUsd: c.query.get('minMc') ?? undefined, maxMarketCapUsd: c.query.get('maxMc') ?? undefined, minSmartMoney: c.query.get('minSm') ? Number(c.query.get('minSm')) : undefined,
      maxTop10Bps: c.query.get('maxTop10') ? Number(c.query.get('maxTop10')) : undefined, excludeRisky: c.query.get('excludeRisky') === '1', unknownPolicy: (c.query.get('unknown') as any) ?? undefined };
    const view = c.params.view; const window = c.query.get('window') ?? '1h';
    if (isLive()) {
      liveSol(chain);
      if (['new', 'near_completion', 'migrated'].includes(view)) return liveEnv(L.liveTrenches(db, view as any, now));
      if (view === 'trending') return liveEnv(L.liveTrending(db, now, window));
      notInLive(`The "${view}" view`);
    }
    if (['new', 'near_completion', 'migrated'].includes(view)) return envl(M.trenches(chain, now, view as any, f), now);
    if (['trending', 'new_pair', 'surge', 'hot_searches'].includes(view)) return envl(M.trending(chain, now, window, view, f), now, { coverage: `JGG ranking (${D.JGG_RANKING_VERSION}) over fixture universe` });
    if (['binance', 'nextbc', 'pump_live'].includes(view)) throw new ApiError('PROVIDER_UNAVAILABLE', `The "${view}" feed needs a provider whose membership rules are verified; none is configured. JGG will not relabel another list as ${view}.`, 503);
    throw new ApiError('NOT_FOUND', 'Unknown market view', 404);
  });
  r.add('GET', '/api/v1/tokens/:chain/:address', (c) => { marketGuard(db, c); if (isLive()) { liveSol(c.params.chain); const lt = L.liveTokenDetail(db, c.params.address, dn()); if (!lt) throw new ApiError('NOT_FOUND', 'Coin not indexed yet (the indexer only knows coins it has seen trade)', 404); return liveEnv(lt); } const t = M.tokenDetail(chainOf(c.params.chain), c.params.address, dn()); if (!t) throw new ApiError('NOT_FOUND', 'Token not found on this chain', 404); return envl(t, dn()); });
  r.add('GET', '/api/v1/tokens/:chain/:address/candles', (c) => {
    marketGuard(db, c);
    const count = Math.min(Math.max(Number(c.query.get('count') ?? 200) || 200, 10), 1000);
    if (isLive()) { liveSol(c.params.chain); const ms = ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as Record<string, number>)[c.query.get('interval') ?? '1m'];
      if (!ms) throw new ApiError('VALIDATION_FAILED', 'Unsupported interval', 400); return liveEnv(L.liveCandles(db, c.params.address, ms, count, dn())); }
    const k = M.candles(chainOf(c.params.chain), c.params.address, c.query.get('interval') ?? '1m', count, dn());
    if (!k) throw new ApiError('NOT_FOUND', 'Token not found', 404); if ('error' in k) throw new ApiError('VALIDATION_FAILED', 'Unsupported interval', 400);
    return envl(k, dn());
  });
  r.add('GET', '/api/v1/tokens/:chain/:address/holders', (c) => { marketGuard(db, c); notInLive('Holder list'); const h = M.holders(chainOf(c.params.chain), c.params.address, dn()); if (!h) throw new ApiError('NOT_FOUND', 'Token not found', 404); return envl(h, dn()); });
  r.add('GET', '/api/v1/tokens/:chain/:address/traders', (c) => { marketGuard(db, c); notInLive('Top traders'); return envl(M.traders(chainOf(c.params.chain), c.params.address, dn(), c.query.get('sort') ?? undefined), dn()); });
  r.add('GET', '/api/v1/tokens/:chain/:address/trades', (c) => { marketGuard(db, c); if (isLive()) return liveEnv(L.liveTrades(db, c.params.address, dn())); return envl(tokenTrades(chainOf(c.params.chain), c.params.address, dn()), dn()); });
  r.add('GET', '/api/v1/wallets/:chain/:address', (c) => { marketGuard(db, c); if (isLive()) { liveSol(c.params.chain); return liveEnv(L.liveWalletDetail(db, c.params.address, dn(), c.query.get('period') ?? '7d')); } return envl(M.walletDetail(chainOf(c.params.chain), c.params.address, dn(), c.query.get('period') ?? '7d'), dn()); });
  r.add('GET', '/api/v1/rank', (c) => { marketGuard(db, c); if (isLive()) { liveSol(c.query.get('chain') ?? 'solana'); return liveEnv(L.liveRank(db, dn(), c.query.get('period') ?? '7d', c.query.get('category') ?? 'all')); } return envl(M.rankWallets(chainOf(c.query.get('chain')), dn(), c.query.get('period') ?? '1d', c.query.get('category') ?? 'all'), dn()); });
  r.add('GET', '/api/v1/signals/:kind', (c) => {
    if (isLive()) {
      liveSol(c.query.get('chain') ?? 'solana');
      if (!['wallet_trades', 'label_trades', 'cluster', 'surge'].includes(c.params.kind) || (c.query.get('label') && !['smart_money', 'fomo'].includes(c.query.get('label')!))) notInLive(`The "${c.params.kind}${c.query.get('label') ? ':' + c.query.get('label') : ''}" signal`);
      if (c.params.kind === 'wallet_trades' && !c.userId) throw new ApiError('AUTH_REQUIRED', 'Sign in to see your tracked wallets', 401);
      const trackedL = c.userId ? new Set(qa(db, `SELECT address FROM tracked_wallets WHERE user_id = ? AND chain = 'solana' AND muted = 0`, c.userId).map(x => x.address as string)) : new Set<string>();
      const wmsL: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3 };
      return liveEnv(L.liveSignals(db, Date.now(), c.params.kind, { label: c.query.get('label') ?? undefined, side: c.query.get('side') ?? undefined, minWallets: Number(c.query.get('minWallets') ?? 3), windowMs: wmsL[c.query.get('window') ?? '1h'] ?? 3600e3, minChangeBps: Number(c.query.get('minChangeBps') ?? 2000), tracked: trackedL }));
    }
    marketGuard(db, c); const chain = chainOf(c.query.get('chain'));
    const tracked = c.userId ? new Set(qa(db, `SELECT address FROM tracked_wallets WHERE user_id = ? AND chain = ? AND muted = 0`, c.userId, chain).map(x => x.address)) : new Set<string>();
    if (c.params.kind === 'wallet_trades' && !c.userId) throw new ApiError('AUTH_REQUIRED', 'Sign in to see your tracked wallets', 401);
    const wms: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3 };
    return envl(M.signals(chain, dn(), c.params.kind, { label: c.query.get('label') ?? undefined, side: c.query.get('side') ?? undefined, minWallets: Number(c.query.get('minWallets') ?? 3), windowMs: wms[c.query.get('window') ?? '1h'] ?? 3600e3, minChangeBps: Number(c.query.get('minChangeBps') ?? 2000), tracked }), dn());
  });
  // Finder: explainable candidate screen. Demo/Paper → fixtures; Live read-only → GMGN (read-only) when configured.
  r.add('GET', '/api/v1/finder', async (c) => {
    const chain = chainOf(c.query.get('chain')); const mode = c.userId ? T.getMode(db, c.userId).mode : 'demo';
    if (mode === 'live_readonly' || mode === 'live') {
      if (!cfg.env.GMGN_API_KEY) throw new ApiError('PROVIDER_UNAVAILABLE', 'Live read-only needs GMGN_API_KEY (and gmgn-cli installed). See /status.', 503);
      const filters = ['not_risk', 'not_honeypot'];
      try {
        const raw = await G.runGmgn(G.trendingArgs({ chain: G.GMGN_CHAIN[chain], interval: '1h', limit: 100, orderBy: 'volume', filters, min: { liquidity: 8000 }, maxCreated: '24h' }), cfg.env);
        const items: any[] = Array.isArray(raw?.data?.rank) ? raw.data.rank : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.rank) ? raw.rank : [];
        const mapped = items.map(it => G.mapRankItem(it, { requestedFilters: filters }));
        return { data: { ...D.runFinder(mapped), unmappedFields: [...new Set(mapped.flatMap(m => m.unmapped))] }, meta: { status: 'live', source: 'gmgn (unverified mapping)', asOf: new Date().toISOString() } };
      } catch (e) {
        const g = e as G.GmgnError;
        throw new ApiError(g.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', `GMGN: ${g.message}`, g.code === 'RATE_LIMITED' ? 429 : 503, true, { retryAfterMs: g.retryAfterMs });
      }
    }
    if (isLive()) { liveSol(chain); const sx = src()!; return liveEnv({ ...D.runFinder(sx.finderCandidates(chain, dn()), sx.finderConfig, sx.finderExclude), note: 'KOL factor excluded: no social data in standalone v1. Smart-money labels need ~24h+ of indexed history.' }); }
    return envl(D.runFinder(M.finderCandidates(chain, dn())), dn(), { coverage: 'JGG Finder v1 over the fixture universe' });
  });
  r.add('GET', '/api/v1/strategies/:id/performance', (c) => S.autoPerformance(db, uid(c), c.params.id), { auth: true });
  r.add('GET', '/api/v1/finder/stats', (c) => {
    if (!isLive()) return { data: null, meta: { status: 'unavailable', source: 'n/a', asOf: new Date().toISOString(), note: 'Finder track record needs live data (JGG_DATA_SOURCE=solana_live) and takes hours to days to accumulate a sample.' } };
    return liveEnv(L.finderOutcomeStats(db, Date.now()));
  });
  r.add('GET', '/api/v1/fees/:chain', (c) => envl(M.gasFees(chainOf(c.params.chain)), dn()));
  r.add('GET', '/api/v1/ticker', () => isLive() ? liveEnv([{ chain: 'solana', native: 'SOL', usd: L.solUsd(db, Date.now())?.usd ?? null }]) : envl(C.CHAINS.map(ch => ({ chain: ch, native: C.CHAIN_META[ch].native, usd: M.nativeUsd(ch) })), dn(), { warnings: ['Fixture native prices; not live.'] }));

  // ---------------- Trading ----------------
  r.add('POST', '/api/v1/quotes', async (c) => {
    const id = uid(c); const body = validate(C.quoteRequest, c.body);
    if (T.getMode(db, id).mode !== 'live') return T.createQuote(db, id, body, dn());
    if (!live) throw new ApiError('CAPABILITY_BLOCKED', 'Live execution is not configured on this server', 409);
    await K.syncBalances(db, live.rpc, id, [body.tokenAddress]).catch(() => null); // reservations must see on-chain balances
    return T.createQuote(db, id, body, Date.now(), await liveJupQuote(body));
  }, { auth: true, scope: 'trade:propose' });
  r.add('POST', '/api/v1/trade-intents', (c) => T.createIntent(db, uid(c), validate(C.intentRequest, c.body), dn(), idem(c)), { auth: true, scope: 'trade:propose' });
  r.add('GET', '/api/v1/trade-intents/:id', (c) => T.intentView(db, uid(c), c.params.id), { auth: true });
  r.add('POST', '/api/v1/trade-intents/:id/approve', (c) => {
    if (c.authKind !== 'session') throw new ApiError('APPROVAL_REQUIRED', 'Approval requires the account owner in an interactive session', 403);
    return T.approveIntent(db, uid(c), c.params.id, { contextHash: c.body?.contextHash, maxSlippageBps: c.body?.maxSlippageBps, maxFeeNative: c.body?.maxFeeNative }, dn());
  }, { auth: true });
  r.add('POST', '/api/v1/trade-intents/:id/reject', (c) => tx(db, () => {
    const id = uid(c); const i = q1(db, `SELECT * FROM trade_intents WHERE id = ? AND user_id = ?`, c.params.id, id); if (!i) throw new ApiError('NOT_FOUND', 'Intent not found', 404);
    if (!['awaiting_approval', 'authorized'].includes(i.state)) throw new ApiError('INVALID_TRANSITION', `Intent is ${i.state}`, 409);
    run(db, `UPDATE trade_intents SET state = 'rejected', reason = 'USER_REJECTED', version = version + 1, updated_at = ? WHERE id = ?`, dn(), i.id);
    if (i.reservation_id) T.releaseReservation(db, i.reservation_id);
    return T.intentView(db, id, i.id);
  }), { auth: true });
  r.add('POST', '/api/v1/trade-intents/:id/execute', async (c) => {
    const id = uid(c); const o = T.executeIntent(db, id, c.params.id, dn(), idem(c), fault(c, cfg));
    if (o.mode === 'live' && o.state === 'submitting' && live) { await K.dispatchLive(db, live.deps, o.id); return T.orderView(db, id, o.id); }
    return o;
  }, { auth: true, scope: 'trade:execute' });

  // ---------------- Custody (JGG trading wallet) ----------------
  r.add('GET', '/api/v1/custody', (c) => {
    const id = uid(c); const g = T.liveAllowed(id); const cw = q1(db, `SELECT c.address, w.id wid FROM custody_wallets c JOIN wallets w ON w.address = c.address AND w.user_id = c.user_id WHERE c.user_id = ?`, id);
    return { gate: g, address: cw?.address ?? null, verifiedWallet: q1(db, `SELECT address FROM identities WHERE user_id = ? AND chain = 'solana'`, id)?.address ?? null,
      balances: cw ? qa(db, `SELECT asset, qty, reserved FROM paper_balances WHERE wallet_id = ?`, cw.wid) : [], limits: T.liveLimits(), serverConfigured: !!live,
      withdrawals: qa(db, `SELECT id, to_address, lamports, signature, status, created_at FROM custody_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, id),
      liveOrders: qa(db, `SELECT o.id, o.side, o.token, o.amount_in, o.filled_out, o.state, l.status exec_status, l.signature FROM orders o LEFT JOIN live_exec l ON l.order_id = o.id WHERE o.user_id = ? AND o.mode = 'live' ORDER BY o.created_at DESC LIMIT 30`, id) };
  }, { auth: true });
  r.add('POST', '/api/v1/custody/wallet', (c) => { if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Interactive session required', 403); return K.createTradingWallet(db, cfg.env, uid(c), Date.now()); }, { auth: true });
  r.add('POST', '/api/v1/custody/sync', async (c) => { if (!live) throw new ApiError('CAPABILITY_BLOCKED', 'Live execution is not configured on this server', 409); return (await K.syncBalances(db, live.rpc, uid(c))) ?? { address: null }; }, { auth: true });
  r.add('POST', '/api/v1/custody/withdraw', async (c) => {
    if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Interactive session required', 403);
    if (c.body?.confirm !== 'WITHDRAW') throw new ApiError('VALIDATION_FAILED', 'Type WITHDRAW to confirm', 400);
    if (!live) throw new ApiError('CAPABILITY_BLOCKED', 'Live execution is not configured on this server', 409);
    const amt = c.body?.amountSol === 'all' ? 'all' : String(c.body?.amountSol ?? '');
    if (amt !== 'all' && !/^\d+(\.\d{1,9})?$/.test(amt)) throw new ApiError('VALIDATION_FAILED', 'amountSol must be a SOL amount (≤9 decimals) or "all"', 400);
    return K.withdraw(db, live.deps, uid(c), amt);
  }, { auth: true });
  r.add('GET', '/api/v1/orders', (c) => T.listOrders(db, uid(c), c.query.get('cursor'), Math.min(Number(c.query.get('limit') ?? 50) || 50, 200)), { auth: true });
  r.add('GET', '/api/v1/orders/:id', (c) => T.orderView(db, uid(c), c.params.id), { auth: true });
  r.add('POST', '/api/v1/orders/:id/cancel', (c) => T.cancelOrder(db, uid(c), c.params.id, dn()), { auth: true, scope: 'strategy:manage' });
  r.add('POST', '/api/v1/orders/:id/reconcile', (c) => T.reconcileOrder(db, uid(c), c.params.id, dn()), { auth: true });
  r.add('GET', '/api/v1/portfolio', (c) => T.portfolio(db, uid(c), chainOf(c.query.get('chain')), dn()), { auth: true, scope: 'wallet:read' });
  r.add('GET', '/api/v1/portfolio/journal', (c) => qa(db, `SELECT e.id, e.kind, e.ref, e.mode, e.at, json_group_array(json_object('account', l.account, 'asset', l.asset, 'amount', l.amount)) lines FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.user_id = ? GROUP BY e.id ORDER BY e.at DESC LIMIT 200`, uid(c)).map(e => ({ ...e, lines: JSON.parse(e.lines) })), { auth: true, scope: 'wallet:read' });
  r.add('GET', '/api/v1/portfolio/export.csv', (c) => {
    const rows = qa(db, `SELECT o.created_at, o.mode, o.chain, o.token, o.side, o.amount_in, o.filled_out, o.fee_native, o.state, o.tx_ref FROM orders o WHERE o.user_id = ? ORDER BY o.created_at`, uid(c));
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = ['time,mode,chain,token,side,amount_in,filled_out,fee_native,state,tx_ref', ...rows.map(o => [new Date(o.created_at).toISOString(), o.mode, o.chain, o.token, o.side, o.amount_in, o.filled_out, o.fee_native, o.state, o.tx_ref].map(esc).join(','))].join('\n');
    c.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="jgg-orders.csv"', 'cache-control': 'no-store' }); c.res.end(csv); return undefined;
  }, { auth: true, scope: 'wallet:read' });
  r.add('GET', '/api/v1/wallets', (c) => qa(db, `SELECT id, chain, address, custody, label, verified_control FROM wallets WHERE user_id = ? ORDER BY chain, label`, uid(c)), { auth: true });
  r.add('POST', '/api/v1/wallets/watch', (c) => {
    const id = uid(c); const chain = chainOf(c.body?.chain); const address = String(c.body?.address ?? '');
    if (!C.isValidAddress(chain, address)) throw new ApiError('VALIDATION_FAILED', 'Invalid address for chain', 400);
    const wid = newId('ww'); run(db, `INSERT OR IGNORE INTO wallets (id, user_id, chain, address, custody, label, verified_control, created_at) VALUES (?, ?, ?, ?, 'watch', ?, 0, ?)`, wid, id, chain, address, String(c.body?.label ?? 'Watch').slice(0, 30), Date.now());
    return { id: wid, custody: 'watch', note: 'Watch-only: public data, no signing authority.' };
  }, { auth: true });
  r.add('POST', '/api/v1/paper/reset', (c) => {
    const id = uid(c); const { mode } = T.getMode(db, id); if (mode !== 'paper' && mode !== 'demo') throw new ApiError('POLICY_DENIED', 'Reset only applies to simulated accounts', 403);
    return tx(db, () => {
      const open = q1(db, `SELECT COUNT(*) n FROM orders WHERE user_id = ? AND state = 'reconciliation_required'`, id).n;
      if (open) throw new ApiError('TRANSACTION_UNCERTAIN', 'Resolve uncertain orders before resetting', 409);
      run(db, `UPDATE strategies SET lifecycle = 'cancelled', reason = 'PAPER_RESET' WHERE user_id = ? AND lifecycle IN ('active','paused','draft')`, id);
      run(db, `DELETE FROM position_lots WHERE user_id = ?`, id); run(db, `DELETE FROM balance_reservations WHERE user_id = ?`, id);
      run(db, `DELETE FROM paper_balances WHERE user_id = ?`, id);
      const ws = qa(db, `SELECT id, chain, label FROM wallets WHERE user_id = ? AND custody = 'paper'`, id);
      const P: Record<string, [string, string]> = { solana: ['SOL', '10'], bsc: ['BNB', '5'], base: ['ETH', '1'], ethereum: ['ETH', '1'] };
      for (const w of ws) run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) VALUES (?, ?, ?, ?)`, id, w.id, P[w.chain][0], w.label === 'Paper 1' ? P[w.chain][1] : '1');
      T.audit(db, id, 'user', 'paper.reset', {}); return { reset: true, note: 'Virtual balances restored; order/journal history kept for audit.' };
    });
  }, { auth: true });

  // ---------------- Strategies ----------------
  r.add('GET', '/api/v1/strategies', (c) => S.listStrategies(db, uid(c)), { auth: true });
  r.add('POST', '/api/v1/strategies', (c) => { const b = validate(C.strategyCreate, c.body); return S.createStrategy(db, uid(c), b as any, dn(), undefined, false); }, { auth: true, scope: 'strategy:manage' });
  r.add('GET', '/api/v1/strategies/:id', (c) => S.strategyView(db, uid(c), c.params.id), { auth: true });
  for (const a of ['activate', 'pause', 'resume', 'cancel'] as const)
    r.add('POST', `/api/v1/strategies/:id/${a}`, (c) => {
      if (a === 'activate' || a === 'resume') { if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'Activating automation requires the owner in an interactive session', 403); }
      const v = S.setStrategyLifecycle(db, uid(c), c.params.id, a, dn());
      return a === 'pause' ? { ...v, inFlight: qa(db, `SELECT id, state FROM orders WHERE strategy_id = ? AND state IN ('submitting','submitted','reconciliation_required')`, c.params.id) } : v;
    }, { auth: true, scope: 'strategy:manage' });

  // ---------------- Watchlists / tracked wallets / alerts / notifications ----------------
  r.add('GET', '/api/v1/watchlists', (c) => {
    const id = uid(c); const lists = qa(db, `SELECT id, name, version FROM watchlists WHERE user_id = ? ORDER BY created_at`, id);
    return lists.map(l => ({ ...l, items: qa(db, `SELECT chain, address, note, added_at FROM watchlist_items WHERE watchlist_id = ? ORDER BY added_at DESC`, l.id).map(i => { const t = M.tokenDetail(i.chain, i.address, dn()); return { ...i, token: t ? { symbol: t.symbol, name: t.name, priceUsd: t.priceUsd, mcUsd: t.mcUsd, change: t.change, liqUsd: t.liqUsd, hue: t.hue } : null }; }) }));
  }, { auth: true });
  r.add('POST', '/api/v1/watchlists', (c) => { const id = uid(c); const b = validate(C.watchlistCreate, c.body); const wid = newId('wl');
    try { run(db, `INSERT INTO watchlists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`, wid, id, b.name, Date.now()); } catch { throw new ApiError('VALIDATION_FAILED', 'A group with that name exists', 409); }
    return { id: wid, name: b.name, version: 1 }; }, { auth: true, scope: 'watchlist:write' });
  r.add('PATCH', '/api/v1/watchlists/:id', (c) => { const id = uid(c); const b = validate(C.watchlistCreate, c.body);
    const res = run(db, `UPDATE watchlists SET name = ?, version = version + 1 WHERE id = ? AND user_id = ? AND version = ?`, b.name, c.params.id, id, Number(c.body?.version));
    if (Number(res.changes) !== 1) { if (!q1(db, `SELECT 1 FROM watchlists WHERE id = ? AND user_id = ?`, c.params.id, id)) throw new ApiError('NOT_FOUND', 'Watchlist not found', 404); throw new ApiError('VERSION_CONFLICT', 'Watchlist changed elsewhere; reload', 409, true); }
    return { id: c.params.id, name: b.name, version: Number(c.body.version) + 1 }; }, { auth: true, scope: 'watchlist:write' });
  r.add('DELETE', '/api/v1/watchlists/:id', (c) => { const id = uid(c); return tx(db, () => { const w = q1(db, `SELECT id FROM watchlists WHERE id = ? AND user_id = ?`, c.params.id, id); if (!w) throw new ApiError('NOT_FOUND', 'Watchlist not found', 404);
    run(db, `DELETE FROM watchlist_items WHERE watchlist_id = ?`, w.id); run(db, `DELETE FROM watchlists WHERE id = ?`, w.id); return { deleted: true }; }); }, { auth: true, scope: 'watchlist:write' });
  r.add('POST', '/api/v1/watchlists/:id/items', (c) => { const id = uid(c);
    const items: any[] = Array.isArray(c.body?.items) ? c.body.items.slice(0, 200) : [c.body];
    const w = q1(db, `SELECT id FROM watchlists WHERE id = ? AND user_id = ?`, c.params.id, id); if (!w) throw new ApiError('NOT_FOUND', 'Watchlist not found', 404);
    const results = items.map((raw, idx) => { try { const it = validate(C.watchlistItem, raw); if (!C.isValidAddress(it.chain, it.address)) throw new ApiError('VALIDATION_FAILED', 'Invalid address for chain');
      run(db, `INSERT OR IGNORE INTO watchlist_items (watchlist_id, user_id, chain, address, note, added_at) VALUES (?, ?, ?, ?, ?, ?)`, w.id, id, it.chain, C.assetKey(it.chain, it.address).split(':').pop(), it.note ?? null, Date.now()); return { idx, ok: true }; }
      catch (e) { return { idx, ok: false, error: (e as Error).message }; } });
    run(db, `UPDATE watchlists SET version = version + 1 WHERE id = ?`, w.id);
    return { added: results.filter(r => r.ok).length, rejected: results.filter(r => !r.ok) }; }, { auth: true, scope: 'watchlist:write' });
  r.add('DELETE', '/api/v1/watchlists/:id/items/:chain/:address', (c) => { const id = uid(c);
    const res = run(db, `DELETE FROM watchlist_items WHERE watchlist_id = ? AND user_id = ? AND chain = ? AND address = ?`, c.params.id, id, c.params.chain, c.params.address);
    return { removed: Number(res.changes) }; }, { auth: true, scope: 'watchlist:write' });
  r.add('GET', '/api/v1/tracked-wallets', (c) => qa(db, `SELECT chain, address, nickname, grp, muted, added_at FROM tracked_wallets WHERE user_id = ? ORDER BY added_at DESC`, uid(c)), { auth: true });
  r.add('POST', '/api/v1/tracked-wallets', (c) => { const id = uid(c); const chain = chainOf(c.body?.chain); const address = String(c.body?.address ?? '');
    if (!C.isValidAddress(chain, address)) throw new ApiError('VALIDATION_FAILED', 'Invalid wallet address for chain', 400);
    const n = q1(db, `SELECT COUNT(*) n FROM tracked_wallets WHERE user_id = ?`, id).n; if (n >= 500) throw new ApiError('BUDGET_EXCEEDED', 'Tracked wallet limit (500) reached', 409);
    run(db, `INSERT INTO tracked_wallets (user_id, chain, address, nickname, grp, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, chain, address) DO UPDATE SET nickname = excluded.nickname, grp = excluded.grp`, id, chain, address, c.body?.nickname ? String(c.body.nickname).slice(0, 40) : null, c.body?.group ? String(c.body.group).slice(0, 30) : null, Date.now());
    return { tracked: true }; }, { auth: true, scope: 'watchlist:write' });
  r.add('PATCH', '/api/v1/tracked-wallets/:chain/:address', (c) => { const id = uid(c);
    const res = run(db, `UPDATE tracked_wallets SET muted = COALESCE(?, muted), nickname = COALESCE(?, nickname) WHERE user_id = ? AND chain = ? AND address = ?`, c.body?.muted === undefined ? null : (c.body.muted ? 1 : 0), c.body?.nickname ?? null, id, c.params.chain, c.params.address);
    if (!Number(res.changes)) throw new ApiError('NOT_FOUND', 'Not tracked', 404); return { updated: true }; }, { auth: true, scope: 'watchlist:write' });
  r.add('DELETE', '/api/v1/tracked-wallets/:chain/:address', (c) => ({ removed: Number(run(db, `DELETE FROM tracked_wallets WHERE user_id = ? AND chain = ? AND address = ?`, uid(c), c.params.chain, c.params.address).changes) }), { auth: true, scope: 'watchlist:write' });
  r.add('GET', '/api/v1/alerts', (c) => qa(db, `SELECT id, config, enabled, last_eval, last_fired, created_at FROM alerts WHERE user_id = ? ORDER BY created_at DESC`, uid(c)).map(a => ({ ...a, config: JSON.parse(a.config), events: qa(db, `SELECT detail, at FROM alert_events WHERE alert_id = ? ORDER BY at DESC LIMIT 20`, a.id).map(e => ({ ...JSON.parse(e.detail), at: new Date(e.at).toISOString() })) })), { auth: true });
  r.add('POST', '/api/v1/alerts', (c) => { const id = uid(c); const b = validate(C.alertCreate, c.body);
    if (b.destination !== 'in_app') throw new ApiError('CAPABILITY_BLOCKED', `${b.destination} delivery needs ${b.destination === 'telegram' ? 'a Telegram bot token + chat link' : 'Web Push VAPID keys'}; only in-app delivery is available.`, 409);
    if (['price_swing'].includes(b.kind) && !b.thresholdBps) throw new ApiError('VALIDATION_FAILED', 'thresholdBps required', 400);
    const n = q1(db, `SELECT COUNT(*) n FROM alerts WHERE user_id = ?`, id).n; if (n >= 50) throw new ApiError('BUDGET_EXCEEDED', 'Alert limit (50) reached', 409);
    const aid = newId('alr'); run(db, `INSERT INTO alerts (id, user_id, config, created_at) VALUES (?, ?, ?, ?)`, aid, id, JSON.stringify(b), Date.now()); return { id: aid, config: b, enabled: 1 }; }, { auth: true, scope: 'watchlist:write' });
  r.add('PATCH', '/api/v1/alerts/:id', (c) => { const res = run(db, `UPDATE alerts SET enabled = ? WHERE id = ? AND user_id = ?`, c.body?.enabled ? 1 : 0, c.params.id, uid(c)); if (!Number(res.changes)) throw new ApiError('NOT_FOUND', 'Alert not found', 404); return { id: c.params.id, enabled: !!c.body?.enabled }; }, { auth: true, scope: 'watchlist:write' });
  r.add('DELETE', '/api/v1/alerts/:id', (c) => ({ removed: Number(run(db, `DELETE FROM alerts WHERE id = ? AND user_id = ?`, c.params.id, uid(c)).changes) }), { auth: true, scope: 'watchlist:write' });
  r.add('GET', '/api/v1/notifications', (c) => qa(db, `SELECT id, kind, title, body, destination, delivery, read_at, at FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT 100`, uid(c)), { auth: true });
  r.add('POST', '/api/v1/notifications/read', (c) => ({ updated: Number(run(db, `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, Date.now(), uid(c)).changes) }), { auth: true });

  // ---------------- Skills / AI / API keys ----------------
  r.add('GET', '/api/v1/skills', () => ({ categories: SKILL_CATEGORIES, skills: SKILLS, note: 'No install/download/view counts are shown: JGG has no real analytics for them yet.' }));
  r.add('GET', '/api/v1/skills/:id', (c) => { const s = SKILLS.find(x => x.id === c.params.id); if (!s) throw new ApiError('NOT_FOUND', 'Skill not found', 404); return { ...s, scope: Tools.toolScope(s.toolId) }; });
  r.add('POST', '/api/v1/skills/:id/run', (c) => Tools.runSkill(db, uid(c), c.params.id, c.body?.inputs ?? {}, dn(), c.authKind === 'api_key' ? 'api_key' : 'user', c.scopes), { auth: true });
  r.add('GET', '/api/v1/skill-runs', (c) => qa(db, `SELECT id, skill_id, mode, inputs, status, output, at FROM skill_runs WHERE user_id = ? ORDER BY at DESC LIMIT 50`, uid(c)).map(x => ({ ...x, inputs: JSON.parse(x.inputs), output: JSON.parse(x.output ?? 'null') })), { auth: true });
  r.add('POST', '/api/v1/ai/runs', (c) => Tools.aiRun(db, uid(c), c.body?.prompt, chainOf(c.body?.chain), dn(), c.scopes), { auth: true });
  r.add('GET', '/api/v1/ai/runs', (c) => qa(db, `SELECT id, prompt, planner, status, output, created_at FROM ai_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, uid(c)).map(x => ({ ...x, output: JSON.parse(x.output ?? 'null') })), { auth: true });
  r.add('GET', '/api/v1/api-keys', (c) => qa(db, `SELECT id, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at, request_budget, used FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`, uid(c)).map(k => ({ ...k, scopes: JSON.parse(k.scopes) })), { auth: true });
  r.add('POST', '/api/v1/api-keys', (c) => {
    if (c.authKind !== 'session') throw new ApiError('FORBIDDEN', 'API keys can only be created from an interactive session', 403);
    const scopes: string[] = Array.isArray(c.body?.scopes) ? c.body.scopes : ['market:read'];
    if (scopes.includes('trade:execute')) throw new ApiError('POLICY_DENIED', 'trade:execute keys are disabled until live execution + unattended signing are verified; use trade:propose.', 403);
    return A.createApiKey(db, uid(c), String(c.body?.name ?? 'key').slice(0, 40), scopes, Math.min(Math.max(Number(c.body?.ttlDays ?? 30), 1), 365), Date.now());
  }, { auth: true });
  r.add('DELETE', '/api/v1/api-keys/:id', (c) => ({ revoked: Number(run(db, `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, Date.now(), c.params.id, uid(c)).changes) }), { auth: true });

  // ---------------- Launch / derivatives / up-down / rewards ----------------
  r.add('POST', '/api/v1/launch-intents', (c) => { const b = validate(C.launchCreate, c.body); return Tools.reviewLaunch({ db, userId: uid(c), now: dn(), actor: 'user', scopes: c.scopes, runId: newId('l') }, b); }, { auth: true, scope: 'launch:propose' });
  r.add('GET', '/api/v1/launch-intents', (c) => qa(db, `SELECT id, mode, launchpad, config, state, review, created_at FROM launch_intents WHERE user_id = ? ORDER BY created_at DESC`, uid(c)).map(l => ({ ...l, config: JSON.parse(l.config), review: JSON.parse(l.review ?? 'null') })), { auth: true });
  r.add('POST', '/api/v1/launch-intents/:id/submit', () => { throw new ApiError('CAPABILITY_BLOCKED', 'Launch submission is blocked: no verified launchpad adapter + signer, and launches are not authorized in this build (spec §17).', 409); }, { auth: true });
  r.add('POST', '/api/v1/derivatives/intents', () => { throw new ApiError('CAPABILITY_BLOCKED', 'Perpetuals require a selected, verified derivatives venue (jurisdiction/eligibility checked). None configured; JGG shows no venue prices.', 409); }, { auth: true });
  r.add('GET', '/api/v1/up-down', () => ({ status: 'blocked_external', reason: 'Up/Down product mechanics, settlement source and eligibility are unverified (only a nav label exists in the references). JGG will not invent a prediction/betting product.' }));
  r.add('GET', '/api/v1/rewards', (c) => {
    const id = uid(c); const u = q1(db, `SELECT referral_code FROM users WHERE id = ?`, id);
    const refs = q1(db, `SELECT COUNT(*) n FROM users WHERE referred_by = ?`, u.referral_code).n;
    const sum = (st: string) => q1(db, `SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM commission_entries WHERE beneficiary = ? AND state = ?`, id, st).s;
    return { referralCode: u.referral_code, inviteLink: `${cfg.origin}/?ref=${u.referral_code}`, referredUsers: refs, jggFeeBps: JGG_FEE_BPS,
      balances: { pending: String(sum('pending')), available: String(sum('available')), paid: String(sum('paid')) },
      terms: 'Commissions accrue only from actually collected JGG trading fees on live trades. JGG currently charges 0 bps and paper/demo trades never accrue, so all balances are 0. No earnings are promised.', payouts: [], payoutStatus: 'blocked_external: payouts require a configured treasury and are not authorized in this build.' };
  }, { auth: true });

  return r;
}

function tokenTrades(chain: C.Chain, address: string, now: number) {
  const names = new Map(fixtureWallets(chain).map(w => [w.address, w]));
  return fixtureTrades(chain, now - 3 * 3_600_000, now).filter(x => x.token === address).slice(-100).reverse()
    .map(x => ({ ...x, walletName: names.get(x.wallet)?.name ?? null, labels: names.get(x.wallet)?.labels ?? [], explorer: C.CHAIN_META[chain].explorerTx + x.txRef }));
}
