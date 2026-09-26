// MarketDataProvider / WalletAnalyticsProvider / SecurityProvider — FIXTURE implementation.
// All outputs carry meta.status = 'simulated' and source = jgg-fixture-v1.
import { CHAIN_META, type Chain, type Provenance } from '../../contracts/src/index.ts';
import * as D from '../../domain/src/index.ts';
import {
  FIXTURE_SOURCE, fixtureTokens, findFixtureToken, priceAt, fixtureCandles, fixtureWallets, fixtureTrades, fixtureAddress, mulberry32, num, NATIVE_USD,
  type FixtureToken, type Lifecycle,
} from '../../test-fixtures/src/index.ts';

export const meta = (now: number, extra: Partial<Provenance> = {}): Provenance => ({ status: 'simulated', source: FIXTURE_SOURCE, asOf: new Date(now).toISOString(), coverage: 'deterministic fixture universe', ...extra });

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

export type TokenRow = {
  chain: Chain; address: string; symbol: string; name: string; launchpad: string; lifecycle: Lifecycle; createdAt: number; ageSec: number;
  priceUsd: string | null; mcUsd: string | null; mcBasis: 'circulating' | 'fdv_approx'; liqUsd: string | null; athMcUsd: string | null;
  vol: Record<'1m' | '5m' | '1h' | '6h' | '24h', string>; txs: { buys: number; sells: number }; holders: number;
  change: Record<'1m' | '5m' | '1h' | '6h' | '24h', number | null>; // bps
  top10Bps: number | null; devHoldingBps: number | null; bundleBps: number | null; insiderBps: number | null; snipers: number;
  smartMoney: number; kols: number; progressBps: number | null; socials: FixtureToken['socials']; hue: number;
  taxBps: { buy: number | null; sell: number | null }; risk: 'ok' | 'caution' | 'danger' | 'unknown'; hotSearches: number;
};

const WIN: Record<string, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000 };

export function tokenRow(t: FixtureToken, now: number): TokenRow {
  const p = priceAt(t, now);
  const supply = D.rawToDec(t.supplyRaw, t.decimals);
  const mc = p === null ? null : D.str(D.rescale(D.mul(supply, num(p)), 2));
  const r = mulberry32(t.seed ^ Math.floor(now / 30_000));
  const ageMin = (now - t.createdAt) / 60_000;
  const vol = Object.fromEntries(Object.entries(WIN).map(([k, ms]) => [k, (Math.min(ms, now - t.createdAt) / 60_000 * (40 + (t.seed % 900)) * (0.6 + r() * 0.8)).toFixed(2)])) as TokenRow['vol'];
  const change = Object.fromEntries(Object.entries(WIN).map(([k, ms]) => {
    const past = priceAt(t, now - ms);
    return [k, p === null || past === null ? null : Math.round(((p - past) / past) * 10_000)];
  })) as TokenRow['change'];
  const ath = p === null ? null : D.str(D.rescale(D.mul(mc!, (1 + (t.seed % 500) / 100).toFixed(2)), 2));
  const liq = t.liquidityBase === null ? null : (t.liquidityBase * (0.9 + r() * 0.2)).toFixed(2);
  const sec = t.security;
  const risk = sec.honeypot === 'risky' || (t.top10Bps ?? 0) > 5000 ? 'danger' : sec.honeypot === 'unknown' ? 'unknown' : (t.devHoldingBps ?? 0) > 800 || (sec.buyTaxBps ?? 0) > 300 ? 'caution' : 'ok';
  const txBase = Math.floor(ageMin * (3 + (t.seed % 40)));
  return {
    chain: t.chain, address: t.address, symbol: t.symbol, name: t.name, launchpad: t.launchpad, lifecycle: t.lifecycle, createdAt: t.createdAt,
    ageSec: Math.floor((now - t.createdAt) / 1000), priceUsd: p === null ? null : num(p), mcUsd: mc, mcBasis: t.circulatingKnown ? 'circulating' : 'fdv_approx',
    liqUsd: liq, athMcUsd: ath, vol, txs: { buys: Math.floor(txBase * 0.54), sells: Math.floor(txBase * 0.46) }, holders: Math.floor(5 + ageMin * (1 + (t.seed % 7))),
    change, top10Bps: t.top10Bps, devHoldingBps: t.devHoldingBps, bundleBps: t.bundleBps, insiderBps: t.insiderBps, snipers: t.snipers,
    smartMoney: t.smartMoney, kols: t.kols, progressBps: t.bondingProgressBps, socials: t.socials, hue: t.hue,
    taxBps: { buy: sec.buyTaxBps, sell: sec.sellTaxBps }, risk, hotSearches: (t.seed % 97) * (1 + Math.floor(r() * 3)),
  };
}

