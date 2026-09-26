// Position exit plan (owner spec 2026-09-26): initial stop-loss, one-time partial take-profit by token quantity,
// and a trailing stop that follows the highest price observed after it activates. Pure and deterministic:
// the API persists ExitState as JSON after every step, so a restart resumes exactly where it stopped.
//
// Units: every price is USD per token (owner's choice). Quantities are token amounts, floored to the token's
// decimals so JGG never tries to sell more than it holds. Percentages are decimal strings ("20" = 20 %).
import { dec, add, sub, mul, div, gte, lte, gt, lt, max, str, rescale, isZero, type Dec } from './decimal.ts';

export type TrailActivation = 'after_partial' | 'at_gain' | 'immediate';
export type ExitConfig = {
  stopLoss: { enabled: boolean; pct: string };                                   // sell everything at entry × (1 − pct)
  partialTp: { enabled: boolean; triggerPct: string; sellPct: string };          // once, at entry × (1 + triggerPct): sell sellPct of tokens held
  trailing: { enabled: boolean; pct: string; activation: TrailActivation; activationGainPct?: string }; // trigger = peak × (1 − pct)
};
export type ExitRule = 'stop_loss' | 'partial_tp' | 'trailing';
export type ConfigIssue = { field: string; code: string; message: string };

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopLoss: { enabled: true, pct: '20' },
  partialTp: { enabled: true, triggerPct: '100', sellPct: '50' },
  trailing: { enabled: true, pct: '20', activation: 'after_partial' },
};

const PCT = /^\d{1,6}(\.\d{1,4})?$/;
/** Every problem with a config, for the UI and the API. Nothing is clamped or substituted. */
export function validateExitConfig(c: ExitConfig): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const pct = (field: string, v: unknown, lo: string, hi: string, loIncl: boolean, hiIncl: boolean, label: string) => {
    if (typeof v !== 'string' || !PCT.test(v)) { out.push({ field, code: 'NOT_A_NUMBER', message: `${label}: enter a number like 20 or 12.5` }); return; }
    const okLo = loIncl ? gte(v, lo) : gt(v, lo); const okHi = hiIncl ? lte(v, hi) : lt(v, hi);
    if (!okLo || !okHi) out.push({ field, code: 'OUT_OF_RANGE', message: `${label} must be ${loIncl ? 'at least' : 'more than'} ${lo}% and ${hiIncl ? 'at most' : 'less than'} ${hi}%` });
  };
  if (!c || typeof c !== 'object' || !c.stopLoss || !c.partialTp || !c.trailing) return [{ field: 'config', code: 'MALFORMED', message: 'Exit plan is incomplete' }];
  if (c.stopLoss.enabled) pct('stopLoss.pct', c.stopLoss.pct, '0', '100', false, false, 'Stop loss');
  if (c.partialTp.enabled) {
    pct('partialTp.triggerPct', c.partialTp.triggerPct, '0', '100000', false, true, 'Take-profit trigger');
    pct('partialTp.sellPct', c.partialTp.sellPct, '0', '100', false, true, 'Take-profit sell amount');
  }
  if (c.trailing.enabled) {
    pct('trailing.pct', c.trailing.pct, '0', '100', false, false, 'Trailing distance');
    if (!['after_partial', 'at_gain', 'immediate'].includes(c.trailing.activation)) out.push({ field: 'trailing.activation', code: 'INVALID', message: 'Choose when trailing starts' });
    if (c.trailing.activation === 'at_gain') pct('trailing.activationGainPct', c.trailing.activationGainPct, '0', '100000', true, true, 'Trailing start gain');
    if (c.trailing.activation === 'after_partial') {
      if (!c.partialTp.enabled) out.push({ field: 'trailing.activation', code: 'TRAIL_NEEDS_PARTIAL', message: 'Trailing is set to start after the partial take-profit, but the partial take-profit is off' });
      else if (PCT.test(c.partialTp.sellPct) && gte(c.partialTp.sellPct, '100')) out.push({ field: 'trailing.activation', code: 'TRAIL_NOTHING_LEFT', message: 'The partial take-profit sells 100%, so nothing is left for the trailing stop' });
    }
  }
  if (!c.stopLoss.enabled && !c.partialTp.enabled && !c.trailing.enabled) out.push({ field: 'config', code: 'NO_RULES', message: 'Turn on at least one rule' });
  return out;
}
export function assertValidExitConfig(c: ExitConfig): void {
  const e = validateExitConfig(c); if (e.length) throw Object.assign(new Error(`EXIT_CONFIG_INVALID: ${e.map(x => x.message).join('; ')}`), { code: 'EXIT_CONFIG_INVALID', issues: e });
}
/** Normalizes a config (drops unknown keys) so what is stored is exactly what was validated. */
export function normalizeExitConfig(c: any): ExitConfig {
  const b = (v: any) => v === true;
  const s = (v: any) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : v);
  const act = c?.trailing?.activation;
  return {
    stopLoss: { enabled: b(c?.stopLoss?.enabled), pct: s(c?.stopLoss?.pct) },
    partialTp: { enabled: b(c?.partialTp?.enabled), triggerPct: s(c?.partialTp?.triggerPct), sellPct: s(c?.partialTp?.sellPct) },
    trailing: { enabled: b(c?.trailing?.enabled), pct: s(c?.trailing?.pct), activation: act, ...(act === 'at_gain' ? { activationGainPct: s(c?.trailing?.activationGainPct) } : {}) },
  };
}

