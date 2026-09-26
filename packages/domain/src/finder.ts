// JGG Finder v1 — explainable candidate screening for new/trending meme coins.
// It is a RISK FILTER + RANKING, not a prediction: the score orders candidates that survived hard safety
// gates; it is never presented as a probability of profit. Unknown inputs lower coverage; they are never "safe".
export const FINDER_VERSION = 'jgg-finder-v1';

import type { Tri } from './analytics.ts';
export type FinderInput = {
  address: string; symbol: string;
  ageMin: number | null; liquidityUsd: number | null; marketCapUsd: number | null; volume1hUsd: number | null;
  holders: number | null; buys1h: number | null; sells1h: number | null;
  change5mBps: number | null; change1hBps: number | null;
  smartMoney: number | null; kols: number | null;
  top10Bps: number | null; devHoldingBps: number | null; insiderBps: number | null; bundleBps: number | null; snipers: number | null;
  honeypot: Tri; mintAuthority: Tri; freezeAuthority: Tri; rugRatio: number | null; // rugRatio 0..1 when a provider supplies it
  ddVerdict: 'pass' | 'caution' | 'fail' | 'insufficient_data' | null; ddScore: number | null;
};
export type FinderConfig = {
  minLiquidityUsd: number; maxTop10Bps: number; maxDevBps: number; maxInsiderBps: number; maxBundleBps: number;
  minAgeMin: number; maxAgeMin: number; maxChange1hBps: number; minCoverageBps: number; maxRugRatio: number;
};
export const DEFAULT_FINDER: FinderConfig = {
  minLiquidityUsd: 8_000, maxTop10Bps: 3_000, maxDevBps: 1_000, maxInsiderBps: 1_500, maxBundleBps: 2_500,
  minAgeMin: 3, maxAgeMin: 24 * 60, maxChange1hBps: 30_000, minCoverageBps: 7_000, maxRugRatio: 0.3,
};
export type FinderResult =
  | { address: string; symbol: string; passed: true; score: number; coverageBps: number; factors: { id: string; points: number | null; max: number; why: string }[]; reasons: string[]; version: string }
  | { address: string; symbol: string; passed: false; gate: string; why: string; version: string };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** `exclude`: factors the data source structurally cannot provide (e.g. KOL labels without social data). They are removed from
 *  the rubric (not counted as unknown), and the result's version is suffixed so scores from different rubrics are never mixed. */
