// Automated strategies (spec §12): limit, TP/SL, trailing, copy, snipes. Demo/Paper only.
// Durable: state JSON persisted after every evaluation; leases prevent double evaluation;
// every submission uses a deterministic idempotency key so a crash/replay never double-spends.
import { createHash } from 'node:crypto';
import { type DB, tx, q1, qa, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import * as D from '../../../packages/domain/src/index.ts';
import { CHAIN_META, type Chain } from '../../../packages/contracts/src/index.ts';
import { findFixtureToken, fixtureTokens, fixtureTrades, priceAt, num } from '../../../packages/test-fixtures/src/index.ts';
import { finderCandidates } from '../../../packages/providers/src/market.ts';
import { getMarketSource, nativeUsdOf } from '../../../packages/providers/src/execution.ts';
import { getMode, tradingModeOrThrow, audit, notify, outbox, createQuote, createIntent, approveIntent, executeIntent } from './trading.ts';

// ---------------- Risk policy (deny-by-default) ----------------
export function getRiskPolicy(db: DB, userId: string) {
  const r = q1(db, `SELECT policy, version FROM risk_policies WHERE user_id = ?`, userId);
  const policy: D.RiskPolicy = r ? JSON.parse(r.policy) : D.DENY_ALL_POLICY;
  return { policy, version: r?.version ?? 0, configured: policy.allowedChains.length > 0 && D.gt(policy.maxPerTrade, '0') };
}

const DEC = /^\d{1,20}(\.\d{1,18})?$/;
export function setRiskPolicy(db: DB, userId: string, body: any, expectedVersion: number | undefined) {
  const cur = getRiskPolicy(db, userId);
  if (expectedVersion !== undefined && expectedVersion !== cur.version) throw new ApiError('VERSION_CONFLICT', 'Risk policy changed elsewhere; reload', 409, true);
  const p: D.RiskPolicy = { ...cur.policy };
  for (const k of ['maxPerTrade', 'maxPerAssetExposure', 'maxDailyGrossBuy', 'maxRealizedDailyLoss', 'maxFeeQuote'] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string' || !DEC.test(body[k])) throw new ApiError('VALIDATION_FAILED', `${k} must be a non-negative decimal string`, 400);
    p[k] = body[k];
  }
  for (const [k, lo, hi] of [['maxOpenPositions', 0, 1000], ['maxSlippageBps', 0, 5000], ['maxDataAgeMs', 0, 600_000]] as const) {
    if (body[k] === undefined) continue;
    if (!Number.isInteger(body[k]) || body[k] < lo || body[k] > hi) throw new ApiError('VALIDATION_FAILED', `${k} must be an integer ${lo}..${hi}`, 400);
    (p as any)[k] = body[k];
  }
  if (body.allowedChains !== undefined) {
    if (!Array.isArray(body.allowedChains) || body.allowedChains.some((c: string) => !(c in CHAIN_META))) throw new ApiError('VALIDATION_FAILED', 'allowedChains must list supported chains', 400);
    p.allowedChains = [...new Set(body.allowedChains as string[])];
  }
  if (body.entriesPaused !== undefined) p.entriesPaused = !!body.entriesPaused;
  return tx(db, () => {
    if (cur.version === 0) run(db, `INSERT INTO risk_policies (user_id, policy, version) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET policy = excluded.policy, version = risk_policies.version + 1`, userId, JSON.stringify(p));
    else run(db, `UPDATE risk_policies SET policy = ?, version = version + 1 WHERE user_id = ?`, JSON.stringify(p), userId);
    audit(db, userId, 'user', 'risk.update', p);
    return getRiskPolicy(db, userId);
  });
}

/** Kill switch: stops automatic submissions immediately; bumps policy version so in-flight evaluations re-check (T35). */
export function setKillSwitch(db: DB, userId: string, on: boolean, now: number) {
  return tx(db, () => {
    const cur = getRiskPolicy(db, userId);
    const p = { ...cur.policy, killSwitch: on, killSwitchVersion: cur.policy.killSwitchVersion + 1 };
    run(db, `INSERT INTO risk_policies (user_id, policy, version) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET policy = excluded.policy, version = risk_policies.version + 1`, userId, JSON.stringify(p));
    let paused = 0;
    if (on) {
      paused = Number(run(db, `UPDATE strategies SET lifecycle = 'paused', reason = 'AUTOMATION_STOPPED', version = version + 1, updated_at = ? WHERE user_id = ? AND lifecycle = 'active'`, now, userId).changes);
      // Reject any automation intents awaiting execution.
      run(db, `UPDATE trade_intents SET state = 'rejected', reason = 'AUTOMATION_STOPPED', version = version + 1, updated_at = ? WHERE user_id = ? AND source IN ('strategy','copy') AND state IN ('awaiting_approval','authorized')`, now, userId);
    }
    audit(db, userId, 'user', on ? 'automation.stop' : 'automation.resume', { paused });
    notify(db, userId, 'automation', on ? 'Automation stopped' : 'Automation resumed', on ? `Kill switch on. ${paused} strategies paused; no automatic submissions.` : 'Kill switch off. Paused strategies stay paused until you resume each one.', `ks:${userId}:${p.killSwitchVersion}`);
    return { killSwitch: on, pausedStrategies: paused, policyVersion: p.killSwitchVersion };
  });
}

// ---------------- Create / manage ----------------
const ENTRY_KINDS = new Set(['limit_buy', 'limit_buy_tp_sl', 'copy', 'migration_buy', 'dev_snipe', 'token_snipe', 'auto_trader']);
const pickExit = (p: any): Partial<D.AutoExitConfig> => Object.fromEntries(Object.entries({ partialBps: p.partialBps, trailActivation: p.trailActivation, retracement: p.retracement, tpGain: p.tpGain, stopLoss: p.stopLoss }).filter(([, v]) => v !== undefined)) as any;
const BLOCKED_KINDS: Record<string, string> = {
  snipex: 'SnipeX semantics are not specified beyond the S11 tab label; JGG will not invent them (spec §0.4).',
};

function positionOf(db: DB, userId: string, walletId: string, chain: string, token: string) {
  const lots = qa(db, `SELECT known_qty, known_basis FROM position_lots WHERE user_id = ? AND wallet_id = ? AND chain = ? AND token = ?`, userId, walletId, chain, token);
  let qty = D.dec('0'); let basis = D.dec('0');
  for (const l of lots) { qty = D.add(qty, l.known_qty); basis = D.add(basis, l.known_basis); }
  const bal = q1(db, `SELECT qty, reserved FROM paper_balances WHERE wallet_id = ? AND asset = ?`, walletId, token);
  const available = bal ? D.sub(bal.qty, bal.reserved) : D.dec('0');
  return { qty, basis, available, avgUsd: D.gt(qty, '0') ? D.div(basis, qty, 18) : null };
}

function exitState(entryUsd: string, qty: string, params: any, kind: string) {
  const coord: D.CoordinatorState = { remaining: qty, claimed: [], version: 0 };
  const tp = (params.stages ?? []).map((s: any, i: number) => ({ id: `tp${i + 1}`, percentBps: s.percentBps, price: D.fixedTakeProfitPrice(entryUsd, s.gain), done: false }));
  const staged = D.stagedQuantities(qty, tp.map((t: any) => ({ id: t.id, percentBps: t.percentBps })));
  for (const t of tp) t.qty = staged.find(x => x.id === t.id)!.qty;
  const sl = params.stopLoss ? { price: D.fixedStopLossPrice(entryUsd, params.stopLoss), done: false } : null;
  const trailing = kind === 'trailing_tp' ? D.newTrailingTp(entryUsd, params.activation ?? '0', params.retracement)
    : kind === 'trailing_sl' ? D.newTrailingSl(entryUsd, params.retracement)
    : kind === 'tp_sl' && params.trailActivation ? D.newTrailingTp(entryUsd, params.trailActivation, params.retracement ?? '0.15') // auto-exit: trail the rest from +activation
    : null;
  return { phase: 'exits', entryUsd, originalQty: qty, coord, tp, sl, trailing };
}

export function createStrategy(db: DB, userId: string, body: { kind: string; chain: Chain; tokenAddress?: string; walletId: string; params: any }, now: number, parent?: { id: string; bucket: string }, activate = true) {
  const { mode } = getMode(db, userId); const m = tradingModeOrThrow(mode, userId);
  if (BLOCKED_KINDS[body.kind]) throw new ApiError('CAPABILITY_BLOCKED', BLOCKED_KINDS[body.kind], 409);
  const LIVE_UNSUPPORTED = ['migration_buy']; // graduated coins are not quotable on the curve in v1
  if (getMarketSource()?.kind === 'solana_live' && LIVE_UNSUPPORTED.includes(body.kind)) throw new ApiError('CAPABILITY_BLOCKED', `${body.kind} is not available on live data in standalone v1: graduated (PumpSwap) coins are not quoted by the JGG curve model.`, 409);
  const w = q1(db, `SELECT * FROM wallets WHERE id = ? AND user_id = ?`, body.walletId, userId);
  if (!w) throw new ApiError('NOT_FOUND', 'Wallet not found', 404);
  if (w.chain !== body.chain || w.custody !== (m === 'live' ? 'hosted' : 'paper')) throw new ApiError('POLICY_DENIED', m === 'live' ? 'Live strategies must use your JGG trading wallet' : 'Strategy wallet must be a paper wallet on the same chain', 403);
  const pol = getRiskPolicy(db, userId);
  if (!parent && activate) {
    if (!pol.configured) throw new ApiError('POLICY_DENIED', 'Configure a risk policy (Settings → Risk) before enabling automation. Default policy denies all automatic trades.', 403, false, { code: 'RISK_POLICY_NOT_CONFIGURED' });
    if (!pol.policy.allowedChains.includes(body.chain)) throw new ApiError('POLICY_DENIED', `Risk policy does not allow automation on ${body.chain}`, 403);
    if (pol.policy.killSwitch) throw new ApiError('AUTOMATION_STOPPED', 'Kill switch is on; resume automation first', 409);
  }
  const p = body.params ?? {}; const need = (k: string) => { if (p[k] === undefined || p[k] === '') throw new ApiError('VALIDATION_FAILED', `params.${k} is required for ${body.kind}`, 400); };
  const token = body.tokenAddress;
  const tokenKinds = ['limit_buy', 'limit_sell', 'tp_sl', 'trailing_tp', 'trailing_sl', 'limit_buy_tp_sl', 'migration_buy', 'dev_sell_exit', 'token_snipe'];
  if (tokenKinds.includes(body.kind)) {
    if (!token) throw new ApiError('VALIDATION_FAILED', 'tokenAddress is required', 400);
    const src = getMarketSource(); const live = !!src && src.kind !== 'fixture';
    const known = live ? src!.priceUsd(body.chain, token, now) !== null : !!findFixtureToken(body.chain, token);
    if (!known && body.kind !== 'token_snipe') throw new ApiError('NOT_FOUND', live ? 'Coin not indexed, graduated, or unpriced on live data' : 'Token not found on this chain', 404);
  }
  let state: any;
  const id = newId('stg');
  try {
    switch (body.kind) {
      case 'limit_buy': case 'limit_buy_tp_sl': need('targetPrice'); need('amount');
        if (body.kind === 'limit_buy_tp_sl' && !p.stages?.length && !p.stopLoss) throw new ApiError('VALIDATION_FAILED', 'Provide TP stages and/or stopLoss', 400);
        if (p.stages) D.stagedQuantities('1', p.stages.map((s: any, i: number) => ({ id: `tp${i}`, percentBps: s.percentBps })));
        state = { phase: 'waiting', epoch: 0 }; break;
      case 'limit_sell': need('targetPrice'); state = { phase: 'waiting', epoch: 0 }; break;
      case 'tp_sl': case 'trailing_tp': case 'trailing_sl': {
        if (body.kind === 'tp_sl' && !p.stages?.length && !p.stopLoss) throw new ApiError('VALIDATION_FAILED', 'Provide TP stages and/or stopLoss', 400);
        if (body.kind !== 'tp_sl') need('retracement');
        const qty = p.qty ?? null; const entry = p.entryUsd ?? null;
        const pos = positionOf(db, userId, body.walletId, body.chain, token!);
        const useQty = qty ?? D.str(D.min(pos.qty, pos.available));
        const useEntry = entry ?? (pos.avgUsd ? D.str(D.rescale(pos.avgUsd, 18)) : null);
        if (!D.gt(useQty, '0') || !useEntry) throw new ApiError('VALIDATION_FAILED', 'No known-basis position for this token in this wallet; exits need an entry price and quantity', 400, false, { code: 'UNKNOWN_COST_BASIS' });
        state = exitState(useEntry, useQty, p, body.kind); break;
      }
      case 'copy': need('sourceWallet');
        if (p.sourceWallet === w.address) throw new ApiError('VALIDATION_FAILED', 'Cannot copy your own wallet', 400);
        if ((p.sizing ?? 'fixed') === 'fixed') need('amount'); if (p.sizing === 'ratio') need('ratio');
        state = { phase: 'watching', cursor: now, holdings: '0' }; break;
      case 'dev_snipe': need('creatorWallet'); need('amount'); state = { phase: 'watching', armedAt: now }; break;
      case 'token_snipe': case 'migration_buy': need('amount'); state = { phase: 'watching', armedAt: now }; break;
      case 'dev_sell_exit': state = { phase: 'watching', cursor: now }; break;
      case 'auto_trader': need('amount');
        D.autoExitParams({ ...D.DEFAULT_AUTO_EXIT, ...pickExit(p) }); // validates the exit plan up front
        state = { phase: 'scanning', lastScanAt: 0, bought: {}, decisions: [] }; break;
      default: throw new ApiError('VALIDATION_FAILED', `Unknown strategy kind ${body.kind}`, 400);
    }
  } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('VALIDATION_FAILED', (e as Error).message, 400); }
  const expires = p.expiresInSec ? now + p.expiresInSec * 1000 : null;
  const grant = { mode: m, chain: body.chain, walletId: body.walletId, token: token ?? null, policyVersion: pol.policy.killSwitchVersion, expiresAt: expires, grantedAt: now, parent: parent?.id ?? null };
  run(db, `INSERT INTO strategies (id, user_id, mode, kind, chain, token, wallet_id, params, state, lifecycle, parent_id, grant_json, bucket, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, m, body.kind, body.chain, token ?? null, body.walletId, JSON.stringify(p), JSON.stringify(state), activate ? 'active' : 'draft', parent?.id ?? null, JSON.stringify(grant), parent?.bucket ?? (ENTRY_KINDS.has(body.kind) ? id : 'manual'), now, now);
  event(db, id, 'created', { kind: body.kind }, null, now);
  audit(db, userId, parent ? `strategy:${parent.id}` : 'user', 'strategy.create', { id, kind: body.kind });
  return strategyView(db, userId, id);
}

function event(db: DB, strategyId: string, kind: string, detail: unknown, dedupe: string | null, now: number) {
  return Number(run(db, `INSERT OR IGNORE INTO strategy_events (strategy_id, kind, detail, dedupe, at) VALUES (?, ?, ?, ?, ?)`, strategyId, kind, JSON.stringify(detail), dedupe, now).changes) === 1;
}

export function strategyView(db: DB, userId: string, id: string) {
  const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ?`, id, userId);
  if (!s) throw new ApiError('NOT_FOUND', 'Strategy not found', 404);
  const events = qa(db, `SELECT kind, detail, at FROM strategy_events WHERE strategy_id = ? ORDER BY id DESC LIMIT 50`, id);
  const t = s.token ? (findFixtureToken(s.chain, s.token) ?? (getMarketSource()?.kind === 'solana_live' ? { symbol: q1(db, `SELECT symbol FROM live_tokens WHERE mint = ?`, s.token)?.symbol ?? null } : null)) : null;
  return { id: s.id, kind: s.kind, mode: s.mode, chain: s.chain, token: s.token, symbol: t?.symbol ?? null, walletId: s.wallet_id, params: JSON.parse(s.params), state: JSON.parse(s.state),
    lifecycle: s.lifecycle, reason: s.reason, parentId: s.parent_id, version: s.version, grant: JSON.parse(s.grant_json ?? 'null'), createdAt: new Date(s.created_at).toISOString(), updatedAt: new Date(s.updated_at).toISOString(),
    events: events.map(e => ({ kind: e.kind, detail: JSON.parse(e.detail ?? 'null'), at: new Date(e.at).toISOString() })) };
}
export const listStrategies = (db: DB, userId: string) => qa(db, `SELECT id FROM strategies WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`, userId).map(r => strategyView(db, userId, r.id));

