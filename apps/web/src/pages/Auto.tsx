import { useState } from 'react';
import { Link } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, ModeBadge, SimTag, I, cls, toast, errMsg, NATIVE, short, usd, pct, price, Drawer } from '../lib.tsx';
import { ExitPlanEditor, describeExit, cloneCfg, DEFAULT_EXIT_CONFIG, type ExitConfig } from '../components/ExitPlan.tsx';
import { validateExitConfig } from '../../../../packages/domain/src/exitPlan.ts';

type Cfg = { amount: string; maxPos: string; minScore: string; exit: ExitConfig };
// Sizing per style; the exit plan of each style is the server's built-in preset of the same name (one source of truth).
const STYLES: Record<'Conservative' | 'Balanced' | 'Aggressive', { amount: string; maxPos: string; minScore: string; blurb: string }> = {
  Conservative: { blurb: 'Small size, strict picks', amount: '0.05', maxPos: '2', minScore: '65' },
  Balanced: { blurb: 'The default', amount: '0.1', maxPos: '3', minScore: '50' },
  Aggressive: { blurb: 'Bigger size, more picks', amount: '0.2', maxPos: '5', minScore: '35' },
};
type StyleName = keyof typeof STYLES;

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
      : <AutoSetup chain={chain} onStarted={() => strats.reload(true)} topPick={f?.passed?.[0]?.address ?? null} />}

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

function AutoSetup({ chain, onStarted, topPick }: { chain: string; onStarted: () => void; topPick: string | null }) {
  const { me } = useApp();
  const presets = useApi<any[]>('/exit-presets', []);
  const exitOf = (n: StyleName): ExitConfig => cloneCfg((presets.data ?? []).find(p => p.builtin && p.name === n)?.config ?? DEFAULT_EXIT_CONFIG);
  const [style, setStyle] = useState<StyleName | 'Custom'>('Balanced');
  const [custom, setCustom] = useState<Cfg | null>(null);
  const [busy, setBusy] = useState(false);
  const pol = useApi<any>('/risk-policy', []);
  const base = (n: StyleName): Cfg => { const { blurb: _b, ...c } = STYLES[n]; return { ...c, exit: exitOf(n) }; };
  const cfg: Cfg = style === 'Custom' && custom ? custom : base(style === 'Custom' ? 'Balanced' : style);
  const unit = NATIVE[chain]; const live = me?.settings.mode === 'live';
  const num = (v: string) => v.replace(/[^\d.]/g, '');
  const edit = (patch: Partial<Cfg>) => { setStyle('Custom'); setCustom({ ...cfg, ...patch }); };
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
      const s = await api('/strategies', { method: 'POST', body: { kind: 'auto_trader', chain, walletId: w.id, params: { amount: cfg.amount, maxPositions: Number(cfg.maxPos), minScore: Number(cfg.minScore), scanEverySec: 30, exit: cfg.exit } } });
      await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} });
      toast(live ? 'Auto trader started (live).' : 'Auto trader started (paper).', 'ok'); onStarted();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const inp = (label: string, v: string, set: (x: string) => void, suffix: string) => <label className="field"><span>{label}</span><span className="suffix"><input inputMode="decimal" value={v} onChange={e => set(num(e.target.value))} /><em>{suffix}</em></span></label>;
  return <section className="panel pad auto-setup" aria-label="Auto trader setup">
    <h2>Pick a style</h2>
    <div className="preset-row" role="radiogroup" aria-label="Style">
      {(Object.keys(STYLES) as StyleName[]).map(n => <button key={n} role="radio" aria-checked={style === n} className={cls('preset-card', style === n && 'on')} onClick={() => { setStyle(n); setCustom(null); }}>
        <b>{n}</b><span>{STYLES[n].amount} {unit} · {STYLES[n].maxPos} coins</span><small>{STYLES[n].blurb}</small></button>)}
    </div>
    <p className="summary-line">Buys up to <b>{cfg.amount} {unit}</b> per coin, <b>{cfg.maxPos}</b> coins at a time. {describeExit(cfg.exit)}</p>
    <details className="fine-tune"><summary>Fine-tune the numbers{style === 'Custom' ? ' (custom)' : ''}</summary>
      <div className="grid2">{inp('Amount per coin', cfg.amount, v => edit({ amount: v }), unit)}{inp('Coins at a time', cfg.maxPos, v => edit({ maxPos: v }), '')}{inp('Min quality score', cfg.minScore, v => edit({ minScore: v }), '/100')}</div>
      <h3 className="h-small">Exit plan</h3>
      <ExitPlanEditor value={cfg.exit} onChange={x => edit({ exit: x })} ctx={topPick ? { chain, tokenAddress: topPick, amount: cfg.amount } : null} />
      {!topPick && <p className="fine muted">An example with real prices appears when the Finder has a pick. Each position shows its exact numbers from its own fill.</p>}
    </details>
    {pol.data && !pol.data.configured && <p className="muted small limits-note">Starting also turns on safe daily limits: at most {+(Number(cfg.amount) * Number(cfg.maxPos) * 2).toFixed(4)} {unit} of buys per day, and stops for the day after {+(Number(cfg.amount) * Number(cfg.maxPos)).toFixed(4)} {unit} of losses. <Link className="link" to="/settings?tab=risk">Change limits</Link></p>}
    {validateExitConfig(cfg.exit).length > 0 && <p className="note err small">Fix the exit plan above before starting.</p>}
    <button className="btn big buy" disabled={busy || !pol.data || !presets.data || validateExitConfig(cfg.exit).length > 0} onClick={start}>{busy ? 'Starting…' : live ? 'Start auto trader — real SOL' : 'Start auto trader'}</button>
  </section>;
}