// ---------------- Exact math ----------------
const frac = (pct: string) => div(pct, '100', 18, 'half_even');
const P = (d: Dec) => str(rescale(d, 18, 'half_even'));
export const stopLossPrice = (entry: string, pct: string) => P(mul(entry, sub('1', frac(pct))));
export const takeProfitPrice = (entry: string, pct: string) => P(mul(entry, add('1', frac(pct))));
export const trailingTrigger = (peak: string, pct: string) => P(mul(peak, sub('1', frac(pct))));
export const floorQty = (q: Dec | string, decimals: number) => str(rescale(q, decimals, 'floor'));
/** Tokens to sell for the partial take-profit: sellPct of what is held now, floored to token precision. */
export const partialSellQty = (held: string, sellPct: string, decimals: number) => gte(sellPct, '100') ? floorQty(held, decimals) : floorQty(mul(held, frac(sellPct)), decimals);

// ---------------- Preview (what the owner sees before enabling) ----------------
export type ExitPreview = {
  issues: ConfigIssue[]; entry: string; qty: string;
  stopLoss: null | { trigger: string; sellsQty: string };
  partialTp: null | { trigger: string; sellsQty: string; keepsQty: string };
  trailing: null | { pct: string; activation: TrailActivation; activatesAt: string | null; protectsQty: string; exampleTrigger: string | null; note: string };
};
export function previewExitPlan(c: ExitConfig, entry: string, qty: string, decimals: number): ExitPreview {
  const issues = validateExitConfig(c); const empty: ExitPreview = { issues, entry, qty, stopLoss: null, partialTp: null, trailing: null };
  if (issues.length || !gt(entry, '0') || !gt(qty, '0')) return empty;
  const held = floorQty(qty, decimals);
  const partialQty = c.partialTp.enabled ? partialSellQty(held, c.partialTp.sellPct, decimals) : '0';
  const keeps = str(sub(held, partialQty));
  const tp = c.partialTp.enabled ? takeProfitPrice(entry, c.partialTp.triggerPct) : null;
  let trailing: ExitPreview['trailing'] = null;
  if (c.trailing.enabled) {
    const activatesAt = c.trailing.activation === 'after_partial' ? tp : c.trailing.activation === 'at_gain' ? takeProfitPrice(entry, c.trailing.activationGainPct!) : null;
    const base = activatesAt ?? entry;
    trailing = { pct: c.trailing.pct, activation: c.trailing.activation, activatesAt, protectsQty: c.trailing.activation === 'after_partial' ? keeps : held, exampleTrigger: trailingTrigger(base, c.trailing.pct),
      note: c.trailing.activation === 'after_partial' ? 'Starts once the partial take-profit sale is confirmed filled; follows the highest price seen after that.'
        : c.trailing.activation === 'at_gain' ? `Starts when the price reaches ${activatesAt}; follows the highest price seen after that.` : 'Starts right away; follows the highest price seen after the plan starts.' };
  }
  return { issues, entry, qty: held,
    stopLoss: c.stopLoss.enabled ? { trigger: stopLossPrice(entry, c.stopLoss.pct), sellsQty: held } : null,
    partialTp: tp ? { trigger: tp, sellsQty: partialQty, keepsQty: keeps } : null, trailing };
}

