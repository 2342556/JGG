import { dec, add, sub, mul, div, cmp, gt, str, isZero, type Dec } from './decimal.ts';

// ---------------- JGG Ranking v1 (spec §6.1, T18) ----------------
// Deterministic, versioned, transparent. NOT the GMGN algorithm.
export const JGG_RANKING_VERSION = 'jgg-ranking-v1';
export type RankInput = { id: string; volumeUsd: string | null; priceChangeBps: number | null; liquidityUsd: string | null; txCount: number | null; holders: number | null };
export type RankWeights = { volume: number; momentum: number; liquidity: number; participation: number };
export const DEFAULT_RANK_WEIGHTS: RankWeights = { volume: 40, momentum: 20, liquidity: 25, participation: 15 };

/** Integer log2-bucket score 0..100 so ranking is exact and reproducible. */
function logScore(v: bigint, cap: bigint): number {
  if (v <= 0n) return 0;
  const bits = v.toString(2).length;
  const capBits = cap.toString(2).length;
  return Math.min(100, Math.floor((bits * 100) / capBits));
}

export function rankScore(x: RankInput, w: RankWeights = DEFAULT_RANK_WEIGHTS): { score: number; missing: string[]; factors: Record<string, number> } {
  const missing: string[] = [];
  const toInt = (s: string | null) => (s === null ? null : dec(s).int / 10n ** BigInt(dec(s).scale));
  const vol = toInt(x.volumeUsd); const liq = toInt(x.liquidityUsd);
  const f: Record<string, number> = {};
  f.volume = vol === null ? (missing.push('volume'), 0) : logScore(vol, 100_000_000n);
  f.liquidity = liq === null ? (missing.push('liquidity'), 0) : logScore(liq, 10_000_000n);
  f.momentum = x.priceChangeBps === null ? (missing.push('momentum'), 0) : Math.max(0, Math.min(100, 50 + Math.trunc(x.priceChangeBps / 200)));
  const part = x.txCount === null && x.holders === null ? null : (x.txCount ?? 0) + (x.holders ?? 0) * 2;
  f.participation = part === null ? (missing.push('participation'), 0) : logScore(BigInt(part), 1_000_000n);
  // Absent inputs contribute 0 (penalised, never imputed).
  const total = w.volume + w.momentum + w.liquidity + w.participation;
  const score = Math.trunc((f.volume * w.volume + f.momentum * w.momentum + f.liquidity * w.liquidity + f.participation * w.participation) / total);
  return { score, missing, factors: f };
}

