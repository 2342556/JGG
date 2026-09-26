// Position exit system (owner spec 2026-09-26) — the durable, idempotent shell around the pure state machine in
// packages/domain/src/exitPlan.ts.
//
// Order safety model:
//  • Write-ahead: the exit order row (id = `<strategy>:<rule>:<seq>`) and the strategy state that points at it are saved in ONE
//    transaction BEFORE any quote/intent/order exists. That id is the idempotency key for the intent and the execution.
//  • One exit order in flight per position (DB unique index), and the partial take-profit can be FILLED only once (DB unique index).
//  • Definitive failure (reverted, expired, rejected before sending) → the next attempt gets a NEW id after a backoff.
//    Uncertain (sent, outcome unknown) → wait for reconciliation; never resubmit blindly.
//  • Restart: a `planned` row found on a later tick is resumed through its idempotency record (existing intent/order), or, if
//    nothing was ever created, closed as not-sent and re-decided on a fresh price.
//  • Quantities: min(plan, tokens actually available), floored to token decimals. Every decision and transition is logged.
import { type DB, tx, q1, qa, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import * as D from '../../../packages/domain/src/index.ts';
import { type Chain } from '../../../packages/contracts/src/index.ts';
import { findFixtureToken } from '../../../packages/test-fixtures/src/index.ts';
import { getMarketSource, paperQuote, type PriceObs } from '../../../packages/providers/src/execution.ts';
import { notify, audit, executeIntent } from './trading.ts';
import { submit, strategyEvent, saveStrategy, observePrice, positionOf, strategyView } from './strategies.ts';

/** Tests only: simulate a process crash at a precise point (after the write-ahead commit / after the order was sent). */
export const _testHooks: { crash: null | 'after_plan' | 'after_submit' } = { crash: null };
export const EXIT_STALE_MS = 30_000;   // a price older than this never triggers a sale
export const DUST_USD = '0.01';        // below this value a sale is not attempted (and the remainder is reported as dust)

export function tokenDecimals(chain: string, token: string): number {
  const src = getMarketSource(); if (src && src.kind !== 'fixture') return 6; // pump.fun mints: 6 decimals
  return findFixtureToken(chain as Chain, token)?.decimals ?? 6;
}

/** Actual average FILL price (USD/token) of the manual position in this wallet since it was last flat, and the tokens held. */
export function manualPositionEntry(db: DB, userId: string, walletId: string, chain: string, token: string): { entry: string; qty: string; basis: 'fills' | 'average_cost' } | null {
  const lot = q1(db, `SELECT * FROM position_lots WHERE user_id = ? AND wallet_id = ? AND chain = ? AND token = ? AND bucket = 'manual'`, userId, walletId, chain, token);
  if (!lot || !D.gt(lot.known_qty, '0')) return null;
  const pos = positionOf(db, userId, walletId, chain, token);
  const qty = D.str(D.min(lot.known_qty, D.max('0', pos.available)));
  const fills = qa(db, `SELECT f.qty_out, f.unit_usd FROM fills f JOIN orders o ON o.id = f.order_id JOIN trade_intents i ON i.id = o.intent_id
    WHERE i.user_id = ? AND i.wallet_id = ? AND o.chain = ? AND o.token = ? AND o.side = 'buy' AND o.strategy_id IS NULL AND f.at >= ?`, userId, walletId, chain, token, lot.opened_at);
  if (fills.length && fills.every(f => f.unit_usd)) {
    let q = D.dec('0'); let v = D.dec('0'); for (const f of fills) { q = D.add(q, f.qty_out); v = D.add(v, D.mul(f.qty_out, f.unit_usd)); }
    if (D.gt(q, '0')) return { entry: D.str(D.rescale(D.div(v, q, 18), 18)), qty, basis: 'fills' };
  }
  // Older fills without a recorded unit price: weighted average cost (includes network fees) — disclosed as such.
  return { entry: D.str(D.rescale(D.div(lot.known_basis, lot.known_qty, 18), 18)), qty, basis: 'average_cost' };
}

/** Create the state for a new position_exit strategy (called from createStrategy). */
export function initialExitState(db: DB, userId: string, walletId: string, chain: string, token: string, p: any) {
  const cfg = D.normalizeExitConfig(p.exit);
  const issues = D.validateExitConfig(cfg);
  if (issues.length) throw new ApiError('VALIDATION_FAILED', issues.map(i => i.message).join('; '), 400, false, { issues });
  let entry: string | undefined = p.entryUsd; let qty: string | undefined = p.qty; let basis = p.entrySource ?? 'fill';
  if (!entry || !qty) {
    const m = manualPositionEntry(db, userId, walletId, chain, token);
    if (!m) throw new ApiError('VALIDATION_FAILED', 'No position you bought manually for this coin in this wallet. Exits need a real entry fill and quantity.', 400, false, { code: 'NO_POSITION' });
    entry = m.entry; qty = m.qty; basis = m.basis;
  }
  p.exit = cfg; p.entryUsd = entry; p.qty = qty; p.entrySource = basis;
  return D.newExitState(cfg, entry, qty, tokenDecimals(chain, token));
}

// ---------------- Evaluation ----------------
type Row = any;
const symOf = (db: DB, s: Row): string => findFixtureToken(s.chain, s.token)?.symbol ?? q1(db, `SELECT symbol FROM live_tokens WHERE mint = ?`, s.token)?.symbol ?? String(s.token).slice(0, 6);
const log = (db: DB, s: Row, events: D.ExitEvent[], now: number, extra: Record<string, unknown> = {}) => { for (const e of events) strategyEvent(db, s.id, `exit.${e.kind}`, { ...e.detail, ...extra }, null, now); };

function observe(db: DB, s: Row, st: D.ExitState, now: number): D.Observation {
  const obs: PriceObs = observePrice(s.chain, s.token, now);
  const pos = positionOf(db, s.user_id, s.wallet_id, s.chain, s.token);
  const dust = obs.usd && D.gt(obs.usd, '0') ? D.str(D.rescale(D.div(DUST_USD, obs.usd, 18), st.decimals, 'ceil')) : undefined;
  return { now, price: obs.usd, priceAt: obs.at, staleReason: obs.staleReason, heldQty: D.str(D.max('0', pos.available)), staleAfterMs: EXIT_STALE_MS, dustQty: dust };
}

const TERMINAL_FAIL = new Set(['failed', 'expired', 'cancelled']);
function orderOutcome(o: any, pendingId: string): D.OrderResult | null {
  if (!o) return null;
  if (o.state === 'finalized') return { id: pendingId, outcome: 'filled', soldQty: o.amount_in };
  if (TERMINAL_FAIL.has(o.state)) return { id: pendingId, outcome: 'failed', reason: o.error ?? `ORDER_${String(o.state).toUpperCase()}` };
  return null; // created/submitting/submitted/confirmed/reconciliation_required: outcome not known yet
}

/** Try to resolve the pending exit. fresh = planned in this very evaluation (so it must be sent now). */
function resolvePending(db: DB, s: Row, st: D.ExitState, now: number, fresh: boolean, fault?: any): D.OrderResult | null {
  const p = st.pending!; const eo = q1(db, `SELECT * FROM exit_orders WHERE id = ?`, p.id);
  if (eo?.order_id) {
    const r = orderOutcome(q1(db, `SELECT state, amount_in, error FROM orders WHERE id = ?`, eo.order_id), p.id);
    if (!r) strategyEvent(db, s.id, 'exit.awaiting_settlement', { id: p.id, orderId: eo.order_id }, `${p.id}:await`, now);
    return r;
  }
  if (!fresh) { // restart / crash recovery: find what (if anything) was created under this id
    const rec = q1(db, `SELECT response FROM idempotency_keys WHERE user_id = ? AND scope = 'intent.create' AND key = ?`, s.user_id, `${p.id}:intent`);
    if (!rec?.response) { strategyEvent(db, s.id, 'exit.recovered_not_sent', { id: p.id }, null, now); return { id: p.id, outcome: 'failed', reason: 'NOT_SENT_BEFORE_RESTART' }; }
    const intent = JSON.parse(rec.response);
    const i = q1(db, `SELECT order_id, state FROM trade_intents WHERE id = ?`, intent.id);
    if (i?.order_id) { run(db, `UPDATE exit_orders SET intent_id = ?, order_id = ?, state = 'submitted', updated_at = ? WHERE id = ?`, intent.id, i.order_id, now, p.id); strategyEvent(db, s.id, 'exit.recovered_order', { id: p.id, orderId: i.order_id }, null, now);
      return orderOutcome(q1(db, `SELECT state, amount_in, error FROM orders WHERE id = ?`, i.order_id), p.id); }
    try { // intent exists but never executed: execute under the same idempotent key, or learn it can no longer be sent
      const o = executeIntent(db, s.user_id, intent.id, now, `${p.id}:exec`, fault ?? 'none', `strategy:${s.id}`);
      run(db, `UPDATE exit_orders SET intent_id = ?, order_id = ?, state = 'submitted', updated_at = ? WHERE id = ?`, intent.id, o.id, now, p.id);
      return orderOutcome(q1(db, `SELECT state, amount_in, error FROM orders WHERE id = ?`, o.id), p.id);
    } catch (e) { return { id: p.id, outcome: 'failed', reason: `NOT_SENT:${(e as any).code ?? 'ERROR'}` }; }
  }
  const r = submit(db, s, { side: 'sell', amount: p.qty, key: p.id, riskReducing: true }, now, fault);
  if (_testHooks.crash === 'after_submit') throw new Error('SIMULATED_CRASH_AFTER_SUBMIT');
  if (!r.ok) {
    strategyEvent(db, s.id, 'exit.not_sent', { id: p.id, code: r.code, message: r.message }, null, now);
    return { id: p.id, outcome: 'failed', reason: r.code };
  }
  run(db, `UPDATE exit_orders SET intent_id = (SELECT intent_id FROM orders WHERE id = ?), order_id = ?, state = 'submitted', updated_at = ? WHERE id = ?`, r.order.id, r.order.id, now, p.id);
  strategyEvent(db, s.id, 'exit.order_sent', { id: p.id, orderId: r.order.id, state: r.order.state, qty: p.qty, rule: p.rule }, null, now);
  return orderOutcome(q1(db, `SELECT state, amount_in, error FROM orders WHERE id = ?`, r.order.id), p.id);
}

function settle(db: DB, s: Row, st: D.ExitState, r: D.OrderResult, now: number): D.ExitState {
  const p = st.pending!;
  const step = D.applyOrderResult(st, r, now);
  if (r.outcome === 'filled') {
    try { run(db, `UPDATE exit_orders SET state = 'filled', sold_qty = ?, updated_at = ? WHERE id = ?`, r.soldQty, now, p.id); }
    catch (e) { strategyEvent(db, s.id, 'exit.invariant_violation', { id: p.id, message: (e as Error).message }, null, now); throw e; } // e.g. a second filled partial: refuse
  } else if (r.outcome === 'failed') run(db, `UPDATE exit_orders SET state = 'failed', reason = ?, updated_at = ? WHERE id = ?`, r.reason, now, p.id);
  log(db, s, step.events, now);
  const sym = symOf(db, s);
  for (const e of step.events) {
    if (e.kind === 'order_filled') notify(db, s.user_id, 'exit_filled', p.rule === 'partial_tp' ? 'Partial profit taken' : p.rule === 'stop_loss' ? 'Stop-loss sold' : 'Trailing stop sold', `${sym}: sold ${(e.detail as any).sold} tokens (${s.mode}).`, `exitfill:${p.id}`);
    if (e.kind === 'order_failed') notify(db, s.user_id, 'unprotected', 'Exit sale failed — retrying', `${sym} ${p.rule.replace('_', ' ')}: ${r.outcome === 'failed' ? r.reason : ''}. JGG retries automatically; the position stays protected by the plan.`, `exitfail:${p.id}`);
    if (e.kind === 'needs_attention') notify(db, s.user_id, 'unprotected', 'Exit needs your attention', `${sym}: ${p.rule.replace('_', ' ')} failed ${(e.detail as any).failures} times in a row (${(e.detail as any).reason}). Check the coin and your SOL balance for fees.`, `exitattn:${s.id}:${st.seq}`);
    if (e.kind === 'short_fill') notify(db, s.user_id, 'exit_filled', 'Partial fill', `${sym}: planned ${(e.detail as any).planned}, sold ${(e.detail as any).sold}. Not topped up (sells once).`, `short:${p.id}`);
  }
  return step.state;
}

export function evalPositionExit(db: DB, s: Row, now: number, fault?: any): string {
  let st: D.ExitState = JSON.parse(s.state);
  if (st.status === 'closed') { saveStrategy(db, s, st, 'completed', st.closeReason, now); return 'closed'; }
  if (st.pending) {
    const r = resolvePending(db, s, st, now, false, fault);
    if (!r) { saveStrategy(db, s, st, 'active', 'PENDING_SETTLEMENT', now); return 'awaiting_settlement'; }
    st = settle(db, s, st, r, now);
    if (st.status === 'closed') { saveStrategy(db, s, st, 'completed', st.closeReason, now); return `closed:${st.closeReason}`; }
  }
  const obs = observe(db, s, st, now);
  const step = D.decideExit(st, obs, s.id);
  log(db, s, step.events, now, obs.price ? { price: obs.price } : {});
  if (step.events.some(e => e.kind === 'price_stale')) notify(db, s.user_id, 'unprotected', 'Exit protection waiting for a price', `${symOf(db, s)}: ${obs.staleReason ?? 'price unavailable'}. Nothing is sold on an old price; exits resume when a fresh price arrives.`, `stale:${s.id}:${step.state.staleSince}`);
  st = step.state;
  if (!step.order) { saveStrategy(db, s, st, st.status === 'closed' ? 'completed' : 'active', st.status === 'closed' ? st.closeReason : null, now); return st.status === 'closed' ? `closed:${st.closeReason}` : 'waiting'; }
  const o = step.order;
  tx(db, () => { // write-ahead: the planned order and the state that references it commit together
    run(db, `INSERT INTO exit_orders (id, user_id, strategy_id, rule, qty, trigger_price, observed_price, state, planned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      o.id, s.user_id, s.id, o.rule, o.qty, o.triggerPrice, o.observedPrice, now, now);
    saveStrategy(db, s, st, 'active', null, now);
  });
  audit(db, s.user_id, `strategy:${s.id}`, 'exit.plan', { id: o.id, rule: o.rule, qty: o.qty, trigger: o.triggerPrice, price: o.observedPrice, mode: s.mode });
  if (_testHooks.crash === 'after_plan') throw new Error('SIMULATED_CRASH_AFTER_PLAN');
  const r = resolvePending(db, s, st, now, true, fault);
  if (!r) { saveStrategy(db, s, st, 'active', 'PENDING_SETTLEMENT', now); return `pending:${o.rule}`; }
  st = settle(db, s, st, r, now);
  const lc = st.status === 'closed' ? 'completed' : 'active';
  if (r.outcome === 'failed' && (r.reason === 'AUTOMATION_STOPPED' || r.reason === 'POLICY_VERSION_CHANGED')) {
    saveStrategy(db, s, st, 'paused', r.reason, now);
    notify(db, s.user_id, 'unprotected', 'Exits paused', `${symOf(db, s)}: automation is stopped (${r.reason}), so the ${o.rule.replace('_', ' ')} was not sent. Resume to re-protect the position.`, `exitpause:${s.id}:${st.seq}`);
    return `paused:${r.reason}`;
  }
  saveStrategy(db, s, st, lc, st.status === 'closed' ? st.closeReason : null, now);
  return r.outcome === 'filled' ? `exit_${o.rule}` : `exit_failed:${r.outcome === 'failed' ? r.reason : ''}`;
}

// ---------------- Presets ----------------
export const BUILTIN_EXIT_PRESETS: { name: string; config: D.ExitConfig; blurb: string }[] = [
  { name: 'Conservative', blurb: 'Tight stop, early profit', config: { stopLoss: { enabled: true, pct: '15' }, partialTp: { enabled: true, triggerPct: '50', sellPct: '50' }, trailing: { enabled: true, pct: '15', activation: 'after_partial' } } },
  { name: 'Balanced', blurb: 'The default', config: D.DEFAULT_EXIT_CONFIG },
  { name: 'Aggressive', blurb: 'Room to run', config: { stopLoss: { enabled: true, pct: '30' }, partialTp: { enabled: true, triggerPct: '150', sellPct: '40' }, trailing: { enabled: true, pct: '25', activation: 'after_partial' } } },
];
export function listExitPresets(db: DB, userId: string) {
  const mine = qa(db, `SELECT id, name, config, version, updated_at FROM exit_presets WHERE user_id = ? ORDER BY name`, userId).map(r => ({ id: r.id, name: r.name, config: JSON.parse(r.config), version: r.version, builtin: false, updatedAt: new Date(r.updated_at).toISOString() }));
  return [...BUILTIN_EXIT_PRESETS.map(p => ({ id: `builtin:${p.name}`, name: p.name, config: p.config, version: 0, builtin: true, blurb: p.blurb })), ...mine];
}
export function saveExitPreset(db: DB, userId: string, body: { name: string; config: any; version?: number }, now: number) {
  const name = body.name.trim(); if (BUILTIN_EXIT_PRESETS.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new ApiError('VALIDATION_FAILED', `"${name}" is a built-in preset name; choose another`, 400);
  const cfg = D.normalizeExitConfig(body.config); const issues = D.validateExitConfig(cfg);
  if (issues.length) throw new ApiError('VALIDATION_FAILED', issues.map(i => i.message).join('; '), 400, false, { issues });
  return tx(db, () => {
    const cur = q1(db, `SELECT id, version FROM exit_presets WHERE user_id = ? AND name = ?`, userId, name);
    if (cur) {
      if (body.version !== undefined && body.version !== cur.version) throw new ApiError('VERSION_CONFLICT', 'Preset changed elsewhere; reload', 409, true);
      run(db, `UPDATE exit_presets SET config = ?, version = version + 1, updated_at = ? WHERE id = ?`, JSON.stringify(cfg), now, cur.id);
    } else run(db, `INSERT INTO exit_presets (id, user_id, name, config, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`, newId('xps'), userId, name, JSON.stringify(cfg), now, now);
    audit(db, userId, 'user', 'exit_preset.save', { name, config: cfg });
    return listExitPresets(db, userId).find(p => p.name === name);
  });
}
export function deleteExitPreset(db: DB, userId: string, id: string) {
  const n = Number(run(db, `DELETE FROM exit_presets WHERE id = ? AND user_id = ?`, id, userId).changes);
  if (!n) throw new ApiError('NOT_FOUND', 'Preset not found', 404);
  audit(db, userId, 'user', 'exit_preset.delete', { id }); return { deleted: true };
}

// ---------------- Preview & override ----------------
export function exitPreview(db: DB, userId: string | null, b: { config: any; chain: string; tokenAddress?: string; walletId?: string; amount?: string; strategyId?: string }, now: number) {
  const cfg = D.normalizeExitConfig(b.config);
  let basis: 'position' | 'strategy' | 'estimate' | 'none' = 'none'; let entry: string | null = null; let qty: string | null = null; let decimals = 6; let note = '';
  if (b.strategyId && userId) {
    const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ? AND kind = 'position_exit'`, b.strategyId, userId);
    if (!s) throw new ApiError('NOT_FOUND', 'Exit plan not found', 404);
    const st: D.ExitState = JSON.parse(s.state); basis = 'strategy'; entry = st.entry; qty = st.managedQty; decimals = st.decimals; note = 'Exact: your actual average fill price and the tokens this plan manages now.';
  } else if (b.tokenAddress && b.walletId && userId) {
    const m = manualPositionEntry(db, userId, b.walletId, b.chain, b.tokenAddress);
    if (m) { basis = 'position'; entry = m.entry; qty = m.qty; decimals = tokenDecimals(b.chain, b.tokenAddress); note = m.basis === 'fills' ? 'Exact: your actual average fill price and tokens held.' : 'Entry = average cost including network fees (older fills have no recorded fill price).'; }
  }
  if (basis === 'none' && b.tokenAddress && b.amount) {
    const q = paperQuote(b.chain as Chain, b.tokenAddress, 'buy', b.amount, 500, now);
    if (q.ok && D.gt(q.quote.expectedOut, '0')) { basis = 'estimate'; qty = q.quote.expectedOut; decimals = tokenDecimals(b.chain, b.tokenAddress); entry = D.gt(q.quote.executionPriceUsd, '0') ? q.quote.executionPriceUsd : null;
      note = 'Estimate from the current quote. Exact prices and quantities are set from the real fill when the buy completes.'; }
  }
  const preview = entry && qty ? D.previewExitPlan(cfg, entry, qty, decimals) : { issues: D.validateExitConfig(cfg), entry, qty, stopLoss: null, partialTp: null, trailing: null };
  return { basis, note, decimals, ...preview };
}

export function overrideExit(db: DB, userId: string, id: string, body: { config: any; version: number }, now: number) {
  return tx(db, () => {
    const s = q1(db, `SELECT * FROM strategies WHERE id = ? AND user_id = ?`, id, userId);
    if (!s || s.kind !== 'position_exit') throw new ApiError('NOT_FOUND', 'Exit plan not found', 404);
    if (body.version !== s.version) throw new ApiError('VERSION_CONFLICT', 'This position changed since you opened it; reload and review the new numbers', 409, true);
    const cfg = D.normalizeExitConfig(body.config); const issues = D.validateExitConfig(cfg);
    if (issues.length) throw new ApiError('VALIDATION_FAILED', issues.map(i => i.message).join('; '), 400, false, { issues });
    let step: D.Step;
    try { step = D.overrideExitConfig(JSON.parse(s.state), cfg, now); } catch (e) { throw new ApiError('INVALID_TRANSITION', (e as Error).message, 409); }
    const p = JSON.parse(s.params); p.exit = cfg;
    run(db, `UPDATE strategies SET params = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ?`, JSON.stringify(p), JSON.stringify(step.state), now, id);
    log(db, s, step.events, now);
    audit(db, userId, 'user', 'exit.override', { id, config: cfg });
    return strategyView(db, userId, id);
  });
}

/** Open exit orders for other tokens must not freeze this position's protection (see evaluateAll). */
export function hasUncertainOrderFor(db: DB, userId: string, token: string) {
  return !!q1(db, `SELECT 1 FROM orders WHERE user_id = ? AND token = ? AND state = 'reconciliation_required'`, userId, token);
}