export type MarketFilter = {
  launchpad?: string; minLiquidityUsd?: string; minMarketCapUsd?: string; maxMarketCapUsd?: string; minSmartMoney?: number; maxTop10Bps?: number;
  minVolumeUsd?: string; keyword?: string; excludeRisky?: boolean; unknownPolicy?: 'include' | 'exclude';
};
export function applyFilter(rows: TokenRow[], f: MarketFilter): { rows: TokenRow[]; excluded: Record<string, number> } {
  const excluded: Record<string, number> = {}; const bump = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; return false; };
  const unk = f.unknownPolicy ?? 'exclude';
  const out = rows.filter(r => {
    if (f.launchpad && f.launchpad !== 'any' && r.launchpad !== f.launchpad) return bump('launchpad');
    if (f.keyword && !(`${r.symbol} ${r.name} ${r.address}`.toLowerCase().includes(f.keyword.toLowerCase()))) return bump('keyword');
    if (f.minLiquidityUsd) { if (r.liqUsd === null) { if (unk === 'exclude') return bump('liquidity_unknown'); } else if (D.lt(r.liqUsd, f.minLiquidityUsd)) return bump('liquidity'); }
    if (f.minMarketCapUsd && (r.mcUsd === null || D.lt(r.mcUsd, f.minMarketCapUsd))) return bump('market_cap_min');
    if (f.maxMarketCapUsd && (r.mcUsd === null || D.gt(r.mcUsd, f.maxMarketCapUsd))) return bump('market_cap_max');
    if (f.minSmartMoney !== undefined && r.smartMoney < f.minSmartMoney) return bump('smart_money');
    if (f.maxTop10Bps !== undefined) { if (r.top10Bps === null) { if (unk === 'exclude') return bump('top10_unknown'); } else if (r.top10Bps > f.maxTop10Bps) return bump('top10'); }
    if (f.minVolumeUsd && D.lt(r.vol['1h'], f.minVolumeUsd)) return bump('volume');
    if (f.excludeRisky && r.risk === 'danger') return bump('risk');
    return true;
  });
  return { rows: out, excluded };
}

export const allRows = (chain: Chain, now: number) => fixtureTokens(chain, now).filter(t => t.createdAt <= now).map(t => tokenRow(t, now));

export function trenches(chain: Chain, now: number, stage: Lifecycle, f: MarketFilter = {}) {
  const rows = allRows(chain, now).filter(r => r.lifecycle === stage);
  const res = applyFilter(rows, f);
  const sorted = stage === 'new' ? res.rows.sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1))
    : stage === 'near_completion' ? res.rows.sort((a, b) => (b.progressBps ?? 0) - (a.progressBps ?? 0) || (a.address < b.address ? -1 : 1))
    : res.rows.sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1));
  return { rows: sorted, excluded: res.excluded };
}

export function trending(chain: Chain, now: number, window: string, view: string, f: MarketFilter = {}) {
  let rows = allRows(chain, now);
  if (view === 'new_pair') rows = rows.filter(r => r.ageSec < 3600 * 6);
  if (view === 'surge') rows = rows.filter(r => (r.change['5m'] ?? 0) > 500);
  const ranked = D.rank(rows.map(r => ({ id: r.address, volumeUsd: r.vol[(window in WIN ? window : '1h') as keyof TokenRow['vol']], priceChangeBps: r.change[(window in WIN ? window : '1h') as keyof TokenRow['change']], liquidityUsd: r.liqUsd, txCount: r.txs.buys + r.txs.sells, holders: r.holders })));
  const by = new Map(rows.map(r => [r.address, r]));
  const res = applyFilter(ranked.map(x => by.get(x.id)!), f);
  const scores = new Map(ranked.map(x => [x.id, x]));
  if (view === 'hot_searches') res.rows.sort((a, b) => b.hotSearches - a.hotSearches);
  return { rows: res.rows.map(r => ({ ...r, jggRank: scores.get(r.address)! })), excluded: res.excluded, ranking: D.JGG_RANKING_VERSION };
}

