import { useState } from 'react';
import { Link } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, ModeBadge, SimTag, I, cls, toast, errMsg, NATIVE, short, price, usd, pct } from '../lib.tsx';
import { QuickBuy } from '../components/Trade.tsx';

const EXIT_DEFAULT = { partialPct: '50', trailAt: '50', trailDist: '15', tpAt: '100', slPct: '30' };

export function AutoPage() {
  const { me, chain, openAuth } = useApp();
  const finder = useApi<any>(`/finder?chain=${chain}`, [chain], 15000);
  const track = useApi<any>('/finder/stats', [], 30000);
  const strats = useApi<any[]>(me ? '/strategies' : null, [me?.user.id], 4000);
  const auto = (strats.data ?? []).find(s => s.kind === 'auto_trader' && s.chain === chain && !['cancelled', 'completed', 'failed', 'expired'].includes(s.lifecycle));
  const children = (strats.data ?? []).filter(s => auto && s.parentId === auto.id);
  const f = finder.data?.data;
  return <div className="page auto">
    <div className="page-head"><h1>Auto</h1>{me && <ModeBadge mode={me.settings.mode} />}<SimTag /></div>
    <p className="note warn honest">No strategy can guarantee a 70–90% win rate on meme coins. JGG shows the real win rate it measures — with the number of closed trades. Executions stay paper (virtual) until live trading is authorized.</p>

    {!me ? <div className="panel pad"><p>Sign in to run the auto trader (Demo/Paper, virtual funds).</p><button className="btn" onClick={openAuth}>Log in</button></div>
      : auto ? <AutoRunning s={auto} children={children} reload={() => strats.reload(true)} />
      : <AutoSetup chain={chain} onStarted={() => strats.reload(true)} />}

    <FinderTrackRecord track={track} />
    <section className="panel" aria-label="Finder">
      <div className="panel-bar"><strong>Finder</strong><span className="muted small">{f ? `${f.passed.length} of ${f.scanned} passed safety gates · ${f.version}` : ''}</span><div className="grow" /><button className="icon-btn sm" aria-label="Refresh finder" onClick={() => finder.reload()}><I.refresh /></button></div>
      <State loading={finder.loading} error={finder.error} onRetry={() => finder.reload()} empty={f && !f.passed.length && 'No token passed every safety gate right now. That is a valid answer — no forced trades.'}>
        {f && <>
          <ul className="finder-list">{f.passed.slice(0, 12).map((c: any, i: number) => <li key={c.address}>
            <Link to={`/token/${chain}/${c.address}`} className="finder-row">
              <span className="rank">{i + 1}</span>
              <span className="grow"><strong>{c.symbol}</strong> <span className="mono muted small">{short(c.address, 4)}</span><br /><span className="small muted">{c.reasons.join(' · ') || 'passed gates'}</span></span>
              <span className="score" title={`Score ${c.score}/100, data coverage ${c.coverageBps / 100}% — a ranking, not a probability`}><b>{c.score}</b><i style={{ width: `${c.score}%` }} /></span>
              <QuickBuy chain={chain} address={c.address} symbol={c.symbol} amount={chain === 'solana' ? '0.1' : '0.01'} />
            </Link></li>)}</ul>
          <details className="pad small"><summary>Why others were excluded</summary><ul>{Object.entries(f.excluded).sort((a: any, b: any) => b[1] - a[1]).map(([g, n]) => <li key={g}>{g.replace(/_/g, ' ')}: {String(n)}</li>)}</ul>
            <p className="muted">Gates: honeypot must be verified safe (unknown fails), mint/freeze not risky, liquidity ≥ $8k, top-10 ≤ 30%, dev ≤ 10%, insiders ≤ 15%, bundlers ≤ 25%, age 3 min–24 h, not already +300% in 1 h, no heavy sell pressure, ≥ 70% data coverage.</p></details>
        </>}
      </State>
    </section>
  </div>;
}