export function rank(items: RankInput[], w?: RankWeights) {
  return items.map(i => ({ id: i.id, ...rankScore(i, w) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // stable tie-breaker
}

// ---------------- Due-diligence score v1 (spec §14.3, C05) ----------------
export const DD_RUBRIC_VERSION = 'jgg-dd-v1';
export type Tri = 'safe' | 'risky' | 'unknown' | 'not_applicable';
export type DdInput = {
  mintAuthority: Tri; freezeAuthority: Tri; honeypot: Tri; lpLockedOrBurned: Tri; openSource: Tri;
  top10ConcentrationBps: number | null; devHoldingBps: number | null; liquidityUsd: string | null; ageMinutes: number | null; buyTaxBps: number | null; sellTaxBps: number | null;
};
type Factor = { id: string; weight: number; points: number | null; note: string };

export function dueDiligence(x: DdInput) {
  const tri = (t: Tri, w: number, id: string, note: string): Factor =>
    ({ id, weight: w, points: t === 'safe' ? w : t === 'risky' ? 0 : t === 'not_applicable' ? w : null, note });
  const band = (v: number | null, w: number, id: string, good: number, bad: number, note: string): Factor => {
    if (v === null) return { id, weight: w, points: null, note };
    if (v <= good) return { id, weight: w, points: w, note };
    if (v >= bad) return { id, weight: w, points: 0, note };
    return { id, weight: w, points: Math.trunc((w * (bad - v)) / (bad - good)), note };
  };
  const liqInt = x.liquidityUsd === null ? null : Number(dec(x.liquidityUsd).int / 10n ** BigInt(dec(x.liquidityUsd).scale));
  const factors: Factor[] = [
    tri(x.honeypot, 20, 'honeypot', 'Sell simulation / provider honeypot observation'),
    tri(x.mintAuthority, 10, 'mint_authority', 'Mint authority renounced (Solana) or no owner-mint (EVM)'),
    tri(x.freezeAuthority, 10, 'freeze_authority', 'Freeze authority absent (Solana-specific)'),
    tri(x.lpLockedOrBurned, 10, 'lp_lock', 'LP burned/locked evidence'),
    tri(x.openSource, 5, 'open_source', 'Verified source (EVM); not applicable to SPL mints'),
    band(x.top10ConcentrationBps, 15, 'top10', 1500, 6000, 'Top-10 holders share excluding pool/burn'),
    band(x.devHoldingBps, 10, 'dev_holding', 100, 1000, 'Creator-attributed holding'),
    band(x.buyTaxBps === null || x.sellTaxBps === null ? null : Math.max(x.buyTaxBps, x.sellTaxBps), 10, 'tax', 0, 1000, 'Max(buy,sell) token tax'),
    liqInt === null ? { id: 'liquidity', weight: 10, points: null, note: 'Pool liquidity USD' } : { id: 'liquidity', weight: 10, points: liqInt >= 50_000 ? 10 : liqInt >= 10_000 ? 6 : liqInt >= 2_000 ? 3 : 0, note: 'Pool liquidity USD' },
  ];
  const known = factors.filter(f => f.points !== null);
  const knownWeight = known.reduce((a, f) => a + f.weight, 0);
  const total = factors.reduce((a, f) => a + f.weight, 0);
  const pts = known.reduce((a, f) => a + (f.points ?? 0), 0);
  // Score is over KNOWN factors only; coverage is reported so missing data can't look "Passed".
  const score = knownWeight === 0 ? null : Math.trunc((pts * 100) / knownWeight);
  const coverageBps = Math.trunc((knownWeight * 10_000) / total);
  const verdict = score === null || coverageBps < 6000 ? 'insufficient_data' : x.honeypot === 'risky' ? 'fail' : score >= 70 ? 'pass' : score >= 45 ? 'caution' : 'fail';
  return { rubric: DD_RUBRIC_VERSION, score, coverageBps, verdict, factors, missing: factors.filter(f => f.points === null).map(f => f.id),
    disclaimer: 'Explainable risk indicator, not a calibrated probability of a rug pull.' };
}

// ---------------- Holder concentration (spec §14.3) ----------------
export function concentration(holders: { address: string; raw: string; system?: 'pool' | 'burn' | 'bridge' | 'escrow' }[], supplyRaw: string, topN = 10) {
  const excluded = holders.filter(h => h.system);
  const excludedRaw = excluded.reduce((a, h) => a + BigInt(h.raw), 0n);
  const denom = BigInt(supplyRaw) - excludedRaw;
  const eligible = holders.filter(h => !h.system).sort((a, b) => (BigInt(b.raw) > BigInt(a.raw) ? 1 : -1)).slice(0, topN);
  const top = eligible.reduce((a, h) => a + BigInt(h.raw), 0n);
  return { topN, topRaw: top.toString(), denominatorRaw: denom.toString(), bps: denom > 0n ? Number((top * 10_000n) / denom) : null,
    excluded: excluded.map(e => ({ address: e.address, kind: e.system })) };
}

// ---------------- Candle aggregation (spec §14.3, T17) ----------------
export type Trade = { eventId: string; swapId: string; ts: number; price: string; volumeQuote: string; legIndex: number };
export type Candle = { t: number; o: string; h: string; l: string; c: string; v: string; trades: number; gap?: false } | { t: number; gap: true };

/** Aggregates trades into interval buckets. Multi-hop legs of one swap count once (first leg).
 *  Duplicate event ids are ignored. Empty intervals become explicit gap markers. */
export function aggregateCandles(trades: Trade[], intervalMs: number, fromMs: number, toMs: number): Candle[] {
  const seenEvents = new Set<string>(); const seenSwaps = new Set<string>();
  const buckets = new Map<number, Trade[]>();
  for (const t of [...trades].sort((a, b) => a.ts - b.ts || a.legIndex - b.legIndex)) {
    if (seenEvents.has(t.eventId)) continue; seenEvents.add(t.eventId);
    if (seenSwaps.has(t.swapId)) continue; seenSwaps.add(t.swapId);
    if (t.ts < fromMs || t.ts >= toMs) continue;
    const b = Math.floor((t.ts - fromMs) / intervalMs) * intervalMs + fromMs;
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(t);
  }
  const out: Candle[] = [];
  for (let t = fromMs; t < toMs; t += intervalMs) {
    const b = buckets.get(t);
    if (!b) { out.push({ t, gap: true }); continue; }
    let h = dec(b[0].price), l = dec(b[0].price), v: Dec = dec('0');
    for (const x of b) { if (cmp(x.price, h) > 0) h = dec(x.price); if (cmp(x.price, l) < 0) l = dec(x.price); v = add(v, x.volumeQuote); }
    out.push({ t, o: b[0].price, h: str(h), l: str(l), c: b[b.length - 1].price, v: str(v), trades: b.length });
  }
  return out;
}

// ---------------- Wallet address score v1 (C48) ----------------
export const WALLET_SCORE_VERSION = 'jgg-wallet-v1';
export function walletScore(x: { closedEpisodes: number; winRateBps: number | null; realizedPnlUsd: string | null; medianHoldMinutes: number | null; medianPositionUsd: string | null; tokensRuggedBps: number | null }) {
  const sample = x.closedEpisodes;
  const profitability = x.winRateBps === null || x.realizedPnlUsd === null ? null
    : Math.min(100, Math.trunc(x.winRateBps / 100) + (gt(x.realizedPnlUsd, '0') ? 20 : 0));
  const copyFeasibility = x.medianHoldMinutes === null ? null : x.medianHoldMinutes < 2 ? 15 : x.medianHoldMinutes < 10 ? 45 : 80;
  const risk = x.tokensRuggedBps === null ? null : Math.max(0, 100 - Math.trunc(x.tokensRuggedBps / 50));
  return { rubric: WALLET_SCORE_VERSION, profitability, copyFeasibility, risk, sampleSize: sample,
    lowSample: sample < 20, note: 'Three separate dimensions; not combined into a profit prediction.' };
}

export { sub, mul, div, isZero };
