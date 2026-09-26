import { dec, add, sub, mul, div, cmp, isZero, str, gt, lt, eq, type Dec } from './decimal.ts';

/**
 * Weighted-average basis per (wallet, asset, strategy-attribution bucket).
 * Not a tax-compliance method. Unknown-basis quantity is tracked separately and never
 * treated as free gains.
 */
export type Bucket = {
  knownQty: Dec;     // quantity with known basis
  knownBasis: Dec;   // total basis of knownQty in reporting currency
  unknownQty: Dec;   // quantity with unknown basis (unmatched transfers-in)
  realized: Dec;     // realized P&L on known-basis sales
  closedEpisodes: { pnl: Dec }[];
};

export const emptyBucket = (): Bucket => ({
  knownQty: dec('0'), knownBasis: dec('0'), unknownQty: dec('0'), realized: dec('0'), closedEpisodes: [],
});

export function averageBasis(b: Bucket): Dec | null {
  if (isZero(b.knownQty)) return null;
  return div(b.knownBasis, b.knownQty, 18);
}

/** Buy q units at unit price with attributable acquisition cost c. Q'=Q+q, C'=C+q*price+c */
export function applyBuy(b: Bucket, qty: string, unitPrice: string, acquisitionCost = '0'): Bucket {
  if (!gt(qty, '0')) throw new Error('QTY_MUST_BE_POSITIVE');
  if (lt(unitPrice, '0') || lt(acquisitionCost, '0')) throw new Error('NEGATIVE_PRICE_OR_COST');
  const c = add(mul(qty, unitPrice), acquisitionCost);
  return { ...b, knownQty: add(b.knownQty, qty), knownBasis: add(b.knownBasis, c) };
}

export type SaleResult = { bucket: Bucket; netProceeds: Dec; releasedBasis: Dec; realizedPnl: Dec };

/**
 * Sell s units at unit price with attributable sale cost. Released basis = s × averageBasis,
 * computed as C×s/Q for exactness. Costs already embedded in proceeds must not be passed again.
 */
export function applySell(b: Bucket, qty: string, unitPrice: string, saleCost = '0'): SaleResult {
  if (!gt(qty, '0')) throw new Error('QTY_MUST_BE_POSITIVE');
  if (cmp(qty, b.knownQty) > 0) {
    if (cmp(qty, add(b.knownQty, b.unknownQty)) > 0) throw new Error('INSUFFICIENT_QUANTITY');
    throw new Error('UNKNOWN_COST_BASIS'); // sale would consume unknown-basis units
  }
  const netProceeds = sub(mul(qty, unitPrice), saleCost);
  const releasedBasis = eq(qty, b.knownQty) ? b.knownBasis : div(mul(b.knownBasis, qty), b.knownQty, 18);
  const realizedPnl = sub(netProceeds, releasedBasis);
  const knownQty = sub(b.knownQty, qty);
  const bucket: Bucket = {
    ...b,
    knownQty,
    knownBasis: isZero(knownQty) ? dec('0') : sub(b.knownBasis, releasedBasis),
    realized: add(b.realized, realizedPnl),
    closedEpisodes: b.closedEpisodes,
  };
  return { bucket, netProceeds, releasedBasis, realizedPnl };
}

/** Transfer-in with unknown basis; optionally a matched owned-wallet transfer preserving basis. */
export function applyTransferIn(b: Bucket, qty: string, matchedBasis: string | null): Bucket {
  if (matchedBasis === null) return { ...b, unknownQty: add(b.unknownQty, qty) };
  return { ...b, knownQty: add(b.knownQty, qty), knownBasis: add(b.knownBasis, matchedBasis) };
}

export type Mark = { markValue: Dec; unrealized: Dec; unknownQtyValue: Dec | null };
/** Unrealized = mark value of known-basis quantity − known remaining basis. */
export function markToMarket(b: Bucket, markPrice: string | null): Mark | null {
  if (markPrice === null) return null; // unpriced: value unavailable, asset still present
  const markValue = mul(b.knownQty, markPrice);
  return {
    markValue,
    unrealized: sub(markValue, b.knownBasis),
    unknownQtyValue: isZero(b.unknownQty) ? null : mul(b.unknownQty, markPrice),
  };
}

/** Window equity P&L = ending − starting − net external inflows. */
export function equityPnl(starting: string, ending: string, netExternalInflows: string): Dec {
  return sub(sub(ending, starting), netExternalInflows);
}

/**
 * Win rate: profitable closed episodes / all closed known-basis episodes (break-evens in the
 * denominator, reported separately). Returns null when the denominator is zero.
 */
export function winRate(episodes: { pnl: string }[]): { rate: Dec | null; wins: number; losses: number; breakEven: number; total: number } {
  let wins = 0, losses = 0, breakEven = 0;
  for (const e of episodes) {
    const c = cmp(e.pnl, '0');
    if (c > 0) wins++; else if (c < 0) losses++; else breakEven++;
  }
  const total = episodes.length;
  return { rate: total ? div(BigInt(wins).toString(), BigInt(total).toString(), 6) : null, wins, losses, breakEven, total };
}

export const s = str;