export function setStrategyLifecycle(db: DB, userId: string, id: string, action: 'pause' | 'resume' | 'activate' | 'cancel', now: number) {
  return tx(db, () => {
    const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ?`, id, userId);
    if (!s) throw new ApiError('NOT_FOUND', 'Strategy not found', 404);
    const terminal = ['cancelled', 'completed', 'expired', 'failed'];
    if (terminal.includes(s.lifecycle)) throw new ApiError('INVALID_TRANSITION', `Strategy is ${s.lifecycle}`, 409);
    if (action === 'pause' && s.lifecycle === 'draft') throw new ApiError('INVALID_TRANSITION', 'Draft is not active', 409);
    if (action === 'resume' || action === 'activate') {
      const pol = getRiskPolicy(db, userId);
      if (pol.policy.killSwitch) throw new ApiError('AUTOMATION_STOPPED', 'Kill switch is on', 409);
      if (!pol.configured) throw new ApiError('POLICY_DENIED', 'Configure a risk policy before activating automation', 403, false, { code: 'RISK_POLICY_NOT_CONFIGURED' });
      if (!pol.policy.allowedChains.includes(s.chain)) throw new ApiError('POLICY_DENIED', `Risk policy does not allow automation on ${s.chain}`, 403);
      const { mode } = getMode(db, userId); if (mode !== s.mode) throw new ApiError('MODE_MISMATCH', `Strategy was created in ${s.mode}; current mode is ${mode}`, 409);
      const g = JSON.parse(s.grant_json); g.policyVersion = pol.policy.killSwitchVersion; // re-grant under the current policy version
      run(db, `UPDATE strategies SET lifecycle = 'active', reason = NULL, grant_json = ?, version = version + 1, updated_at = ? WHERE id = ?`, JSON.stringify(g), now, id);
    } else run(db, `UPDATE strategies SET lifecycle = ?, reason = ?, version = version + 1, updated_at = ? WHERE id = ?`, action === 'pause' ? 'paused' : 'cancelled', `USER_${action.toUpperCase()}`, now, id);
    event(db, id, action, null, null, now);
    return strategyView(db, userId, id);
  });
}

// ---------------- Evaluation (worker) ----------------
let priceOverride: ((token: string, now: number) => string | null) | null = null; // tests only
function priceUsd(chain: Chain, token: string, now: number): string | null {
  if (priceOverride) { const o = priceOverride(token, now); if (o !== undefined) return o; }
  const src = getMarketSource(); if (src && src.kind !== 'fixture') return src.priceUsd(chain, token, now);
  const t = findFixtureToken(chain, token); const p = t ? priceAt(t, now) : null; return p === null ? null : num(p);
}
function usage(db: DB, userId: string, chain: string, token: string | null, now: number): D.RiskUsage {
  const dayStart = now - 86_400_000; const native = CHAIN_META[chain as Chain].native;
  const buys = qa(db, `SELECT amount_in FROM orders WHERE user_id = ? AND chain = ? AND side = 'buy' AND strategy_id IS NOT NULL AND created_at >= ? AND state NOT IN ('cancelled','failed','expired')`, userId, chain, dayStart);
  let gross = D.dec('0'); for (const b of buys) gross = D.add(gross, b.amount_in);
  const exp = token ? qa(db, `SELECT amount_in FROM orders WHERE user_id = ? AND chain = ? AND token = ? AND side = 'buy' AND strategy_id IS NOT NULL AND state NOT IN ('cancelled','failed','expired')`, userId, chain, token) : [];
  let e = D.dec('0'); for (const b of exp) e = D.add(e, b.amount_in);
  const lots = qa(db, `SELECT realized, known_qty FROM position_lots WHERE user_id = ? AND chain = ?`, userId, chain);
  let loss = D.dec('0'); let open = 0;
  for (const l of lots) { if (D.lt(l.realized, '0')) loss = D.add(loss, D.neg(D.div(l.realized, nativeUsdOf(chain as Chain, now), 18))); if (D.gt(l.known_qty, '0')) open++; }
  void native;
  return { dailyGrossBuy: D.str(gross), realizedDailyLoss: D.str(loss), assetExposure: D.str(e), openPositions: open };
}

type Submit = { side: 'buy' | 'sell'; amount: string; key: string; riskReducing: boolean; source?: 'strategy' | 'copy' };

/** Full automated path: risk check → quote → intent → approval under the stored grant → execute. Idempotent per key. */
function submit(db: DB, s: any, x: Submit, now: number, fault?: any): { ok: true; order: any } | { ok: false; code: string; message: string } {
  const pol = getRiskPolicy(db, s.user_id); const grant = JSON.parse(s.grant_json);
  // Idempotency keys must stay ≤128 chars; long ids (e.g. 88-char Solana signatures) are hashed deterministically, so replays still dedupe.
  if (x.key.length > 100) x = { ...x, key: 'h:' + createHash('sha256').update(x.key).digest('hex').slice(0, 64) };
  if (x.side === 'sell') { // never request more precision than the token supports (floor = never oversell)
    const src = getMarketSource(); const decimals = src && src.kind !== 'fixture' ? 6 : findFixtureToken(s.chain, s.token)?.decimals;
    if (decimals !== undefined) x = { ...x, amount: D.str(D.rescale(x.amount, decimals, 'floor')) };
    if (!D.gt(x.amount, '0')) return { ok: false, code: 'NOTHING_TO_SELL', message: 'Quantity rounds to zero' };
  } else x = { ...x, amount: D.str(D.rescale(x.amount, 9, 'floor')) };
  const native = CHAIN_META[s.chain as Chain].native;
  const amountQuote = x.side === 'buy' ? x.amount : D.str(D.div(D.mul(x.amount, priceUsd(s.chain, s.token, now) ?? '0'), nativeUsdOf(s.chain as Chain, now), 18));
  const slippageBps = Math.min(pol.policy.maxSlippageBps || 300, 1500);
  const r = D.checkRisk(pol.policy, usage(db, s.user_id, s.chain, s.token, now), { side: x.side, amountQuote, slippageBps, feeQuote: '0', dataAgeMs: 0, chain: s.chain, riskReducing: x.riskReducing, policyVersionSeen: grant.policyVersion });
  if (!r.ok) return { ok: false, code: r.code, message: `Risk policy blocked: ${r.code}` };
  if (grant.expiresAt && now > grant.expiresAt) return { ok: false, code: 'GRANT_EXPIRED', message: 'Automation grant expired' };
  try {
    const q = createQuote(db, s.user_id, { chain: s.chain, tokenAddress: s.token, side: x.side, amount: x.amount, slippageBps, walletId: s.wallet_id }, now);
    if (D.gt(q.fees.find((f: any) => f.kind === 'network')?.amount ?? '0', pol.policy.maxFeeQuote) && !x.riskReducing) return { ok: false, code: 'FEE_ABOVE_POLICY', message: 'Quoted network fee above policy' };
    const intent = createIntent(db, s.user_id, { quoteId: q.id, source: x.source ?? 'strategy', strategyId: s.id }, now, `${x.key}:intent`);
    if (intent.state === 'awaiting_approval') approveIntent(db, s.user_id, intent.id, { maxSlippageBps: pol.policy.maxSlippageBps || slippageBps }, now, `strategy:${s.id}`);
    const order = executeIntent(db, s.user_id, intent.id, now, `${x.key}:exec`, fault ?? 'none', `strategy:${s.id}`);
    void native;
    return { ok: true, order };
  } catch (e) {
    const err = e as ApiError; return { ok: false, code: err.code ?? 'INTERNAL', message: err.message };
  }
}

function save(db: DB, s: any, state: any, lifecycle: string, reason: string | null, now: number) {
  run(db, `UPDATE strategies SET state = ?, lifecycle = ?, reason = COALESCE(?, reason), version = version + 1, updated_at = ? WHERE id = ?`, JSON.stringify(state), lifecycle, reason, now, s.id);
  outbox(db, s.user_id, `strategies:${s.user_id}`, { id: s.id, lifecycle });
}

/** Claim a lease so only one worker evaluates a strategy at a time (T30). Returns false if another owner holds it. */
export function claimLease(db: DB, id: string, owner: string, now: number, ms = 15_000): boolean {
  return Number(run(db, `UPDATE strategies SET lease_owner = ?, lease_until = ? WHERE id = ? AND lifecycle = 'active' AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)`, owner, now + ms, id, now, owner).changes) === 1;
}
const releaseLease = (db: DB, id: string, owner: string) => run(db, `UPDATE strategies SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`, id, owner);

export function evaluateAll(db: DB, owner: string, now: number, opts: { userId?: string; fault?: any } = {}) {
  const rows = opts.userId ? qa(db, `SELECT id, user_id FROM strategies WHERE lifecycle = 'active' AND user_id = ?`, opts.userId) : qa(db, `SELECT id, user_id FROM strategies WHERE lifecycle = 'active' LIMIT 500`);
  const results: { id: string; outcome: string }[] = [];
  // T53/T54: while a user has unresolved (uncertain) submissions — e.g. after a crash or a DB restore — automation
  // for that user waits until reconciliation settles them; it never acts on possibly stale balances.
  const blocked = new Set(qa(db, `SELECT DISTINCT user_id FROM orders WHERE state = 'reconciliation_required'`).map(r => r.user_id as string));
  for (const { id, user_id } of rows) {
    if (blocked.has(user_id)) { results.push({ id, outcome: 'awaiting_reconciliation' }); continue; }
    if (!claimLease(db, id, owner, now)) { results.push({ id, outcome: 'lease_held' }); continue; }
    try { results.push({ id, outcome: evaluateOne(db, id, now, opts.fault) }); }
    catch (e) { results.push({ id, outcome: `error:${(e as Error).message}` }); }
    finally { releaseLease(db, id, owner); }
  }
  return results;
}

export function evaluateOne(db: DB, id: string, now: number, fault?: any): string {
  const s = q1(db, `SELECT * FROM strategies WHERE id = ?`, id);
  if (!s || s.lifecycle !== 'active') return 'inactive';
  const { mode } = getMode(db, s.user_id);
  if (mode !== s.mode) { save(db, s, JSON.parse(s.state), 'paused', 'MODE_CHANGED', now); return 'paused:mode_changed'; }
  const grant = JSON.parse(s.grant_json);
  if (grant.expiresAt && now > grant.expiresAt) { save(db, s, JSON.parse(s.state), 'expired', 'EXPIRED', now); event(db, id, 'expired', null, null, now); return 'expired'; }
  const p = JSON.parse(s.params); const st = JSON.parse(s.state);
  const price = s.token ? priceUsd(s.chain, s.token, now) : null;

  const fail = (res: { code: string; message: string }, keep = true) => {
    event(db, id, 'blocked', res, null, now);
    if (res.code === 'AUTOMATION_STOPPED' || res.code === 'POLICY_VERSION_CHANGED') { save(db, s, st, 'paused', res.code, now); return `paused:${res.code}`; }
    if (!keep) save(db, s, st, 'failed', res.code, now);
    return `blocked:${res.code}`;
  };

  switch (s.kind) {
    case 'limit_buy': case 'limit_buy_tp_sl': case 'limit_sell': {
      if (price === null) return 'no_price';
      const hit = s.kind === 'limit_sell' ? D.limitSellTriggered(price, p.targetPrice) : D.limitBuyTriggered(price, p.targetPrice);
      if (!hit) return 'waiting';
      let amount = p.amount;
      if (s.kind === 'limit_sell') { const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, s.token); amount = D.str(p.amount ? D.min(p.amount, pos.available) : pos.available); if (!D.gt(amount, '0')) return fail({ code: 'NO_POSITION', message: 'Nothing to sell' }, false); }
      event(db, id, 'triggered', { price }, `${id}:trigger:${st.epoch}`, now);
      const r = submit(db, s, { side: s.kind === 'limit_sell' ? 'sell' : 'buy', amount, key: `stg:${id}:${st.epoch}`, riskReducing: s.kind === 'limit_sell' }, now, fault);
      if (!r.ok) return fail(r);
      const o = r.order;
      if (o.state === 'reconciliation_required' || o.state === 'submitting' || o.state === 'submitted') { save(db, s, { ...st, phase: 'awaiting_reconciliation', orderId: o.id }, 'active', 'PENDING_SETTLEMENT', now); return 'pending'; }
      if (o.state !== 'finalized') { save(db, s, { ...st, orderId: o.id }, 'failed', `ORDER_${o.state.toUpperCase()}`, now); return `order_${o.state}`; }
      if (s.kind === 'limit_buy_tp_sl') activateChildExits(db, s, o, p, now);
      save(db, s, { ...st, phase: 'done', orderId: o.id }, 'completed', null, now);
      return 'filled';
    }
    case 'tp_sl': case 'trailing_tp': case 'trailing_sl': {
      if (price === null) return 'no_price';
      if (st.pending) return reconcilePending(db, s, st, now);
      // Adjust for external reductions (manual sells etc.) — never sell more than actually held.
      const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, s.token);
      if (D.lt(pos.available, st.coord.remaining)) st.coord = D.applyExternalReduction(st.coord, D.str(D.sub(st.coord.remaining, D.max('0', pos.available))));
      if (D.isFlat(st.coord)) { save(db, s, st, 'completed', 'POSITION_CLOSED', now); return 'flat'; }
      const claims: { exitId: string; kind: D.ExitClaim['kind']; qty: string }[] = [];
      if (st.trailing) {
        const ev = st.trailing.kind === 'trailing_tp' ? D.evalTrailingTp(st.trailing, price) : D.evalTrailingSl(st.trailing, price);
        const changed = ev.event !== 'none'; st.trailing = ev.state; st.stop = ev.stop;
        if (changed) event(db, id, ev.event, { price, stop: ev.stop, peak: (ev.state as any).peak }, ev.event === 'triggered' ? `${id}:trail:fire` : null, now);
        if (ev.triggered) claims.push({ exitId: 'trailing', kind: 'trailing', qty: st.coord.remaining });
      }
      if (st.sl && !st.sl.done && D.lte(price, st.sl.price)) claims.push({ exitId: 'sl', kind: 'stop', qty: st.coord.remaining });
      else for (const t of st.tp ?? []) if (!t.done && D.gte(price, t.price)) claims.push({ exitId: t.id, kind: 'tp_stage', qty: t.qty });
      if (!claims.length) { save(db, s, st, 'active', null, now); return 'waiting'; }
      const c = claims[0];
      const claim = D.claimExit(st.coord, { exitId: c.exitId, kind: c.kind, requestedQty: c.qty }, st.coord.version);
      if (!claim.ok) { save(db, s, st, 'active', null, now); return `claim_${claim.code}`; }
      if (!D.gt(claim.qty, '0')) { save(db, s, st, 'active', null, now); return 'nothing_to_sell'; }
      st.coord = claim.state;
      const r = submit(db, s, { side: 'sell', amount: claim.qty, key: `stg:${id}:${c.exitId}`, riskReducing: true }, now, fault);
      if (!r.ok) { event(db, id, 'exit_failed', r, null, now); notify(db, s.user_id, 'unprotected', 'Exit could not be submitted', `${s.kind} exit ${c.exitId} failed: ${r.message}. Position may be unprotected.`, `exitfail:${id}:${c.exitId}`); save(db, s, st, 'active', r.code, now); return `exit_blocked:${r.code}`; }
      if (['reconciliation_required', 'submitting', 'submitted'].includes(r.order.state)) { st.pending = { orderId: r.order.id, exitId: c.exitId }; save(db, s, st, 'active', 'PENDING_SETTLEMENT', now); return 'pending'; }
      markExitDone(st, c.exitId);
      event(db, id, 'exit_filled', { exitId: c.exitId, qty: claim.qty, orderId: r.order.id }, `${id}:exit:${c.exitId}`, now);
      const flat = D.isFlat(st.coord) || c.exitId === 'sl' || c.exitId === 'trailing';
      save(db, s, st, flat ? 'completed' : 'active', null, now);
      return `exit_${c.exitId}`;
    }
    case 'copy': return getMarketSource()?.kind === 'solana_live' ? evalCopyLive(db, s, p, st, now, fault) : evalCopy(db, s, p, st, now, fault);
    case 'auto_trader': return evalAutoTrader(db, s, p, st, now, fault);
    case 'dev_snipe': case 'token_snipe': case 'migration_buy': {
      if (getMarketSource()?.kind === 'solana_live') {
        if (s.kind === 'migration_buy') { save(db, s, st, 'paused', 'NOT_ON_LIVE_DATA', now); return 'paused:not_on_live_data'; }
        const target = s.kind === 'dev_snipe'
          ? q1(db, `SELECT mint FROM live_tokens WHERE creator = ? AND seen_from_creation = 1 AND complete = 0 AND created_at > ? AND created_at <= ? ORDER BY created_at LIMIT 1`, p.creatorWallet, st.armedAt, now)?.mint
          : q1(db, `SELECT mint FROM live_tokens WHERE mint = ? AND complete = 0 AND v_sol IS NOT NULL`, s.token)?.mint;
        if (!target) return 'watching';
        if (!s.token) run(db, `UPDATE strategies SET token = ? WHERE id = ?`, target, id);
        const sx = { ...s, token: target };
        event(db, id, 'triggered', { token: target }, `${id}:snipe`, now);
        const r = submit(db, sx, { side: 'buy', amount: p.amount, key: `stg:${id}:snipe`, riskReducing: false }, now, fault);
        if (!r.ok) return fail(r, false);
        save(db, sx, { ...st, phase: 'done', orderId: r.order.id }, r.order.state === 'finalized' ? 'completed' : 'active', r.order.state === 'finalized' ? null : 'UNCERTAIN', now);
        return r.order.state === 'finalized' ? 'filled' : 'uncertain';
      }
      let target: string | null = null;
      if (s.kind === 'dev_snipe') target = fixtureTokens(s.chain, now).find(t => t.creator === p.creatorWallet && t.createdAt > st.armedAt && t.createdAt <= now)?.address ?? null;
      if (s.kind === 'token_snipe') { const t = findFixtureToken(s.chain, s.token); target = t && t.createdAt <= now ? t.address : null; }
      if (s.kind === 'migration_buy') { const t = findFixtureToken(s.chain, s.token); target = t?.migratedPool && t.migratedPool.at <= now && t.migratedPool.at > st.armedAt ? t.address : null; }
      if (!target) return 'watching';
      if (!s.token) run(db, `UPDATE strategies SET token = ? WHERE id = ?`, target, id);
      const s2 = { ...s, token: target };
      event(db, id, 'triggered', { token: target }, `${id}:snipe`, now);
      const r = submit(db, s2, { side: 'buy', amount: p.amount, key: `stg:${id}:snipe`, riskReducing: false }, now, fault);
      if (!r.ok) return fail(r, false);
      save(db, s2, { ...st, phase: 'done', orderId: r.order.id }, r.order.state === 'finalized' ? 'completed' : 'active', r.order.state === 'finalized' ? null : 'UNCERTAIN', now);
      return r.order.state === 'finalized' ? 'filled' : 'uncertain';
    }
    case 'dev_sell_exit': {
      if (getMarketSource()?.kind === 'solana_live') {
        const t = q1(db, `SELECT creator FROM live_tokens WHERE mint = ?`, s.token); if (!t?.creator) return 'no_token';
        const sold = q1(db, `SELECT 1 FROM live_trades WHERE mint = ? AND wallet = ? AND is_buy = 0 AND ts > ?`, s.token, t.creator, st.cursor);
        st.cursor = now;
        if (!sold) { save(db, s, st, 'active', null, now); return 'watching'; }
        const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, s.token);
        if (!D.gt(pos.available, '0')) { save(db, s, st, 'completed', 'NO_POSITION', now); return 'flat'; }
        const r = submit(db, s, { side: 'sell', amount: D.str(pos.available), key: `stg:${id}:devsell`, riskReducing: true }, now, fault);
        if (!r.ok) return fail(r);
        save(db, s, { ...st, orderId: r.order.id }, 'completed', null, now);
        return 'exit_dev_sell';
      }
      const t = findFixtureToken(s.chain, s.token); if (!t) return 'no_token';
      const sold = fixtureTrades(s.chain, st.cursor, now).find(x => x.token === s.token && x.wallet === t.creator && x.side === 'sell');
      st.cursor = now;
      if (!sold) { save(db, s, st, 'active', null, now); return 'watching'; }
      const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, s.token);
      if (!D.gt(pos.available, '0')) { save(db, s, st, 'completed', 'NO_POSITION', now); return 'flat'; }
      const r = submit(db, s, { side: 'sell', amount: D.str(pos.available), key: `stg:${id}:devsell`, riskReducing: true }, now, fault);
      if (!r.ok) return fail(r);
      save(db, s, { ...st, orderId: r.order.id }, 'completed', null, now);
      return 'exit_dev_sell';
    }
    default: return 'unsupported';
  }
}

function markExitDone(st: any, exitId: string) {
  if (exitId === 'sl' && st.sl) st.sl.done = true;
  for (const t of st.tp ?? []) if (t.id === exitId) t.done = true;
}

function reconcilePending(db: DB, s: any, st: any, now: number) {
  const o = q1(db, `SELECT state FROM orders WHERE id = ?`, st.pending.orderId);
  if (['reconciliation_required', 'submitting', 'submitted', 'confirmed'].includes(o.state)) return 'awaiting_settlement';
  if (o.state === 'finalized') { markExitDone(st, st.pending.exitId); delete st.pending; save(db, s, st, D.isFlat(st.coord) ? 'completed' : 'active', null, now); return 'reconciled_filled'; }
  // Not landed: return the claimed quantity to the coordinator so the exit can be re-evaluated (new epoch key).
  const exitId = st.pending.exitId; const claimed = st.coord.claimed.find((c: any) => c.exitId === exitId);
  if (claimed) { st.coord.remaining = D.str(D.add(st.coord.remaining, claimed.qty)); st.coord.claimed = st.coord.claimed.filter((c: any) => c.exitId !== exitId); st.coord.version++; }
  delete st.pending; save(db, s, st, 'active', null, now); return 'reconciled_not_landed';
}

/** Parent limit/buy filled → activate exits for ACTUAL filled quantity (spec §12.3). Failure → Unprotected notification (T29). */
function activateChildExits(db: DB, s: any, o: any, p: any, now: number) {
  try {
    const entryUsd = D.str(D.rescale(D.div(D.mul(o.amountIn, nativeUsdOf(s.chain as Chain, now)), o.filledOut, 18), 18));
    const exitParams = s.kind === 'auto_trader' ? D.autoExitParams({ ...D.DEFAULT_AUTO_EXIT, ...pickExit(p) }) : { stages: p.stages, stopLoss: p.stopLoss };
    const child = createStrategyInTx(db, s, { ...exitParams, qty: o.filledOut, entryUsd }, now);
    event(db, s.id, 'exits_activated', { childId: child, qty: o.filledOut, entryUsd }, `${s.id}:child`, now);
  } catch (e) {
    event(db, s.id, 'exits_failed', { message: (e as Error).message }, `${s.id}:childfail`, now);
    notify(db, s.user_id, 'unprotected', 'Unprotected position', `Buy filled but TP/SL could not be activated: ${(e as Error).message}. Set exits manually.`, `unprot:${s.id}`);
  }
}
function createStrategyInTx(db: DB, parent: any, params: any, now: number): string {
  const v = createStrategy(db, parent.user_id, { kind: 'tp_sl', chain: parent.chain, tokenAddress: parent.token, walletId: parent.wallet_id, params }, now, { id: parent.id, bucket: parent.bucket ?? parent.id });
  return v.id;
}
export const _testing = { activateChildExits, setPriceOverride: (f: typeof priceOverride) => { priceOverride = f; } };

// ---------------- Copy trading (spec §12.4) ----------------
function evalCopy(db: DB, s: any, p: any, st: any, now: number, fault?: any): string {
  const events = fixtureTrades(s.chain, st.cursor, now).filter(t => t.wallet === p.sourceWallet);
  const nusd = nativeUsdOf(s.chain as Chain, now); const outcomes: string[] = [];
  for (const ev of events) {
    // Inbox dedupe: at-least-once delivery, processed once per task (T15/T31).
    const fresh = Number(run(db, `INSERT OR IGNORE INTO inbox_events (source, event_id, consumer, received_at) VALUES ('fixture-trades', ?, ?, ?)`, ev.eventId, `copy:${s.id}`, now).changes) === 1;
    if (!fresh) { outcomes.push('dup'); continue; }
    s.token = ev.token;
    if (ev.side === 'buy') {
      const cfg: D.CopyBuyConfig = { sizing: (p.sizing ?? 'fixed') === 'fixed' ? { mode: 'fixed', amount: p.amount } : p.sizing === 'ratio' ? { mode: 'ratio', ratio: p.ratio } : { mode: 'capped_source', cap: p.amount ?? '0.1' },
        maxEventAgeMs: (p.maxEventAgeSec ?? 30) * 1000, minAmount: '0.001', maxAmount: p.maxAmount ?? p.amount ?? '1', requireConfirmed: true };
      const d = D.copyBuyDecision(cfg, { sourceEventId: ev.eventId, observedAt: ev.ts, sourceAmount: D.str(D.div(ev.amountUsd, nusd, 9)), commitment: 'confirmed' }, now, new Set(), s.id);
      if (d.action === 'skip') { event(db, s.id, 'copy_skip', { eventId: ev.eventId, reason: d.reason }, D.copyDedupeKey(s.id, ev.eventId, 'buy'), now); outcomes.push(d.reason); continue; }
      if (!event(db, s.id, 'copy_buy', { eventId: ev.eventId, amount: d.amount, token: ev.token }, D.copyDedupeKey(s.id, ev.eventId, 'buy'), now)) { outcomes.push('dup'); continue; }
      const r = submit(db, s, { side: 'buy', amount: d.amount, key: `copy:${s.id}:${ev.eventId}`, riskReducing: false, source: 'copy' }, now, fault);
      if (!r.ok) { event(db, s.id, 'copy_blocked', r, null, now); outcomes.push(r.code); if (r.code === 'AUTOMATION_STOPPED' || r.code === 'POLICY_VERSION_CHANGED') { save(db, s, st, 'paused', r.code, now); return `paused:${r.code}`; } continue; }
      outcomes.push('bought');
    } else if ((p.sellMode ?? 'follow_source') === 'follow_source') {
      // Source pre-sell balance from the source's own fixture history for this token.
      const t = findFixtureToken(s.chain, ev.token); if (!t) continue;
      const hist = fixtureTrades(s.chain, t.createdAt, ev.ts).filter(x => x.wallet === ev.wallet && x.token === ev.token && x.eventId !== ev.eventId);
      let bal = D.dec('0'); for (const h of hist) bal = h.side === 'buy' ? D.add(bal, h.tokenQty) : D.max('0', D.sub(bal, h.tokenQty));
      const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, ev.token);
      const f = D.followSell({ [s.id]: D.str(pos.available) }, s.id, { sourcePreSellBalance: D.gt(bal, '0') ? D.str(bal) : null, sourceSellQty: ev.tokenQty });
      if (!f.ok) { event(db, s.id, 'copy_skip', { eventId: ev.eventId, reason: f.code }, D.copyDedupeKey(s.id, ev.eventId, 'sell'), now); outcomes.push(f.code); continue; }
      if (!D.gt(f.sellQty, '0')) { outcomes.push('nothing_held'); continue; }
      if (!event(db, s.id, 'copy_sell', { eventId: ev.eventId, qty: f.sellQty }, D.copyDedupeKey(s.id, ev.eventId, 'sell'), now)) continue;
      const r = submit(db, s, { side: 'sell', amount: f.sellQty, key: `copy:${s.id}:${ev.eventId}:sell`, riskReducing: true, source: 'copy' }, now, fault);
      outcomes.push(r.ok ? 'sold' : r.code);
    }
  }
  st.cursor = now; st.lastOutcomes = outcomes.slice(-10);
  save(db, s, st, 'active', null, now);
  return events.length ? `copy:${outcomes.join(',')}` : 'watching';
}

// ---------------- Auto trader (owner request): finder → buy → auto exits. Paper/Demo only. ----------------
// Scans with the explainable JGG Finder, buys at most one new candidate per scan within the risk policy,
// then attaches exits: partial at +50% with a trailing stop on the rest, remainder at +100%, hard stop-loss.
// It never re-buys a token it already traded and never exceeds maxPositions open auto positions.
function evalAutoTrader(db: DB, s: any, p: any, st: any, now: number, fault?: any): string {
  const every = (p.scanEverySec ?? 30) * 1000;
  if (now - (st.lastScanAt ?? 0) < every) return 'waiting';
  st.lastScanAt = now;
  const open = qa(db, `SELECT id FROM strategies WHERE parent_id = ? AND lifecycle IN ('active','paused')`, s.id).length;
  if (open >= (p.maxPositions ?? 3)) { save(db, s, st, 'active', null, now); return 'max_positions'; }
  const src = getMarketSource(); const live = src && src.kind !== 'fixture';
  const res = live ? D.runFinder(src!.finderCandidates(s.chain, now), src!.finderConfig, src!.finderExclude) : D.runFinder(finderCandidates(s.chain, now));
  const pick = res.passed.find(c => c.score >= (p.minScore ?? 50) && !st.bought[c.address]);
  const decision = { at: new Date(now).toISOString(), scanned: res.scanned, passed: res.passed.length, excluded: res.excluded, pick: pick ? { address: pick.address, symbol: pick.symbol, score: pick.score, reasons: pick.reasons } : null };
  st.decisions = [decision, ...(st.decisions ?? [])].slice(0, 20);
  if (!pick) { save(db, s, st, 'active', null, now); return 'no_candidate'; }
  st.bought[pick.address] = now; // never chase the same token twice (also if the buy fails)
  save(db, s, st, 'active', null, now);
  const sx = { ...s, token: pick.address };
  event(db, s.id, 'auto_pick', decision.pick, `${s.id}:pick:${pick.address}`, now);
  const r = submit(db, sx, { side: 'buy', amount: p.amount, key: `auto:${s.id}:${pick.address}`, riskReducing: false }, now, fault);
  if (!r.ok) { event(db, s.id, 'auto_blocked', r, null, now); if (r.code === 'AUTOMATION_STOPPED' || r.code === 'POLICY_VERSION_CHANGED') { save(db, s, st, 'paused', r.code, now); return `paused:${r.code}`; } return `blocked:${r.code}`; }
  if (r.order.state === 'finalized') { activateChildExits(db, { ...sx, bucket: s.id }, r.order, p, now); return `bought:${pick.symbol}`; }
  return `order_${r.order.state}`;
}

/** Honest performance of an auto trader: closed child positions only; win = realized P&L > 0. */
export function autoPerformance(db: DB, userId: string, id: string) {
  const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ?`, id, userId);
  if (!s) throw new ApiError('NOT_FOUND', 'Strategy not found', 404);
  const lots = qa(db, `SELECT token, known_qty, realized FROM position_lots WHERE user_id = ? AND bucket = ?`, userId, id);
  const closed = lots.filter(l => D.isZero(l.known_qty));
  const wins = closed.filter(l => D.gt(l.realized, '0')).length;
  let realized = D.dec('0'); for (const l of lots) realized = D.add(realized, l.realized);
  return { strategyId: id, mode: s.mode, openPositions: lots.length - closed.length, closedTrades: closed.length, wins, losses: closed.length - wins,
    winRate: closed.length ? Math.round(wins * 1000 / closed.length) / 10 : null, realizedUsd: D.fixed(realized, 2),
    sampleNote: closed.length < 30 ? `Only ${closed.length} closed trades — too few to judge any win rate.` : 'Past simulated results do not predict live results.',
    dataNote: getMarketSource()?.kind === 'solana_live' ? 'Paper fills priced on live Solana reserves (no real trades). Real fills can differ: latency, competition, fees.' : 'Simulated (fixture market data + paper execution). Not evidence of real-market performance.' };
}