// ---------------- State machine ----------------
export type PendingExit = { id: string; rule: ExitRule; qty: string; triggerPrice: string; observedPrice: string; plannedAt: number };
export type ExitState = {
  v: 1; entry: string; decimals: number; config: ExitConfig;
  status: 'active' | 'closed';
  originalQty: string; managedQty: string;
  partial: 'armed' | 'pending' | 'done' | 'skipped' | 'off';
  partialFilledQty: string | null;
  trailing: { status: 'waiting' | 'active' | 'off'; peak: string | null; trigger: string | null; activatedAt: number | null };
  pending: PendingExit | null;
  seq: number; failures: number; retryAfter: number;
  lastPrice: { usd: string; at: number } | null; staleSince: number | null;
  closeReason: string | null;
};
export type ExitEvent = { kind: string; detail: Record<string, unknown> };
export type Observation = {
  now: number;
  price: string | null;      // USD per token
  priceAt: number | null;    // when that price was valid
  heldQty: string;           // reconciled tokens actually held for this position right now
  staleAfterMs: number;      // older prices never trigger anything
  dustQty?: string;          // below this quantity a sale is not attempted (would not route / costs more than it returns)
  staleReason?: string | null; // why the source considers the price unusable (logged); forces "stale"
};
export type Step = { state: ExitState; events: ExitEvent[]; order: PendingExit | null };

export function newExitState(config: ExitConfig, entry: string, qty: string, decimals: number): ExitState {
  assertValidExitConfig(config);
  if (!gt(entry, '0')) throw Object.assign(new Error('ENTRY_MUST_BE_POSITIVE'), { code: 'UNKNOWN_COST_BASIS' });
  const held = floorQty(qty, decimals); if (!gt(held, '0')) throw Object.assign(new Error('QTY_MUST_BE_POSITIVE'), { code: 'NO_POSITION' });
  return { v: 1, entry: P(dec(entry)), decimals, config: structuredClone(config), status: 'active', originalQty: held, managedQty: held,
    partial: config.partialTp.enabled ? 'armed' : 'off', partialFilledQty: null,
    trailing: { status: config.trailing.enabled ? 'waiting' : 'off', peak: null, trigger: null, activatedAt: null },
    pending: null, seq: 0, failures: 0, retryAfter: 0, lastPrice: null, staleSince: null, closeReason: null };
}

/** Current trigger levels, for display and logs. */
export function levels(s: ExitState) {
  const c = s.config;
  return {
    stopLoss: c.stopLoss.enabled ? stopLossPrice(s.entry, c.stopLoss.pct) : null,
    partialTp: c.partialTp.enabled && (s.partial === 'armed' || s.partial === 'pending') ? takeProfitPrice(s.entry, c.partialTp.triggerPct) : null,
    trailingActivatesAt: c.trailing.enabled && s.trailing.status === 'waiting' && c.trailing.activation === 'at_gain' ? takeProfitPrice(s.entry, c.trailing.activationGainPct!) : null,
    trailing: s.trailing.status === 'active' ? s.trailing.trigger : null,
  };
}

