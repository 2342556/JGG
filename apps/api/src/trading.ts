// Spec §11 execution sequence for Demo/Paper (simulated execution). Live mode is blocked
// until a verified execution provider + signer exist; the same state machine will be used.
import { type DB, tx, q1, qa, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import { sha256 } from './auth.ts';
import * as D from '../../../packages/domain/src/index.ts';
import { CHAIN_META, type Chain, type Mode } from '../../../packages/contracts/src/index.ts';
import { paperQuote, paperExecute, getMarketSource, nativeUsdOf, type PaperQuote, type PaperFault } from '../../../packages/providers/src/execution.ts';
import { findFixtureToken, priceAt, num } from '../../../packages/test-fixtures/src/index.ts';

const INTENT_TTL_MS = 60_000;

export function getMode(db: DB, userId: string): { mode: Mode; modeVersion: number } {
  const s = q1(db, `SELECT mode, mode_version FROM settings WHERE user_id = ?`, userId);
  if (!s) throw new ApiError('AUTH_REQUIRED', 'Unknown user', 401);
  return { mode: s.mode, modeVersion: s.mode_version };
}

/** Trading is only possible in simulated modes; live execution is capability-blocked. */
// Live trading gate, installed by the API/worker process from custody configuration (null = live disabled).
let liveGate: ((userId: string) => { ok: boolean; reasons: string[] }) | null = null;
let limits: { maxTradeSol: string; maxDailySol: string } | null = null;
export const setLiveLimits = (l: typeof limits) => { limits = l; };
export const liveLimits = () => limits;
export const setLiveGate = (g: typeof liveGate) => { liveGate = g; };
export const liveAllowed = (userId: string) => liveGate ? liveGate(userId) : { ok: false, reasons: ['LIVE_TRADING_DISABLED'] };
export function tradingModeOrThrow(mode: Mode, userId?: string): 'demo' | 'paper' | 'live' {
  if (mode === 'demo' || mode === 'paper') return mode;
  if (mode === 'live' && userId) { const g = liveAllowed(userId); if (g.ok) return 'live'; throw new ApiError('CAPABILITY_BLOCKED', `Live trading unavailable: ${g.reasons.join(', ')}`, 409, false, { reasons: g.reasons }); }
  if (mode === 'live_readonly') throw new ApiError('POLICY_DENIED', 'Live read-only mode: trading is disconnected.', 403);
  throw new ApiError('CAPABILITY_BLOCKED', 'Live trading is blocked: no verified execution provider/signer configured and no funded-test authorization (spec §11.1, T59).', 409);
}

export function setMode(db: DB, userId: string, mode: Mode, now: number) {
  return tx(db, () => {
    const s = q1(db, `SELECT mode, mode_version FROM settings WHERE user_id = ?`, userId);
    if (s.mode === mode) return { mode, modeVersion: s.mode_version, invalidated: 0 };
    run(db, `UPDATE settings SET mode = ?, mode_version = mode_version + 1 WHERE user_id = ?`, mode, userId);
    // Mode change invalidates pending quotes/approvals and releases their reservations (spec §11.1).
    const pending = qa(db, `SELECT id, reservation_id FROM trade_intents WHERE user_id = ? AND state IN ('draft','validating','awaiting_approval','authorized')`, userId);
    for (const p of pending) { transitionIntent(db, p.id, 'expired', 'MODE_CHANGED', now); if (p.reservation_id) releaseReservation(db, p.reservation_id); }
    run(db, `UPDATE quotes SET expires_at = ? WHERE user_id = ? AND expires_at > ?`, now, userId, now);
    audit(db, userId, 'user', 'mode.change', { from: s.mode, to: mode });
    return { mode, modeVersion: s.mode_version + 1, invalidated: pending.length };
  });
}

export function audit(db: DB, userId: string | null, actor: string, action: string, detail: unknown, correlationId?: string) {
  run(db, `INSERT INTO audit_events (user_id, actor, action, detail, correlation_id, at) VALUES (?, ?, ?, ?, ?, ?)`, userId, actor, action, JSON.stringify(detail), correlationId ?? null, Date.now());
}
export function outbox(db: DB, userId: string | null, topic: string, payload: unknown) {
  run(db, `INSERT INTO outbox_events (user_id, topic, payload, created_at) VALUES (?, ?, ?, ?)`, userId, topic, JSON.stringify(payload), Date.now());
}
export function notify(db: DB, userId: string, kind: string, title: string, body: string, dedupe: string) {
  run(db, `INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, dedupe, destination, delivery, at) VALUES (?, ?, ?, ?, ?, ?, 'in_app', 'delivered', ?)`, newId('ntf'), userId, kind, title, body, dedupe, Date.now());
}

// ---------------- Idempotency (spec §10) ----------------
export function idempotent<T>(db: DB, userId: string, scope: string, key: string | undefined, payload: unknown, fn: () => T): T {
  if (!key || key.length < 8 || key.length > 128) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key header (8–128 chars) is required for this operation', 400);
  const hash = sha256(D.canonicalJson(payload));
  const prior = q1(db, `SELECT payload_hash, response FROM idempotency_keys WHERE user_id = ? AND scope = ? AND key = ?`, userId, scope, key);
  if (prior) {
    if (prior.payload_hash !== hash) throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with a different payload', 422);
    if (prior.response) return JSON.parse(prior.response) as T;
    throw new ApiError('DUPLICATE_REQUEST', 'Request with this key is still in progress', 409, true);
  }
  run(db, `INSERT INTO idempotency_keys (user_id, key, scope, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)`, userId, key, scope, hash, Date.now());
  try {
    const r = fn();
    run(db, `UPDATE idempotency_keys SET response = ? WHERE user_id = ? AND scope = ? AND key = ?`, JSON.stringify(r), userId, scope, key);
    return r;
  } catch (e) {
    run(db, `DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND key = ? AND response IS NULL`, userId, scope, key);
    throw e;
  }
}

// ---------------- Balances & reservations ----------------
function wallet(db: DB, userId: string, walletId: string) {
  const w = q1(db, `SELECT * FROM wallets WHERE id = ? AND user_id = ?`, walletId, userId);
  if (!w) throw new ApiError('NOT_FOUND', 'Wallet not found', 404);
  return w;
}
function balanceRow(db: DB, walletId: string, asset: string) {
  return q1(db, `SELECT * FROM paper_balances WHERE wallet_id = ? AND asset = ?`, walletId, asset) ?? { qty: '0', reserved: '0', version: 0, missing: true };
}
export function reserve(db: DB, userId: string, walletId: string, asset: string, qty: string, purpose: string, now: number, ttl: number): string {
  const b = balanceRow(db, walletId, asset);
  const available = D.sub(b.qty, b.reserved);
  if (D.lt(available, qty)) throw new ApiError('INSUFFICIENT_BALANCE', `Insufficient available ${asset}: available ${D.str(available)}, needed ${qty}`, 409, false, { available: D.str(available), needed: qty });
  const res = run(db, `UPDATE paper_balances SET reserved = ?, version = version + 1 WHERE wallet_id = ? AND asset = ? AND version = ?`, D.str(D.add(b.reserved, qty)), walletId, asset, b.version);
  if (Number(res.changes) !== 1) throw new ApiError('VERSION_CONFLICT', 'Balance changed concurrently; retry', 409, true);
  const id = newId('rsv');
  run(db, `INSERT INTO balance_reservations (id, user_id, wallet_id, asset, qty, state, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?)`, id, userId, walletId, asset, qty, purpose, now, now + ttl);
  return id;
}
export function releaseReservation(db: DB, id: string, consume = false) {
  const r = q1(db, `SELECT * FROM balance_reservations WHERE id = ?`, id);
  if (!r || r.state !== 'held') return;
  const b = balanceRow(db, r.wallet_id, r.asset);
  run(db, `UPDATE paper_balances SET reserved = ?, version = version + 1 WHERE wallet_id = ? AND asset = ?`, D.str(D.max('0', D.sub(b.reserved, r.qty))), r.wallet_id, r.asset);
  run(db, `UPDATE balance_reservations SET state = ? WHERE id = ?`, consume ? 'consumed' : 'released', id);
}
function adjustBalance(db: DB, userId: string, walletId: string, asset: string, delta: D.Dec) {
  const b = balanceRow(db, walletId, asset);
  const next = D.add(b.qty, delta);
  if (D.isNeg(next)) throw new ApiError('INSUFFICIENT_BALANCE', `Balance would go negative for ${asset}`, 409);
  if (b.missing) run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) VALUES (?, ?, ?, ?)`, userId, walletId, asset, D.str(next));
  else run(db, `UPDATE paper_balances SET qty = ?, version = version + 1 WHERE wallet_id = ? AND asset = ?`, D.str(next), walletId, asset);
}

// ---------------- Quotes ----------------
export function createQuote(db: DB, userId: string, input: { chain: Chain; tokenAddress: string; side: 'buy' | 'sell'; amount: string; slippageBps: number; explicitHighSlippage?: boolean; walletId: string }, now: number, override?: PaperQuote) {
  const { mode, modeVersion } = getMode(db, userId); const m = tradingModeOrThrow(mode, userId);
  const w = wallet(db, userId, input.walletId);
  if (w.chain !== input.chain) throw new ApiError('CHAIN_UNSUPPORTED', `Wallet is on ${w.chain}, token is on ${input.chain}`, 400);
  if (m === 'live' ? w.custody !== 'hosted' : w.custody !== 'paper') throw new ApiError('POLICY_DENIED', m === 'live' ? 'Live mode trades only from your JGG trading wallet' : 'Only virtual paper wallets can trade in Demo/Paper mode', 403);
  if (m === 'live' && input.side === 'buy') { const lim = liveLimits(); if (lim && D.gt(input.amount, lim.maxTradeSol)) throw new ApiError('POLICY_DENIED', `Live buy above the per-trade limit (${lim.maxTradeSol} SOL)`, 403); }
  try { D.validateSlippageBps(input.slippageBps, input.explicitHighSlippage ?? false); } catch (e) { throw new ApiError('VALIDATION_FAILED', (e as Error).message, 400); }
  // Live: the approval context comes from an external quote (Jupiter) when supplied, else from the live curve (graduated sells get a price floor).
  const r = override ? { ok: true as const, quote: override } : paperQuote(input.chain, input.tokenAddress, input.side, input.amount, input.slippageBps, now, 15_000, { live: m === 'live' });
  if (!r.ok) throw new ApiError(r.code === 'TOKEN_NOT_FOUND' ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE', `Quote unavailable: ${r.code}`, r.code === 'TOKEN_NOT_FOUND' ? 404 : 422);
  const id = newId('qt');
  const context = { chain: input.chain, token: input.tokenAddress, side: input.side, amount: input.amount, walletId: input.walletId, slippageBps: input.slippageBps, minOut: r.quote.minOut, mode, modeVersion };
  run(db, `INSERT INTO quotes (id, user_id, mode, mode_version, wallet_id, chain, token, side, body, context_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, mode, modeVersion, input.walletId, input.chain, input.tokenAddress, input.side, JSON.stringify(r.quote), sha256(D.canonicalJson(context)), now, r.quote.expiresAt);
  return { id, mode, ...r.quote, expiresAt: new Date(r.quote.expiresAt).toISOString(), quotedAt: new Date(r.quote.quotedAt).toISOString(), ttlMs: r.quote.expiresAt - now, simulated: true }; // ttlMs: clients count down relative to receipt (demo clock ≠ wall clock)
}