export function tokenDetail(chain: Chain, address: string, now: number) {
  const t = findFixtureToken(chain, address); if (!t) return null;
  const row = tokenRow(t, now);
  const holders = holdersOf(t, now);
  const dd = D.dueDiligence({ ...t.security, top10ConcentrationBps: t.top10Bps, devHoldingBps: t.devHoldingBps, liquidityUsd: row.liqUsd, ageMinutes: Math.floor(row.ageSec / 60), buyTaxBps: t.security.buyTaxBps, sellTaxBps: t.security.sellTaxBps });
  return {
    ...row, decimals: t.decimals, supplyRaw: t.supplyRaw, creator: t.creator, security: t.security, dd,
    concentration: D.concentration(holders.map(h => ({ address: h.address, raw: h.raw, system: h.system })), t.supplyRaw, 10),
    pools: poolsOf(t, row), migratedPool: t.migratedPool ?? null,
    explorer: CHAIN_META[chain].explorerAddr + address,
  };
}

function holdersOf(t: FixtureToken, now: number) {
  const r = mulberry32(t.seed ^ 0xabc); const supply = BigInt(t.supplyRaw); const out: { address: string; raw: string; system?: 'pool' | 'burn'; label?: string }[] = [];
  const poolShare = BigInt(Math.floor(1500 + r() * 2500)); out.push({ address: t.migratedPool?.newPool ?? fixtureAddress(t.chain, 'bc' + t.seed), raw: (supply * poolShare / 10000n).toString(), system: 'pool' });
  if (r() < 0.4) out.push({ address: t.chain === 'solana' ? '1nc1nerator11111111111111111111111111111111' : '0x000000000000000000000000000000000000dEaD', raw: (supply * 300n / 10000n).toString(), system: 'burn' });
  const ws = fixtureWallets(t.chain);
  let remaining = supply * 5000n / 10000n;
  for (let i = 0; i < 100 && remaining > 0n; i++) {
    const share = remaining * BigInt(Math.floor(3 + r() * 12)) / 100n; remaining -= share;
    const w = i < 40 && r() < 0.5 ? ws[(t.seed + i) % ws.length] : null;
    out.push({ address: w?.address ?? fixtureAddress(t.chain, `h${t.seed}:${i}`), raw: share.toString(), label: w?.labels[0] });
  }
  return out;
}

function poolsOf(t: FixtureToken, row: TokenRow) {
  const quote = CHAIN_META[t.chain].native;
  const pools = [];
  if (t.lifecycle !== 'migrated') pools.push({ address: fixtureAddress(t.chain, 'bc' + t.seed), dex: `${t.launchpad} bonding curve`, quote, liquidityUsd: row.liqUsd, feeBps: null, createdAt: t.createdAt, lp: 'not_applicable' });
  if (t.migratedPool) pools.push({ address: t.migratedPool.newPool, dex: t.migratedPool.dex, quote, liquidityUsd: row.liqUsd, feeBps: 25, createdAt: t.migratedPool.at, lp: t.security.lpLockedOrBurned });
  return pools;
}

export function holders(chain: Chain, address: string, now: number, limit = 100) {
  const t = findFixtureToken(chain, address); if (!t) return null;
  const p = priceAt(t, now); const all = holdersOf(t, now);
  const rows = all.slice(0, limit + 2).map((h, i) => {
    const qty = D.rawToDec(h.raw, t.decimals);
    return { rank: i + 1, address: h.address, system: h.system ?? null, label: h.label ?? null, qty: D.str(D.rescale(qty, 4)),
      shareBps: Number(BigInt(h.raw) * 10000n / BigInt(t.supplyRaw)), valueUsd: p === null ? null : D.fixed(D.mul(qty, num(p)), 2) };
  });
  return { rows, denominator: 'total supply (raw)', supplyRaw: t.supplyRaw, excludedSystem: rows.filter(r => r.system).map(r => r.address), coverageNote: 'Fixture holders; system addresses labeled and excluded from concentration.' };
}