const CLOSE_LABEL: Record<string, string> = { STOP_LOSS: 'Stopped out', TRAILING_STOP: 'Sold on trailing stop', PARTIAL_SOLD_EVERYTHING: 'Sold', POSITION_GONE: 'No tokens left', DUST_REMAINDER: 'Dust left (too small to sell)' };
function stageOf(c: any): string {
  const st = c.state ?? {};
  if (c.kind === 'position_exit') {
    if (st.status === 'closed') return CLOSE_LABEL[st.closeReason] ?? 'Closed';
    if (st.pending) return 'Selling…';
    if (st.staleSince) return 'Waiting for a fresh price';
    if (st.trailing?.status === 'active') return 'Trailing the top';
    if (st.partial === 'done') return 'Partial profit taken';
    return 'Holding';
  }
  if (c.lifecycle === 'completed' || Number(st.coord?.remaining ?? 1) === 0) return st.sl?.done ? 'Stopped out' : 'Sold';
  if (st.trailing?.active && !st.trailing?.fired) return 'Trailing the top';
  if (st.tp?.some((t: any) => t.done)) return 'Partial profit taken';
  return 'Holding';
}
function leftPct(c: any): number {
  const st = c.state ?? {}; const orig = Number(st.originalQty ?? 0); const rem = Number(c.kind === 'position_exit' ? st.managedQty : st.coord?.remaining ?? 0);
  return orig ? Math.round(rem * 100 / orig) : 0;
}

