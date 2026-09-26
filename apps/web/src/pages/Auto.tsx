import { useState } from 'react';
import { Link } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, ModeBadge, SimTag, I, cls, toast, errMsg, NATIVE, short, usd, pct } from '../lib.tsx';

type ExitCfg = { partialPct: string; trailAt: string; trailDist: string; tpAt: string; slPct: string };
type Cfg = { amount: string; maxPos: string; minScore: string; ex: ExitCfg };
const PRESETS: Record<'Conservative' | 'Balanced' | 'Aggressive', Cfg & { blurb: string }> = {
  Conservative: { blurb: 'Small size, strict picks', amount: '0.05', maxPos: '2', minScore: '65', ex: { partialPct: '50', trailAt: '50', trailDist: '20', tpAt: '80', slPct: '20' } },
  Balanced: { blurb: 'The default', amount: '0.1', maxPos: '3', minScore: '50', ex: { partialPct: '50', trailAt: '50', trailDist: '15', tpAt: '100', slPct: '30' } },
  Aggressive: { blurb: 'Bigger size, more picks', amount: '0.2', maxPos: '5', minScore: '35', ex: { partialPct: '40', trailAt: '40', trailDist: '25', tpAt: '150', slPct: '35' } },
};
type PresetName = keyof typeof PRESETS;

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
    <p className="muted small honest">No bot can promise a win rate. JGG shows what it actually measures. {me?.settings.mode === 'live' ? 'Live mode: trades use real SOL.' : 'Trades are paper (virtual money) until you switch to live.'}</p>

    {!me ? <div className="panel pad"><p>Sign in to run the auto trader (Demo/Paper, virtual funds).</p><button className="btn" onClick={openAuth}>Log in</button></div>
      : auto ? <AutoRunning s={auto} children={children} reload={() => strats.reload(true)} />
      : <AutoSetup chain={chain} onStarted={() => strats.reload(true)} />}

    <FinderTrackRecord track={track} />
    <section className="panel" aria-label="Today's picks">
      <div className="panel-bar"><strong>Today's picks</strong><div className="grow" /><span className="muted small">{f ? `${f.passed.length} of ${f.scanned} passed` : ''}</span></div>
      <State loading={finder.loading} error={finder.error} onRetry={() => finder.reload()} empty={f && !f.passed.length && 'Nothing passed the safety checks right now — so nothing gets bought. That is on purpose.'}>
        {f && <>
          <ul className="finder-list">{f.passed.slice(0, 10).map((c: any) => <li key={c.address}>
            <Link to={`/token/${chain}/${c.address}`} className="finder-row">
              <span className="grow"><strong>{c.symbol}</strong><br /><span className="small muted">{c.reasons[0] ?? 'Passed all safety checks'}</span></span>
              <span className="score" title={`Quality score ${c.score}/100 — a ranking, not a probability`}><b>{c.score}</b><i style={{ width: `${c.score}%` }} /></span>
            </Link></li>)}</ul>
          <details className="pad small"><summary>What the safety checks are</summary>
            <p className="muted">A coin is skipped if any check fails or its data is missing: honeypot not verified safe, risky mint/freeze authority, liquidity under $8k, top-10 holders over 30%, dev over 10%, insiders over 15%, bundlers over 25%, younger than 3 min or older than 24 h, already up 300% in an hour, or heavy selling.</p>
            <ul>{Object.entries(f.excluded).sort((a: any, b: any) => b[1] - a[1]).map(([g, n]) => <li key={g}>{g.replace(/_/g, ' ')}: {String(n)}</li>)}</ul></details>
        </>}
      </State>
    </section>
  </div>;
}

