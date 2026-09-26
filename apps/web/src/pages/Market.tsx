import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useQueryState, useRouter } from '../router.tsx';
import { useApp, useApi, useTicks, State, TokenAvatar, Copy, Tip, Tabs, Seg, I, usd, pct, bpsPct, age, short, cls, signCls, price, SimTag, type Tick } from '../lib.tsx';
import { QuickBuy } from '../components/Trade.tsx';

const merge = (r: any, t?: Tick) => t ? { ...r, priceUsd: t.p ?? r.priceUsd, mcUsd: t.mc ?? r.mcUsd, change: { ...r.change, '5m': t.c5m, '1h': t.c1h }, txs: t.tx, holders: t.h, vol: { ...r.vol, '1h': t.v1h } } : r;

/** Freeze row order while the pointer/keyboard is inside a list; buffer and count incoming changes (spec §4.5). */
function useFrozen<T extends { address: string }>(rows: T[], paused: boolean) {
  const [shown, setShown] = useState<T[]>(rows); const pending = useRef<T[] | null>(null); const [n, setN] = useState(0);
  useEffect(() => {
    if (paused && shown.length) { // never freeze an empty list (initial load while the pointer rests on the column)
      pending.current = rows; const cur = new Set(shown.map(r => r.address)); setN(rows.filter(r => !cur.has(r.address)).length);
      const by = new Map(rows.map(r => [r.address, r])); setShown(s => s.map(r => by.get(r.address) ?? r)); // values update, order frozen
    } else { setShown(rows); setN(0); pending.current = null; }
  }, [rows, paused]);
  return { shown, pendingCount: n };
}

const RISK_LABEL: Record<string, string> = { ok: 'No major risk flags', warn: 'Some risk flags — open the coin for details', danger: 'High risk — open the coin for details' };

/** One coin, one row: who it is, how old, how big, how it's moving. Details live on the coin page. */
function TokenCard({ r, chain, qb, window: win = '5m' }: { r: any; chain: string; qb: string; window?: string }) {
  const hot = (r.change['5m'] ?? 0) > 1000; const chg = r.change[win] ?? null;
  return <Link to={`/token/${chain}/${r.address}`} className={cls('tcard', hot && 'flash')} aria-label={`${r.symbol}, ${RISK_LABEL[r.risk] ?? r.risk}`}>
    <span className="tcard-av"><TokenAvatar symbol={r.symbol} hue={r.hue} size={44} /><span className={cls('risk-dot', r.risk)} title={RISK_LABEL[r.risk] ?? r.risk} /></span>
    <div className="tcard-main">
      <div className="tline"><strong className="sym">{r.symbol}</strong><span className="muted small">{age(r.ageSec)}</span></div>
      <div className="tline sub"><span><I.users />{r.holders ?? '—'}</span>
        {r.lifecycle !== 'migrated' && r.progressBps !== null && r.progressBps !== undefined && <><span className="dot-sep" /><span>{bpsPct(r.progressBps)} bonded</span></>}
      </div>
    </div>
    <div className="tcard-side">
      <b className="mc-val" title={`Market cap (${r.mcBasis === 'circulating' ? 'circulating' : 'FDV approx.'})`}>{usd(r.mcUsd)}</b>
      <span className={cls('chg', signCls(chg))}>{pct(chg)}</span>
    </div>
    <QuickBuy chain={chain} address={r.address} symbol={r.symbol} amount={qb} />
  </Link>;
}

