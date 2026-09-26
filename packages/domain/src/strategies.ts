import { dec, add, sub, mul, div, gte, lte, gt, cmp, max, min, str, isZero, type Dec } from './decimal.ts';

// ---------------- Trailing math (spec §12.3) ----------------
// All state is plain JSON of decimal strings so it can be persisted durably and survive restarts.

export type TrailingTpState = {
  kind: 'trailing_tp';
  entry: string; activation: string; retracement: string; // fractions, e.g. "0.2", "0.1"
  active: boolean; peak: string | null; fired: boolean;
};
export type TrailingSlState = {
  kind: 'trailing_sl';
  entry: string; retracement: string;
  peak: string; fired: boolean;
};
export type TrailingEval<S> = { state: S; stop: string | null; triggered: boolean; event: 'none' | 'activated' | 'raised' | 'triggered' };

function checkFraction(f: string, name: string, allowZero = false) {
  const d = dec(f);
  if ((allowZero ? cmp(d, '0') < 0 : !gt(d, '0')) || !(cmp(d, '1') < 0)) throw new Error(`${name.toUpperCase()}_OUT_OF_RANGE`);
}

export function newTrailingTp(entry: string, activation: string, retracement: string): TrailingTpState {
  if (!gt(entry, '0')) throw new Error('ENTRY_MUST_BE_POSITIVE');
  checkFraction(activation, 'activation', true); checkFraction(retracement, 'retracement');
  return { kind: 'trailing_tp', entry, activation, retracement, active: false, peak: null, fired: false };
}

const stopFrom = (peak: string, d: string): Dec => mul(peak, sub('1', d));

/** TTP: inactive until P >= E(1+a); then H = max(H,P); trigger when P <= H(1-d). Fires once. */
export function evalTrailingTp(s: TrailingTpState, price: string): TrailingEval<TrailingTpState> {
  if (s.fired) return { state: s, stop: s.peak ? str(stopFrom(s.peak, s.retracement)) : null, triggered: false, event: 'none' };
  if (!s.active) {
    const threshold = mul(s.entry, add('1', s.activation));
    if (!gte(price, threshold)) return { state: s, stop: null, triggered: false, event: 'none' };
    const next = { ...s, active: true, peak: price };
    return { state: next, stop: str(stopFrom(price, s.retracement)), triggered: false, event: 'activated' };
  }
  const peak = str(max(s.peak!, price));
  const raised = gt(peak, s.peak!);
  const stop = stopFrom(peak, s.retracement);
  if (lte(price, stop)) return { state: { ...s, peak, fired: true }, stop: str(stop), triggered: true, event: 'triggered' };
  return { state: { ...s, peak }, stop: str(stop), triggered: false, event: raised ? 'raised' : 'none' };
}

export function newTrailingSl(entry: string, retracement: string): TrailingSlState {
  if (!gt(entry, '0')) throw new Error('ENTRY_MUST_BE_POSITIVE');
  checkFraction(retracement, 'retracement');
  return { kind: 'trailing_sl', entry, retracement, peak: entry, fired: false };
}

/** TSL: H starts at E; H = max(H,P); trigger at P <= H(1-d). Stop never moves down. */
export function evalTrailingSl(s: TrailingSlState, price: string): TrailingEval<TrailingSlState> {
  const peak = str(max(s.peak, price));
  const stop = stopFrom(peak, s.retracement);
  if (s.fired) return { state: s, stop: str(stopFrom(s.peak, s.retracement)), triggered: false, event: 'none' };
  if (lte(price, stop)) return { state: { ...s, peak, fired: true }, stop: str(stop), triggered: true, event: 'triggered' };
  return { state: { ...s, peak }, stop: str(stop), triggered: false, event: gt(peak, s.peak) ? 'raised' : 'none' };
}

/** Fixed TP/SL targets from a disclosed entry reference. No hidden peak update. */
export const fixedTakeProfitPrice = (entry: string, fraction: string) => str(mul(entry, add('1', fraction)));
export const fixedStopLossPrice = (entry: string, fraction: string) => str(mul(entry, sub('1', fraction)));

// ---------------- Monitored limit triggers (spec §12.1) ----------------
export const limitBuyTriggered = (price: string, target: string) => lte(price, target);
export const limitSellTriggered = (price: string, target: string) => gte(price, target);

// ---------------- Staged exits (spec §12.2, fixture A06) ----------------
export type StageSpec = { id: string; percentBps: number }; // of ORIGINAL filled quantity by default

export function stagedQuantities(originalFilled: string, stages: StageSpec[]): { id: string; qty: string }[] {
  const total = stages.reduce((a, s) => a + s.percentBps, 0);
  if (stages.some(s => !Number.isInteger(s.percentBps) || s.percentBps <= 0)) throw new Error('STAGE_PERCENT_INVALID');
  if (total > 10_000) throw new Error('STAGES_EXCEED_100_PERCENT');
  return stages.map(s => ({ id: s.id, qty: str(div(mul(originalFilled, BigInt(s.percentBps).toString()), '10000', 18, 'floor')) }));
}

// ---------------- Exit coordinator (spec §12.2, T26/T27) ----------------
// Serializes competing sell triggers on one position/strategy scope. TP and SL are
// alternative claims on the same inventory; a winning exit atomically claims quantity
// and siblings are reduced. Never negative inventory.

export type ExitClaim = { exitId: string; kind: 'tp_stage' | 'stop' | 'trailing' | 'manual' | 'copy_follow'; requestedQty: string };
export type CoordinatorState = { remaining: string; claimed: { exitId: string; qty: string }[]; version: number };

export function claimExit(state: CoordinatorState, claim: ExitClaim, expectedVersion: number):
  { ok: true; state: CoordinatorState; qty: string; reduced: boolean } | { ok: false; code: 'VERSION_CONFLICT' | 'NOTHING_REMAINING' | 'ALREADY_CLAIMED' } {
  if (state.version !== expectedVersion) return { ok: false, code: 'VERSION_CONFLICT' };
  if (state.claimed.some(c => c.exitId === claim.exitId)) return { ok: false, code: 'ALREADY_CLAIMED' };
  if (!gt(state.remaining, '0')) return { ok: false, code: 'NOTHING_REMAINING' };
  const qty = min(claim.requestedQty, state.remaining);
  return {
    ok: true,
    qty: str(qty),
    reduced: cmp(qty, claim.requestedQty) < 0,
    state: { remaining: str(sub(state.remaining, qty)), claimed: [...state.claimed, { exitId: claim.exitId, qty: str(qty) }], version: state.version + 1 },
  };
}

/** Manual sale / withdrawal reduces the coordinator's remaining inventory first (T27). */
export function applyExternalReduction(state: CoordinatorState, qty: string): CoordinatorState {
  const r = sub(state.remaining, qty);
  return { ...state, remaining: str(cmp(r, '0') < 0 ? dec('0') : r), version: state.version + 1 };
}

export const isFlat = (s: CoordinatorState) => isZero(s.remaining);