function AutoSetup({ chain, onStarted }: { chain: string; onStarted: () => void }) {
  const { me } = useApp();
  const [preset, setPreset] = useState<PresetName | 'Custom'>('Balanced');
  const [custom, setCustom] = useState<Cfg>(() => { const { blurb: _b, ...c } = PRESETS.Balanced; return { ...c, ex: { ...c.ex } }; });
  const [busy, setBusy] = useState(false);
  const pol = useApi<any>('/risk-policy', []);
  const cfg: Cfg = preset === 'Custom' ? custom : PRESETS[preset];
  const unit = NATIVE[chain]; const live = me?.settings.mode === 'live';
  const num = (v: string) => v.replace(/[^\d.]/g, '');
  const frac = (p: string) => String(Number(p) / 100);
  const pick = (n: PresetName) => { setPreset(n); const { blurb: _b, ...c } = PRESETS[n]; setCustom({ ...c, ex: { ...c.ex } }); };
  const edit = (patch: Partial<Cfg> | { ex: Partial<ExitCfg> }) => { setPreset('Custom'); setCustom(c => ({ ...c, ...patch, ex: { ...c.ex, ...((patch as any).ex ?? {}) } })); };
  async function starterPolicy() {
    const a = Number(cfg.amount); const m = Number(cfg.maxPos);
    await api('/risk-policy', { method: 'PUT', body: { version: pol.data?.version, policy: { maxPerTrade: cfg.amount, maxPerAssetExposure: cfg.amount, maxDailyGrossBuy: String(+(a * m * 2).toFixed(6)), maxRealizedDailyLoss: String(+(a * m).toFixed(6)), maxOpenPositions: m, maxSlippageBps: 1500, maxFeeQuote: chain === 'solana' ? '0.01' : '0.005', maxDataAgeMs: 60000, allowedChains: [chain], entriesPaused: false } } });
    pol.reload(true);
  }
  async function start() {
    setBusy(true);
    try {
      const w = (await api<any[]>('/wallets')).find(x => x.chain === chain && x.custody === (live ? 'hosted' : 'paper'));
      if (!w) throw new Error(live ? 'Create your trading wallet first (Settings → Trading wallet)' : 'No paper wallet');
      if (live && !confirm(`Start with REAL ${unit}? Up to ${cfg.amount} ${unit} per coin, ${cfg.maxPos} coins at a time.`)) return;
      if (pol.data && !pol.data.configured) await starterPolicy(); // safe starter limits sized to this plan (daily loss cap = amount × coins)
      const ex = cfg.ex;
      const s = await api('/strategies', { method: 'POST', body: { kind: 'auto_trader', chain, walletId: w.id, params: { amount: cfg.amount, maxPositions: Number(cfg.maxPos), minScore: Number(cfg.minScore), scanEverySec: 30,
        partialBps: Math.round(Number(ex.partialPct) * 100), trailActivation: frac(ex.trailAt), retracement: frac(ex.trailDist), tpGain: frac(ex.tpAt), stopLoss: frac(ex.slPct) } } });
      await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} });
      toast(live ? 'Auto trader started (live).' : 'Auto trader started (paper).', 'ok'); onStarted();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const inp = (label: string, v: string, set: (x: string) => void, suffix: string) => <label className="field"><span>{label}</span><span className="suffix"><input inputMode="decimal" value={v} onChange={e => set(num(e.target.value))} /><em>{suffix}</em></span></label>;
  const ex = cfg.ex;
  return <section className="panel pad auto-setup" aria-label="Auto trader setup">
    <h2>Pick a style</h2>
    <div className="preset-row" role="radiogroup" aria-label="Style">
      {(Object.keys(PRESETS) as PresetName[]).map(n => <button key={n} role="radio" aria-checked={preset === n} className={cls('preset-card', preset === n && 'on')} onClick={() => pick(n)}>
        <b>{n}</b><span>{PRESETS[n].amount} {unit} · {PRESETS[n].maxPos} coins</span><small>{PRESETS[n].blurb}</small></button>)}
    </div>
    <p className="summary-line">Buys up to <b>{cfg.amount} {unit}</b> per coin, <b>{cfg.maxPos}</b> coins at a time. Sells <b>{ex.partialPct}%</b> at <b>+{ex.trailAt}%</b>, then follows the rest up and sells if it drops <b>{ex.trailDist}%</b> from the top. Sells everything at <b>+{ex.tpAt}%</b> or <b>−{ex.slPct}%</b>.</p>
    <details className="fine-tune"><summary>Fine-tune the numbers{preset === 'Custom' ? ' (custom)' : ''}</summary><div className="grid2">
      {inp('Amount per coin', cfg.amount, v => edit({ amount: v }), unit)}{inp('Coins at a time', cfg.maxPos, v => edit({ maxPos: v }), '')}{inp('Min quality score', cfg.minScore, v => edit({ minScore: v }), '/100')}
      {inp('Partial sell', ex.partialPct, v => edit({ ex: { partialPct: v } }), '%')}{inp('Partial sell at', ex.trailAt, v => edit({ ex: { trailAt: v } }), '% gain')}
      {inp('Trail distance', ex.trailDist, v => edit({ ex: { trailDist: v } }), '%')}{inp('Take profit', ex.tpAt, v => edit({ ex: { tpAt: v } }), '% gain')}{inp('Stop-loss', ex.slPct, v => edit({ ex: { slPct: v } }), '% loss')}
    </div>
    </details>
    {pol.data && !pol.data.configured && <p className="muted small limits-note">Starting also turns on safe daily limits: at most {+(Number(cfg.amount) * Number(cfg.maxPos) * 2).toFixed(4)} {unit} of buys per day, and stops for the day after {+(Number(cfg.amount) * Number(cfg.maxPos)).toFixed(4)} {unit} of losses. <Link className="link" to="/settings?tab=risk">Change limits</Link></p>}
    <button className="btn big buy" disabled={busy || !pol.data} onClick={start}>{busy ? 'Starting…' : live ? 'Start auto trader — real SOL' : 'Start auto trader'}</button>
  </section>;
}