// ---------------- Intents ----------------
export function transitionIntent(db: DB, id: string, to: D.IntentState, reason: string | null, now: number) {
  const i = q1(db, `SELECT state, version FROM trade_intents WHERE id = ?`, id);
  D.assertTransition(D.INTENT_TRANSITIONS, i.state, to);
  const r = run(db, `UPDATE trade_intents SET state = ?, version = version + 1, reason = COALESCE(?, reason), updated_at = ? WHERE id = ? AND version = ?`, to, reason, now, id, i.version);
  if (Number(r.changes) !== 1) throw new ApiError('VERSION_CONFLICT', 'Intent changed concurrently', 409, true);
}

export function createIntent(db: DB, userId: string, body: { quoteId: string; source: string; strategyId?: string }, now: number, idemKey: string | undefined) {
  return tx(db, () => idempotent(db, userId, 'intent.create', idemKey, body, () => {
    const q = q1(db, `SELECT * FROM quotes WHERE id = ? AND user_id = ?`, body.quoteId, userId);
    if (!q) throw new ApiError('NOT_FOUND', 'Quote not found', 404);
    if (q.expires_at <= now) throw new ApiError('QUOTE_EXPIRED', 'Quote expired — request a new quote', 409, true);
    const { mode, modeVersion } = getMode(db, userId);
    if (q.mode !== mode || q.mode_version !== modeVersion) throw new ApiError('MODE_MISMATCH', 'Operating mode changed since this quote', 409);
    const quote: PaperQuote = JSON.parse(q.body);
    const id = newId('int');
    const native = CHAIN_META[q.chain as Chain].native;
    const fees = D.additionalCostsByAsset(quote.fees);
    const reserveAsset = q.side === 'buy' ? native : q.token;
    const reserveQty = q.side === 'buy' ? D.str(D.add(quote.amountIn, fees[native] ?? '0')) : quote.amountIn;
    run(db, `INSERT INTO trade_intents (id, user_id, mode, mode_version, quote_id, wallet_id, chain, token, side, amount, state, source, strategy_id, context_hash, created_at, expires_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?,?)`,
      id, userId, mode, modeVersion, q.id, q.wallet_id, q.chain, q.token, q.side, quote.amountIn, body.source, body.strategyId ?? null, q.context_hash, now, now + INTENT_TTL_MS, now);
    transitionIntent(db, id, 'validating', null, now);
    const rsv = reserve(db, userId, q.wallet_id, reserveAsset, reserveQty, `intent:${id}`, now, INTENT_TTL_MS);
    run(db, `UPDATE trade_intents SET reservation_id = ? WHERE id = ?`, rsv, id);
    transitionIntent(db, id, 'awaiting_approval', null, now);
    audit(db, userId, 'user', 'intent.create', { id, source: body.source });
    return intentView(db, userId, id);
  }));
}