export function traders(chain: Chain, address: string, now: number, sortBy = 'realized_pnl') {
  const tr = fixtureTrades(chain, now - 6 * 3_600_000, now).filter(x => x.token === address);
  const by = new Map<string, { wallet: string; buys: number; sells: number; buyUsd: D.Dec; sellUsd: D.Dec }>();
  for (const x of tr) {
    const e = by.get(x.wallet) ?? { wallet: x.wallet, buys: 0, sells: 0, buyUsd: D.dec('0'), sellUsd: D.dec('0') };
    if (x.side === 'buy') { e.buys++; e.buyUsd = D.add(e.buyUsd, x.amountUsd); } else { e.sells++; e.sellUsd = D.add(e.sellUsd, x.amountUsd); }
    by.set(x.wallet, e);
  }
  const rows = [...by.values()].map(e => ({ wallet: e.wallet, buys: e.buys, sells: e.sells, buyUsd: D.fixed(e.buyUsd, 2), sellUsd: D.fixed(e.sellUsd, 2),
    netFlowUsd: D.fixed(D.sub(e.sellUsd, e.buyUsd), 2), realizedPnlUsd: null as string | null }));
  rows.sort((a, b) => sortBy === 'trades' ? (b.buys + b.sells) - (a.buys + a.sells) : D.cmp(b.buyUsd, a.buyUsd));
  return { rows: rows.slice(0, 100), coverage: '6h fixture window', note: 'Realized P&L requires full per-wallet basis history; shown as unknown rather than estimated.' };
}

export function candles(chain: Chain, address: string, interval: string, count: number, now: number) {
  const t = findFixtureToken(chain, address); if (!t) return null;
  const ms = ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as Record<string, number>)[interval];
  if (!ms) return { error: 'INTERVAL_UNSUPPORTED' as const };
  return { interval, currency: 'USD', pool: t.migratedPool?.newPool ?? 'bonding-curve', rows: fixtureCandles(t, ms, Math.min(count, 1000), now) };
}

// ---------------- Wallets ----------------
const PERIOD_MS: Record<string, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const tradeCache = new Map<string, ReturnType<typeof fixtureTrades>>();
function periodTrades(chain: Chain, now: number, period: string) {
  const minute = Math.floor(now / 60_000); const key = `${chain}:${period}:${minute}`;
  let v = tradeCache.get(key);
  if (!v) { v = fixtureTrades(chain, minute * 60_000 - (PERIOD_MS[period] ?? PERIOD_MS['7d']), minute * 60_000); if (tradeCache.size > 12) tradeCache.clear(); tradeCache.set(key, v); }
  return v;
}
export function walletDetail(chain: Chain, address: string, now: number, period = '7d') {
  const w = fixtureWallets(chain).find(x => x.address === address);
  const trades = periodTrades(chain, now, period).filter(x => x.wallet === address);
  // Replay trades through the accounting engine per token (weighted average), skipping sells without basis.
  const buckets = new Map<string, D.Bucket>(); let unknownSells = 0; const episodes: { pnl: string }[] = [];
  for (const x of trades.sort((a, b) => a.ts - b.ts)) {
    let b = buckets.get(x.token) ?? D.emptyBucket();
    if (x.side === 'buy') b = D.applyBuy(b, x.tokenQty, x.price, '0');
    else {
      const q = D.min(x.tokenQty, b.knownQty);
      if (!D.gt(q, '0')) { unknownSells++; continue; }
      const r = D.applySell(b, D.str(q), x.price, '0'); b = r.bucket; episodes.push({ pnl: D.str(r.realizedPnl) });
    }
    buckets.set(x.token, b);
  }
  const realized = episodes.reduce((a, e) => D.add(a, e.pnl), D.dec('0'));
  const wr = D.winRate(episodes);
  const holdings = [...buckets.entries()].filter(([, b]) => D.gt(b.knownQty, '0')).map(([tok, b]) => {
    const t = findFixtureToken(chain, tok)!; const p = priceAt(t, now); const m = D.markToMarket(b, p === null ? null : num(p));
    return { token: tok, symbol: t.symbol, qty: D.fixed(b.knownQty, 4), basisUsd: D.fixed(b.knownBasis, 2), valueUsd: m ? D.fixed(m.markValue, 2) : null, unrealizedUsd: m ? D.fixed(m.unrealized, 2) : null };
  });
  const r = mulberry32(hash(address));
  return {
    chain, address, known: !!w, name: w?.name ?? null, labels: (w?.labels ?? []).map(l => ({ label: l, source: 'jgg-fixture-rule-v1', confidence: 'fixture', method: 'Deterministic fixture classification; not a live label.' })),
    nativeBalance: (r() * 800).toFixed(3), period, trades: trades.length,
    buys: trades.filter(x => x.side === 'buy').length, sells: trades.filter(x => x.side === 'sell').length,
    volumeUsd: D.fixed(trades.reduce((a, x) => D.add(a, x.amountUsd), D.dec('0')), 2),
    realizedPnlUsd: D.fixed(realized, 2), winRate: wr.rate === null ? null : D.fixed(D.mul(wr.rate, '100'), 1), winRateDenominator: wr.total, breakEven: wr.breakEven,
    unknownBasisSells: unknownSells, holdings, history: [...trades].slice(-100).reverse(),
    coverage: `Fixture trades in period; ${unknownSells} sells skipped for unknown basis (not counted as profit).`,
    score: D.walletScore({ closedEpisodes: wr.total, winRateBps: wr.rate === null ? null : Number(D.rescale(D.mul(wr.rate, '10000'), 0).int), realizedPnlUsd: D.str(realized), medianHoldMinutes: 5 + Math.floor(r() * 90), medianPositionUsd: '500', tokensRuggedBps: Math.floor(r() * 3000) }),
  };
}