function Column({ stage, title, chain, ticks, qb }: { stage: string; title: string; chain: string; ticks: Map<string, Tick>; qb: string }) {
  const [filt, setFilt] = useState({ minLiq: '', minMc: '', maxMc: '', minSm: '', keyword: '', excludeRisky: false });
  const [showF, setShowF] = useState(false); const [paused, setPaused] = useState(false); const [hover, setHover] = useState(false);
  const qs = new URLSearchParams({ chain, ...Object.fromEntries(Object.entries(filt).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])) });
  const d = useApi<any>(`/markets/${stage}?${qs}`, [qs.toString()], paused ? 0 : 5000);
  const rows = useMemo(() => (d.data?.data.rows ?? []).map((r: any) => merge(r, ticks.get(r.address))), [d.data, ticks]);
  const { shown, pendingCount } = useFrozen(rows, hover || paused);
  const excluded = d.data?.data.excluded ?? {};
  return <section className="tcol" aria-label={title} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(false); }}>
    <header className="tcol-head">
      <h2>{title}</h2><span className="count">{rows.length}</span>
      {(hover || paused) && <span className="paused" role="status">{paused ? 'Paused' : 'Hold'}{pendingCount ? ` · ${pendingCount} new` : ''}</span>}
      <div className="grow" />
      <button className={cls('icon-btn sm', paused && 'on')} aria-pressed={paused} aria-label={paused ? 'Resume feed' : 'Pause feed'} onClick={() => setPaused(!paused)}>{paused ? <I.play /> : <I.pause />}</button>
      <button className={cls('icon-btn sm', showF && 'on')} aria-expanded={showF} aria-label="Filters" onClick={() => setShowF(!showF)}><I.filter /></button>
    </header>
    {showF && <div className="filters">
      <label>Keyword<input value={filt.keyword} onChange={e => setFilt({ ...filt, keyword: e.target.value })} /></label>
      <label>Min liq $<input inputMode="decimal" value={filt.minLiq} onChange={e => setFilt({ ...filt, minLiq: e.target.value.replace(/[^\d.]/g, '') })} /></label>
      <label>Min MC $<input inputMode="decimal" value={filt.minMc} onChange={e => setFilt({ ...filt, minMc: e.target.value.replace(/[^\d.]/g, '') })} /></label>
      <label>Max MC $<input inputMode="decimal" value={filt.maxMc} onChange={e => setFilt({ ...filt, maxMc: e.target.value.replace(/[^\d.]/g, '') })} /></label>
      <label>Min SM<input inputMode="numeric" value={filt.minSm} onChange={e => setFilt({ ...filt, minSm: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="check"><input type="checkbox" checked={filt.excludeRisky} onChange={e => setFilt({ ...filt, excludeRisky: e.target.checked })} />Hide risky</label>
      <button className="link" onClick={() => setFilt({ minLiq: '', minMc: '', maxMc: '', minSm: '', keyword: '', excludeRisky: false })}>Reset</button>
      {Object.keys(excluded).length > 0 && <p className="muted fine">Excluded: {Object.entries(excluded).map(([k, v]) => `${k} ${v}`).join(', ')} (unknown values excluded when a filter needs them)</p>}
    </div>}
    <div className="tcol-body"><State loading={d.loading} error={d.error} onRetry={() => d.reload()} empty={!shown.length && 'No tokens match. Loosen filters or wait for new launches.'} rows={8}>
      {shown.map((r: any) => <TokenCard key={r.address} r={r} chain={chain} qb={qb} />)}
    </State></div>
  </section>;
}

export function Trenches() {
  const { chain } = useApp(); const { ticks } = useTicks(chain);
  const [qb, setQb] = useState(() => localStorage.getItem('jgg.qb.' + chain) ?? (chain === 'solana' ? '0.1' : '0.01'));
  useEffect(() => setQb(localStorage.getItem('jgg.qb.' + chain) ?? (chain === 'solana' ? '0.1' : '0.01')), [chain]);
  const [stage, setStage] = useQueryState('stage', 'new');
  return <div className="page trenches">
    <div className="subbar">
      <h1 className="h-inline">Trenches</h1><SimTag />
      <div className="grow" />
      <label className="qb-input"><I.bolt /><span className="sr-only">Quick buy amount</span><input inputMode="decimal" value={qb} aria-label="Quick buy amount" onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); setQb(v); localStorage.setItem('jgg.qb.' + chain, v); }} /><span className="muted">{chain === 'solana' ? 'SOL' : chain === 'bsc' ? 'BNB' : 'ETH'}</span></label>
    </div>
    <div className="show-sm-block"><Tabs label="Stage" value={stage as any} onChange={setStage} items={[{ id: 'new', label: 'New' }, { id: 'near_completion', label: 'Almost bonded' }, { id: 'migrated', label: 'Migrated' }]} /></div>
    <div className="tcols" data-stage={stage}>
      <Column stage="new" title="Newly created" chain={chain} ticks={ticks} qb={qb} />
      <Column stage="near_completion" title="Almost bonded" chain={chain} ticks={ticks} qb={qb} />
      <Column stage="migrated" title="Migrated" chain={chain} ticks={ticks} qb={qb} />
    </div>
  </div>;
}

// ---------------- Trending (M02) ----------------
const TREND_TABS = [{ id: 'new_pair', label: 'New Pair' }, { id: 'trending', label: 'Trending' }, { id: 'hot_searches', label: 'Hot Searches' }, { id: 'binance', label: 'Binance' }, { id: 'surge', label: 'Surge' }, { id: 'nextbc', label: 'NextBC' }, { id: 'pump_live', label: 'Pump Live' }];
const SORTS = [{ id: 'rank', label: 'Top' }, { id: 'chg', label: 'Gainers' }, { id: 'mc', label: 'Market cap' }, { id: 'vol', label: 'Volume' }];
export function Trending() {
  const { chain } = useApp(); const { ticks } = useTicks(chain);
  const [view, setView] = useQueryState('view', 'trending'); const [win, setWin] = useQueryState('window', '1h');
  const [sort, setSort] = useQueryState('sort', 'rank'); const [hover, setHover] = useState(false);
  const qb = localStorage.getItem('jgg.qb.' + chain) ?? (chain === 'solana' ? '0.1' : '0.01');
  const d = useApi<any>(`/markets/${view}?chain=${chain}&window=${win}`, [view, win, chain], 5000);
  const rows = useMemo(() => {
    const xs = (d.data?.data.rows ?? []).map((r: any, i: number) => ({ ...merge(r, ticks.get(r.address)), _rank: i }));
    const key = (r: any) => sort === 'chg' ? (r.change[win] ?? -1e9) : sort === 'mc' ? Number(r.mcUsd ?? -1) : sort === 'vol' ? Number(r.vol[win] ?? r.vol['1h'] ?? 0) : -r._rank;
    return [...xs].sort((a, b) => key(b) - key(a));
  }, [d.data, ticks, sort, win]);
  const { shown, pendingCount } = useFrozen(rows, hover);
  return <div className="page trending">
    <h1 className="sr-only">Trending</h1>
    <div className="subbar">
      <Tabs big label="Trending views" value={view as any} onChange={setView} items={TREND_TABS} />
    </div>
    <div className="subbar slim">
      <Seg label="Sort" items={SORTS} value={sort as any} onChange={setSort} />
      <div className="grow" />
      <Seg label="Period" items={['1m', '5m', '1h', '6h', '24h']} value={win as any} onChange={setWin} />
      {hover && pendingCount > 0 && <span className="paused" role="status">{pendingCount} new</span>}
    </div>
    <State loading={d.loading} error={d.error} onRetry={() => d.reload()} empty={!shown.length && 'No coins in this view yet.'} rows={10}>
      <div className="tlist" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {shown.map((r: any) => <TokenCard key={r.address} r={r} chain={chain} qb={qb} window={win} />)}
      </div>
    </State>
  </div>;
}
export { useRouter };
