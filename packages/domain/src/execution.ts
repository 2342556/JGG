import { raw, dec, add, sub, mul, div, gt, lte, min as dmin, str, type Dec } from './decimal.ts';

export const BPS_DENOMINATOR = 10_000n;
/** Hard bounds for slippage configuration. Above SLIPPAGE_EXPLICIT_BPS requires explicit opt-in. */
export const SLIPPAGE_MIN_BPS = 1;
export const SLIPPAGE_EXPLICIT_BPS = 1_500; // 15%
export const SLIPPAGE_MAX_BPS = 5_000; // 50%

export function validateSlippageBps(bps: number, explicitHighSlippage = false): void {
  if (!Number.isInteger(bps)) throw new Error('SLIPPAGE_BPS_NOT_INTEGER');
  if (bps < SLIPPAGE_MIN_BPS || bps > SLIPPAGE_MAX_BPS) throw new Error('SLIPPAGE_BPS_OUT_OF_RANGE');
  if (bps > SLIPPAGE_EXPLICIT_BPS && !explicitHighSlippage) throw new Error('SLIPPAGE_REQUIRES_EXPLICIT_CONFIRMATION');
}

/**
 * minimumOutRaw = floor(quotedOutRaw × (10000 − slippageBps) / 10000).
 * Only valid when the upstream quote is a simple net executable quote; callers must
 * not reapply slippage to an output already constrained by the provider.
 */
export function minimumOutRaw(quotedOutRaw: string | bigint, slippageBps: number): bigint {
  validateSlippageBps(slippageBps, true);
  const q = raw(quotedOutRaw);
  return (q * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR; // bigint division floors for non-negatives
}

/** Fee in raw units from a bps rate, rounded up so the fee is never understated. */
export function bpsFeeRaw(amountRaw: string | bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error('FEE_BPS_OUT_OF_RANGE');
  const a = raw(amountRaw);
  const n = a * BigInt(feeBps);
  return n / BPS_DENOMINATOR + (n % BPS_DENOMINATOR === 0n ? 0n : 1n);
}

export type FeeComponent = {
  kind: 'provider' | 'jgg' | 'dex' | 'network' | 'priority' | 'token_tax' | 'rent' | 'sponsorship';
  amount: string; // decimal string in `asset`
  asset: string;  // canonical asset id or quote currency
  includedInQuotedOutput: boolean;
  note?: string;
};

/** Sum fee components NOT already embedded in the quoted output, per asset, to avoid double counting. */
export function additionalCostsByAsset(fees: FeeComponent[]): Record<string, string> {
  const out: Record<string, Dec> = {};
  for (const f of fees) {
    if (f.includedInQuotedOutput) continue;
    out[f.asset] = add(out[f.asset] ?? dec('0'), f.amount);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, str(v)]));
}

/**
 * "Sell initial": sell enough to recover the unrecovered spend of a known-basis position.
 * netPricePerToken is the executable net receipt per token for the intended size (quote-derived).
 * Returns the token quantity to sell capped at holdings and whether full recovery is feasible.
 */
export function sellInitialPlan(input: {
  unrecoveredSpend: string | null; // null = unknown basis
  holdings: string;
  netPricePerToken: string;
}): { ok: true; sellQty: string; expectedProceeds: string; fullRecovery: boolean; residualQty: string }
  | { ok: false; code: 'UNKNOWN_COST_BASIS' | 'NO_PRICE' | 'NOTHING_TO_RECOVER' } {
  if (input.unrecoveredSpend === null) return { ok: false, code: 'UNKNOWN_COST_BASIS' };
  if (!gt(input.netPricePerToken, '0')) return { ok: false, code: 'NO_PRICE' };
  if (lte(input.unrecoveredSpend, '0')) return { ok: false, code: 'NOTHING_TO_RECOVER' };
  const needed = div(input.unrecoveredSpend, input.netPricePerToken, 18, 'ceil');
  const sellQty = dmin(needed, input.holdings);
  const fullRecovery = lte(needed, input.holdings);
  return {
    ok: true,
    sellQty: str(sellQty),
    expectedProceeds: str(mul(sellQty, input.netPricePerToken)),
    fullRecovery,
    residualQty: str(sub(input.holdings, sellQty)),
  };
}
