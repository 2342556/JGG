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

function TokenCard({ r, chain, qb }: { r: any; chain: string; qb: string }) {
  const hot = (r.change['5m'] ?? 0) > 1000;
  return <Link to={`/token/${chain}/${r.address}`} className={cls('tcard', hot && 'flash')} aria-label={`${r.symbol} ${r.name}`}>
    <TokenAvatar symbol={r.symbol} hue={r.hue} chain={chain} size={60} />
    <div className="tcard-main">
      <div className="tline"><strong className="sym">{r.symbol}</strong><span className="nm">{r.name}</span><Copy text={r.address} /></div>
      <div className="tline small"><span className="age">{age(r.ageSec)}</span>
        {r.socials.x && <Tip text="X account listed in token metadata (unverified)"><I.xlogo /></Tip>}{r.socials.web && <Tip text="Website in metadata (unverified)"><I.globe /></Tip>}{r.socials.tg && <Tip text="Telegram in metadata (unverified)"><I.send /></Tip>}
        <Tip text="Holders"><span className="ic"><I.users />{r.holders ?? '—'}</span></Tip>
        <Tip text="Smart-money wallets holding"><span className="ic sm">SM {r.smartMoney ?? '—'}</span></Tip>
        <Tip text="KOL wallets holding"><span className="ic">KOL {r.kols ?? '—'}</span></Tip>
        {r.lifecycle !== 'migrated' && r.progressBps !== null && <Tip text="Bonding curve progress"><span className="ic">{bpsPct(r.progressBps)}</span></Tip>}
      </div>
      <div className="tline small badges">
        <Tip text="Top-10 holders share, excl. pool & burn"><span className={cls('b', (r.top10Bps ?? 0) > 3000 ? 'neg' : 'pos')}>T10 {bpsPct(r.top10Bps)}</span></Tip>
        <Tip text="Dev holding share"><span className={cls('b', (r.devHoldingBps ?? 0) > 800 ? 'neg' : 'pos')}>Dev {bpsPct(r.devHoldingBps)}</span></Tip>
        <Tip text="Snipers in first blocks"><span className="b">Sn {r.snipers ?? '—'}</span></Tip>
        <Tip text="Insider share"><span className={cls('b', (r.insiderBps ?? 0) > 1000 && 'neg')}>Ins {bpsPct(r.insiderBps)}</span></Tip>
        <Tip text="Bundled-buy share"><span className={cls('b', (r.bundleBps ?? 0) > 1500 && 'neg')}>Bnd {bpsPct(r.bundleBps)}</span></Tip>
        {r.risk !== 'ok' && <span className={cls('b', r.risk === 'danger' ? 'neg' : 'warn')} title="JGG risk flag">{r.risk}</span>}
      </div>
    </div>
    <div className="tcard-side">
      <div><Tip text={`Market cap (${r.mcBasis === 'circulating' ? 'circulating' : 'FDV approx.'})`}><span className="mc">MC <b>{usd(r.mcUsd)}</b></span></Tip></div>
      <div className="small">V <b>{usd(r.vol['1h'])}</b> <span className="muted">TX {(r.txs?.buys ?? 0) + (r.txs?.sells ?? 0)}</span></div>
      <div className={cls('small', signCls(r.change['5m']))}>{pct(r.change['5m'])} <span className="muted">5m</span></div>
      <QuickBuy chain={chain} address={r.address} symbol={r.symbol} amount={qb} />
    </div>
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
export function Trending() {
  const { chain } = useApp(); const { ticks } = useTicks(chain);
  const [view, setView] = useQueryState('view', 'trending'); const [win, setWin] = useQueryState('window', '1h');
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: 'rank', dir: 1 }); const [hover, setHover] = useState(false);
  const d = useApi<any>(`/markets/${view}?chain=${chain}&window=${win}`, [view, win, chain], 5000);
  const rows = useMemo(() => {
    const xs = (d.data?.data.rows ?? []).map((r: any, i: number) => ({ ...merge(r, ticks.get(r.address)), _rank: i }));
    const key = (r: any) => sort.k === 'rank' ? r._rank : sort.k === 'age' ? r.ageSec : sort.k === 'mc' ? Number(r.mcUsd ?? -1) : sort.k === 'liq' ? Number(r.liqUsd ?? -1) : sort.k === 'vol' ? Number(r.vol[win] ?? 0) : sort.k === 'holders' ? r.holders : sort.k === 'chg' ? (r.change[win] ?? -1e9) : 0;
    return [...xs].sort((a, b) => (key(a) - key(b)) * sort.dir);
  }, [d.data, ticks, sort, win]);
  const { shown, pendingCount } = useFrozen(rows, hover);
  const H = ({ k, children, right }: { k: string; children: any; right?: boolean }) => <th className={right ? 'r' : ''} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}><button className="th" onClick={() => setSort(s => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : (k === 'rank' || k === 'age' ? 1 : -1) }))}>{children}{sort.k === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>;
  return <div className="page trending">
    <h1 className="sr-only">Trending</h1>
    <div className="subbar">
      <Tabs big label="Trending views" value={view as any} onChange={setView} items={TREND_TABS} />
      <div className="grow" />
      <Seg label="Period" items={['1m', '5m', '1h', '6h', '24h']} value={win as any} onChange={setWin} />
      {hover && <span className="paused" role="status">Order held{pendingCount ? ` · ${pendingCount} new` : ''}</span>}
    </div>
    <State loading={d.loading} error={d.error} onRetry={() => d.reload()} empty={!shown.length && 'No tokens in this view.'} rows={10}>
      <div className="table-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <table className="tbl trend">
          <caption className="sr-only">Trending tokens — {view}, {win}. JGG ranking {d.data?.data.ranking}. Simulated data.</caption>
          <thead><tr><H k="rank">Token</H><H k="age" right>Age</H><H k="liq" right>Liq/MC</H><H k="holders" right>Holders</H><th className="r">TXs</th><H k="vol" right>Vol</H><th className="r">Price</th><H k="chg" right>{win}%</H><th className="r">Top10 / Dev</th><th className="r">Risk</th><th className="r">Buy</th></tr></thead>
          <tbody>{shown.map((r: any) => <tr key={r.address}>
            <td className="pin"><Link to={`/token/${chain}/${r.address}`} className="tok"><TokenAvatar symbol={r.symbol} hue={r.hue} size={44} chain={chain} /><span><strong>{r.symbol}</strong> <span className="muted">{r.name}</span><br /><span className="mono muted small">{short(r.address, 4)}</span> <Copy text={r.address} /></span></Link></td>
            <td className="r">{age(r.ageSec)}</td>
            <td className="r">{usd(r.liqUsd)}<br /><span className="muted small">{usd(r.mcUsd)}</span></td>
            <td className="r">{r.holders === null || r.holders === undefined ? '—' : r.holders.toLocaleString()}</td>
            <td className="r">{(r.txs.buys + r.txs.sells).toLocaleString()}<br /><span className="small"><span className="pos">{r.txs.buys}</span>/<span className="neg">{r.txs.sells}</span></span></td>
            <td className="r">{usd(r.vol[win] ?? r.vol['1h'])}</td>
            <td className="r">{price(r.priceUsd)}</td>
            <td className={cls('r', signCls(r.change[win]))}>{pct(r.change[win])}</td>
            <td className="r small">{bpsPct(r.top10Bps)} / {bpsPct(r.devHoldingBps)}</td>
            <td className="r"><span className={cls('b', r.risk === 'ok' ? 'pos' : r.risk === 'danger' ? 'neg' : 'warn')}>{r.risk}</span></td>
            <td className="r"><QuickBuy chain={chain} address={r.address} symbol={r.symbol} amount={chain === 'solana' ? '0.1' : '0.01'} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="muted fine pad">Ranking: {d.data?.data.ranking} (volume, momentum, liquidity, participation; missing data penalized). Data is simulated. Binance / NextBC / Pump Live need providers whose membership rules are verified.</p>
    </State>
  </div>;
}
export { useRouter };