function close(s: ExitState, reason: string, ev: ExitEvent[]) { s.status = 'closed'; s.closeReason = reason; s.pending = null; ev.push({ kind: 'closed', detail: { reason, managedQty: s.managedQty } }); }
const RULE_TAG: Record<ExitRule, string> = { stop_loss: 'sl', partial_tp: 'tp', trailing: 'tr' };

/** One evaluation. Idempotent: the same observation twice produces no second order. */
export function decideExit(prev: ExitState, o: Observation, idPrefix: string): Step {
  const s: ExitState = structuredClone(prev); const ev: ExitEvent[] = [];
  if (s.status === 'closed') return { state: prev, events: [], order: null };
  if (s.pending) return { state: prev, events: [], order: null }; // one order at a time per position; holdings reconcile after it settles

  // 1. Reconcile against what is actually held (manual sells, transfers, anything outside this plan).
  const held = floorQty(max('0', o.heldQty), s.decimals);
  if (lt(held, s.managedQty)) { ev.push({ kind: 'reconciled', detail: { from: s.managedQty, to: held, reason: 'held_less_than_managed' } }); s.managedQty = held; }
  if (isZero(s.managedQty)) { close(s, 'POSITION_GONE', ev); return { state: s, events: ev, order: null }; }

  // 2. Only fresh, positive, in-order prices can move a stop or trigger a sale.
  const fresh = !o.staleReason && o.price !== null && o.priceAt !== null && gt(o.price, '0') && o.now - o.priceAt <= o.staleAfterMs;
  if (!fresh) {
    if (s.staleSince === null) { s.staleSince = o.now; ev.push({ kind: 'price_stale', detail: { reason: o.staleReason ?? (o.price === null ? 'NO_PRICE' : 'TOO_OLD'), price: o.price, priceAt: o.priceAt, now: o.now, maxAgeMs: o.staleAfterMs } }); }
    return { state: s, events: ev, order: null };
  }
  if (s.lastPrice && o.priceAt! < s.lastPrice.at) return { state: s, events: ev, order: null }; // older than what we already used
  if (s.staleSince !== null) { ev.push({ kind: 'price_fresh', detail: { price: o.price, staleForMs: o.now - s.staleSince } }); s.staleSince = null; }
  const price = o.price!; s.lastPrice = { usd: price, at: o.priceAt! };
  const c = s.config;

  // 3. Trailing: activation, then peak only rises, so the trigger only rises.
  if (s.trailing.status === 'waiting') {
    const start = c.trailing.activation === 'immediate' || (c.trailing.activation === 'at_gain' && gte(price, takeProfitPrice(s.entry, c.trailing.activationGainPct!)));
    if (start) { s.trailing = { status: 'active', peak: null, trigger: null, activatedAt: o.now }; ev.push({ kind: 'trailing_activated', detail: { mode: c.trailing.activation, price } }); }
  }
  if (s.trailing.status === 'active' && (s.trailing.peak === null || gt(price, s.trailing.peak))) {
    const first = s.trailing.peak === null; s.trailing.peak = price;
    const t = trailingTrigger(price, c.trailing.pct); // monotonic even after an owner override kept a higher trigger
    s.trailing.trigger = s.trailing.trigger && gt(s.trailing.trigger, t) ? s.trailing.trigger : t;
    ev.push({ kind: first ? 'trailing_peak_started' : 'trailing_raised', detail: { peak: price, trigger: s.trailing.trigger } });
  }

  // 4. Back off after a definitive failure (the next attempt uses a new order id).
  if (o.now < s.retryAfter) return { state: s, events: ev, order: null };

  // 5. Stops: stop-loss and trailing both sell everything left; the higher stop wins.
  const sl = c.stopLoss.enabled ? stopLossPrice(s.entry, c.stopLoss.pct) : null;
  const tr = s.trailing.status === 'active' ? s.trailing.trigger : null;
  let stop: { rule: ExitRule; price: string } | null = null;
  if (sl) stop = { rule: 'stop_loss', price: sl };
  if (tr && (!stop || gte(tr, stop.price))) stop = { rule: 'trailing', price: tr };
  let plan: { rule: ExitRule; qty: string; trigger: string } | null = null;
  if (stop && lte(price, stop.price)) {
    if (s.partial === 'armed' && c.partialTp.enabled && gte(price, takeProfitPrice(s.entry, c.partialTp.triggerPct))) { s.partial = 'skipped'; ev.push({ kind: 'partial_skipped', detail: { reason: 'STOP_TRIGGERED_SAME_TICK', price } }); }
    plan = { rule: stop.rule, qty: s.managedQty, trigger: stop.price };
    ev.push({ kind: 'stop_triggered', detail: { rule: stop.rule, price, trigger: stop.price, otherStop: stop.rule === 'trailing' ? sl : tr } });
  } else if (s.partial === 'armed' && gte(price, takeProfitPrice(s.entry, c.partialTp.triggerPct))) {
    const qty = partialSellQty(s.managedQty, c.partialTp.sellPct, s.decimals);
    const trig = takeProfitPrice(s.entry, c.partialTp.triggerPct);
    if (!gt(qty, '0') || (o.dustQty && lt(qty, o.dustQty))) {
      s.partial = 'skipped'; ev.push({ kind: 'partial_skipped', detail: { reason: 'BELOW_MINIMUM_SIZE', qty, dustQty: o.dustQty ?? '0' } });
      if (s.trailing.status === 'waiting' && c.trailing.activation === 'after_partial') { s.trailing = { status: 'active', peak: price, trigger: trailingTrigger(price, c.trailing.pct), activatedAt: o.now }; ev.push({ kind: 'trailing_activated', detail: { mode: 'after_partial', reason: 'PARTIAL_SKIPPED', price, trigger: s.trailing.trigger } }); }
    } else { plan = { rule: 'partial_tp', qty, trigger: trig }; ev.push({ kind: 'partial_triggered', detail: { price, trigger: trig, heldQty: s.managedQty, sellPct: c.partialTp.sellPct, qty } }); }
  }
  if (!plan) return { state: s, events: ev, order: null };
  if (plan.rule !== 'partial_tp' && (!gt(plan.qty, '0') || (o.dustQty && lt(plan.qty, o.dustQty)))) { ev.push({ kind: 'dust_remainder', detail: { qty: plan.qty, dustQty: o.dustQty ?? '0' } }); close(s, 'DUST_REMAINDER', ev); return { state: s, events: ev, order: null }; }
  s.seq += 1;
  const order: PendingExit = { id: `${idPrefix}:${RULE_TAG[plan.rule]}:${s.seq}`, rule: plan.rule, qty: plan.qty, triggerPrice: plan.trigger, observedPrice: price, plannedAt: o.now };
  s.pending = order; if (plan.rule === 'partial_tp') s.partial = 'pending';
  ev.push({ kind: 'order_planned', detail: { ...order } });
  return { state: s, events: ev, order };
}