function AutoSetup({ chain, onStarted }: { chain: string; onStarted: () => void }) {
  const { me } = useApp();
  const [amount, setAmount] = useState(chain === 'solana' ? '0.1' : '0.01'); const [maxPos, setMaxPos] = useState('3'); const [minScore, setMinScore] = useState('50');
  const [ex, setEx] = useState(EXIT_DEFAULT); const [busy, setBusy] = useState(false);
  const pol = useApi<any>('/risk-policy', []);
  const num = (v: string) => v.replace(/[^\d.]/g, '');
  const frac = (pct: string) => String(Number(pct) / 100);
  async function starterPolicy() {
    try {
      const a = Number(amount); const m = Number(maxPos);
      await api('/risk-policy', { method: 'PUT', body: { version: pol.data?.version, policy: { maxPerTrade: amount, maxPerAssetExposure: amount, maxDailyGrossBuy: String(+(a * m * 2).toFixed(6)), maxRealizedDailyLoss: String(+(a * m).toFixed(6)), maxOpenPositions: m, maxSlippageBps: 1500, maxFeeQuote: chain === 'solana' ? '0.01' : '0.005', maxDataAgeMs: 60000, allowedChains: [chain], entriesPaused: false } } });
      toast('Risk limits saved', 'ok'); pol.reload(true);
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function start() {
    setBusy(true);
    try {
      const live = me?.settings.mode === 'live'; const w = (await api<any[]>('/wallets')).find(x => x.chain === chain && x.custody === (live ? 'hosted' : 'paper'));
      if (!w) throw new Error(live ? 'Create your trading wallet first (Settings → Trading wallet)' : 'No paper wallet');
      if (live && !confirm(`Start the auto trader with REAL SOL? Up to ${amount} SOL per trade, ${maxPos} positions, within the server caps.`)) { setBusy(false); return; }
      const s = await api('/strategies', { method: 'POST', body: { kind: 'auto_trader', chain, walletId: w.id, params: { amount, maxPositions: Number(maxPos), minScore: Number(minScore), scanEverySec: 30,
        partialBps: Math.round(Number(ex.partialPct) * 100), trailActivation: frac(ex.trailAt), retracement: frac(ex.trailDist), tpGain: frac(ex.tpAt), stopLoss: frac(ex.slPct) } } });
      await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} });
      toast('Auto trader started (paper).', 'ok'); onStarted();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const inp = (label: string, v: string, set: (x: string) => void, suffix: string) => <label className="field"><span>{label}</span><span className="suffix"><input inputMode="decimal" value={v} onChange={e => set(num(e.target.value))} /><em>{suffix}</em></span></label>;
  return <section className="panel pad auto-setup" aria-label="Auto trader setup">
    <h2>Auto trader</h2>
    <p className="muted small">Scans with the Finder every 30 s, buys at most one new candidate per scan, never buys the same token twice, then manages exits automatically.</p>
    <div className="grid2">
      {inp('Amount per trade', amount, setAmount, NATIVE[chain])}{inp('Max open positions', maxPos, setMaxPos, '')}{inp('Min finder score', minScore, setMinScore, '/100')}
    </div>
    <h3>Exit plan</h3>
    <ol className="plan">
      <li>At <b>+{ex.trailAt}%</b>: sell <b>{ex.partialPct}%</b> and arm a trailing stop on the rest</li>
      <li>Trailing stop: sell the rest if price falls <b>{ex.trailDist}%</b> from its peak</li>
      <li>At <b>+{ex.tpAt}%</b>: take profit on everything left</li>
      <li>Stop-loss: sell all at <b>−{ex.slPct}%</b></li>
    </ol>
    <details><summary>Adjust exit plan</summary><div className="grid2">
      {inp('Partial sell', ex.partialPct, v => setEx({ ...ex, partialPct: v }), '%')}{inp('Partial + trail start', ex.trailAt, v => setEx({ ...ex, trailAt: v }), '% gain')}
      {inp('Trail distance', ex.trailDist, v => setEx({ ...ex, trailDist: v }), '%')}{inp('Take profit', ex.tpAt, v => setEx({ ...ex, tpAt: v }), '% gain')}{inp('Stop-loss', ex.slPct, v => setEx({ ...ex, slPct: v }), '% loss')}
    </div></details>
    {pol.data && !pol.data.configured ? <div className="note warn"><p>Automation is off by default. Set risk limits first.</p><p className="small">Starter limits: max {amount} {NATIVE[chain]} per trade, {maxPos} open positions, daily buys ≤ {+(Number(amount) * Number(maxPos) * 2).toFixed(4)} {NATIVE[chain]}, stop for the day after {+(Number(amount) * Number(maxPos)).toFixed(4)} {NATIVE[chain]} realized loss.</p><button className="btn" onClick={starterPolicy}>Use these limits</button> <Link className="link" to="/settings?tab=risk">Customize</Link></div>
      : <button className="btn big buy" disabled={busy || !pol.data} onClick={start}>{busy ? 'Starting…' : me?.settings.mode === 'live' ? 'Start auto trader (LIVE — real SOL)' : 'Start auto trader (paper)'}</button>}
  </section>;
}

function AutoRunning({ s, children, reload }: { s: any; children: any[]; reload: () => void }) {
  const perf = useApi<any>(`/strategies/${s.id}/performance`, [s.id, children.length], 8000);
  const act = async (a: string) => { try { await api(`/strategies/${s.id}/${a}`, { method: 'POST', body: {} }); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const kill = async () => { try { await api('/automation/stop', { method: 'POST', body: {} }); toast('All automation stopped.', 'warn'); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const p = perf.data; const last = s.state.decisions?.[0];
  return <section className="panel pad auto-run" aria-label="Auto trader status">
    <div className="row gap wrap"><h2 className="grow">Auto trader <span className={cls('b', s.lifecycle === 'active' ? 'pos' : 'warn')}>{s.lifecycle}{s.reason ? ` · ${s.reason}` : ''}</span></h2>
      {s.lifecycle === 'active' ? <button className="btn ghost" onClick={() => act('pause')}>Pause</button> : <button className="btn" onClick={() => act('resume')}>Resume</button>}
      <button className="btn ghost" onClick={() => act('cancel')}>Stop</button><button className="btn danger" onClick={kill}>Kill switch</button></div>
    <p className="small muted">{s.params.amount} {NATIVE[s.chain]}/trade · max {s.params.maxPositions ?? 3} positions · min score {s.params.minScore ?? 50} · exits: {(s.params.partialBps ?? 5000) / 100}% at +{Number(s.params.trailActivation ?? 0.5) * 100}% + trail {Number(s.params.retracement ?? 0.15) * 100}%, TP +{Number(s.params.tpGain ?? 1) * 100}%, SL −{Number(s.params.stopLoss ?? 0.3) * 100}%</p>
    <div className="stat-grid compact">
      <div className="stat"><span>Win rate</span><b>{p?.winRate === null || !p ? '—' : `${p.winRate}%`}</b><small className="muted">{p ? `${p.wins}W / ${p.losses}L of ${p.closedTrades} closed` : ''}</small></div>
      <div className="stat"><span>Realized</span><b className={!p ? '' : Number(p.realizedUsd) < 0 ? 'neg' : Number(p.realizedUsd) > 0 ? 'pos' : ''}>{p ? usd(p.realizedUsd, 2) : '—'}</b></div>
      <div className="stat"><span>Open</span><b>{p?.openPositions ?? '—'}</b></div>
    </div>
    {p && <p className="small muted">{p.sampleNote} {p.dataNote}</p>}
    {last && <p className="small">Last scan {last.at.slice(11, 19)}: {last.pick ? <>picked <Link className="link" to={`/token/${s.chain}/${last.pick.address}`}>{last.pick.symbol}</Link> (score {last.pick.score})</> : 'no candidate passed'} · {last.passed}/{last.scanned} passed gates</p>}
    <h3>Positions</h3>
    {!children.length ? <p className="muted small">None yet. The worker scans every 30 s.</p> : <ul className="pos-list">{children.map(c => {
      const st = c.state; const orig = Number(st.originalQty ?? 0); const rem = Number(st.coord?.remaining ?? 0);
      return <li key={c.id}><Link to={`/token/${c.chain}/${c.token}`} className="link"><strong>{c.symbol ?? short(c.token)}</strong></Link> <span className={cls('b', c.lifecycle === 'active' ? 'pos' : '')}>{c.lifecycle}</span>
        <div className="small muted">entry {price(st.entryUsd)} · left {orig ? Math.round(rem * 100 / orig) : 0}% · {st.tp?.map((t: any) => `${t.id} ${t.done ? '✓' : '·'}`).join(' ')} {st.sl?.done ? 'SL ✓' : ''} · trail {st.trailing?.fired ? 'fired' : st.trailing?.active ? `armed, stop ${price(st.stop)}` : 'waiting'}</div>
        <div className="progress" aria-label={`${Math.round(rem * 100 / (orig || 1))}% of position remaining`}><i style={{ width: `${orig ? (rem * 100 / orig) : 0}%` }} /></div></li>;
    })}</ul>}
  </section>;
}


function FinderTrackRecord({ track }: { track: ReturnType<typeof useApi<any>> }) {
  const d = track.data?.data;
  return <section className="panel" aria-label="Finder track record">
    <div className="panel-bar"><strong>Finder track record</strong><span className="muted small">jgg-finder-v1 · measured, not promised</span></div>
    <State loading={track.loading} error={track.error} onRetry={() => track.reload()} empty={!d && !track.loading && (track.data?.meta?.note ?? 'Not available.')}>
      {d && <div className="pad">
        <div className="row gap wrap" style={{ marginBottom: 8 }}>
          <span className="b">{d.totalTracked} coins tracked</span><span className="b">{d.currentlyTracking} still tracking</span>
          {Object.entries(d.outcomeCounts).map(([k, v]: any) => <span key={k} className={cls('b', k === 'rugged' ? 'neg' : k === 'graduated' ? 'pos' : '')}>{k.replace(/_/g, ' ')}: {v}</span>)}
        </div>
        <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Since scan</th><th className="r">Sample</th><th className="r">Median move</th><th className="r">Avg move</th><th className="r">≥+50%</th><th className="r">≥+100%</th></tr></thead>
          <tbody>{d.byHorizon.map((h: any) => <tr key={h.minutes}><td>{h.minutes < 60 ? `${h.minutes}m` : h.minutes < 1440 ? `${h.minutes / 60}h` : `${h.minutes / 1440}d`}</td>
            <td className="r">{h.n || '—'}</td><td className={cls('r', h.medianBps === null ? '' : h.medianBps >= 0 ? 'pos' : 'neg')}>{h.medianBps === null ? '—' : pct(h.medianBps)}</td>
            <td className={cls('r', h.avgBps === null ? '' : h.avgBps >= 0 ? 'pos' : 'neg')}>{h.avgBps === null ? '—' : pct(h.avgBps)}</td>
            <td className="r">{h.hit50Rate === null ? '—' : `${h.hit50Rate}%`}</td><td className="r">{h.hit100Rate === null ? '—' : `${h.hit100Rate}%`}</td></tr>)}</tbody></table></div>
        {d.caveats.map((c: string, i: number) => <p key={i} className="muted small">{c}</p>)}
      </div>}
    </State>
  </section>;
}
