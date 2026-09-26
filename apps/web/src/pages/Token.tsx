import { useEffect, useRef, useState } from 'react';
import { Link } from '../router.tsx';
import { api, newKey } from '../api.ts';
import { useApp, useApi, useTicks, State, TokenAvatar, Copy, Tabs, Seg, I, usd, pct, bpsPct, age, short, cls, signCls, price, SimTag, toast, errMsg, Drawer, NATIVE } from '../lib.tsx';
import { TradeTicket } from '../components/Trade.tsx';

// ---------------- Canvas candlestick chart (own implementation; no external chart lib available offline) ----------------
export function CandleChart({ rows, height = 360 }: { rows: any[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null); const [hover, setHover] = useState<number | null>(null); const wrap = useRef<HTMLDivElement>(null); const [w, setW] = useState(800);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width)))); if (wrap.current) ro.observe(wrap.current); return () => ro.disconnect(); }, []);
  const data = rows.filter(r => !r.gap);
  useEffect(() => {
    const c = ref.current; if (!c) return; const dpr = devicePixelRatio || 1; c.width = w * dpr; c.height = height * dpr; const g = c.getContext('2d')!; g.scale(dpr, dpr);
    g.fillStyle = '#111213'; g.fillRect(0, 0, w, height);
    if (!rows.length) return;
    const padR = 70, padB = 22, vh = 56; const cw = (w - padR) / rows.length;
    const hi = Math.max(...data.map(r => +r.h)), lo = Math.min(...data.map(r => +r.l)); const vmax = Math.max(...data.map(r => +r.v), 1);
    const y = (p: number) => 8 + (hi - p) / ((hi - lo) || 1) * (height - padB - vh - 16);
    g.strokeStyle = '#1f2224'; g.lineWidth = 1; g.font = '11px system-ui, sans-serif'; g.fillStyle = '#818A93';
    for (let i = 0; i <= 4; i++) { const p = lo + (hi - lo) * i / 4; const yy = y(p); g.beginPath(); g.moveTo(0, yy); g.lineTo(w - padR, yy); g.stroke(); g.fillText(fmtP(p), w - padR + 6, yy + 4); }
    rows.forEach((r, i) => {
      const x = i * cw + cw / 2;
      if (r.gap) { g.fillStyle = 'rgba(255,186,69,.08)'; g.fillRect(i * cw, 0, cw, height - padB); return; } // explicit gap, no fabricated candle
      const up = +r.c >= +r.o; g.strokeStyle = g.fillStyle = up ? '#2DCF89' : '#F05260';
      g.beginPath(); g.moveTo(x, y(+r.h)); g.lineTo(x, y(+r.l)); g.stroke();
      const top = y(Math.max(+r.o, +r.c)), bot = y(Math.min(+r.o, +r.c)); g.fillRect(x - Math.max(1, cw * 0.35), top, Math.max(2, cw * 0.7), Math.max(1, bot - top));
      g.globalAlpha = 0.35; const vhh = (+r.v / vmax) * vh; g.fillRect(x - Math.max(1, cw * 0.35), height - padB - vhh, Math.max(2, cw * 0.7), vhh); g.globalAlpha = 1;
    });
    g.fillStyle = '#818A93'; const step = Math.ceil(rows.length / 6);
    rows.forEach((r, i) => { if (i % step === 0) g.fillText(new Date(r.t).toISOString().slice(11, 16), i * cw, height - 6); });
    if (hover !== null && rows[hover] && !rows[hover].gap) { g.strokeStyle = '#A1A8AF'; g.setLineDash([3, 3]); const x = hover * cw + cw / 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height - padB); g.stroke(); g.setLineDash([]); }
  }, [rows, w, height, hover]);
  const hv = hover !== null ? rows[hover] : data[data.length - 1];
  return <div className="chart" ref={wrap}>
    <div className="chart-legend" aria-live="off">{hv && !hv.gap ? <>O <b>{fmtP(+hv.o)}</b> H <b>{fmtP(+hv.h)}</b> L <b>{fmtP(+hv.l)}</b> C <b className={+hv.c >= +hv.o ? 'pos' : 'neg'}>{fmtP(+hv.c)}</b> V <b>{usd(hv.v)}</b></> : hv?.gap ? 'No trades in this interval (gap)' : ''}</div>
    <canvas ref={ref} style={{ width: w, height }} role="img" aria-label={`Candlestick chart, ${data.length} candles, ${rows.length - data.length} gaps`}
      onMouseMove={e => { const r = (e.target as HTMLCanvasElement).getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / ((w - 70) / rows.length)); setHover(i >= 0 && i < rows.length ? i : null); }} onMouseLeave={() => setHover(null)} />
  </div>;
}
const fmtP = (p: number) => p >= 1 ? p.toFixed(4) : p.toPrecision(4);