export type OrderResult = { id: string; outcome: 'filled'; soldQty: string; proceedsUsd?: string } | { id: string; outcome: 'failed'; reason: string } | { id: string; outcome: 'uncertain'; reason?: string };
const BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/** Apply an order outcome. A result for an order that is not the pending one (duplicate delivery, old attempt) is ignored. */
export function applyOrderResult(prev: ExitState, r: OrderResult, now: number): Step {
  if (!prev.pending || prev.pending.id !== r.id) return { state: prev, events: [{ kind: 'result_ignored', detail: { id: r.id, outcome: r.outcome, pending: prev.pending?.id ?? null } }], order: null };
  const s: ExitState = structuredClone(prev); const ev: ExitEvent[] = []; const p = s.pending!;
  if (r.outcome === 'uncertain') { ev.push({ kind: 'order_uncertain', detail: { id: p.id, reason: r.reason ?? null } }); return { state: s, events: ev, order: null }; }
  if (r.outcome === 'failed') {
    s.pending = null; s.failures += 1; s.retryAfter = now + BACKOFF_MS[Math.min(s.failures, BACKOFF_MS.length) - 1];
    if (p.rule === 'partial_tp') s.partial = 'armed'; // not done: it may be tried again, still only once successfully
    ev.push({ kind: 'order_failed', detail: { id: p.id, rule: p.rule, reason: r.reason, failures: s.failures, retryAfter: s.retryAfter } });
    if (s.failures >= 3) ev.push({ kind: 'needs_attention', detail: { rule: p.rule, failures: s.failures, reason: r.reason } });
    return { state: s, events: ev, order: null };
  }
  const sold = floorQty(max('0', r.soldQty), s.decimals);
  if (lt(sold, p.qty)) ev.push({ kind: 'short_fill', detail: { id: p.id, planned: p.qty, sold } });
  if (gt(sold, p.qty)) ev.push({ kind: 'over_fill_anomaly', detail: { id: p.id, planned: p.qty, sold } });
  s.managedQty = str(max('0', sub(s.managedQty, sold)));
  s.pending = null; s.failures = 0; s.retryAfter = 0;
  ev.push({ kind: 'order_filled', detail: { id: p.id, rule: p.rule, sold, managedQty: s.managedQty, proceedsUsd: r.proceedsUsd ?? null } });
  if (p.rule === 'partial_tp') {
    s.partial = 'done'; s.partialFilledQty = sold; // once: a short fill is logged, never topped up (owner decision)
    if (s.config.trailing.enabled && s.trailing.status === 'waiting' && s.config.trailing.activation === 'after_partial') {
      s.trailing = { status: 'active', peak: null, trigger: null, activatedAt: now };
      ev.push({ kind: 'trailing_activated', detail: { mode: 'after_partial', protectsQty: s.managedQty } });
    }
  }
  if (isZero(s.managedQty)) close(s, p.rule === 'partial_tp' ? 'PARTIAL_SOLD_EVERYTHING' : p.rule === 'stop_loss' ? 'STOP_LOSS' : 'TRAILING_STOP', ev);
  return { state: s, events: ev, order: null };
}