export function rankWallets(chain: Chain, now: number, period: string, category: string) {
  const list = fixtureWallets(chain).filter(w => category === 'all' || w.labels.includes(category as any));
  const rows = list.map(w => { const d = walletDetail(chain, w.address, now, period); return { address: w.address, name: w.name, labels: w.labels, hue: w.hue, nativeBalance: d.nativeBalance, realizedPnlUsd: d.realizedPnlUsd, winRate: d.winRate, winRateDenominator: d.winRateDenominator, buys: d.buys, sells: d.sells, volumeUsd: d.volumeUsd }; });
  rows.sort((a, b) => D.cmp(b.realizedPnlUsd, a.realizedPnlUsd) || (a.address < b.address ? -1 : 1));
  const days = period === '30d' ? 30 : period === '7d' ? 7 : 1;
  return { rows, interval: { from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now).toISOString() }, method: 'Realized P&L from fixture trade replay (weighted-average basis); unknown-basis sells excluded.' };
}

// ---------------- Signals ----------------
export function signals(chain: Chain, now: number, kind: string, opts: { label?: string; side?: string; minWallets?: number; windowMs?: number; minChangeBps?: number; tracked?: Set<string> } = {}) {
  const ws = new Map(fixtureWallets(chain).map(w => [w.address, w]));
  const trades = fixtureTrades(chain, now - (opts.windowMs ?? 3_600_000), now);
  const tokens = new Map(fixtureTokens(chain, now).map(t => [t.address, t]));
  const enrich = (x: typeof trades[number]) => ({ ...x, symbol: tokens.get(x.token)?.symbol ?? '?', walletName: ws.get(x.wallet)?.name ?? null, labels: ws.get(x.wallet)?.labels ?? [], explorer: CHAIN_META[chain].explorerTx + x.txRef });
  if (kind === 'wallet_trades') return trades.filter(x => opts.tracked?.has(x.wallet)).filter(x => !opts.side || opts.side === 'all' || x.side === opts.side).map(enrich).reverse();
  if (kind === 'label_trades') return trades.filter(x => ws.get(x.wallet)?.labels.includes(opts.label as any)).filter(x => !opts.side || opts.side === 'all' || x.side === opts.side).map(enrich).reverse();
  if (kind === 'cluster') {
    const side = opts.side ?? 'buy'; const g = new Map<string, Set<string>>();
    for (const x of trades) if (x.side === side && ws.get(x.wallet)?.labels.includes('smart_money')) (g.get(x.token) ?? g.set(x.token, new Set()).get(x.token)!).add(x.wallet);
    return [...g.entries()].filter(([, s]) => s.size >= (opts.minWallets ?? 3)).map(([tok, s]) => ({ token: tok, symbol: tokens.get(tok)?.symbol, side, distinctWallets: s.size, wallets: [...s], windowMs: opts.windowMs, assumption: 'Distinct addresses; common ownership not assumed or excluded.' }));
  }
  if (kind === 'surge') {
    return allRows(chain, now).filter(r => (r.change['5m'] ?? 0) >= (opts.minChangeBps ?? 2000)).map(r => ({ token: r.address, symbol: r.symbol, changeBps: r.change['5m'], baseline: 'price 5m earlier (fixture path)', at: new Date(now).toISOString(), risk: r.risk, liqUsd: r.liqUsd, top10Bps: r.top10Bps }));
  }
  if (kind === 'claims') {
    return fixtureTokens(chain).filter(t => t.launchpad === 'pumpfun' && t.seed % 5 === 0).slice(0, 12).map(t => ({ token: t.address, symbol: t.symbol, beneficiary: t.creator, amount: ((t.seed % 1000) / 100).toFixed(2) + ' SOL', type: 'creator_fee_claim (fixture)', at: new Date(now - (t.seed % 3600) * 1000).toISOString() }));
  }
  if (kind === 'callouts') {
    return fixtureTokens(chain).slice(0, 15).map((t, i) => {
      const callAt = now - (i + 1) * 17 * 60_000; const p0 = priceAt(t, callAt); const p1 = priceAt(t, now);
      return { caller: fixtureWallets(chain)[(i * 5) % 40].name, token: t.address, symbol: t.symbol, calledAt: new Date(callAt).toISOString(), priceAtCall: p0 === null ? null : num(p0),
        observedChangeBps: p0 === null || p1 === null ? null : Math.round((p1 - p0) / p0 * 10_000), window: 'call time → now', note: 'Observed post-call price move; not executable follower profit.' };
    });
  }
  return [];
}