export function intentView(db: DB, userId: string, id: string) {
  const i = q1(db, `SELECT * FROM trade_intents WHERE id = ? AND user_id = ?`, id, userId);
  if (!i) throw new ApiError('NOT_FOUND', 'Intent not found', 404);
  const q = q1(db, `SELECT body FROM quotes WHERE id = ?`, i.quote_id);
  return { id: i.id, state: i.state, version: i.version, mode: i.mode, chain: i.chain, token: i.token, side: i.side, amount: i.amount, walletId: i.wallet_id, source: i.source,
    approval: i.approval ? JSON.parse(i.approval) : null, orderId: i.order_id, reason: i.reason, expiresAt: new Date(i.expires_at).toISOString(), quote: JSON.parse(q.body) };
}

/** Approval binds chain/asset/wallet/side/amount/min-out/slippage & fee ceilings/expiry to the context hash. */
export function approveIntent(db: DB, userId: string, id: string, body: { contextHash?: string; maxSlippageBps?: number; maxFeeNative?: string }, now: number, actor = 'user') {
  const r = approveTx(db, userId, id, body, now, actor);
  if ((r as any).expired) throw new ApiError('QUOTE_EXPIRED', 'Intent expired before approval; reservation released', 409);
  return r;
}
function approveTx(db: DB, userId: string, id: string, body: { contextHash?: string; maxSlippageBps?: number; maxFeeNative?: string }, now: number, actor: string) {
  return tx(db, () => {
    const i = q1(db, `SELECT * FROM trade_intents WHERE id = ? AND user_id = ?`, id, userId);
    if (!i) throw new ApiError('NOT_FOUND', 'Intent not found', 404);
    if (i.state !== 'awaiting_approval') throw new ApiError('INVALID_TRANSITION', `Intent is ${i.state}`, 409);
    if (i.expires_at <= now) { transitionIntent(db, id, 'expired', 'APPROVAL_WINDOW_ELAPSED', now); if (i.reservation_id) releaseReservation(db, i.reservation_id); return { expired: true } as any; }
    if (body.contextHash && body.contextHash !== i.context_hash) throw new ApiError('APPROVAL_REQUIRED', 'Approved context differs from intent context', 409);
    const quote: PaperQuote = JSON.parse(q1(db, `SELECT body FROM quotes WHERE id = ?`, i.quote_id).body);
    const fees = D.additionalCostsByAsset(quote.fees); const native = CHAIN_META[i.chain as Chain].native;
    const approval = { by: actor, at: now, contextHash: i.context_hash, chain: i.chain, token: i.token, walletId: i.wallet_id, side: i.side, amount: i.amount, minOut: quote.minOut,
      maxSlippageBps: body.maxSlippageBps ?? quote.slippageBps, maxFeeNative: body.maxFeeNative ?? (fees[native] ?? '0'), expiresAt: i.expires_at };
    if (approval.maxSlippageBps < quote.slippageBps) throw new ApiError('POLICY_DENIED', 'Quote slippage exceeds approved ceiling', 409);
    if (D.gt(fees[native] ?? '0', approval.maxFeeNative)) throw new ApiError('POLICY_DENIED', 'Quoted fees exceed approved fee ceiling', 409);
    run(db, `UPDATE trade_intents SET approval = ? WHERE id = ?`, JSON.stringify(approval), id);
    transitionIntent(db, id, 'authorized', null, now);
    audit(db, userId, actor, 'intent.approve', { id });
    return intentView(db, userId, id);
  });
}

