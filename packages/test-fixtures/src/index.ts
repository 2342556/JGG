// JGG DETERMINISTIC FIXTURES — simulated data for Demo/Paper modes and tests.
// Every value here is generated from a seed. None of it is a live market fact.
// JS numbers are used ONLY to generate fixture inputs; they are emitted as decimal strings.
import type { Chain } from '../../contracts/src/index.ts';

export const FIXTURE_SOURCE = 'jgg-fixture-v1';
export const FIXTURE_EPOCH = Date.UTC(2026, 8, 25, 0, 0, 0); // fixed epoch for reproducibility
/** Demo clock: starts 30 min after the epoch and advances in real time from process start. */
let BOOT = Date.now();
/** API and worker share one anchor (persisted in worker_state) so both processes see the same demo time. */
export const setDemoAnchor = (wallMs: number) => { BOOT = wallMs; };
export const demoNow = () => FIXTURE_EPOCH + 30 * 60_000 + (Date.now() - BOOT);

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function fixtureAddress(chain: Chain, key: string): string {
  const r = mulberry32(hashStr(chain + ':' + key));
  if (chain === 'solana') { let s = ''; for (let i = 0; i < 44; i++) s += B58[Math.floor(r() * 58)]; return s; }
  let s = '0x'; for (let i = 0; i < 40; i++) s += '0123456789abcdef'[Math.floor(r() * 16)]; return s;
}

const SYL = ['zor', 'ka', 'lu', 'mi', 'tro', 'nex', 'vel', 'qua', 'pix', 'dro', 'fen', 'gal', 'ho', 'ji', 'ku', 'lem', 'mor', 'nu', 'ob', 'pra', 'ri', 'sa', 'tev', 'ux', 'vo', 'wi', 'yo', 'zen'];
const WORDS = ['Cat', 'Frog', 'Moon', 'Pepe', 'Robot', 'Dog', 'Chip', 'Wave', 'Owl', 'Bear', 'Coin', 'Orbit', 'Sprout', 'Comet', 'Pixel', 'Tiger'];
export const LAUNCHPADS: Record<Chain, string[]> = { solana: ['pumpfun', 'letsbonk', 'moonshot'], bsc: ['fourmeme', 'flap'], base: ['clanker', 'bankr', 'zora'], ethereum: ['uniswap-v2'] };

export type Lifecycle = 'new' | 'near_completion' | 'migrated';
export type FixtureToken = {
  chain: Chain; address: string; symbol: string; name: string; decimals: number; launchpad: string; lifecycle: Lifecycle;
  createdAt: number; seed: number; basePrice: number; supplyRaw: string; circulatingKnown: boolean; creator: string;
  bondingProgressBps: number | null; liquidityBase: number | null; hue: number;
  socials: { x?: string; web?: string; tg?: string };
  security: { honeypot: Tri; mintAuthority: Tri; freezeAuthority: Tri; lpLockedOrBurned: Tri; openSource: Tri; buyTaxBps: number | null; sellTaxBps: number | null };
  top10Bps: number | null; devHoldingBps: number | null; bundleBps: number | null; insiderBps: number | null; snipers: number;
  smartMoney: number; kols: number; migratedPool?: { oldPool: string; newPool: string; dex: string; at: number };
};
type Tri = 'safe' | 'risky' | 'unknown' | 'not_applicable';