function stageOf(c: any): string {
  const st = c.state ?? {};
  if (c.lifecycle === 'completed' || Number(st.coord?.remaining ?? 1) === 0) return st.sl?.done ? 'Stopped out' : 'Sold';
  if (st.trailing?.active && !st.trailing?.fired) return 'Trailing the top';
  if (st.tp?.some((t: any) => t.done)) return 'Partial profit taken';
  return 'Holding';
}

function AutoRunning({ s, children, reload }: { s: any; children: any[]; reload: () => void }) {
  const perf = useApi<any>(`/strategies/${s.id}/performance`, [s.id, children.length], 8000);
  const act = async (a: string) => { try { await api(`/strategies/${s.id}/${a}`, { method: 'POST', body: {} }); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const kill = async () => { if (!confirm('Stop ALL automation now?')) return; try { await api('/automation/stop', { method: 'POST', body: {} }); toast('All automation stopped.', 'warn'); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const p = perf.data; const last = s.state.decisions?.[0]; const on = s.lifecycle === 'active';
  return <section className="panel pad auto-run" aria-label="Auto trader status">
    <div className="run-head"><span className={cls('run-dot', on && 'on')} /><div className="grow"><h2>{on ? 'Running' : s.lifecycle === 'paused' ? 'Paused' : s.lifecycle}</h2>
      <span className="muted small">{s.params.amount} {NATIVE[s.chain]} per coin · up to {s.params.maxPositions ?? 3} coins{s.reason ? ` · ${s.reason}` : ''}</span></div></div>
    <div className="stat-grid compact">
      <div className="stat"><span>Win rate</span><b>{!p || p.winRate === null ? '—' : `${p.winRate}%`}</b><small className="muted">{p ? `${p.closedTrades} closed` : ''}</small></div>
      <div className="stat"><span>Profit</span><b className={!p ? '' : Number(p.realizedUsd) < 0 ? 'neg' : Number(p.realizedUsd) > 0 ? 'pos' : ''}>{p ? usd(p.realizedUsd, 2) : '—'}</b></div>
      <div className="stat"><span>Open</span><b>{p?.openPositions ?? '—'}</b></div>
    </div>
    {last && <p className="small muted">Last check {last.at.slice(11, 16)} UTC — {last.pick ? <>bought <Link className="link" to={`/token/${s.chain}/${last.pick.address}`}>{last.pick.symbol}</Link></> : 'nothing passed, nothing bought'}.</p>}
    <ul className="pos-list">{children.map(c => {
      const st = c.state; const orig = Number(st.originalQty ?? 0); const rem = Number(st.coord?.remaining ?? 0); const left = orig ? Math.round(rem * 100 / orig) : 0;
      return <li key={c.id}><div className="row gap"><Link to={`/token/${c.chain}/${c.token}`} className="link grow"><strong>{c.symbol ?? short(c.token)}</strong></Link><span className="small muted">{stageOf(c)} · {left}% left</span></div>
        <div className="progress" aria-label={`${left}% of position remaining`}><i style={{ width: `${left}%` }} /></div></li>;
    })}</ul>
    {!children.length && <p className="muted small">No coins yet — it checks every 30 seconds.</p>}
    <div className="run-actions">{on ? <button className="btn ghost" onClick={() => act('pause')}>Pause</button> : <button className="btn" onClick={() => act('resume')}>Resume</button>}
      <button className="btn ghost" onClick={() => act('cancel')}>Stop</button><button className="btn danger" onClick={kill}>Stop everything</button></div>
    {p && <p className="fine muted">{p.sampleNote}</p>}
  </section>;
}


function FinderTrackRecord({ track }: { track: ReturnType<typeof useApi<any>> }) {
  const d = track.data?.data; const [more, setMore] = useState(false);
  const withData = (d?.byHorizon ?? []).filter((h: any) => h.n > 0 && h.hit50Rate !== null);
  const headline = withData[withData.length - 1];
  const hz = (m: number) => m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} d`;
  return <section className="panel pad" aria-label="Track record">
    <h2 className="h-small">Track record</h2>
    <State loading={track.loading} error={track.error} onRetry={() => track.reload()} empty={!d && !track.loading && 'The track record starts once JGG runs on live market data. It follows every pick for 24 hours, so give it a few days to collect enough coins.'}>
      {d && <>
        {headline ? <p className="headline-stat"><b>{headline.hit50Rate}%</b> of picks were up 50%+ within {hz(headline.minutes)} <span className="muted small">({headline.n} coins)</span></p>
          : <p className="muted">Still collecting — {d.totalTracked} picks followed so far. Numbers appear once enough time has passed.</p>}
        <button className="link small" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Hide details' : 'Show details by time held'}</button>
        {more && <div className="table-wrap"><table className="tbl dense"><thead><tr><th>After</th><th className="r">Coins</th><th className="r">Typical move</th><th className="r">Up 50%+</th><th className="r">Up 100%+</th></tr></thead>
          <tbody>{d.byHorizon.map((h: any) => <tr key={h.minutes}><td>{hz(h.minutes)}</td><td className="r">{h.n || '—'}</td>
            <td className={cls('r', h.medianBps === null ? '' : h.medianBps >= 0 ? 'pos' : 'neg')}>{h.medianBps === null ? '—' : pct(h.medianBps)}</td>
            <td className="r">{h.hit50Rate === null ? '—' : `${h.hit50Rate}%`}</td><td className="r">{h.hit100Rate === null ? '—' : `${h.hit100Rate}%`}</td></tr>)}</tbody></table>
          <p className="muted small">{d.totalTracked} picks followed · {Object.entries(d.outcomeCounts).map(([k, v]: any) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}</p>
          {d.caveats.map((c: string, i: number) => <p key={i} className="muted fine">{c}</p>)}</div>}
      </>}
    </State>
  </section>;
}