// ---------------- Orders ----------------
export function orderTransition(db: DB, orderId: string, to: D.OrderState, detail: unknown, now: number) {
  const o = q1(db, `SELECT state, version FROM orders WHERE id = ?`, orderId);
  D.assertTransition(D.ORDER_TRANSITIONS, o.state, to);
  const r = run(db, `UPDATE orders SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`, to, now, orderId, o.version);
  if (Number(r.changes) !== 1) throw new ApiError('VERSION_CONFLICT', 'Order changed concurrently', 409, true);
  run(db, `INSERT INTO order_events (order_id, from_state, to_state, version, detail, at) VALUES (?, ?, ?, ?, ?, ?)`, orderId, o.state, to, o.version + 1, detail === undefined ? null : JSON.stringify(detail), now);
}

export function executeIntent(db: DB, userId: string, id: string, now: number, idemKey: string | undefined, fault: PaperFault | 'timeout_not_landed' = 'none', actor = 'user') {
  // Phase A (tx): final validation, order + attempt persisted BEFORE dispatch.
  const prepared = tx(db, () => idempotent(db, userId, 'intent.execute', idemKey, { id }, () => {
    const i = q1(db, `SELECT * FROM trade_intents WHERE id = ? AND user_id = ?`, id, userId);
    if (!i) throw new ApiError('NOT_FOUND', 'Intent not found', 404);
    if (i.order_id) return { orderId: i.order_id as string, existing: true }; // T19: one logical execution
    if (i.state !== 'authorized') throw new ApiError('APPROVAL_REQUIRED', `Intent is ${i.state}; approval required`, 409);
    const { mode, modeVersion } = getMode(db, userId);
    // Terminal outcomes are COMMITTED (not rolled back by a throw) and reported after the transaction.
    if (mode !== i.mode || modeVersion !== i.mode_version) { transitionIntent(db, id, 'expired', 'MODE_CHANGED', now); if (i.reservation_id) releaseReservation(db, i.reservation_id); return { fail: ['MODE_MISMATCH', 'Mode changed; intent invalidated', 409, false] as const }; }
    const q = q1(db, `SELECT * FROM quotes WHERE id = ?`, i.quote_id);
    if (q.expires_at <= now || i.expires_at <= now) { // T21: never execute a stale context
      transitionIntent(db, id, 'expired', 'QUOTE_EXPIRED', now); if (i.reservation_id) releaseReservation(db, i.reservation_id);
      return { fail: ['QUOTE_EXPIRED', 'Quote expired before execution; nothing was submitted. Request a new quote.', 409, true] as const };
    }
    if (i.source === 'strategy' || i.source === 'copy') {
      const pol = JSON.parse(q1(db, `SELECT policy FROM risk_policies WHERE user_id = ?`, userId).policy);
      if (pol.killSwitch) { transitionIntent(db, id, 'rejected', 'AUTOMATION_STOPPED', now); if (i.reservation_id) releaseReservation(db, i.reservation_id); return { fail: ['AUTOMATION_STOPPED', 'Automatic submissions are stopped', 409, false] as const }; }
    }
    const quote: PaperQuote = JSON.parse(q.body);
    const orderId = newId('ord');
    run(db, `INSERT INTO orders (id, user_id, mode, intent_id, strategy_id, chain, token, side, amount_in, min_out, state, provider, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'created', ?, ?, ?)`,
      orderId, userId, i.mode, id, i.strategy_id, i.chain, i.token, i.side, i.amount, quote.minOut, i.mode === 'live' ? 'jupiter-swap-v2' : 'jgg-paper', now, now);
    run(db, `INSERT INTO order_events (order_id, from_state, to_state, version, at) VALUES (?, NULL, 'created', 0, ?)`, orderId, now);
    for (const s of ['validated', 'awaiting_signature', 'prepared', 'submitting'] as D.OrderState[]) orderTransition(db, orderId, s, s === 'awaiting_signature' ? { signer: i.mode === 'live' ? 'jgg-custody (encrypted key, signs after simulation)' : 'paper-simulator (no key material)' } : undefined, now);
    run(db, `INSERT INTO order_attempts (id, order_id, attempt, dispatched_at) VALUES (?, ?, 1, ?)`, newId('att'), orderId, now);
    run(db, `UPDATE trade_intents SET order_id = ? WHERE id = ?`, orderId, id);
    transitionIntent(db, id, 'executing', null, now);
    audit(db, userId, actor, 'order.dispatch', { orderId, intentId: id });
    return { orderId, existing: false };
  }));
  if ('fail' in prepared) { const [c, m, st, retry] = prepared.fail as any; throw new ApiError(c, m, st, retry); }
  if (prepared.existing) return orderView(db, userId, prepared.orderId);
  // Dispatch claim: exactly one caller may dispatch attempt 1 (replayed/concurrent requests just read the order).
  const claimed = Number(run(db, `UPDATE order_attempts SET outcome = 'dispatching' WHERE order_id = ? AND attempt = 1 AND outcome IS NULL`, prepared.orderId).changes) === 1;
  if (!claimed) return orderView(db, userId, prepared.orderId);
  if (q1(db, `SELECT mode FROM orders WHERE id = ?`, prepared.orderId).mode === 'live') return orderView(db, userId, prepared.orderId); // async live dispatcher takes it from here

  // Phase B: dispatch outside any DB transaction.
  const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, id);
  const quote: PaperQuote = JSON.parse(q1(db, `SELECT body FROM quotes WHERE id = ?`, i.quote_id).body);
  const result = paperExecute(quote, now + 1, fault === 'timeout_not_landed' ? 'timeout_after_dispatch' : fault);

  // Simulated external truth for reconciliation tests (the "paper chain").
  if (result.outcome === 'uncertain') {
    const truth = fault === 'timeout_not_landed' ? null : paperExecute({ ...quote, expiresAt: now + 60_000 }, now + 1, 'none');
    run(db, `INSERT INTO paper_chain (tx_ref, order_id, landed, filled_out, fee, at) VALUES (?, ?, ?, ?, ?, ?)`, result.txRef, prepared.orderId,
      truth && truth.outcome === 'filled' ? 1 : 0, truth && truth.outcome === 'filled' ? truth.filledOut : null, truth && truth.outcome === 'filled' ? truth.networkFee : null, now);
  }

  // Phase C (tx): record outcome.
  tx(db, () => {
    run(db, `UPDATE orders SET tx_ref = ? WHERE id = ?`, result.txRef, prepared.orderId);
    run(db, `UPDATE order_attempts SET tx_ref = ?, outcome = ? WHERE order_id = ? AND attempt = 1`, result.txRef, result.outcome, prepared.orderId);
    if (result.outcome === 'uncertain') {
      orderTransition(db, prepared.orderId, 'reconciliation_required', { reason: 'SUBMISSION_TIMEOUT', note: 'Dispatch may have occurred; will not resubmit until reconciled' }, now);
      notify(db, userId, 'uncertain_execution', 'Order outcome uncertain', `Order ${prepared.orderId} timed out after dispatch. JGG will reconcile before any retry.`, `uncertain:${prepared.orderId}`);
      return;
    }
    orderTransition(db, prepared.orderId, 'submitted', { txRef: result.txRef }, now);
    if (result.outcome === 'failed') { settleFailure(db, userId, prepared.orderId, result.reason, result.networkFee, now); return; }
    applyFill(db, userId, prepared.orderId, result.filledOut, result.networkFee, `${result.txRef}:0`, now);
  });
  return orderView(db, userId, prepared.orderId);
}