/** One open position: exact trigger levels now, and an edit (per-trade override). */
function PositionRow({ c, onChanged }: { c: any; onChanged: () => void }) {
  const [edit, setEdit] = useState(false); const left = leftPct(c); const lv = c.exit?.levels; const st = c.state;
  return <li>
    <div className="row gap"><Link to={`/token/${c.chain}/${c.token}`} className="link grow"><strong>{c.symbol ?? short(c.token)}</strong></Link><span className="small muted">{stageOf(c)} · {left}% left</span>
      {c.kind === 'position_exit' && st.status !== 'closed' && <button className="btn sm ghost" onClick={() => setEdit(true)}>Edit exits</button>}</div>
    <div className="progress" aria-label={`${left}% of position remaining`}><i style={{ width: `${left}%` }} /></div>
    {c.kind === 'position_exit' && lv && st.status !== 'closed' && <div className="levels small">
      <span>Entry <b>{price(st.entry)}</b></span>
      {lv.stopLoss && <span>Stop <b className="neg">{price(lv.stopLoss)}</b></span>}
      {lv.partialTp ? <span>Take profit <b className="pos">{price(lv.partialTp)}</b></span> : st.partial === 'done' ? <span className="muted">Profit taken ✓</span> : null}
      {lv.trailing ? <span>Trailing <b>{price(lv.trailing)}</b></span> : lv.trailingActivatesAt ? <span className="muted">Trail from {price(lv.trailingActivatesAt)}</span> : st.trailing?.status === 'active' ? <span className="muted">Trailing starts on next price</span> : null}
    </div>}
    {edit && <EditExitsDrawer c={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); }} />}
  </li>;
}

export function EditExitsDrawer({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<ExitConfig>(() => cloneCfg(c.params.exit)); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api(`/strategies/${c.id}/exit`, { method: 'PUT', body: { config: cfg, version: c.params.exitVersion ?? 0 } }); toast('Exit plan updated for this position', 'ok'); onSaved(); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return <Drawer open onClose={onClose} title={`Exits · ${c.symbol ?? short(c.token)}`}>
    <p className="muted small">Changes apply to this position only. A partial profit already taken stays taken; an active trailing trigger never moves down.</p>
    <ExitPlanEditor value={cfg} onChange={setCfg} ctx={{ chain: c.chain, strategyId: c.id }} />
    <div className="row gap end"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save for this position'}</button></div>
  </Drawer>;
}

function AutoRunning({ s, children, reload }: { s: any; children: any[]; reload: () => void }) {
  const perf = useApi<any>(`/strategies/${s.id}/performance`, [s.id, children.length], 8000);
  const act = async (a: string) => { try { await api(`/strategies/${s.id}/${a}`, { method: 'POST', body: {} }); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const kill = async () => { if (!confirm('Stop ALL automation now?')) return; try { await api('/automation/stop', { method: 'POST', body: {} }); toast('All automation stopped.', 'warn'); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const p = perf.data; const last = s.state.decisions?.[0]; const on = s.lifecycle === 'active';
  return <section className="panel pad auto-run" aria-label="Auto trader status">
    <div className="run-head"><span className={cls('run-dot', on && 'on')} /><div className="grow"><h2>{on ? 'Running' : s.lifecycle === 'paused' ? 'Paused' : s.lifecycle}</h2>
      <span className="muted small">{s.params.amount} {NATIVE[s.chain]} per coin · up to {s.params.maxPositions ?? 3} coins{s.reason ? ` · ${s.reason}` : ''}</span></div></div>
    {s.params.exit && <p className="small muted exit-sum">{describeExit(s.params.exit)}</p>}
    <div className="stat-grid compact">
      <div className="stat"><span>Win rate</span><b>{!p || p.winRate === null ? '—' : `${p.winRate}%`}</b><small className="muted">{p ? `${p.closedTrades} closed` : ''}</small></div>
      <div className="stat"><span>Profit</span><b className={!p ? '' : Number(p.realizedUsd) < 0 ? 'neg' : Number(p.realizedUsd) > 0 ? 'pos' : ''}>{p ? usd(p.realizedUsd, 2) : '—'}</b></div>
      <div className="stat"><span>Open</span><b>{p?.openPositions ?? '—'}</b></div>
    </div>
    {last && <p className="small muted">Last check {last.at.slice(11, 16)} UTC — {last.pick ? <>bought <Link className="link" to={`/token/${s.chain}/${last.pick.address}`}>{last.pick.symbol}</Link></> : 'nothing passed, nothing bought'}.</p>}
    <ul className="pos-list">{children.map(c => <PositionRow key={c.id} c={c} onChanged={reload} />)}</ul>
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