function makeToken(chain: Chain, i: number): FixtureToken {
  const seed = hashStr(`${chain}:${i}`); const r = mulberry32(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  let symbol = (pick(SYL) + pick(SYL) + (r() < 0.4 ? pick(SYL) : '')).toUpperCase().slice(0, 9);
  let name = `${symbol.charAt(0)}${symbol.slice(1).toLowerCase()} ${pick(WORDS)}`;
  // Deliberate identity traps for T10 / C03: same symbol on two chains + a same-chain copycat.
  if (i === 0) { symbol = 'JGGDEMO'; name = 'JGG Demo Token'; }
  if (i === 1 && chain === 'solana') { symbol = 'JGGDEMO'; name = 'JGG Demo Token (copycat)'; }
  const lifecycle: Lifecycle = i % 3 === 0 ? 'migrated' : i % 3 === 1 ? 'near_completion' : 'new';
  const ageMin = lifecycle === 'new' ? Math.floor(r() * 90) - 60 : lifecycle === 'near_completion' ? 20 + Math.floor(r() * 200) : 60 + Math.floor(r() * 3000);
  const decimals = chain === 'solana' ? (r() < 0.8 ? 6 : 9) : 18;
  const tri = (pSafe: number, pUnknown = 0.12): Tri => (r() < pUnknown ? 'unknown' : r() < pSafe ? 'safe' : 'risky');
  const evm = chain !== 'solana';
  const hasTax = evm && r() < 0.35;
  return {
    chain, address: fixtureAddress(chain, 'tok' + i), symbol, name, decimals, launchpad: pick(LAUNCHPADS[chain]), lifecycle,
    createdAt: FIXTURE_EPOCH - ageMin * 60_000, seed, basePrice: 10 ** (-(3.3 + r() * 2.2)), supplyRaw: (1_000_000_000n * 10n ** BigInt(decimals)).toString(),
    circulatingKnown: r() > 0.2, creator: fixtureAddress(chain, 'dev' + (i % 17)), hue: Math.floor(r() * 360),
    bondingProgressBps: lifecycle === 'migrated' ? null : lifecycle === 'near_completion' ? 7000 + Math.floor(r() * 2999) : Math.floor(r() * 6000),
    liquidityBase: r() < 0.07 ? null : 2_000 + r() * (lifecycle === 'migrated' ? 400_000 : 40_000),
    socials: { x: r() < 0.7 ? `https://x.com/${symbol.toLowerCase()}` : undefined, web: r() < 0.4 ? `https://${symbol.toLowerCase()}.example` : undefined, tg: r() < 0.3 ? `https://t.me/${symbol.toLowerCase()}` : undefined },
    security: {
      honeypot: tri(0.9), mintAuthority: evm ? 'not_applicable' : tri(0.85), freezeAuthority: evm ? 'not_applicable' : tri(0.9),
      lpLockedOrBurned: lifecycle === 'migrated' ? tri(0.7) : 'not_applicable', openSource: evm ? tri(0.6) : 'not_applicable',
      buyTaxBps: evm ? (hasTax ? 100 + Math.floor(r() * 400) : 0) : 0, sellTaxBps: evm ? (hasTax ? 100 + Math.floor(r() * 400) : 0) : 0,
    },
    top10Bps: r() < 0.1 ? null : 800 + Math.floor(r() * 6000), devHoldingBps: r() < 0.1 ? null : Math.floor(r() * 1500),
    bundleBps: Math.floor(r() * 3000), insiderBps: Math.floor(r() * 2000), snipers: Math.floor(r() * 12),
    smartMoney: Math.floor(r() * 9), kols: Math.floor(r() * 5),
    migratedPool: lifecycle === 'migrated' ? { oldPool: fixtureAddress(chain, 'bc' + i), newPool: fixtureAddress(chain, 'pool' + i), dex: evm ? 'PancakeSwap-like AMM (fixture)' : 'AMM pool (fixture)', at: FIXTURE_EPOCH - Math.floor(ageMin / 2) * 60_000 } : undefined,
  };
}

const cache = new Map<Chain, FixtureToken[]>();
/** Static fixture universe, plus (when `now` is given) freshly "launched" tokens that keep the New column alive. */
export function fixtureTokens(chain: Chain, now?: number): FixtureToken[] {
  if (!cache.has(chain)) cache.set(chain, Array.from({ length: chain === 'solana' ? 96 : 42 }, (_, i) => makeToken(chain, i)));
  const base = cache.get(chain)!;
  return now === undefined ? base : [...base, ...spawnedTokens(chain, now)];
}
// Continuous launches: one new token per chain every SPAWN_MS of demo time, deterministic per slot.
export const SPAWN_MS = 150_000;
const SPAWN_WINDOW = 40; // the most recent 40 launches (~100 min) are listed
const spawnCache = new Map<string, FixtureToken>(); const spawnByAddr = new Map<string, FixtureToken>();
function spawned(chain: Chain, slot: number): FixtureToken {
  const k = `${chain}:${slot}`; let t = spawnCache.get(k);
  if (!t) {
    const b = makeToken(chain, 10_000 + slot);
    t = { ...b, lifecycle: 'new', createdAt: FIXTURE_EPOCH + slot * SPAWN_MS, migratedPool: undefined, bondingProgressBps: Math.floor((b.seed % 40) * 100),
      security: { ...b.security, lpLockedOrBurned: 'not_applicable' }, liquidityBase: b.liquidityBase === null ? null : Math.min(b.liquidityBase, 30_000) };
    spawnCache.set(k, t); spawnByAddr.set(`${chain}:${t.address}`, t);
  }
  return t;
}
export function spawnedTokens(chain: Chain, now: number): FixtureToken[] {
  const max = Math.floor((now - FIXTURE_EPOCH) / SPAWN_MS); const out: FixtureToken[] = [];
  for (let s = Math.max(0, max - SPAWN_WINDOW + 1); s <= max; s++) out.push(spawned(chain, s));
  return out;
}
export function findFixtureToken(chain: Chain, address: string): FixtureToken | undefined {
  const eq = (t: FixtureToken) => t.address === address || (chain !== 'solana' && t.address.toLowerCase() === address.toLowerCase());
  const st = fixtureTokens(chain).find(eq); if (st) return st;
  const hit = spawnByAddr.get(`${chain}:${address}`); if (hit) return hit;
  const max = Math.min(Math.floor((demoNow() - FIXTURE_EPOCH) / SPAWN_MS), 50_000); // cold process: rebuild index
  for (let s = 0; s <= max; s++) { const t = spawned(chain, s); if (eq(t)) return t; }
  return undefined;
}

const paths = new Map<number, { arr: number[]; rr: () => number; amp: number; tau: number }>();
/** Mean-reverting walk in log space around a bounded lifecycle curve (keeps fixture MCs plausible over days). */
function pathFor(t: FixtureToken, upto: number): number[] {
  let e = paths.get(t.seed);
  if (!e) { const r = mulberry32(t.seed ^ 0x9e3779b9); e = { arr: [Math.log(t.basePrice)], rr: mulberry32(t.seed + 7), amp: -1.2 + r() * 4, tau: 30 + r() * 600 }; paths.set(t.seed, e); }
  const base = Math.log(t.basePrice);
  while (e.arr.length <= upto) {
    const n = e.arr.length; const last = e.arr[n - 1];
    const target = base + e.amp * (1 - Math.exp(-n / e.tau));
    e.arr.push(last + 0.03 * (target - last) + (e.rr() - 0.5) * 0.05);
  }
  return e.arr;
}

/** Deterministic price path: multiplicative walk per minute. `now` drives simulated live updates. */
export function priceAt(t: FixtureToken, ms: number): number | null {
  if (ms < t.createdAt) return null;
  const minute = Math.floor((ms - t.createdAt) / 60_000);
  const path = pathFor(t, Math.min(minute, 20_000));
  const p = Math.exp(path[Math.min(minute, 20_000)]);
  const sub = ((ms - t.createdAt) % 60_000) / 60_000; const rs = mulberry32(t.seed + minute);
  return Math.max(p * (1 + (rs() - 0.5) * 0.02 * sub), 1e-12);
}

export type FixtureCandle = { t: number; o: string; h: string; l: string; c: string; v: string } | { t: number; gap: true };
export function fixtureCandles(tok: FixtureToken, intervalMs: number, count: number, now: number): FixtureCandle[] {
  const out: FixtureCandle[] = []; const end = Math.floor(now / intervalMs) * intervalMs;
  for (let k = count - 1; k >= 0; k--) {
    const t = end - k * intervalMs; if (t < tok.createdAt) continue;
    const g = mulberry32(tok.seed ^ Math.floor(t / intervalMs));
    if (g() < 0.03) { out.push({ t, gap: true }); continue; } // deliberate gaps (no trades) — T08/T17
    const o = priceAt(tok, t)!; const c = priceAt(tok, t + intervalMs - 1)!;
    const h = Math.max(o, c) * (1 + g() * 0.03); const l = Math.min(o, c) * (1 - g() * 0.03);
    out.push({ t, o: num(o), h: num(h), l: num(l), c: num(c), v: (g() * 20_000 * (intervalMs / 60_000)).toFixed(2) });
  }
  return out;
}

export function num(x: number): string { // fixed-significant decimal string, no exponent
  if (x === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const places = Math.min(18, Math.max(2, 5 - mag));
  return x.toFixed(places).replace(/\.?0+$/, '');
}

export type FixtureWallet = { chain: Chain; address: string; name: string; labels: ('smart_money' | 'kol' | 'sniper' | 'fresh' | 'dev' | 'launchpad_sm' | 'live')[]; seed: number; hue: number };
export function fixtureWallets(chain: Chain): FixtureWallet[] {
  return Array.from({ length: 40 }, (_, i) => {
    const seed = hashStr(`${chain}:w${i}`); const r = mulberry32(seed);
    const labels: FixtureWallet['labels'] = [];
    if (i % 3 === 0) labels.push('smart_money'); if (i % 5 === 0) labels.push('kol'); if (i % 7 === 0) labels.push('sniper');
    if (i % 11 === 0) labels.push('fresh'); if (i % 13 === 0) labels.push('dev'); if (i % 4 === 0) labels.push('launchpad_sm');
    return { chain, address: fixtureAddress(chain, 'w' + i), name: `${SYL[i % SYL.length]}${SYL[(i * 7) % SYL.length]}.${['sol', 'eth', 'bnb'][i % 3]}`, labels, seed, hue: Math.floor(r() * 360) };
  });
}

export type FixtureTrade = { eventId: string; chain: Chain; wallet: string; token: string; side: 'buy' | 'sell'; amountUsd: string; tokenQty: string; price: string; ts: number; txRef: string; sourcePreBalance: string | null };
/** Deterministic trade events in [from,to); each has a stable eventId for dedupe tests. */
export function fixtureTrades(chain: Chain, from: number, to: number): FixtureTrade[] {
  const ws = fixtureWallets(chain); const out: FixtureTrade[] = []; let ts = fixtureTokens(chain, from); let tsSlot = Math.floor(from / SPAWN_MS);
  const start = Math.floor(from / 15_000);
  for (let slot = start; slot * 15_000 < to; slot++) {
    if (Math.floor((slot * 15_000) / SPAWN_MS) !== tsSlot) { tsSlot = Math.floor((slot * 15_000) / SPAWN_MS); ts = fixtureTokens(chain, tsSlot * SPAWN_MS); } // token set fixed per spawn slot
    const r = mulberry32(hashStr(chain) ^ slot);
    const n = Math.floor(r() * 3);
    for (let j = 0; j < n; j++) {
      const w = ws[Math.floor(r() * ws.length)]; const tk = ts[Math.floor(r() * ts.length)];
      const at = slot * 15_000 + Math.floor(r() * 15_000); const p = priceAt(tk, at); if (p === null || at < from || at >= to) continue;
      const usd = 50 + r() * 4000; const side = r() < 0.6 ? 'buy' : 'sell';
      out.push({ eventId: `${chain}:${slot}:${j}`, chain, wallet: w.address, token: tk.address, side, amountUsd: usd.toFixed(2), tokenQty: num(usd / p), price: num(p), ts: at,
        txRef: fixtureAddress(chain, `tx${slot}:${j}`) + (chain === 'solana' ? 'x'.repeat(0) : ''), sourcePreBalance: r() < 0.9 ? num((usd / p) * (1 + r() * 4)) : null });
    }
  }
  return out;
}

export const NATIVE_USD: Record<Chain, string> = { solana: '150.00', bsc: '600.00', base: '3000.00', ethereum: '3000.00' }; // fixture only