export function settleFailure(db: DB, userId: string, orderId: string, reason: string, networkFee: string, now: number) {
  const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id);
  orderTransition(db, orderId, 'failed', { reason }, now);
  run(db, `UPDATE orders SET error = ?, fee_native = ? WHERE id = ?`, reason, networkFee, orderId);
  if (i?.reservation_id) releaseReservation(db, i.reservation_id);
  if (D.gt(networkFee, '0')) { // T24: a reverted tx still costs network fees; no fake holdings.
    const native = CHAIN_META[o.chain as Chain].native;
    adjustBalance(db, userId, i.wallet_id, native, D.neg(networkFee));
    journal(db, userId, o.mode, `fail:${orderId}`, 'failed_tx_fee', [[`wallet:${i.wallet_id}`, native, D.str(D.neg(networkFee))], ['fees:network', native, networkFee]]);
  }
  if (i) transitionIntent(db, i.id, 'completed', `ORDER_FAILED:${reason}`, now);
  notify(db, userId, 'order_failed', 'Order failed', `${o.side.toUpperCase()} failed: ${reason}`, `failed:${orderId}`);
  outbox(db, userId, `orders:${userId}`, { orderId, state: 'failed' });
}

function journal(db: DB, userId: string, mode: string, ref: string, kind: string, lines: [string, string, string][]) {
  const sums = new Map<string, D.Dec>();
  for (const [, asset, amt] of lines) sums.set(asset, D.add(sums.get(asset) ?? D.dec('0'), amt));
  for (const [asset, s] of sums) if (!D.isZero(s)) throw new Error(`UNBALANCED_JOURNAL ${asset} ${D.str(s)}`);
  const id = newId('je');
  run(db, `INSERT INTO journal_entries (id, user_id, mode, ref, kind, at) VALUES (?, ?, ?, ?, ?, ?)`, id, userId, mode, ref, kind, Date.now());
  for (const [acct, asset, amt] of lines) run(db, `INSERT INTO journal_lines (entry_id, account, asset, amount) VALUES (?, ?, ?, ?)`, id, acct, asset, amt);
}