export function gasFees(chain: Chain) {
  return chain === 'solana'
    ? { chain, unit: 'micro-lamports per compute unit (priority fee)', baseFeeLamportsPerSignature: '5000', tiers: { low: '1000', average: '10000', high: '100000' } }
    : { chain, unit: 'gwei', tiers: chain === 'bsc' ? { low: '1', average: '1', high: '3' } : chain === 'base' ? { low: '0.005', average: '0.01', high: '0.05' } : { low: '8', average: '12', high: '25' } };
}

export function search(q: string, now: number, chainHint?: Chain) {
  const query = q.trim(); if (!query) return [];
  const chains: Chain[] = ['solana', 'bsc', 'base', 'ethereum'];
  const out: { type: 'token' | 'wallet'; chain: Chain; address: string; symbol?: string; name?: string; mcUsd?: string | null; ageSec?: number; exact: boolean }[] = [];
  for (const c of chains) {
    for (const t of fixtureTokens(c, now)) {
      const exact = t.address === query || (c !== 'solana' && t.address.toLowerCase() === query.toLowerCase());
      if (exact || t.symbol.toLowerCase() === query.toLowerCase() || t.name.toLowerCase().includes(query.toLowerCase())) {
        const r = tokenRow(t, now); out.push({ type: 'token', chain: c, address: t.address, symbol: t.symbol, name: t.name, mcUsd: r.mcUsd, ageSec: r.ageSec, exact });
      }
    }
    for (const w of fixtureWallets(c)) if (w.address === query || w.name.toLowerCase() === query.toLowerCase()) out.push({ type: 'wallet', chain: c, address: w.address, name: w.name, exact: w.address === query });
  }
  out.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.chain === chainHint) - Number(a.chain === chainHint));
  return out.slice(0, 30);
}

export const nativeUsd = (c: Chain) => NATIVE_USD[c];

// ---------------- Finder candidates (fixture source; GMGN adapter produces the same FinderInput shape) ----------------
export function finderCandidates(chain: Chain, now: number): D.FinderInput[] {
  return allRows(chain, now).map(r => {
    const t = findFixtureToken(chain, r.address)!;
    const dd = D.dueDiligence({ ...t.security, top10ConcentrationBps: t.top10Bps, devHoldingBps: t.devHoldingBps, liquidityUsd: r.liqUsd, ageMinutes: Math.floor(r.ageSec / 60), buyTaxBps: t.security.buyTaxBps, sellTaxBps: t.security.sellTaxBps });
    return {
      address: r.address, symbol: r.symbol, ageMin: Math.floor(r.ageSec / 60), liquidityUsd: r.liqUsd === null ? null : Number(r.liqUsd), marketCapUsd: r.mcUsd === null ? null : Number(r.mcUsd),
      volume1hUsd: Number(r.vol['1h']), holders: r.holders, buys1h: r.txs.buys, sells1h: r.txs.sells, change5mBps: r.change['5m'], change1hBps: r.change['1h'],
      smartMoney: r.smartMoney, kols: r.kols, top10Bps: r.top10Bps, devHoldingBps: r.devHoldingBps, insiderBps: r.insiderBps, bundleBps: r.bundleBps, snipers: r.snipers,
      honeypot: t.security.honeypot, mintAuthority: t.security.mintAuthority, freezeAuthority: t.security.freezeAuthority, rugRatio: null,
      ddVerdict: dd.verdict as D.FinderInput['ddVerdict'], ddScore: dd.score,
    };
  });
}
