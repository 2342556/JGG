// Shared tool registry: Skills Market (C01–C66), AI planner and public API use the SAME tools (spec §5, §9).
// Every tool validates arguments server-side and declares a scope. Trade/launch tools never execute
// from AI: they create proposals (intents awaiting explicit user approval) — T38/T39/T40.
import { type DB, q1, qa, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import * as D from '../../../packages/domain/src/index.ts';
import * as M from '../../../packages/providers/src/market.ts';
import { SKILLS, type Skill, type InputField } from '../../../packages/catalog/src/index.ts';
import { CHAINS, CHAIN_META, isValidAddress, type Chain } from '../../../packages/contracts/src/index.ts';
import { fixtureTokens, fixtureWallets, findFixtureToken, priceAt, num, FIXTURE_SOURCE, LAUNCHPADS } from '../../../packages/test-fixtures/src/index.ts';
import { getMode, tradingModeOrThrow, createQuote, createIntent, cancelOrder, audit } from './trading.ts';
import { getMarketSource } from '../../../packages/providers/src/execution.ts';
import { createStrategy, listStrategies } from './strategies.ts';

export type ToolCtx = { db: DB; userId: string; now: number; actor: 'user' | 'ai' | 'api_key'; scopes: Set<string> | null; runId: string };
type Tool = { scope: string; kind: 'read' | 'proposal' | 'strategy' | 'launch'; run: (c: ToolCtx, a: Record<string, any>) => unknown };

const WINMS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000 };
const need = <T>(v: T | null | undefined, what: string): T => { if (v === null || v === undefined) throw new ApiError('NOT_FOUND', `${what} not found`, 404); return v; };
const filt = (a: any): M.MarketFilter => ({ minLiquidityUsd: a.minLiquidityUsd, minMarketCapUsd: a.minMarketCapUsd, maxMarketCapUsd: a.maxMarketCapUsd, minSmartMoney: a.minSmartMoney, maxTop10Bps: a.maxTop10Bps, minVolumeUsd: a.minVolumeUsd, launchpad: a.launchpad });
const top = (rows: any[], n = 20) => rows.slice(0, n);
const paperWallet = (c: ToolCtx, chain: string, walletId?: string) => {
  const w = walletId ? q1(c.db, `SELECT * FROM wallets WHERE id = ? AND user_id = ?`, walletId, c.userId) : q1(c.db, `SELECT * FROM wallets WHERE user_id = ? AND chain = ? AND custody = 'paper' ORDER BY label LIMIT 1`, c.userId, chain);
  return need(w, 'Paper wallet');
};

/** Trade proposal = real quote + intent in awaiting_approval with reservation. Execution requires a separate approval by the user. */
function propose(c: ToolCtx, a: { chain: Chain; address: string; side: 'buy' | 'sell'; amount: string; slippageBps?: number; walletId?: string }) {
  const { mode } = getMode(c.db, c.userId); tradingModeOrThrow(mode);
  const w = paperWallet(c, a.chain, a.walletId);
  const dd = M.tokenDetail(a.chain, a.address, c.now)?.dd ?? null;
  const q = createQuote(c.db, c.userId, { chain: a.chain, tokenAddress: a.address, side: a.side, amount: a.amount, slippageBps: a.slippageBps ?? 300, walletId: w.id }, c.now);
  const intent = createIntent(c.db, c.userId, { quoteId: q.id, source: c.actor === 'ai' ? 'ai_proposal' : 'manual' }, c.now, `tool:${c.runId}:${a.side}:${a.address}:${a.amount}`.slice(0, 128));
  return { proposal: true, requiresApproval: true, intentId: intent.id, state: intent.state, quote: q, dueDiligence: dd, note: 'Nothing was executed. Review and approve in the trade panel.' };
}