/** Copy trading on live data: the source wallet's pump.fun trades from our index, each processed once. */
function evalCopyLive(db: DB, s: any, p: any, st: any, now: number, fault?: any): string {
  const rows = qa(db, `SELECT sig, idx, mint, is_buy, sol, tok, ts, slot FROM live_trades WHERE wallet = ? AND ts > ? ORDER BY ts, slot, sig, idx LIMIT 200`, p.sourceWallet, (st.cursor ?? now) - 60_000);
  const outcomes: string[] = []; let maxTs = st.cursor ?? now;
  for (const x of rows) {
    const evId = `${x.sig}:${x.idx}`; maxTs = Math.max(maxTs, x.ts);
    const fresh = Number(run(db, `INSERT OR IGNORE INTO inbox_events (source, event_id, consumer, received_at) VALUES ('live-trades', ?, ?, ?)`, evId, `copy:${s.id}`, now).changes) === 1;
    if (!fresh) continue;
    const sx = { ...s, token: x.mint };
    if (x.is_buy) {
      const cfg: D.CopyBuyConfig = { sizing: (p.sizing ?? 'fixed') === 'fixed' ? { mode: 'fixed', amount: p.amount } : p.sizing === 'ratio' ? { mode: 'ratio', ratio: p.ratio } : { mode: 'capped_source', cap: p.amount ?? '0.1' },
        maxEventAgeMs: (p.maxEventAgeSec ?? 30) * 1000, minAmount: '0.001', maxAmount: p.maxAmount ?? p.amount ?? '1', requireConfirmed: true };
      const d = D.copyBuyDecision(cfg, { sourceEventId: evId, observedAt: x.ts, sourceAmount: D.str(D.rawToDec(x.sol, 9)), commitment: 'confirmed' }, now, new Set(), s.id);
      if (d.action === 'skip') { event(db, s.id, 'copy_skip', { eventId: evId, reason: d.reason }, D.copyDedupeKey(s.id, evId, 'buy'), now); outcomes.push(d.reason); continue; }
      if (!event(db, s.id, 'copy_buy', { eventId: evId, amount: d.amount, token: x.mint }, D.copyDedupeKey(s.id, evId, 'buy'), now)) continue;
      const r = submit(db, sx, { side: 'buy', amount: d.amount, key: `copy:${s.id}:${evId}`, riskReducing: false, source: 'copy' }, now, fault);
      outcomes.push(r.ok ? 'bought' : r.code);
      if (!r.ok && (r.code === 'AUTOMATION_STOPPED' || r.code === 'POLICY_VERSION_CHANGED')) { save(db, s, st, 'paused', r.code, now); return `paused:${r.code}`; }
    } else if ((p.sellMode ?? 'follow_source') === 'follow_source') {
      const before = qa(db, `SELECT is_buy, tok FROM live_trades WHERE wallet = ? AND mint = ? AND (ts < ? OR (ts = ? AND (slot < ? OR (slot = ? AND (sig < ? OR (sig = ? AND idx < ?))))))`,
        p.sourceWallet, x.mint, x.ts, x.ts, x.slot, x.slot, x.sig, x.sig, x.idx);
      let bal = 0n; let sawBuy = false; for (const b of before) { if (b.is_buy) { bal += BigInt(b.tok); sawBuy = true; } else bal -= BigInt(b.tok); }
      const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, x.mint);
      const f = D.followSell({ [s.id]: D.str(pos.available) }, s.id, { sourcePreSellBalance: sawBuy && bal > 0n ? D.str(D.rawToDec(String(bal), 6)) : null, sourceSellQty: D.str(D.rawToDec(x.tok, 6)) });
      if (!f.ok) { event(db, s.id, 'copy_skip', { eventId: evId, reason: f.code }, D.copyDedupeKey(s.id, evId, 'sell'), now); outcomes.push(f.code); continue; }
      if (!D.gt(f.sellQty, '0')) { outcomes.push('nothing_held'); continue; }
      if (!event(db, s.id, 'copy_sell', { eventId: evId, qty: f.sellQty }, D.copyDedupeKey(s.id, evId, 'sell'), now)) continue;
      const r = submit(db, sx, { side: 'sell', amount: f.sellQty, key: `copy:${s.id}:${evId}:sell`, riskReducing: true, source: 'copy' }, now, fault);
      if (!r.ok) event(db, s.id, 'copy_blocked', r, null, now);
      outcomes.push(r.ok ? 'sold' : r.code);
    }
  }
  st.cursor = maxTs; st.lastOutcomes = outcomes.slice(-10);
  save(db, s, st, 'active', null, now);
  return rows.length ? `copy:${outcomes.join(',') || 'seen'}` : 'watching';
}

/** Called after a LIVE order settles on chain: finish parent strategies and attach exits (live orders fill asynchronously). */
export function afterLiveFill(db: DB, orderId: string, now: number) {
  const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId); if (!o?.strategy_id || o.state !== 'finalized') return;
  const s = q1(db, `SELECT * FROM strategies WHERE id = ?`, o.strategy_id); if (!s) return;
  const p = JSON.parse(s.params); const view = { id: o.id, amountIn: o.amount_in, filledOut: o.filled_out };
  if (o.side === 'buy' && (s.kind === 'auto_trader' || s.kind === 'limit_buy_tp_sl')) {
    if (!q1(db, `SELECT 1 FROM strategies WHERE parent_id = ? AND token = ?`, s.id, o.token)) activateChildExits(db, { ...s, token: o.token, bucket: s.bucket ?? s.id }, view, p, now);
    if (s.kind === 'limit_buy_tp_sl') save(db, s, { ...JSON.parse(s.state), phase: 'done', orderId }, 'completed', null, now);
  } else if (['limit_buy', 'limit_sell', 'dev_snipe', 'token_snipe', 'dev_sell_exit'].includes(s.kind)) save(db, s, { ...JSON.parse(s.state), phase: 'done', orderId }, 'completed', null, now);
}