/** Owner edits a live position's plan. Done rules stay done; an active trailing trigger never moves down. */
export function overrideExitConfig(prev: ExitState, next: ExitConfig, now: number): Step {
  assertValidExitConfig(next);
  if (prev.status === 'closed') throw Object.assign(new Error('POSITION_CLOSED'), { code: 'INVALID_TRANSITION' });
  const s: ExitState = structuredClone(prev); const ev: ExitEvent[] = [{ kind: 'config_changed', detail: { from: prev.config, to: next } }];
  s.config = structuredClone(next);
  if (s.partial === 'armed' || s.partial === 'off') s.partial = next.partialTp.enabled ? 'armed' : 'off'; // done / pending / skipped are history and stay
  if (!next.trailing.enabled) s.trailing = { status: 'off', peak: null, trigger: null, activatedAt: null };
  else if (s.trailing.status === 'off') {
    const startNow = next.trailing.activation === 'after_partial' && s.partial === 'done';
    s.trailing = { status: startNow ? 'active' : 'waiting', peak: null, trigger: null, activatedAt: startNow ? now : null };
  } else if (s.trailing.status === 'active' && s.trailing.peak) {
    const t = trailingTrigger(s.trailing.peak, next.trailing.pct);
    if (s.trailing.trigger && lt(t, s.trailing.trigger)) ev.push({ kind: 'trailing_kept_higher', detail: { kept: s.trailing.trigger, wouldBe: t, note: 'An active trailing trigger never moves down; the new distance applies as the price makes new highs.' } });
    else s.trailing.trigger = t;
  }
  return { state: s, events: ev, order: null };
}