export function TokenPage({ chain, address }: { chain: string; address: string }) {
  const { me } = useApp(); const { ticks } = useTicks(chain);
  const t = useApi<any>(`/tokens/${chain}/${address}`, [chain, address], 10000);
  const [iv, setIv] = useState('1m'); const k = useApi<any>(`/tokens/${chain}/${address}/candles?interval=${iv}&count=150`, [iv, chain, address], 15000);
  const [tab, setTab] = useState<'activity' | 'holders' | 'traders' | 'dev' | 'pools' | 'risk' | 'positions'>('activity');
  const [exitOpen, setExitOpen] = useState(false);
  const tok = t.data?.data; const tk = ticks.get(address);
  const priceNow = tk?.p ?? tok?.priceUsd; const mc = tk?.mc ?? tok?.mcUsd;
  useEffect(() => { if (tok) document.title = `${tok.symbol} ${price(priceNow)} · JGG`; return () => { document.title = 'JGG — AI Trading Terminal'; }; }, [tok?.symbol, priceNow]);
  async function star() {
    if (!me) return toast('Sign in to use watchlists', 'warn');
    try { const lists = await api<any[]>('/watchlists'); const wl = lists[0]; await api(`/watchlists/${wl.id}/items`, { method: 'POST', body: { chain, address } }); toast(`Added ${tok.symbol} to ${wl.name}`, 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  if (!tok) return <div className="page"><State loading={t.loading} error={t.error} onRetry={() => t.reload()} rows={10} /></div>;
  return <div className="page token">
    <div className="token-head">
      <TokenAvatar symbol={tok.symbol} hue={tok.hue} size={48} />
      <div className="token-head-id">
        <h1>{tok.symbol}</h1>
        {tok.name && tok.name.replace(/\s+/g, '').toLowerCase() !== tok.symbol.replace(/\s+/g, '').toLowerCase() && <div className="token-name muted">{tok.name}</div>}
        <div className="small muted">{age(tok.ageSec)} old · <span className="mono">{short(address, 4)}</span> <Copy text={address} /> · <a className="link" href={tok.explorer} target="_blank" rel="noopener noreferrer">Explorer</a></div>
      </div>
      <button className="icon-btn" aria-label="Add to watchlist" onClick={star}><I.star /></button>
      <div className="grow" />
      <div className="token-head-price"><b>{price(priceNow)}</b><span className={cls('chip-pct', signCls(tk?.c1h ?? tok.change['1h']))}>{pct(tk?.c1h ?? tok.change['1h'])} <span className="muted">1h</span></span></div>
      <dl className="stats"><div><dt>Market cap</dt><dd>{usd(mc)}</dd></div><div><dt>Liquidity</dt><dd>{usd(tok.liqUsd)}</dd></div><div><dt>Holders</dt><dd>{(tk?.h ?? tok.holders)?.toLocaleString?.() ?? '—'}</dd></div></dl>
      <SimTag />
    </div>
    <div className="token-grid">
      <div className="token-main">
        <div className="panel"><div className="panel-bar"><Seg label="Interval" items={['1m', '5m', '15m', '1h', '4h']} value={iv} onChange={setIv} /></div>
          <State loading={k.loading} error={k.error} onRetry={() => k.reload()} rows={8}>{k.data && <CandleChart rows={k.data.data.rows} />}</State></div>
        <div className="panel">
          <Tabs label="Token details" value={tab} onChange={setTab} items={[{ id: 'activity', label: 'Activity' }, { id: 'holders', label: 'Holders' }, { id: 'traders', label: 'Traders' }, { id: 'dev', label: 'Dev' }, { id: 'pools', label: 'Pools' }, { id: 'risk', label: 'Risk' }, { id: 'positions', label: 'My position' }]} />
          <div className="panel-body">{tab === 'activity' ? <Activity chain={chain} address={address} /> : tab === 'holders' ? <Holders chain={chain} address={address} /> : tab === 'traders' ? <Traders chain={chain} address={address} /> : tab === 'dev' ? <Dev chain={chain} tok={tok} /> : tab === 'pools' ? <Pools tok={tok} /> : tab === 'risk' ? <Risk tok={tok} /> : <MyPosition chain={chain} address={address} onExits={() => setExitOpen(true)} />}</div>
        </div>
      </div>
      <div className="token-side"><div className="panel"><TradeTicket chain={chain} address={address} symbol={tok.symbol} /></div>
        <div className="panel pad"><h3>Exits &amp; automation</h3><p className="muted small">TP/SL, trailing and limit orders run in the JGG worker under your risk policy (deny-by-default).</p><button className="btn" onClick={() => setExitOpen(true)} disabled={!me}>Set TP / SL / trailing</button></div></div>
    </div>
    <ExitDrawer open={exitOpen} onClose={() => setExitOpen(false)} chain={chain} address={address} symbol={tok.symbol} priceNow={priceNow} />
  </div>;
}

function Activity({ chain, address }: { chain: string; address: string }) {
  const d = useApi<any>(`/tokens/${chain}/${address}/trades`, [chain, address], 5000); const rows = d.data?.data ?? [];
  return <State loading={d.loading} error={d.error} empty={!rows.length && 'No trades in the last 3h (fixture window).'}><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Time</th><th>Side</th><th className="r">USD</th><th className="r">Qty</th><th className="r">Price</th><th>Wallet</th><th>Tx</th></tr></thead>
    <tbody>{rows.map((x: any) => <tr key={x.eventId}><td>{new Date(x.ts).toISOString().slice(11, 19)}</td><td className={x.side === 'buy' ? 'pos' : 'neg'}>{x.side}</td><td className="r">{usd(x.amountUsd)}</td><td className="r">{Number(x.tokenQty).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td className="r">{price(x.price)}</td><td><Link to={`/wallet/${chain}/${x.wallet}`} className="link">{x.walletName ?? short(x.wallet)}</Link> {x.labels.map((l: string) => <span key={l} className="b">{l}</span>)}</td><td className="mono muted small">{short(x.txRef, 5)}</td></tr>)}</tbody></table></div></State>;
}
function Holders({ chain, address }: { chain: string; address: string }) {
  const d = useApi<any>(`/tokens/${chain}/${address}/holders`, [chain, address]); const h = d.data?.data;
  return <State loading={d.loading} error={d.error}>{h && <><p className="muted small pad">Share of {h.denominator}. System addresses (pool/burn) are labeled and excluded from concentration.</p><div className="table-wrap"><table className="tbl dense"><thead><tr><th>#</th><th>Address</th><th className="r">Share</th><th className="r">Qty</th><th className="r">Value</th></tr></thead>
    <tbody>{h.rows.map((r: any) => <tr key={r.address}><td>{r.rank}</td><td>{r.system ? <span className="b">{r.system}</span> : null} <Link className="link mono" to={`/wallet/${chain}/${r.address}`}>{short(r.address, 5)}</Link> {r.label && <span className="b">{r.label}</span>}</td><td className="r">{(r.shareBps / 100).toFixed(2)}%</td><td className="r">{Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td className="r">{usd(r.valueUsd)}</td></tr>)}</tbody></table></div></>}</State>;
}
function Traders({ chain, address }: { chain: string; address: string }) {
  const d = useApi<any>(`/tokens/${chain}/${address}/traders`, [chain, address]); const x = d.data?.data;
  return <State loading={d.loading} error={d.error} empty={x && !x.rows.length && 'No traders in window.'}>{x && <><p className="muted small pad">{x.note}</p><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Wallet</th><th className="r">Buys</th><th className="r">Sells</th><th className="r">Bought</th><th className="r">Sold</th><th className="r">Net flow</th><th className="r">Realized P&amp;L</th></tr></thead>
    <tbody>{x.rows.map((r: any) => <tr key={r.wallet}><td><Link className="link mono" to={`/wallet/${chain}/${r.wallet}`}>{short(r.wallet, 5)}</Link></td><td className="r">{r.buys}</td><td className="r">{r.sells}</td><td className="r">{usd(r.buyUsd)}</td><td className="r">{usd(r.sellUsd)}</td><td className={cls('r', signCls(Number(r.netFlowUsd)))}>{usd(r.netFlowUsd)}</td><td className="r muted" title="Needs full basis history">—</td></tr>)}</tbody></table></div></>}</State>;
}
function Dev({ chain, tok }: { chain: string; tok: any }) {
  return <div className="pad"><dl className="kv"><dt>Creator</dt><dd><Link className="link mono" to={`/wallet/${chain}/${tok.creator}`}>{short(tok.creator, 8)}</Link> <Copy text={tok.creator} /></dd><dt>Dev holding</dt><dd>{bpsPct(tok.devHoldingBps)}</dd><dt>Launchpad</dt><dd>{tok.launchpad}</dd></dl><p className="muted small">Run skill C24 (Dev Info) / C09 (Dev Score) in AI → Skills for the creator's token history.</p></div>;
}
function Pools({ tok }: { tok: any }) {
  return <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Pool</th><th>DEX</th><th>Quote</th><th className="r">Liquidity</th><th className="r">Fee</th><th>LP</th></tr></thead><tbody>{tok.pools.map((p: any) => <tr key={p.address}><td className="mono">{short(p.address, 5)}</td><td>{p.dex}</td><td>{p.quote}</td><td className="r">{usd(p.liquidityUsd)}</td><td className="r">{p.feeBps === null ? '—' : `${p.feeBps / 100}%`}</td><td>{p.lp.replace('_', ' ')}</td></tr>)}</tbody></table>{tok.migratedPool && <p className="muted small pad">Migrated from {short(tok.migratedPool.oldPool)} → {short(tok.migratedPool.newPool)} ({tok.migratedPool.dex}).</p>}</div>;
}
function Risk({ tok }: { tok: any }) {
  const s = tok.security; const dd = tok.dd;
  const tri = (v: string) => <span className={cls('b', v === 'safe' ? 'pos' : v === 'risky' ? 'neg' : 'warn')}>{v.replace('_', ' ')}</span>;
  return <div className="pad risk"><p><strong>Due diligence ({dd.rubric}):</strong> <span className={cls('b', dd.verdict === 'pass' ? 'pos' : dd.verdict === 'fail' ? 'neg' : 'warn')}>{dd.verdict}</span> {dd.score !== null && <>score {dd.score}/100</>} · coverage {dd.coverageBps / 100}%</p>
    <dl className="kv"><dt>Honeypot</dt><dd>{tri(s.honeypot)}</dd><dt>Mint authority</dt><dd>{tri(s.mintAuthority)}</dd><dt>Freeze authority</dt><dd>{tri(s.freezeAuthority)}</dd><dt>LP locked/burned</dt><dd>{tri(s.lpLockedOrBurned)}</dd><dt>Open source</dt><dd>{tri(s.openSource)}</dd><dt>Buy / sell tax</dt><dd>{s.buyTaxBps === null ? '—' : bpsPct(s.buyTaxBps)} / {s.sellTaxBps === null ? '—' : bpsPct(s.sellTaxBps)}</dd><dt>Top-10 (excl. system)</dt><dd>{tok.concentration.bps === null ? '—' : bpsPct(tok.concentration.bps)}</dd></dl>
    <details><summary>Factors</summary><ul>{dd.factors.map((f: any) => <li key={f.id}>{f.id}: {f.points === null ? 'unknown' : `${f.points}/${f.weight}`} — {f.note}</li>)}</ul></details><p className="muted small">{dd.disclaimer} Unknown is never treated as safe.</p></div>;
}
function MyPosition({ chain, address, onExits }: { chain: string; address: string; onExits: () => void }) {
  const { me } = useApp(); const p = useApi<any>(me ? `/portfolio?chain=${chain}` : null, [me?.user.id, chain], 5000); const st = useApi<any[]>(me ? '/strategies' : null, [me?.user.id], 5000);
  if (!me) return <State signedOut />;
  const pos = (p.data?.positions ?? []).filter((x: any) => x.token === address); const strat = (st.data ?? []).filter(s => s.token === address);
  return <State loading={p.loading} error={p.error} empty={!pos.length && !strat.length && 'No position or strategy for this token yet.'}>
    <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Bucket</th><th className="r">Qty</th><th className="r">Avg</th><th className="r">Value</th><th className="r">Unrealized</th><th className="r">Realized</th></tr></thead>
      <tbody>{pos.map((x: any) => <tr key={x.id}><td>{x.bucket === 'manual' ? 'manual' : short(x.bucket, 4)}</td><td className="r">{num4(x.qty)}</td><td className="r">{price(x.avgPriceUsd)}</td><td className="r">{usd(x.valueUsd)}</td><td className={cls('r', signCls(Number(x.unrealizedUsd)))}>{usd(x.unrealizedUsd)}</td><td className={cls('r', signCls(Number(x.realizedUsd)))}>{usd(x.realizedUsd)}</td></tr>)}</tbody></table></div>
    {strat.length > 0 && <ul className="plain">{strat.map(s => <li key={s.id}><span className="b">{s.kind}</span> {s.lifecycle} {s.reason && <span className="muted">({s.reason})</span>}</li>)}</ul>}
    <button className="btn" onClick={onExits}>Add exits</button>
  </State>;
}
const num4 = (v: string) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });

export function ExitDrawer({ open, onClose, chain, address, symbol, priceNow }: { open: boolean; onClose: () => void; chain: string; address: string; symbol: string; priceNow: string | null }) {
  const [kind, setKind] = useState<'tp_sl' | 'trailing_tp' | 'trailing_sl' | 'limit_sell' | 'limit_buy'>('tp_sl');
  const [f, setF] = useState({ tp1: '0.5', tp1pct: '50', tp2: '1', tp2pct: '50', sl: '0.3', activation: '0.2', retracement: '0.1', target: '', amount: '0.1' });
  const [busy, setBusy] = useState(false); const [created, setCreated] = useState<any>(null);
  async function submit(activate: boolean) {
    setBusy(true);
    try {
      const wallets = await api<any[]>('/wallets'); const w = wallets.find(x => x.chain === chain && x.custody === 'paper');
      const params: any = kind === 'tp_sl' ? { stages: [{ percentBps: Math.round(Number(f.tp1pct) * 100), gain: f.tp1 }, ...(Number(f.tp2pct) > 0 ? [{ percentBps: Math.round(Number(f.tp2pct) * 100), gain: f.tp2 }] : [])], ...(f.sl ? { stopLoss: f.sl } : {}) }
        : kind === 'trailing_tp' ? { activation: f.activation, retracement: f.retracement } : kind === 'trailing_sl' ? { retracement: f.retracement } : kind === 'limit_buy' ? { targetPrice: f.target, amount: f.amount } : { targetPrice: f.target };
      const s = await api('/strategies', { method: 'POST', body: { kind, chain, tokenAddress: address, walletId: w.id, params } });
      if (activate) await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} });
      setCreated(s); toast(activate ? 'Strategy active — the worker evaluates it every ~2s.' : 'Saved as draft.', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const inp = (k: keyof typeof f, label: string, hint?: string) => <label className="field"><span>{label}</span><input inputMode="decimal" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') })} />{hint && <small className="muted">{hint}</small>}</label>;
  return <Drawer open={open} onClose={() => { setCreated(null); onClose(); }} title={`Automation · ${symbol}`}>
    <Seg label="Strategy" value={kind} onChange={v => setKind(v as typeof kind)} items={[{ id: 'tp_sl', label: 'TP/SL' }, { id: 'trailing_tp', label: 'Trailing TP' }, { id: 'trailing_sl', label: 'Trailing SL' }, { id: 'limit_buy', label: 'Limit buy' }, { id: 'limit_sell', label: 'Limit sell' }]} />
    <p className="muted small">Current price {price(priceNow)}. Exits apply to your known-basis position in your first paper wallet; entry = weighted-average cost.</p>
    {kind === 'tp_sl' && <>{inp('tp1', 'TP1 gain (fraction, 0.5 = +50%)')}{inp('tp1pct', 'TP1 sells % of original')}{inp('tp2', 'TP2 gain')}{inp('tp2pct', 'TP2 sells %')}{inp('sl', 'Stop loss (fraction, 0.3 = −30%)', 'Stop sells all remaining')}</>}
    {kind === 'trailing_tp' && <>{inp('activation', 'Activation a', 'Arms at entry × (1 + a)')}{inp('retracement', 'Retracement d', 'Fires once at peak × (1 − d)')}</>}
    {kind === 'trailing_sl' && inp('retracement', 'Retracement d', 'Stop trails the high-water mark; never moves down')}
    {(kind === 'limit_buy' || kind === 'limit_sell') && <>{inp('target', 'Target price (USD)')}{kind === 'limit_buy' && inp('amount', `Amount (${NATIVE[chain]})`)}</>}
    <p className="note">Requires a configured risk policy (Settings → Risk). Default denies all automation. Kill switch: Settings or Portfolio.</p>
    {created ? <p className="note ok">Created {created.kind} ({created.id}). <Link to="/portfolio?tab=strategies" className="link" onClick={onClose}>View strategies</Link></p> :
      <div className="row gap end"><button className="btn ghost" disabled={busy} onClick={() => submit(false)}>Save draft</button><button className="btn buy" disabled={busy} onClick={() => submit(true)}>Activate</button></div>}
  </Drawer>;
}

// ---------------- Wallet page (M13) ----------------
export function WalletPage({ chain, address }: { chain: string; address: string }) {
  const { me } = useApp(); const [period, setPeriod] = useState('7d'); const [tab, setTab] = useState<'holdings' | 'history' | 'score'>('holdings'); const [copyOpen, setCopyOpen] = useState(false);
  const d = useApi<any>(`/wallets/${chain}/${address}?period=${period}`, [chain, address, period]); const w = d.data?.data;
  async function track() { if (!me) return toast('Sign in to track wallets', 'warn'); try { await api('/tracked-wallets', { method: 'POST', body: { chain, address, nickname: w?.name ?? undefined } }); toast('Now tracking this wallet', 'ok'); } catch (e) { toast(errMsg(e), 'err'); } }
  return <div className="page wallet">
    <div className="token-head"><span className="avatar round"><I.wallet /></span><div><h1>{w?.name ?? short(address, 6)}</h1><div className="mono muted small">{chain} · {address} <Copy text={address} /></div></div>
      <div className="grow" /><Seg label="Period" items={['1d', '7d', '30d']} value={period} onChange={setPeriod} /><button className="btn ghost" onClick={track}><I.eye /> Track</button><button className="btn" onClick={() => me ? setCopyOpen(true) : toast('Sign in first', 'warn')}>Copy trade</button><SimTag /></div>
    <State loading={d.loading} error={d.error} onRetry={() => d.reload()} rows={10}>{w && <>
      <div className="labels">{w.labels.length ? w.labels.map((l: any) => <span key={l.label} className="b" title={`${l.source}: ${l.method}`}>{l.label}</span>) : <span className="muted small">No labels (unknown wallet)</span>}</div>
      <div className="stat-grid">
        <div className="stat"><span>Realized P&amp;L</span><b className={signCls(Number(w.realizedPnlUsd))}>{usd(w.realizedPnlUsd)}</b></div>
        <div className="stat"><span>Win rate</span><b>{w.winRate === null ? '—' : `${w.winRate}%`}</b><small className="muted">{w.winRateDenominator} closed · {w.breakEven} break-even</small></div>
        <div className="stat"><span>Trades</span><b>{w.trades}</b><small className="muted">{w.buys} buys / {w.sells} sells</small></div>
        <div className="stat"><span>Volume</span><b>{usd(w.volumeUsd)}</b></div>
        <div className="stat"><span>Native balance</span><b>{w.nativeBalance} {NATIVE[chain]}</b></div>
      </div>
      <p className="muted small">{w.coverage}</p>
      <Tabs label="Wallet sections" value={tab} onChange={setTab} items={[{ id: 'holdings', label: 'Holdings' }, { id: 'history', label: 'History' }, { id: 'score', label: 'Score' }]} />
      {tab === 'holdings' ? <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Token</th><th className="r">Qty</th><th className="r">Basis</th><th className="r">Value</th><th className="r">Unrealized</th></tr></thead><tbody>{w.holdings.map((h: any) => <tr key={h.token}><td><Link className="link" to={`/token/${chain}/${h.token}`}>{h.symbol}</Link></td><td className="r">{h.qty}</td><td className="r">{usd(h.basisUsd)}</td><td className="r">{usd(h.valueUsd)}</td><td className={cls('r', signCls(Number(h.unrealizedUsd)))}>{usd(h.unrealizedUsd)}</td></tr>)}</tbody></table>{!w.holdings.length && <p className="state">No open holdings in period.</p>}</div>
        : tab === 'history' ? <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Time</th><th>Side</th><th>Token</th><th className="r">USD</th><th className="r">Price</th></tr></thead><tbody>{w.history.map((x: any) => <tr key={x.eventId}><td>{new Date(x.ts).toISOString().slice(5, 16).replace('T', ' ')}</td><td className={x.side === 'buy' ? 'pos' : 'neg'}>{x.side}</td><td><Link className="link mono" to={`/token/${chain}/${x.token}`}>{short(x.token, 4)}</Link></td><td className="r">{usd(x.amountUsd)}</td><td className="r">{price(x.price)}</td></tr>)}</tbody></table></div>
        : <dl className="kv pad"><dt>Rubric</dt><dd>{w.score.rubric}</dd><dt>Profitability</dt><dd>{w.score.profitability ?? '—'}</dd><dt>Copy feasibility</dt><dd>{w.score.copyFeasibility ?? '—'}</dd><dt>Risk</dt><dd>{w.score.risk ?? '—'}</dd><dt>Sample</dt><dd>{w.score.sampleSize}{w.score.lowSample ? ' (low sample)' : ''}</dd><dt>Note</dt><dd>{w.score.note}</dd></dl>}
    </>}</State>
    <CopyDrawer open={copyOpen} onClose={() => setCopyOpen(false)} chain={chain} source={address} />
  </div>;
}

export function CopyDrawer({ open, onClose, chain, source }: { open: boolean; onClose: () => void; chain: string; source: string }) {
  const [f, setF] = useState({ sizing: 'fixed', amount: '0.05', ratio: '0.1', sellMode: 'follow_source', maxAge: '30' }); const [busy, setBusy] = useState(false);
  async function go(activate: boolean) {
    setBusy(true);
    try {
      const w = (await api<any[]>('/wallets')).find(x => x.chain === chain && x.custody === 'paper');
      const s = await api('/strategies', { method: 'POST', body: { kind: 'copy', chain, walletId: w.id, params: { sourceWallet: source, sizing: f.sizing, ...(f.sizing === 'ratio' ? { ratio: f.ratio } : { amount: f.amount }), sellMode: f.sellMode, maxEventAgeSec: Number(f.maxAge) } } });
      if (activate) await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} });
      toast(activate ? 'Copy task active (paper).' : 'Copy task saved as draft.', 'ok'); onClose();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return <Drawer open={open} onClose={onClose} title="Copy trade (paper)">
    <p className="mono small">Source: {short(source, 8)} on {chain}</p>
    <label className="field"><span>Sizing</span><select value={f.sizing} onChange={e => setF({ ...f, sizing: e.target.value })}><option value="fixed">Fixed amount</option><option value="capped_source">Match source, capped</option><option value="ratio">Ratio of source</option></select></label>
    {f.sizing === 'ratio' ? <label className="field"><span>Ratio</span><input value={f.ratio} onChange={e => setF({ ...f, ratio: e.target.value })} /></label> : <label className="field"><span>{f.sizing === 'fixed' ? 'Amount' : 'Cap'} ({NATIVE[chain]})</span><input value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>}
    <label className="field"><span>Sells</span><select value={f.sellMode} onChange={e => setF({ ...f, sellMode: e.target.value })}><option value="follow_source">Follow source proportionally</option><option value="manual">Manual</option></select></label>
    <label className="field"><span>Max event age (s)</span><input value={f.maxAge} onChange={e => setF({ ...f, maxAge: e.target.value.replace(/\D/g, '') })} /></label>
    <p className="note">Copies only confirmed, fresh source trades once each; sells follow the source's sold fraction of its own position and never touch positions from other tasks. Needs a risk policy.</p>
    <div className="row gap end"><button className="btn ghost" disabled={busy} onClick={() => go(false)}>Save draft</button><button className="btn buy" disabled={busy} onClick={() => go(true)}>Activate</button></div>
  </Drawer>;
}
