import { useMemo, useState } from 'react';
import { Link, useQueryState } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, Tabs, Drawer, I, cls, toast, errMsg, short, CHAINS } from '../lib.tsx';

const STATUS_LABEL: Record<string, string> = { implemented_demo: 'Demo', implemented_paper: 'Paper', blocked_external: 'Needs provider', verified_live: 'Live', implemented_live_unverified: 'Live (unverified)', unsupported_by_selected_provider: 'Unsupported', not_started: 'Not started', in_progress: 'In progress' };

export function AIPage() {
  const { me, chain, openAuth } = useApp();
  const [prompt, setPrompt] = useState(''); const [run, setRun] = useState<any>(null); const [busy, setBusy] = useState(false);
  const skills = useApi<any>('/skills', []);
  const [cat, setCat] = useQueryState('cat', 'All'); const [q, setQ] = useQueryState('q', ''); 
  const [detail, setDetail] = useQueryState('skill', '');
  const list = useMemo(() => (skills.data?.skills ?? []).filter((s: any) => (cat === 'All' || s.category === cat) && (!q || (s.title + ' ' + s.summary + ' ' + s.id).toLowerCase().includes(q.toLowerCase()))), [skills.data, cat, q]);
  async function ask(p = prompt) {
    if (!me) return openAuth(); if (!p.trim()) return;
    setBusy(true); try { setRun(await api('/ai/runs', { method: 'POST', body: { prompt: p, chain } })); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const modeKey = me?.settings.mode === 'live' ? 'live' : me?.settings.mode === 'paper' ? 'paper' : 'demo';
  return <div className="page ai">
    <div className="ai-wrap">
      <section className="ai-hero simple">
        <h1>Ask JGG anything</h1>
        <p className="lede">Find coins, check a token, or see what smart wallets are buying. Nothing is bought until you approve it.</p>
        <div className="ask">
          <textarea rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} placeholder="e.g. What's trending on Solana?" aria-label="Ask the JGG agent" />
          <button className="btn big" disabled={busy} onClick={() => ask()}>{busy ? 'Thinking…' : me ? 'Ask' : 'Log in to ask'}</button>
        </div>
        <div className="chips">{['Top trending tokens right now', 'Smart money buy clusters', 'Any price surges?', 'Gas fees'].map(x => <button key={x} className="chip" onClick={() => { setPrompt(x); ask(x); }}>{x}</button>)}</div>
      </section>

      {run && <section className="panel pad answer-panel" aria-label="Answer">
        <div className="answer">{run.answer.map((a: string, i: number) => <p key={i}>{a}</p>)}</div>
        {run.steps.some((s: any) => s.result?.intentId) && <p><Link className="link" to="/portfolio?tab=orders">A trade proposal is waiting for your approval →</Link></p>}
        <details className="small"><summary>How this answer was put together</summary>
          <ul className="plain">{run.steps.map((s: any) => <li key={s.id}><span className={cls('b', s.status === 'succeeded' ? 'pos' : s.status === 'denied' ? 'warn' : 'neg')}>{s.status}</span> <code>{s.tool}</code> <span className="muted">— {s.why}</span>{s.result?.intentId && <> · proposal {short(s.result.intentId, 5)}</>}</li>)}</ul>
          <p className="muted">{run.untrustedContentNote} {run.planner.note}</p></details>
      </section>}

      <section className="skills" aria-label="Skills Market">
        <div className="skills-head"><h2>Skills</h2><div className="grow" />
          <div className="search small"><I.search /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" /></div>
        </div>
        <Tabs label="Skill categories" value={cat as any} onChange={setCat} items={(skills.data?.categories ?? ['All']).map((c: string) => ({ id: c, label: c }))} />
        <State loading={skills.loading} error={skills.error} onRetry={() => skills.reload()} empty={!list.length && 'No skills match.'}>
          <div className="skill-grid">{list.map((s: any) => { const st = s.status[modeKey]; const ok = String(st).startsWith('implemented') || st === 'verified_live';
            return <button key={s.id} className="skill-card" onClick={() => setDetail(s.id)} aria-label={`${s.title} — ${STATUS_LABEL[st] ?? st}`}>
              <span className="skill-icon" aria-hidden="true">{s.icon}</span>
              <span className="skill-text"><b>{s.title}</b><span className="clamp2 muted">{s.summary}</span></span>
              <span className={cls('b', ok ? 'pos' : 'warn')} title={s.blocker}>{ok ? 'Ready' : STATUS_LABEL[st] ?? st}</span>
            </button>; })}</div>
          <p className="muted small pad">Use these from your own agent with an <Link className="link" to="/settings?tab=api">API key</Link>.</p>
        </State>
      </section>
      {me && <RunHistory />}
    </div>
    {detail && <SkillDetail id={detail} onClose={() => setDetail('')} />}
  </div>;
}

function SkillDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me, chain, openAuth } = useApp(); const d = useApi<any>(`/skills/${id}`, [id]);
  const [inputs, setInputs] = useState<Record<string, any>>({}); const [out, setOut] = useState<any>(null); const [busy, setBusy] = useState(false);
  const s = d.data;
  async function runIt() {
    if (!me) return openAuth(); setBusy(true); setOut(null);
    const body: Record<string, any> = {};
    for (const f of s.inputs) { const v = inputs[f.name] ?? (f.type === 'chain' ? chain : undefined); if (v !== undefined && v !== '') body[f.name] = f.type === 'int' ? Number(v) : v; }
    try { setOut(await api(`/skills/${id}/run`, { method: 'POST', body: { inputs: body } })); } catch (e) { setOut({ status: 'failed', error: { message: errMsg(e), details: (e as any).e?.details } }); } finally { setBusy(false); }
  }
  return <Drawer open onClose={onClose} title={s ? `${s.icon} ${s.title}` : 'Skill'} wide>
    <State loading={d.loading} error={d.error}>{s && <>
      <p>{s.summary}</p>
      <dl className="kv"><dt>ID / version</dt><dd>{s.id} · {s.version}</dd><dt>Tool</dt><dd><code>{s.toolId}</code></dd><dt>Permissions</dt><dd>{s.scopes.join(', ')}</dd><dt>Chains</dt><dd>{s.supportedChains.join(', ')}</dd><dt>Dependencies</dt><dd>{s.dependencies.join(', ')}</dd><dt>Status</dt><dd>demo {STATUS_LABEL[s.status.demo]} · paper {STATUS_LABEL[s.status.paper]} · live {STATUS_LABEL[s.status.live]}</dd><dt>Reference</dt><dd>{s.ref}</dd></dl>
      {s.blocker && <p className="note warn">{s.blocker}</p>}
      <h3>Inputs</h3>
      <div className="form">{s.inputs.map((f: any) => <label key={f.name} className="field"><span>{f.name}{f.required ? ' *' : ''} <span className="muted small">{f.type}</span></span>
        {f.type === 'chain' ? <select value={inputs[f.name] ?? chain} onChange={e => setInputs({ ...inputs, [f.name]: e.target.value })}>{CHAINS.filter(c => s.supportedChains.includes(c)).map(c => <option key={c}>{c}</option>)}</select>
          : f.type === 'enum' ? <select value={inputs[f.name] ?? f.default ?? ''} onChange={e => setInputs({ ...inputs, [f.name]: e.target.value })}>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select>
          : f.type === 'bool' ? <input type="checkbox" checked={!!inputs[f.name]} onChange={e => setInputs({ ...inputs, [f.name]: e.target.checked })} />
          : <input value={inputs[f.name] ?? ''} placeholder={f.default !== undefined ? String(f.default) : ''} onChange={e => setInputs({ ...inputs, [f.name]: e.target.value })} />}
        {f.help && <small className="muted">{f.help}</small>}</label>)}</div>
      <h3>Output example</h3><pre className="code">{s.outputExample}</pre>
      <button className="btn big" disabled={busy} onClick={runIt}>{busy ? 'Running…' : 'Run'}</button>
      {out && <div className="run-out"><p><span className={cls('b', out.status === 'succeeded' ? 'pos' : out.status === 'blocked' ? 'warn' : 'neg')}>{out.status}</span> {out.error?.message}</p>
        {out.error?.details && <ul className="neg small">{(out.error.details as any[]).map((d: any, i: number) => <li key={i}>{d.path}: {d.message}</li>)}</ul>}
        {out.data && <pre className="code tall">{JSON.stringify(out.data, null, 2).slice(0, 12000)}</pre>}{out.meta && <p className="muted small">source {out.meta.source} · {out.meta.status} · as of {out.meta.asOf}</p>}</div>}
    </>}</State>
  </Drawer>;
}

function RunHistory() {
  const d = useApi<any[]>('/skill-runs', [], 0); const a = useApi<any[]>('/ai/runs', [], 0);
  return <section className="panel"><div className="panel-bar"><strong>Run history</strong><button className="icon-btn sm" aria-label="Refresh" onClick={() => { d.reload(true); a.reload(true); }}><I.refresh /></button></div>
    <div className="table-wrap"><table className="tbl dense"><thead><tr><th>When</th><th>Kind</th><th>What</th><th>Status</th></tr></thead><tbody>
      {[...(a.data ?? []).map(r => ({ at: r.created_at, kind: 'AI', what: r.prompt, status: r.status })), ...(d.data ?? []).map(r => ({ at: r.at, kind: 'Skill', what: `${r.skill_id} ${JSON.stringify(r.inputs).slice(0, 60)}`, status: r.status }))].sort((x, y) => y.at - x.at).slice(0, 30).map((r, i) => <tr key={i}><td>{new Date(r.at).toISOString().slice(11, 19)}</td><td>{r.kind}</td><td className="small">{r.what}</td><td>{r.status}</td></tr>)}
    </tbody></table>{!a.data?.length && !d.data?.length && <p className="state">No runs yet.</p>}</div></section>;
}