/** Writes deduplicated fill, balanced journal, balances, lots; activates exits for acquired qty. */
export function applyFill(db: DB, userId: string, orderId: string, filledOut: string, networkFee: string, chainFillId: string, now: number) {
  const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  const dup = q1(db, `SELECT 1 FROM fills WHERE order_id = ? AND chain_fill_id = ?`, orderId, chainFillId);
  if (dup) return; // T15: duplicate delivery does not duplicate trades/P&L
  const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id);
  const native = CHAIN_META[o.chain as Chain].native; const nusd = nativeUsdOf(o.chain as Chain, now);
  // unit_usd = USD per token of this fill (buy: SOL in ÷ tokens out; sell: SOL out ÷ tokens in), excluding network fees.
  const fillUnitUsd = D.gt(o.side === 'buy' ? filledOut : o.amount_in, '0') ? D.str(D.rescale(o.side === 'buy' ? D.div(D.mul(o.amount_in, nusd), filledOut, 18) : D.div(D.mul(filledOut, nusd), o.amount_in, 18), 18)) : null;
  run(db, `INSERT INTO fills (id, order_id, chain_fill_id, qty_in, qty_out, fee_native, at, unit_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId('fil'), orderId, chainFillId, o.amount_in, filledOut, networkFee, now, fillUnitUsd);
  if (i.reservation_id) releaseReservation(db, i.reservation_id, true);
  const bucket = o.strategy_id ? (q1(db, `SELECT bucket FROM strategies WHERE id = ?`, o.strategy_id)?.bucket ?? o.strategy_id) : 'manual';
  const lot = q1(db, `SELECT * FROM position_lots WHERE wallet_id = ? AND chain = ? AND token = ? AND bucket = ?`, i.wallet_id, o.chain, o.token, bucket);
  let b: D.Bucket = lot ? { knownQty: D.dec(lot.known_qty), knownBasis: D.dec(lot.known_basis), unknownQty: D.dec(lot.unknown_qty), realized: D.dec(lot.realized), closedEpisodes: [] } : D.emptyBucket();
  if (o.side === 'buy') {
    adjustBalance(db, userId, i.wallet_id, native, D.neg(D.add(o.amount_in, networkFee)));
    adjustBalance(db, userId, i.wallet_id, o.token, D.dec(filledOut));
    journal(db, userId, o.mode, `fill:${orderId}:${chainFillId}`, 'buy', [
      [`wallet:${i.wallet_id}`, native, D.str(D.neg(D.add(o.amount_in, networkFee)))], ['market', native, o.amount_in], ['fees:network', native, networkFee],
      [`wallet:${i.wallet_id}`, o.token, filledOut], ['market', o.token, D.str(D.neg(filledOut))]]);
    const unitUsd = D.div(D.mul(o.amount_in, nusd), filledOut, 18);
    b = D.applyBuy(b, filledOut, D.str(unitUsd), D.str(D.mul(networkFee, nusd)));
  } else {
    adjustBalance(db, userId, i.wallet_id, o.token, D.neg(o.amount_in));
    adjustBalance(db, userId, i.wallet_id, native, D.sub(filledOut, networkFee));
    journal(db, userId, o.mode, `fill:${orderId}:${chainFillId}`, 'sell', [
      [`wallet:${i.wallet_id}`, o.token, D.str(D.neg(o.amount_in))], ['market', o.token, o.amount_in],
      [`wallet:${i.wallet_id}`, native, D.str(D.sub(filledOut, networkFee))], ['market', native, D.str(D.neg(filledOut))], ['fees:network', native, networkFee]]);
    const unitUsd = D.div(D.mul(filledOut, nusd), o.amount_in, 18);
    if (D.gt(o.amount_in, b.knownQty)) { /* sold more than known-basis qty in this bucket: realize only known part */ }
    const q = D.min(o.amount_in, b.knownQty);
    if (D.gt(q, '0')) b = D.applySell(b, D.str(q), D.str(unitUsd), D.str(D.mul(networkFee, nusd))).bucket;
  }
  if (lot) run(db, `UPDATE position_lots SET known_qty = ?, known_basis = ?, realized = ?, opened_at = CASE WHEN ? THEN ? ELSE opened_at END, version = version + 1 WHERE id = ?`,
    D.str(b.knownQty), D.str(b.knownBasis), D.str(b.realized), o.side === 'buy' && D.isZero(lot.known_qty) ? 1 : 0, now, lot.id); // a buy into a flat lot starts a new episode (entry price counts from here)
  else run(db, `INSERT INTO position_lots (id, user_id, wallet_id, chain, token, bucket, known_qty, known_basis, realized, opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, newId('lot'), userId, i.wallet_id, o.chain, o.token, bucket, D.str(b.knownQty), D.str(b.knownBasis), D.str(b.realized), now);
  run(db, `UPDATE orders SET filled_out = ?, fee_native = ? WHERE id = ?`, filledOut, networkFee, orderId);
  orderTransition(db, orderId, 'confirmed', { filledOut }, now);
  orderTransition(db, orderId, 'finalized', { note: 'paper simulator: confirmed=finalized' }, now);
  transitionIntent(db, i.id, 'completed', null, now);
  notify(db, userId, 'order_filled', `${o.side === 'buy' ? 'Bought' : 'Sold'} (${o.mode})`, `${o.side} ${o.amount_in} → ${filledOut}`, `filled:${orderId}`);
  outbox(db, userId, `orders:${userId}`, { orderId, state: 'finalized' });
  // Referral commissions: only actual collected JGG fees accrue. Paper/demo never accrue (T49/T55).
}