export function finderScore(x: FinderInput, c: FinderConfig = DEFAULT_FINDER, exclude: string[] = []): FinderResult {
  const fail = (gate: string, why: string): FinderResult => ({ address: x.address, symbol: x.symbol, passed: false, gate, why, version: FINDER_VERSION });
  // ---- Hard gates (any failure excludes the token; unknown security never passes a security gate) ----
  if (x.honeypot !== 'safe') return fail('honeypot', x.honeypot === 'risky' ? 'Honeypot / cannot sell' : 'Honeypot status unknown');
  if (x.mintAuthority === 'risky') return fail('mint_authority', 'Mint authority not renounced');
  if (x.freezeAuthority === 'risky') return fail('freeze_authority', 'Freeze authority active');
  if (x.ddVerdict === 'fail') return fail('due_diligence', 'Due-diligence verdict: fail');
  if (x.rugRatio !== null && x.rugRatio > c.maxRugRatio) return fail('rug_ratio', `Rug ratio ${x.rugRatio} > ${c.maxRugRatio}`);
  if (x.liquidityUsd === null || x.liquidityUsd < c.minLiquidityUsd) return fail('liquidity', x.liquidityUsd === null ? 'Liquidity unknown' : `Liquidity $${Math.round(x.liquidityUsd)} < $${c.minLiquidityUsd}`);
  if (x.top10Bps !== null && x.top10Bps > c.maxTop10Bps) return fail('concentration', `Top-10 hold ${(x.top10Bps / 100).toFixed(1)}%`);
  if (x.devHoldingBps !== null && x.devHoldingBps > c.maxDevBps) return fail('dev_holding', `Dev holds ${(x.devHoldingBps / 100).toFixed(1)}%`);
  if (x.insiderBps !== null && x.insiderBps > c.maxInsiderBps) return fail('insiders', `Insiders ${(x.insiderBps / 100).toFixed(1)}%`);
  if (x.bundleBps !== null && x.bundleBps > c.maxBundleBps) return fail('bundlers', `Bundled buys ${(x.bundleBps / 100).toFixed(1)}%`);
  if (x.ageMin !== null && x.ageMin < c.minAgeMin) return fail('too_new', `Only ${x.ageMin} min old`);
  if (x.ageMin !== null && x.ageMin > c.maxAgeMin) return fail('too_old', `Older than ${Math.round(c.maxAgeMin / 60)}h`);
  if (x.change1hBps !== null && x.change1hBps > c.maxChange1hBps) return fail('overextended', `Already +${Math.round(x.change1hBps / 100)}% in 1h (chasing)`);
  if (x.buys1h !== null && x.sells1h !== null && x.sells1h > x.buys1h * 1.5) return fail('sell_pressure', `Sells ${x.sells1h} vs buys ${x.buys1h}`);

  // ---- Weighted factors (integer points; null = unknown) ----
  const f: { id: string; points: number | null; max: number; why: string }[] = [];
  const add = (id: string, max: number, v: number | null, why: string) => f.push({ id, max, points: v === null ? null : Math.round(clamp(v, 0, 1) * max), why });
  add('smart_money', 25, x.smartMoney === null ? null : Math.min(x.smartMoney, 8) / 8, `${x.smartMoney ?? '?'} smart-money holders`);
  add('kols', 8, x.kols === null ? null : Math.min(x.kols, 4) / 4, `${x.kols ?? '?'} KOL holders`);
  // healthy momentum: rising but not parabolic (peak credit at +20..+150% 1h, some 5m continuation)
  const m1h = x.change1hBps === null ? null : x.change1hBps <= 0 ? 0 : x.change1hBps <= 2000 ? x.change1hBps / 2000 : x.change1hBps <= 15000 ? 1 : Math.max(0, 1 - (x.change1hBps - 15000) / 15000);
  add('momentum_1h', 15, m1h, `1h ${x.change1hBps === null ? '?' : (x.change1hBps / 100).toFixed(0) + '%'}`);
  add('momentum_5m', 5, x.change5mBps === null ? null : x.change5mBps > 0 && x.change5mBps < 3000 ? 1 : x.change5mBps >= 3000 ? 0.4 : 0.2, `5m ${x.change5mBps === null ? '?' : (x.change5mBps / 100).toFixed(1) + '%'}`);
  const turnover = x.volume1hUsd !== null && x.liquidityUsd ? x.volume1hUsd / x.liquidityUsd : null;
  add('turnover', 12, turnover === null ? null : Math.min(turnover, 3) / 3, `1h volume / liquidity ${turnover === null ? '?' : turnover.toFixed(2)}`);
  const bp = x.buys1h !== null && x.sells1h !== null && x.buys1h + x.sells1h > 0 ? x.buys1h / (x.buys1h + x.sells1h) : null;
  add('buy_pressure', 10, bp === null ? null : clamp((bp - 0.45) / 0.2, 0, 1), `buy share ${bp === null ? '?' : (bp * 100).toFixed(0) + '%'}`);
  add('distribution', 10, x.top10Bps === null ? null : 1 - x.top10Bps / c.maxTop10Bps, `top-10 ${x.top10Bps === null ? '?' : (x.top10Bps / 100).toFixed(1) + '%'}`);
  add('holders', 5, x.holders === null ? null : Math.min(x.holders, 2000) / 2000, `${x.holders ?? '?'} holders`);
  add('due_diligence', 10, x.ddScore === null ? null : x.ddScore / 100, `DD ${x.ddVerdict ?? '?'} ${x.ddScore ?? ''}`);
  for (let i = f.length - 1; i >= 0; i--) if (exclude.includes(f[i].id)) f.splice(i, 1);
  const maxAll = f.reduce((a, y) => a + y.max, 0);
  const known = f.filter(y => y.points !== null);
  const coverageBps = Math.round(known.reduce((a, y) => a + y.max, 0) * 10_000 / maxAll);
  if (coverageBps < c.minCoverageBps) return fail('coverage', `Only ${(coverageBps / 100).toFixed(0)}% of scoring data known`);
  const score = Math.round(known.reduce((a, y) => a + (y.points as number), 0) * 100 / maxAll); // unknown factors count as 0
  const reasons = [...f].filter(y => y.points !== null && y.points >= y.max * 0.7).sort((a, b) => b.max - a.max).slice(0, 3).map(y => y.why);
  return { address: x.address, symbol: x.symbol, passed: true, score, coverageBps, factors: f, reasons, version: exclude.length ? `${FINDER_VERSION}-no:${[...exclude].sort().join(',')}` : FINDER_VERSION };
}

/** Rank candidates deterministically (score desc, then address) and report exclusion counts per gate. */
export function runFinder(xs: FinderInput[], c: FinderConfig = DEFAULT_FINDER, exclude: string[] = []) {
  const all = xs.map(x => finderScore(x, c, exclude));
  const passed = all.filter((r): r is Extract<FinderResult, { passed: true }> => r.passed).sort((a, b) => b.score - a.score || (a.address < b.address ? -1 : 1));
  const excluded: Record<string, number> = {};
  for (const r of all) if (!r.passed) excluded[r.gate] = (excluded[r.gate] ?? 0) + 1;
  return { version: exclude.length ? `${FINDER_VERSION}-no:${[...exclude].sort().join(',')}` : FINDER_VERSION, passed, excluded, scanned: xs.length };
}

// ---------------- Auto exit plan (owner's rule: partial/trailing from +50%, TP at +100%) ----------------
export type AutoExitConfig = { partialBps: number; trailActivation: string; retracement: string; tpGain: string; stopLoss: string };
export const DEFAULT_AUTO_EXIT: AutoExitConfig = { partialBps: 5000, trailActivation: '0.5', retracement: '0.15', tpGain: '1', stopLoss: '0.3' };
/** Params for a tp_sl strategy: sell `partialBps` of the original at +trailActivation, arm a trailing stop on the rest
 *  from the same level, take the remainder at +tpGain, and a hard stop-loss below entry. */
export function autoExitParams(e: AutoExitConfig) {
  if (!(e.partialBps >= 0 && e.partialBps < 10_000)) throw new Error('PARTIAL_OUT_OF_RANGE');
  if (!(Number(e.tpGain) > Number(e.trailActivation))) throw new Error('TP_MUST_BE_ABOVE_TRAIL_ACTIVATION');
  const stages = [...(e.partialBps > 0 ? [{ percentBps: e.partialBps, gain: e.trailActivation }] : []), { percentBps: 10_000 - e.partialBps, gain: e.tpGain }];
  return { stages, stopLoss: e.stopLoss, trailActivation: e.trailActivation, retracement: e.retracement };
}