const TOOLS: Record<string, Tool> = {
  'market.trending': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trending(a.chain, c.now, a.window ?? '1h', 'trending', filt(a)).rows, a.limit) },
  'market.hotlist': { scope: 'market:read', kind: 'read', run: (c, a) => top(CHAINS.flatMap(ch => M.trending(ch, c.now, '1h', 'trending', { ...filt(a), unknownPolicy: 'exclude' }).rows.slice(0, 10)).sort((x: any, y: any) => y.jggRank.score - x.jggRank.score), a.limit) },
  'market.launchpadTrending': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trending(a.chain, c.now, a.window ?? '1h', 'trending', { ...filt(a), launchpad: 'pumpfun' }).rows, a.limit) },
  'market.newTokens': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trenches(a.chain, c.now, 'new', filt(a)).rows, a.limit) },
  'market.hotSearch': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trending(a.chain, c.now, a.window ?? '5m', 'hot_searches').rows, a.limit).map((r: any) => ({ ...r, hotSearchesBasis: 'fixture search counter (JGG has no search telemetry yet)' })) },
  'market.kolBought': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trenches(a.chain, c.now, 'new').rows.filter((r: any) => r.kols >= (a.minKols ?? 1)), a.limit) },
  'market.migrated': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trenches(a.chain, c.now, 'migrated', filt(a)).rows, a.limit) },
  'market.migratedScreen': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trenches(a.chain, c.now, 'migrated', { minMarketCapUsd: a.minMarketCapUsd ?? '50000', maxMarketCapUsd: a.maxMarketCapUsd ?? '200000', minLiquidityUsd: a.minLiquidityUsd ?? '10000', maxTop10Bps: a.maxTop10Bps ?? 3000 }).rows, 20) },
  'market.nearCompletion': { scope: 'market:read', kind: 'read', run: (c, a) => top(M.trenches(a.chain, c.now, 'near_completion', filt(a)).rows.filter((r: any) => (r.progressBps ?? 0) >= (a.minProgressBps ?? 0)), a.limit) },
  'token.info': { scope: 'market:read', kind: 'read', run: (c, a) => need(M.tokenDetail(a.chain, a.address, c.now), 'Token') },
  'token.dd': { scope: 'market:read', kind: 'read', run: (c, a) => { const t = need(M.tokenDetail(a.chain, a.address, c.now), 'Token'); return { token: a.address, symbol: t.symbol, ...t.dd }; } },
  'token.security': { scope: 'market:read', kind: 'read', run: (c, a) => { const t = need(M.tokenDetail(a.chain, a.address, c.now), 'Token'); return { security: t.security, taxBps: t.taxBps, note: 'unknown ≠ safe' }; } },
  'token.kline': { scope: 'market:read', kind: 'read', run: (c, a) => need(M.candles(a.chain, a.address, a.interval ?? '5m', a.count ?? 200, c.now), 'Token') },
  'token.pools': { scope: 'market:read', kind: 'read', run: (c, a) => { const t = need(M.tokenDetail(a.chain, a.address, c.now), 'Token'); return { pools: t.pools, supplyRaw: t.supplyRaw, decimals: t.decimals }; } },
  'token.holders': { scope: 'market:read', kind: 'read', run: (c, a) => need(M.holders(a.chain, a.address, c.now, a.limit ?? 100), 'Token') },
  'token.labeledHolders': { scope: 'market:read', kind: 'read', run: (c, a) => { const h = need(M.holders(a.chain, a.address, c.now, 100), 'Token'); return { ...h, rows: h.rows.filter(r => r.label === (a.label ?? 'smart_money')) }; } },
  'token.traders': { scope: 'market:read', kind: 'read', run: (c, a) => M.traders(a.chain, a.address, c.now, a.sortBy) },
  'token.pattern': { scope: 'market:read', kind: 'read', run: (c, a) => patternRead(need(M.candles(a.chain, a.address, a.interval ?? '5m', 60, c.now), 'Token') as any) },
  'dev.info': { scope: 'market:read', kind: 'read', run: (c, a) => { const t = need(findFixtureToken(a.chain, a.address), 'Token'); return devProfile(a.chain, t.creator, c.now); } },
  'dev.tokens': { scope: 'market:read', kind: 'read', run: (c, a) => devProfile(a.chain, a.creator, c.now).tokens },
  'dev.score': { scope: 'market:read', kind: 'read', run: (c, a) => { const p = devProfile(a.chain, a.creator, c.now); return { creator: a.creator, conduct: p.conduct, power: p.power, basis: p.basis }; } },
  'wallet.analysis': { scope: 'wallet:read', kind: 'read', run: (c, a) => walletGates(M.walletDetail(a.chain, a.wallet, c.now, a.window ?? '7d')) },
  'wallet.pnl': { scope: 'wallet:read', kind: 'read', run: (c, a) => { const d = M.walletDetail(a.chain, a.wallet, c.now, a.window ?? '7d'); return { realizedPnlUsd: d.realizedPnlUsd, winRate: d.winRate, winRateDenominator: d.winRateDenominator, trades: d.trades, volumeUsd: d.volumeUsd, coverage: d.coverage }; } },
  'wallet.holdings': { scope: 'wallet:read', kind: 'read', run: (c, a) => M.walletDetail(a.chain, a.wallet, c.now, '30d').holdings },
  'wallet.history': { scope: 'wallet:read', kind: 'read', run: (c, a) => M.walletDetail(a.chain, a.wallet, c.now, '7d').history.filter((x: any) => !a.type || a.type === 'all' || x.side === a.type).slice(0, a.limit ?? 50) },
  'wallet.tokenBalance': { scope: 'wallet:read', kind: 'read', run: (c, a) => M.walletDetail(a.chain, a.wallet, c.now, '30d').holdings.find((h: any) => h.token === a.address) ?? { token: a.address, qty: '0', note: 'No fixture balance' } },
  'wallet.copyAssessment': { scope: 'wallet:read', kind: 'read', run: (c, a) => { const g = walletGates(M.walletDetail(a.chain, a.wallet, c.now, '30d')); return { ...g, copyable: g.gates.every((x: any) => x.result === 'pass') ? 'candidate' : 'not_recommended' }; } },
  'wallet.score': { scope: 'wallet:read', kind: 'read', run: (c, a) => M.walletDetail(a.chain, a.wallet, c.now, '30d').score },
  'signals.walletTrades': { scope: 'signals:read', kind: 'read', run: (c, a) => top(M.signals(a.chain, c.now, 'wallet_trades', { side: a.side, tracked: new Set(qa(c.db, `SELECT address FROM tracked_wallets WHERE user_id = ? AND chain = ? AND muted = 0`, c.userId, a.chain).map(r => r.address)) }), a.limit ?? 50) },
  'signals.labelTrades': { scope: 'signals:read', kind: 'read', run: (c, a) => top(M.signals(a.chain, c.now, 'label_trades', { label: a.label ?? 'smart_money', side: a.side }), a.limit ?? 50) },
  'signals.callouts': { scope: 'signals:read', kind: 'read', run: (c, a) => top(M.signals(a.chain, c.now, 'callouts'), a.limit ?? 15) },
  'signals.claims': { scope: 'signals:read', kind: 'read', run: (c, a) => top(M.signals(a.chain, c.now, 'claims'), a.limit ?? 12) },
  'signals.cluster': { scope: 'signals:read', kind: 'read', run: (c, a) => M.signals(a.chain, c.now, 'cluster', { side: a.side, minWallets: a.minWallets ?? 3, windowMs: WINMS[a.window ?? '1h'] }) },
  'signals.surge': { scope: 'signals:read', kind: 'read', run: (c, a) => M.signals(a.chain, c.now, 'surge', { minChangeBps: a.minChangeBps ?? 2000 }) },
  'signals.surgeScreen': { scope: 'signals:read', kind: 'read', run: (c, a) => (M.signals(a.chain, c.now, 'surge', { minChangeBps: a.minChangeBps ?? 2000 }) as any[]).map(s => { const t = M.tokenDetail(a.chain, s.token, c.now)!; return { ...s, dd: { verdict: t.dd.verdict, score: t.dd.score, coverageBps: t.dd.coverageBps }, liqUsd: t.liqUsd, top10Bps: t.top10Bps }; }).filter(s => s.dd.verdict !== 'fail') },
  'watchlist.query': { scope: 'market:read', kind: 'read', run: (c, a) => watchlistRows(c, a.group) },
  'watchlist.swings': { scope: 'market:read', kind: 'read', run: (c, a) => watchlistRows(c).filter((r: any) => Math.abs(r.change?.[a.window ?? '1h'] ?? 0) >= (a.thresholdBps ?? 1000)) },
  'chain.fees': { scope: 'market:read', kind: 'read', run: (_c, a) => M.gasFees(a.chain) },
  'orders.open': { scope: 'wallet:read', kind: 'read', run: (c, a) => ({ strategies: listStrategies(c.db, c.userId).filter(s => ['active', 'paused'].includes(s.lifecycle) && (!a.chain || s.chain === a.chain)),
    uncertainOrders: qa(c.db, `SELECT id, state, token, side FROM orders WHERE user_id = ? AND state = 'reconciliation_required'`, c.userId) }) },
  'launch.stats': { scope: 'market:read', kind: 'read', run: (c, a) => { const from = c.now - (WINMS[a.window ?? '24h'] ?? 86_400_000); const out: Record<string, number> = {};
    for (const lp of LAUNCHPADS[a.chain as Chain]) out[lp] = fixtureTokens(a.chain, c.now).filter(t => t.launchpad === lp && t.createdAt > from && t.createdAt <= c.now).length;
    return { chain: a.chain, window: a.window ?? '24h', createdCounts: out, basis: 'Fixture tokens created in window (not JGG-attributed launches; JGG has launched none).' }; } },
  'social.query': { scope: 'market:read', kind: 'read', run: () => { throw new ApiError('CAPABILITY_BLOCKED', 'X/Twitter data needs an authorized X API or 6551 OpenTwitter provider + credentials. Not configured; JGG will not fabricate posts.', 409); } },
  'social.following': { scope: 'market:read', kind: 'read', run: () => { throw new ApiError('CAPABILITY_BLOCKED', 'Following feed needs the user\'s authorized X account (OAuth) via the official X API. Not configured.', 409); } },
  'news.query': { scope: 'market:read', kind: 'read', run: () => { throw new ApiError('CAPABILITY_BLOCKED', 'News needs a licensed news provider (e.g. 6551 OpenNews) + credentials. Not configured; JGG will not fabricate headlines.', 409); } },
  // ---- proposals (never execute directly) ----
  'trade.marketBuy': { scope: 'trade:propose', kind: 'proposal', run: (c, a) => propose(c, { chain: a.chain, address: a.address, side: 'buy', amount: a.amount, slippageBps: a.slippageBps }) },
  'trade.marketSell': { scope: 'trade:propose', kind: 'proposal', run: (c, a) => {
    const w = paperWallet(c, a.chain); const b = q1(c.db, `SELECT qty, reserved FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w.id, a.address);
    const avail = b ? D.sub(b.qty, b.reserved) : D.dec('0'); if (!D.gt(avail, '0')) throw new ApiError('INSUFFICIENT_BALANCE', 'No position in this token in your first paper wallet', 409);
    const t = need(findFixtureToken(a.chain, a.address), 'Token');
    const qty = D.str(D.rescale(D.div(D.mul(avail, a.percentBps ?? 10000), '10000', 18), t.decimals, 'floor'));
    return propose(c, { chain: a.chain, address: a.address, side: 'sell', amount: qty, slippageBps: a.slippageBps, walletId: w.id }); } },
  'trade.buyByName': { scope: 'trade:propose', kind: 'proposal', run: (c, a) => {
    const cands = M.search(a.query, c.now, a.chain).filter(x => x.type === 'token' && x.chain === a.chain);
    if (!cands.length) throw new ApiError('NOT_FOUND', 'No token matches that name on this chain', 404);
    const exact = cands.find(x => x.exact);
    const scored = cands.map(x => { const d = M.tokenDetail(a.chain, x.address, c.now)!; return { address: x.address, symbol: x.symbol, name: x.name, mcUsd: x.mcUsd, ageSec: x.ageSec, liqUsd: d.liqUsd, holders: d.holders, dd: d.dd.verdict }; });
    if (!exact && cands.length > 1) return { proposal: false, ambiguous: true, candidates: scored, note: 'Several tokens share this name (possible copycats). Choose the exact contract address; JGG will not guess.' };
    return { resolvedBy: exact ? 'exact_address' : 'unique_name', candidates: scored, ...propose(c, { chain: a.chain, address: (exact ?? cands[0]).address, side: 'buy', amount: a.amount, slippageBps: a.slippageBps }) }; } },
  'trade.multiWalletBuy': { scope: 'trade:propose', kind: 'proposal', run: (c, a) => {
    const ids: string[] = String(a.wallets ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const wallets = ids.length ? ids : qa(c.db, `SELECT id FROM wallets WHERE user_id = ? AND chain = ? AND custody = 'paper'`, c.userId, a.chain).map(r => r.id);
    const children = wallets.map(w => ({ walletId: w, amount: a.amountEach }));
    try { D.validateBatch(children); } catch (e) { throw new ApiError('VALIDATION_FAILED', (e as Error).message, 400); }
    const results = children.map(ch => { try { return { walletId: ch.walletId, status: 'proposed', ...propose(c, { chain: a.chain, address: a.address, side: 'buy', amount: ch.amount, walletId: ch.walletId }) }; } catch (e) { return { walletId: ch.walletId, status: 'failed', error: (e as ApiError).code, message: (e as Error).message }; } });
    return { atomic: false, note: 'Independent child transactions: partial success is possible.', summary: { proposed: results.filter(r => r.status === 'proposed').length, failed: results.filter(r => r.status === 'failed').length }, children: results }; } },
  'orders.cancel': { scope: 'strategy:manage', kind: 'strategy', run: (c, a) => cancelOrder(c.db, c.userId, a.orderId, c.now) },
  ...Object.fromEntries(([['strategy.limitBuy', 'limit_buy'], ['strategy.limitBuyTpSl', 'limit_buy_tp_sl'], ['strategy.limitSell', 'limit_sell'], ['strategy.buyTpSl', 'buy_tp_sl'], ['strategy.trailingTp', 'trailing_tp'], ['strategy.trailingSl', 'trailing_sl']] as const)
    .map(([tid, kind]) => [tid, { scope: 'strategy:manage', kind: 'strategy', run: (c: ToolCtx, a: any) => strategyTool(c, kind, a) } satisfies Tool])),
  'launch.create': { scope: 'launch:propose', kind: 'launch', run: (c, a) => reviewLaunch(c, a) },
};

function strategyTool(c: ToolCtx, kind: string, a: any) {
  const params: any = { targetPrice: a.targetPrice, amount: a.amount, expiresInSec: a.expiresInSec, activation: a.activation, retracement: a.retracement };
  if (a.takeProfit) params.stages = [{ percentBps: 10000, gain: a.takeProfit }];
  if (a.stopLoss) params.stopLoss = a.stopLoss;
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  const w = paperWallet(c, a.chain);
  if (c.actor === 'ai') return { proposal: true, draftStrategy: { kind, chain: a.chain, tokenAddress: a.address, walletId: w.id, params }, note: 'AI drafts automation only; enable it yourself on the Strategies panel.' };
  const activate = c.actor === 'user'; // API keys / CLI / MCP create DRAFTS; activation needs the owner in an interactive session (same rule as the HTTP route)
  if (kind === 'buy_tp_sl') { // buy now (proposal) + exits activate from the actual fill: modelled as limit_buy_tp_sl at current price
    const px = priceAt(need(findFixtureToken(a.chain, a.address), 'Token'), c.now); if (px === null) throw new ApiError('STALE_DATA', 'No current price', 409);
    return createStrategy(c.db, c.userId, { kind: 'limit_buy_tp_sl', chain: a.chain, tokenAddress: a.address, walletId: w.id, params: { ...params, targetPrice: num(px * 1.02) } }, c.now, undefined, activate);
  }
  if (kind === 'limit_sell' && a.percentBps) { const b = q1(c.db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w.id, a.address); if (b) params.amount = D.str(D.div(D.mul(b.qty, a.percentBps), '10000', 9, 'floor')); }
  return createStrategy(c.db, c.userId, { kind, chain: a.chain, tokenAddress: a.address, walletId: w.id, params }, c.now, undefined, activate);
}

// ---------------- Launch intents: validate + review only; submission is blocked (spec §13) ----------------
const LAUNCH_CHAIN: Record<string, Chain> = { pumpfun: 'solana', pumpfun_special: 'solana', fourmeme: 'bsc', fourmeme_tax: 'bsc', flap_tax: 'bsc', clanker: 'base' };
export function reviewLaunch(c: ToolCtx, a: any) {
  const chain = LAUNCH_CHAIN[a.launchpad]; if (!chain) throw new ApiError('VALIDATION_FAILED', 'Unsupported launchpad', 400);
  const issues: string[] = [];
  if (!a.name || String(a.name).length > 32) issues.push('name: 1–32 characters');
  if (!a.symbol || !/^[A-Za-z0-9]{1,10}$/.test(a.symbol)) issues.push('symbol: 1–10 alphanumeric');
  if (a.launchpad.endsWith('_tax') && (a.buyTaxBps === undefined || a.sellTaxBps === undefined)) issues.push('tax launch requires buyTaxBps and sellTaxBps');
  const { mode } = getMode(c.db, c.userId);
  const id = newId('lch');
  const review = { chain, launchpad: a.launchpad, issues, irreversible: ['Token contract/mint is permanent once created', 'Initial buy spends real funds', 'Metadata may be immutable'],
    submission: 'blocked_external', blocker: 'No verified launchpad adapter/SDK + signer configured, and launches are not authorized in this build. Review only.' };
  run(c.db, `INSERT INTO launch_intents (id, user_id, mode, launchpad, config, state, review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, c.userId, mode, a.launchpad, JSON.stringify(a), issues.length ? 'draft' : 'reviewed', JSON.stringify(review), c.now);
  audit(c.db, c.userId, c.actor, 'launch.review', { id });
  return { launchIntentId: id, state: issues.length ? 'draft' : 'reviewed', review };
}

// ---------------- Derived analytics helpers ----------------
function patternRead(k: { rows: any[] }) {
  const rows = k.rows.filter((r: any) => !r.gap);
  if (rows.length < 12) return { pattern: 'insufficient_data', score: null, candles: rows.length };
  const closes = rows.map((r: any) => Number(r.c)); const n = closes.length;
  const first = closes.slice(0, Math.floor(n / 3)).reduce((a, b) => a + b, 0) / Math.floor(n / 3); const last = closes.slice(-Math.floor(n / 3)).reduce((a, b) => a + b, 0) / Math.floor(n / 3);
  const hi = Math.max(...closes), lo = Math.min(...closes), cur = closes[n - 1]; const pos = (cur - lo) / ((hi - lo) || 1); const trend = (last - first) / first;
  const pattern = trend > 0.15 && pos > 0.7 ? 'uptrend_channel' : trend < -0.15 && pos < 0.3 ? 'breakdown' : trend < -0.05 && pos > 0.4 ? 'bounce_off_lows' : trend > 0.05 && pos < 0.5 ? 'distribution_at_highs' : 'basing';
  return { pattern, score: Math.round(50 + Math.max(-50, Math.min(50, trend * 100))), basis: { trendPct: +(trend * 100).toFixed(2), positionInRange: +pos.toFixed(2), candles: n }, method: 'jgg-pattern-v1 deterministic rules (not a prediction)' };
}
function devProfile(chain: Chain, creator: string, now: number) {
  const toks = fixtureTokens(chain, now).filter(t => t.creator === creator && t.createdAt <= now);
  const tokens = toks.map(t => { const r = M.tokenRow(t, now); return { address: t.address, symbol: t.symbol, lifecycle: t.lifecycle, mcUsd: r.mcUsd, athMcUsd: r.athMcUsd, devHoldingBps: t.devHoldingBps, createdAt: new Date(t.createdAt).toISOString() }; });
  const migrated = toks.filter(t => t.lifecycle === 'migrated').length;
  const held = toks.filter(t => (t.devHoldingBps ?? 0) > 0).length;
  if (!toks.length) return { creator, tokens, conduct: null, power: null, basis: 'No tokens by this creator in coverage' };
  return { creator, tokens, conduct: Math.round(100 * held / toks.length), power: Math.min(100, migrated * 35 + toks.length * 5), basis: `${toks.length} tokens, ${migrated} migrated, ${held} still dev-held (jgg-dev-v1 fixture rubric)` };
}
function walletGates(d: ReturnType<typeof M.walletDetail>) {
  const gates = [
    { gate: 'real_record', result: d.winRateDenominator >= 10 ? 'pass' : d.winRateDenominator === 0 ? 'insufficient_data' : 'fail', basis: `${d.winRateDenominator} closed episodes` },
    { gate: 'edge_still_working', result: d.winRate === null ? 'insufficient_data' : Number(d.winRate) >= 50 && Number(d.realizedPnlUsd) > 0 ? 'pass' : 'fail', basis: `win ${d.winRate ?? '—'}%, realized $${d.realizedPnlUsd}` },
    { gate: 'can_you_get_filled', result: Number(d.volumeUsd) / Math.max(1, d.trades) < 20000 ? 'pass' : 'fail', basis: 'median trade size vs fixture liquidity' },
    { gate: 'cuts_losers', result: d.unknownBasisSells > d.sells / 2 ? 'insufficient_data' : 'pass', basis: `${d.unknownBasisSells} unknown-basis sells` },
  ];
  return { wallet: d.address, name: d.name, labels: d.labels, gates, coverage: d.coverage };
}
function watchlistRows(c: ToolCtx, group?: string) {
  const items = qa(c.db, `SELECT i.chain, i.address, w.name FROM watchlist_items i JOIN watchlists w ON w.id = i.watchlist_id WHERE w.user_id = ? ${group ? 'AND w.name = ?' : ''}`, c.userId, ...(group ? [group] : []));
  return items.map(i => { const t = findFixtureToken(i.chain, i.address); return t ? { group: i.name, ...M.tokenRow(t, c.now) } : { group: i.name, chain: i.chain, address: i.address, status: 'unknown' }; });
}

// ---------------- Skill runner ----------------
function coerce(f: InputField, raw: unknown, chain: string | undefined): unknown {
  if (raw === undefined || raw === null || raw === '') { if (f.required && f.default === undefined) throw new Error(`${f.name} is required`); return f.default; }
  switch (f.type) {
    case 'chain': if (!CHAINS.includes(raw as Chain)) throw new Error(`${f.name}: unsupported chain`); return raw;
    case 'address': case 'wallet': { const s = String(raw).trim(); if (chain && !isValidAddress(chain as Chain, s)) throw new Error(`${f.name}: not a valid ${chain} address`); return s; }
    case 'decimal': { const s = String(raw).trim(); if (!/^\d{1,20}(\.\d{1,18})?$/.test(s)) throw new Error(`${f.name}: must be a non-negative decimal`); return s; }
    case 'int': { const n = Number(raw); if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) throw new Error(`${f.name}: integer ${f.min ?? ''}..${f.max ?? ''}`); return n; }
    case 'enum': if (!f.options!.includes(String(raw))) throw new Error(`${f.name}: one of ${f.options!.join(', ')}`); return String(raw);
    case 'bool': return raw === true || raw === 'true';
    default: { const s = String(raw); if (s.length > 500) throw new Error(`${f.name}: too long`); return s; }
  }
}

export function validateSkillInputs(skill: Skill, inputs: Record<string, unknown>) {
  const out: Record<string, any> = {}; const issues: { path: string; message: string }[] = [];
  const known = new Set(skill.inputs.map(i => i.name));
  for (const k of Object.keys(inputs ?? {})) if (!known.has(k)) issues.push({ path: k, message: 'unknown input' });
  const chain = (inputs?.chain as string) ?? skill.inputs.find(i => i.name === 'chain')?.default as string | undefined;
  for (const f of skill.inputs) { try { const v = coerce(f, inputs?.[f.name], chain); if (v !== undefined) out[f.name] = v; } catch (e) { issues.push({ path: f.name, message: (e as Error).message }); } }
  if (out.chain && !skill.supportedChains.includes(out.chain)) issues.push({ path: 'chain', message: `${skill.id} supports ${skill.supportedChains.join(', ')}` });
  if (issues.length) throw new ApiError('VALIDATION_FAILED', 'Invalid skill inputs', 400, false, issues);
  return out;
}

export function runTool(c: ToolCtx, toolId: string, args: Record<string, any>) {
  const tool = TOOLS[toolId]; if (!tool) throw new ApiError('CAPABILITY_BLOCKED', `Tool ${toolId} is not implemented`, 409);
  if (c.scopes && !c.scopes.has(tool.scope)) throw new ApiError('FORBIDDEN', `Missing scope ${tool.scope}`, 403);
  const LIVE_OK = new Set(['trade.marketBuy', 'trade.marketSell', 'orders.open', 'orders.cancel', 'strategy.limitBuy', 'strategy.limitBuyTpSl', 'strategy.limitSell', 'strategy.buyTpSl', 'strategy.trailingTp', 'strategy.trailingSl']);
  if (getMarketSource()?.kind === 'solana_live' && !LIVE_OK.has(toolId)) throw new ApiError('PROVIDER_UNAVAILABLE', `${toolId} still runs on simulated data and is disabled while JGG uses live data (standalone v1 covers Solana pump.fun quotes, finder and exits).`, 503);
  const { mode } = getMode(c.db, c.userId);
  if (mode === 'live_readonly' || mode === 'live') {
    if (tool.kind !== 'read') tradingModeOrThrow(mode);
    throw new ApiError('PROVIDER_UNAVAILABLE', `${MODE_NOTE[mode]} No verified live market-data provider is configured, so JGG shows no data rather than fixtures in this mode.`, 503);
  }
  return tool.run(c, args);
}
const MODE_NOTE: Record<string, string> = { live_readonly: 'Live read-only mode.', live: 'Live mode.' };

export function runSkill(db: DB, userId: string, skillId: string, inputs: Record<string, unknown>, now: number, actor: ToolCtx['actor'], scopes: Set<string> | null) {
  const skill = SKILLS.find(s => s.id === skillId); if (!skill) throw new ApiError('NOT_FOUND', 'Skill not found', 404);
  const args = validateSkillInputs(skill, inputs);
  const { mode } = getMode(db, userId);
  const id = newId('skr');
  const c: ToolCtx = { db, userId, now, actor, scopes, runId: id };
  let status = 'succeeded'; let output: unknown; let error: any = null;
  try { output = runTool(c, skill.toolId, args); }
  catch (e) { status = e instanceof ApiError && e.code === 'CAPABILITY_BLOCKED' ? 'blocked' : 'failed'; error = e instanceof ApiError ? { code: e.code, message: e.message, details: e.details } : { code: 'INTERNAL', message: 'Tool failed' }; }
  run(db, `INSERT INTO skill_runs (id, user_id, skill_id, mode, inputs, status, output, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, userId, skillId, mode, JSON.stringify(args), status, JSON.stringify(error ?? summarize(output)), now);
  return { runId: id, skillId, toolId: skill.toolId, mode, status, inputs: args, data: output ?? null, error, meta: M.meta(now, { source: FIXTURE_SOURCE }) };
}
const summarize = (o: unknown) => Array.isArray(o) ? { rows: o.length } : o && typeof o === 'object' ? { keys: Object.keys(o).slice(0, 10) } : o;

// ---------------- AI planner (rule-based; no LLM key configured) ----------------
export const PLANNER = { id: 'jgg-rule-planner-v1', llm: false, note: 'No LLM provider configured. Deterministic keyword planner; every sentence below is generated from tool results.' };
const AI_SCOPES = new Set(['market:read', 'wallet:read', 'signals:read', 'trade:propose', 'strategy:manage']);

export function aiRun(db: DB, userId: string, prompt: string, chain: Chain, now: number, userScopes: Set<string> | null) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new ApiError('VALIDATION_FAILED', 'Prompt must be 1–2000 characters', 400);
  const id = newId('air');
  run(db, `INSERT INTO ai_runs (id, user_id, prompt, planner, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`, id, userId, prompt, PLANNER.id, now);
  // AI can never exceed the caller's scopes, and never holds trade:execute / launch:execute.
  const scopes = new Set([...AI_SCOPES].filter(s => !userScopes || userScopes.has(s)));
  const c: ToolCtx = { db, userId, now, actor: 'ai', scopes, runId: id };
  const text = prompt.toLowerCase();
  const addr = prompt.match(/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
  const amount = prompt.match(/(\d+(?:\.\d+)?)\s*(sol|bnb|eth)\b/i)?.[1];
  const plan: { tool: string; args: any; why: string }[] = [];
  const addrChain: Chain = addr?.startsWith('0x') ? (CHAINS.find(ch => ch !== 'solana' && findFixtureToken(ch, addr!)) ?? 'base') : chain;
  const isWallet = addr && fixtureWallets(addrChain).some(w => w.address === addr);
  if (/\b(buy|ape)\b/.test(text) && (addr || amount)) {
    const name = prompt.match(/buy\s+(?:\d+(?:\.\d+)?\s*\w+\s+(?:of\s+)?)?\$?([A-Za-z0-9]{2,12})/i)?.[1];
    if (addr && !isWallet) plan.push({ tool: 'token.dd', args: { chain: addrChain, address: addr }, why: 'Check token risk before proposing a trade' }, { tool: 'trade.marketBuy', args: { chain: addrChain, address: addr, amount: amount ?? '0.1', slippageBps: 300 }, why: 'Create a buy proposal (requires your approval)' });
    else if (name) plan.push({ tool: 'trade.buyByName', args: { chain, query: name, amount: amount ?? '0.1', slippageBps: 300 }, why: 'Resolve the exact contract (copycat check) and create a proposal' });
  } else if (addr && isWallet) plan.push({ tool: 'wallet.analysis', args: { chain: addrChain, wallet: addr, window: '7d' }, why: 'Four-gate wallet analysis' }, { tool: 'wallet.score', args: { chain: addrChain, wallet: addr }, why: 'Wallet score' });
  else if (addr) plan.push({ tool: 'token.info', args: { chain: addrChain, address: addr }, why: 'Token overview' }, { tool: 'token.dd', args: { chain: addrChain, address: addr }, why: 'Due-diligence score' });
  if (/trend|hot|top token/.test(text)) plan.push({ tool: 'market.trending', args: { chain, window: /5m|5 min/.test(text) ? '5m' : '1h', limit: 5 }, why: 'Ranked trending tokens' });
  if (/smart money|cluster/.test(text)) plan.push({ tool: 'signals.cluster', args: { chain, side: /exit|sell|dump/.test(text) ? 'sell' : 'buy', minWallets: 2, window: '1h' }, why: 'Smart-money cluster signal' });
  if (/new|fresh|launch(ed)? token/.test(text) && !plan.length) plan.push({ tool: 'market.newTokens', args: { chain, limit: 5 }, why: 'Newly created tokens' });
  if (/surge|pump|spike/.test(text)) plan.push({ tool: 'signals.surge', args: { chain, minChangeBps: 1000 }, why: 'Price surge signal' });
  if (/gas|fee/.test(text)) plan.push({ tool: 'chain.fees', args: { chain }, why: 'Current fee tiers' });
  if (/news|tweet|twitter|\bx\b/.test(text)) plan.push({ tool: 'news.query', args: { topic: prompt.slice(0, 60) }, why: 'News/social lookup' });
  if (/launch|deploy|create (a )?token/.test(text) && !plan.some(p => p.tool === 'market.newTokens')) plan.push({ tool: 'launch.create', args: {}, why: 'Launches are never run by AI' });

  const steps: any[] = [];
  for (const p of plan.slice(0, 5)) {
    const tcId = newId('tc');
    let status = 'succeeded'; let result: any; let err: any = null;
    try {
      if (p.tool === 'launch.create') throw new ApiError('FORBIDDEN', 'AI cannot create launches; use the Cooking panel and review every irreversible field yourself.', 403);
      result = runTool(c, p.tool, p.args);
    } catch (e) { status = e instanceof ApiError && (e.code === 'FORBIDDEN' || e.code === 'CAPABILITY_BLOCKED') ? 'denied' : 'failed'; err = { code: (e as ApiError).code ?? 'INTERNAL', message: (e as Error).message }; }
    run(db, `INSERT INTO ai_tool_calls (id, run_id, tool, scope, args, status, result_summary, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, tcId, id, p.tool, TOOLS[p.tool]?.scope ?? '-', JSON.stringify(p.args), status, JSON.stringify(err ?? summarize(result)), now);
    steps.push({ id: tcId, tool: p.tool, why: p.why, args: p.args, status, error: err, result });
  }
  const answer = compose(steps);
  run(db, `UPDATE ai_runs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?`, JSON.stringify({ answer, steps: steps.map(s => ({ tool: s.tool, status: s.status })) }), now, id);
  return { runId: id, planner: PLANNER, prompt, steps, answer, untrustedContentNote: 'Token names/metadata are third-party data and are shown as data, never followed as instructions.' };
}

/** Grounded summary: only states facts present in tool results. */
function compose(steps: any[]): string[] {
  if (!steps.length) return ['I could not map that request to a JGG tool. Try: "trending on solana", "smart money buys", "analyze <token address>", "buy 0.1 SOL of <address>", or pick a skill below.'];
  const out: string[] = [];
  for (const s of steps) {
    if (s.status !== 'succeeded') { out.push(`${s.tool}: ${s.status} — ${s.error.message}`); continue; }
    const r = s.result;
    switch (s.tool) {
      case 'market.trending': case 'market.newTokens': out.push(`${s.tool === 'market.trending' ? 'Top trending' : 'Newest'} (simulated fixture data): ` + r.slice(0, 5).map((x: any) => `${sym(x.symbol)} MC $${x.mcUsd ?? '?'}`).join(', ') + '.'); break;
      case 'token.info': out.push(`${sym(r.symbol)}: price $${r.priceUsd ?? 'unknown'}, MC $${r.mcUsd ?? 'unknown'} (${r.mcBasis}), liquidity $${r.liqUsd ?? 'unknown'}, ${r.holders} holders, top-10 ${r.concentration.bps === null ? 'unknown' : r.concentration.bps / 100 + '%'} excl. pool/burn.`); break;
      case 'token.dd': out.push(`Due diligence (${r.rubric}): ${r.verdict}${r.score !== null ? `, score ${r.score}/100` : ''}, coverage ${r.coverageBps / 100}%.${r.missing.length ? ' Missing: ' + r.missing.join(', ') + '.' : ''}`); break;
      case 'wallet.analysis': out.push(`Wallet gates: ` + r.gates.map((g: any) => `${g.gate} ${g.result} (${g.basis})`).join('; ') + '.'); break;
      case 'wallet.score': out.push(`Wallet score (${r.rubric}): profitability ${r.profitability ?? 'n/a'}, copy feasibility ${r.copyFeasibility ?? 'n/a'}, risk ${r.risk ?? 'n/a'}; sample ${r.sampleSize}${r.lowSample ? ' (low sample)' : ''}.`); break;
      case 'signals.cluster': out.push(r.length ? `Clusters: ` + r.slice(0, 5).map((x: any) => `${sym(x.symbol)} ${x.distinctWallets} wallets`).join(', ') + '.' : 'No smart-money cluster met the threshold in this window.'); break;
      case 'signals.surge': out.push(r.length ? `Surging: ` + r.slice(0, 5).map((x: any) => `${sym(x.symbol)} +${(x.changeBps / 100).toFixed(1)}%/5m`).join(', ') + '.' : 'No surge above threshold.'); break;
      case 'chain.fees': out.push(`Fees (${r.unit}): low ${r.tiers.low}, avg ${r.tiers.average}, high ${r.tiers.high}.`); break;
      case 'trade.marketBuy': case 'trade.buyByName':
        if (r.ambiguous) out.push(`"${s.args.query}" matches ${r.candidates.length} tokens (possible copycats). Pick the exact address — no proposal created.`);
        else out.push(`Proposal ${r.intentId}: buy ${r.quote.amountIn} ${r.quote.side === 'buy' ? 'native' : ''} → min ${r.quote.minOut} tokens (simulated). Awaiting YOUR approval; nothing executed.`); break;
      default: out.push(`${s.tool}: ok.`);
    }
  }
  return out;
}
const sym = (s: string) => `$${String(s).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`; // untrusted metadata rendered as inert text

export const TOOL_IDS = Object.keys(TOOLS);
export const toolScope = (id: string) => TOOLS[id]?.scope;