/** Reconcile an uncertain order against external truth (paper chain). Never resubmits. */
export function reconcileOrder(db: DB, userId: string, orderId: string, now: number) {
  return tx(db, () => {
    const o = q1(db, `SELECT * FROM orders WHERE id = ? AND user_id = ?`, orderId, userId);
    if (!o) throw new ApiError('NOT_FOUND', 'Order not found', 404);
    if (o.state !== 'reconciliation_required') return { orderId, state: o.state, action: 'none' };
    if (o.mode === 'live') return { orderId, state: o.state, action: 'deferred_to_live_reconciler' };
    const truth = q1(db, `SELECT * FROM paper_chain WHERE tx_ref = ?`, o.tx_ref);
    if (!truth) return { orderId, state: o.state, action: 'unresolved', note: 'No evidence yet; operation stays paused' };
    if (truth.landed) {
      orderTransition(db, orderId, 'submitted', { reconciled: true }, now);
      applyFill(db, userId, orderId, truth.filled_out, truth.fee, `${o.tx_ref}:0`, now);
      audit(db, userId, 'reconciler', 'order.reconciled', { orderId, outcome: 'landed' });
      return { orderId, state: 'finalized', action: 'restored_fill' };
    }
    // Definitive not-landed evidence (paper chain says the tx cannot land) -> expired, release.
    orderTransition(db, orderId, 'expired', { reconciled: true, reason: 'TX_NOT_LANDED_AND_EXPIRED' }, now);
    const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id);
    if (i?.reservation_id) releaseReservation(db, i.reservation_id);
    if (i) transitionIntent(db, i.id, 'completed', 'ORDER_EXPIRED', now);
    audit(db, userId, 'reconciler', 'order.reconciled', { orderId, outcome: 'not_landed' });
    return { orderId, state: 'expired', action: 'released' };
  });
}

/**
 * Paper only: an order left in 'submitting' means the process stopped between persisting the order and recording the
 * simulator's outcome. The simulator is in-process, so nothing executed: expire it (via reconciliation_required) and release
 * its reservation, so the strategy that owns it can decide again. Live orders are never touched here (the chain is the truth).
 */
export function expireInterruptedPaperOrders(db: DB, now: number, olderThanMs = 30_000) {
  const rows = qa(db, `SELECT id, user_id, intent_id FROM orders WHERE mode != 'live' AND state = 'submitting' AND updated_at < ? LIMIT 100`, now - olderThanMs);
  for (const o of rows) tx(db, () => {
    orderTransition(db, o.id, 'reconciliation_required', { reason: 'PAPER_DISPATCH_INTERRUPTED' }, now);
    const pc = q1(db, `SELECT tx_ref FROM paper_chain WHERE order_id = ?`, o.id);
    if (pc) { run(db, `UPDATE orders SET tx_ref = COALESCE(tx_ref, ?) WHERE id = ?`, pc.tx_ref, o.id); return; } // simulated chain has a record: reconcileOrder applies that truth
    orderTransition(db, o.id, 'expired', { reason: 'PAPER_DISPATCH_INTERRUPTED', note: 'In-process simulator never produced an outcome; nothing executed.' }, now);
    const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id);
    if (i?.reservation_id) releaseReservation(db, i.reservation_id);
    if (i && i.state === 'executing') transitionIntent(db, i.id, 'completed', 'ORDER_EXPIRED', now);
    audit(db, o.user_id, 'reconciler', 'order.interrupted_paper_expired', { orderId: o.id });
  });
  return rows.length;
}

export function cancelOrder(db: DB, userId: string, orderId: string, now: number) {
  return tx(db, () => {
    const o = q1(db, `SELECT * FROM orders WHERE id = ? AND user_id = ?`, orderId, userId);
    if (!o) {
      const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ?`, orderId, userId);
      if (!s) throw new ApiError('NOT_FOUND', 'Order not found', 404);
      if (['cancelled', 'completed', 'expired'].includes(s.lifecycle)) return { id: orderId, state: s.lifecycle, cancelled: false };
      run(db, `UPDATE strategies SET lifecycle = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?`, now, orderId);
      return { id: orderId, state: 'cancelled', cancelled: true };
    }
    const cancellable: D.OrderState[] = ['created', 'validated', 'waiting_trigger', 'triggered', 'awaiting_signature'];
    if (!cancellable.includes(o.state)) throw new ApiError('CANCEL_TOO_LATE', `Order is ${o.state}; a dispatched blockchain transaction cannot be cancelled.`, 409, false, { state: o.state });
    orderTransition(db, orderId, 'cancelled', { by: 'user' }, now);
    const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id);
    if (i?.reservation_id) releaseReservation(db, i.reservation_id);
    return { id: orderId, state: 'cancelled', cancelled: true };
  });
}

export function orderView(db: DB, userId: string, id: string) {
  const o = q1(db, `SELECT * FROM orders WHERE id = ? AND user_id = ?`, id, userId);
  if (!o) throw new ApiError('NOT_FOUND', 'Order not found', 404);
  const events = qa(db, `SELECT from_state, to_state, version, detail, at FROM order_events WHERE order_id = ? ORDER BY version`, id);
  return { id: o.id, state: o.state, mode: o.mode, chain: o.chain, token: o.token, side: o.side, amountIn: o.amount_in, minOut: o.min_out, filledOut: o.filled_out, feeNative: o.fee_native,
    txRef: o.tx_ref, provider: o.provider, error: o.error, createdAt: new Date(o.created_at).toISOString(), strategyId: o.strategy_id,
    events: events.map(e => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null, at: new Date(e.at).toISOString() })) };
}

export function listOrders(db: DB, userId: string, cursor: string | null, limit: number) {
  const rows = cursor
    ? qa(db, `SELECT id, created_at FROM orders WHERE user_id = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`, userId, Number(cursor.split(':')[0]), cursor.split(':')[1], limit + 1)
    : qa(db, `SELECT id, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, userId, limit + 1);
  const page = rows.slice(0, limit);
  return { rows: page.map(r => orderView(db, userId, r.id)), nextCursor: rows.length > limit ? `${page[page.length - 1].created_at}:${page[page.length - 1].id}` : null };
}

// ---------------- Portfolio (spec §14) ----------------
export function portfolio(db: DB, userId: string, chain: Chain, now: number) {
  const { mode } = getMode(db, userId);
  const wallets = qa(db, `SELECT id, address, label, custody FROM wallets WHERE user_id = ? AND chain = ? ORDER BY label`, userId, chain);
  const native = CHAIN_META[chain].native; const nusd = nativeUsdOf(chain, now);
  const balances = qa(db, `SELECT wallet_id, asset, qty, reserved FROM paper_balances WHERE user_id = ? AND wallet_id IN (SELECT id FROM wallets WHERE user_id = ? AND chain = ?)`, userId, userId, chain);
  const lots = qa(db, `SELECT * FROM position_lots WHERE user_id = ? AND chain = ?`, userId, chain);
  let equity = D.dec('0'); let unrealized = D.dec('0'); let realized = D.dec('0'); const unpriced: string[] = [];
  for (const b of balances) if (b.asset === native) equity = D.add(equity, D.mul(b.qty, nusd));
  const positions = lots.map(l => {
    const src = getMarketSource(); const live = src && src.kind !== 'fixture';
    const t = live ? null : findFixtureToken(chain, l.token); const p: number | string | null = live ? src!.priceUsd(chain, l.token, now) : t ? priceAt(t, now) : null;
    const bucket: D.Bucket = { knownQty: D.dec(l.known_qty), knownBasis: D.dec(l.known_basis), unknownQty: D.dec(l.unknown_qty), realized: D.dec(l.realized), closedEpisodes: [] };
    const m = D.markToMarket(bucket, p === null ? null : typeof p === 'string' ? p : num(p));
    realized = D.add(realized, l.realized);
    if (m) { equity = D.add(equity, m.markValue); unrealized = D.add(unrealized, m.unrealized); } else if (D.gt(l.known_qty, '0')) unpriced.push(l.token);
    const avg = D.averageBasis(bucket);
    return { id: l.id, walletId: l.wallet_id, token: l.token, symbol: t?.symbol ?? (getMarketSource()?.kind === 'solana_live' ? (q1(db, `SELECT symbol FROM live_tokens WHERE mint = ?`, l.token)?.symbol ?? '?') : '?'), bucket: l.bucket, qty: l.known_qty, basisUsd: D.fixed(l.known_basis, 2), avgPriceUsd: avg ? D.str(D.rescale(avg, 12)) : null,
      priceUsd: p === null ? null : typeof p === 'string' ? p : num(p), valueUsd: m ? D.fixed(m.markValue, 2) : null, unrealizedUsd: m ? D.fixed(m.unrealized, 2) : null, realizedUsd: D.fixed(l.realized, 2), closed: D.isZero(l.known_qty) };
  });
  return { mode, chain, simulated: true, dataSource: getMarketSource()?.kind ?? 'fixture', wallets, balances, positions, totals: { equityUsd: D.fixed(equity, 2), unrealizedUsd: D.fixed(unrealized, 2), realizedUsd: D.fixed(realized, 2), unpriced,
    note: unpriced.length ? 'Some holdings are unpriced; totals exclude them and are incomplete.' : 'Mark value, not executable liquidation value.' } };
}
