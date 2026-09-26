import { useMemo, useState } from 'react';
import { Link, useQueryState } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, Tabs, Drawer, I, cls, toast, errMsg, short, Seg, CHAINS } from '../lib.tsx';

const STAGES = [['screening', 'Screening', 'market.trending, signals.*'], ['analysis', 'Analysis', 'token.dd, token.info, wallet.analysis'], ['proposal', 'Order proposal', 'trade.* → intent awaiting approval'], ['monitoring', 'Position monitoring', 'strategies + worker'], ['alerts', 'Risk alerts', 'alerts + notifications']] as const;
const stageOf = (tool: string) => tool.startsWith('market.') || tool.startsWith('signals.') ? 'screening' : tool.startsWith('token.') || tool.startsWith('wallet.') || tool.startsWith('dev.') ? 'analysis' : tool.startsWith('trade.') ? 'proposal' : tool.startsWith('strategy.') || tool.startsWith('orders.') ? 'monitoring' : 'alerts';
const STATUS_LABEL: Record<string, string> = { implemented_demo: 'Demo', implemented_paper: 'Paper', blocked_external: 'Needs provider', verified_live: 'Live', implemented_live_unverified: 'Live (unverified)', unsupported_by_selected_provider: 'Unsupported', not_started: 'Not started', in_progress: 'In progress' };

export function AIPage() {
  const { me, chain, openAuth } = useApp();
  const [prompt, setPrompt] = useState(''); const [run, setRun] = useState<any>(null); const [busy, setBusy] = useState(false);
  const skills = useApi<any>('/skills', []);
  const [cat, setCat] = useQueryState('cat', 'All'); const [q, setQ] = useQueryState('q', ''); const [src, setSrc] = useQueryState('src', 'all');
  const [detail, setDetail] = useQueryState('skill', '');
  const list = useMemo(() => (skills.data?.skills ?? []).filter((s: any) => (cat === 'All' || s.category === cat) && (src === 'all' || s.source === src) && (!q || (s.title + ' ' + s.summary + ' ' + s.id).toLowerCase().includes(q.toLowerCase()))), [skills.data, cat, q, src]);
  async function ask(p = prompt) {
    if (!me) return openAuth(); if (!p.trim()) return;
    setBusy(true); try { setRun(await api('/ai/runs', { method: 'POST', body: { prompt: p, chain } })); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const hit = new Set((run?.steps ?? []).map((s: any) => stageOf(s.tool)));
  return <div className="page ai">
    <div className="ai-wrap">
      <section className="ai-hero">
        <div>
          <h1>Trade with an AI copilot that shows its work</h1>
          <p className="lede">Screen, research and draft orders with JGG's 66 skills. Every figure comes from a tool call you can inspect, and nothing executes until you approve it.</p>
          <div className="ask">
            <textarea rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} placeholder='Try "trending on solana", "smart money buys", or "analyze <token address>"' aria-label="Ask the JGG agent" />
            <button className="btn big" disabled={busy} onClick={() => ask()}>{busy ? 'Running…' : me ? 'Run' : 'Log in to run'}</button>
          </div>
          <div className="chips">{['Top trending tokens right now', 'Smart money buy clusters', 'Any price surges?', 'Gas fees'].map(x => <button key={x} className="chip" onClick={() => { setPrompt(x); ask(x); }}>{x}</button>)}</div>
        </div>
        <div className="panel pad install">
          <h2>Use JGG from your own agent</h2>
          <p className="muted small">Scoped API keys (Settings → API keys). Same tools and validation as this page. Trade scopes create proposals only.</p>
          <pre className="code">{`curl -H "Authorization: Bearer $JGG_API_KEY" \\
  "${location.origin}/api/v1/skills/C05/run" \\
  -X POST -H 'content-type: application/json' \\
  -d '{"inputs":{"chain":"solana","address":"<mint>"}}'`}</pre>
          <Link className="btn ghost" to="/settings?tab=api"><I.key /> Manage API keys</Link>
        </div>
      </section>

      <section className="panel trader" aria-label="AI trader run">
        <div className="panel-bar"><strong>AI trader</strong><span className="b">Rule-based planner (no LLM configured)</span>{!run && <span className="b warn">Demo — run a prompt to see real events</span>}</div>
        <ol className="stages">{STAGES.map(([id, label, tools]) => <li key={id} className={cls(hit.has(id) && 'on')}><strong>{label}</strong><span className="muted small">{tools}</span></li>)}</ol>
        {run && <div className="run">
          <div className="answer">{run.answer.map((a: string, i: number) => <p key={i}>{a}</p>)}</div>
          <details open><summary>{run.steps.length} tool call(s) · {run.planner.id}</summary><ul className="plain">{run.steps.map((s: any) => <li key={s.id}><span className={cls('b', s.status === 'succeeded' ? 'pos' : s.status === 'denied' ? 'warn' : 'neg')}>{s.status}</span> <code>{s.tool}</code> <span className="muted small">— {s.why}</span>{s.result?.intentId && <> · <Link className="link" to="/portfolio?tab=orders">proposal {short(s.result.intentId, 5)} awaiting your approval</Link></>}</li>)}</ul></details>
          <p className="muted small">{run.untrustedContentNote} {run.planner.note}</p>
        </div>}
      </section>

      <section className="skills" aria-label="Skills Market">
        <div className="skills-head"><h2>Skills Market</h2><div className="grow" />
          <div className="search small"><I.search /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" /></div>
          <Seg label="Source" items={[{ id: 'all', label: 'All sources' }, { id: 'JGG', label: 'JGG' }, { id: '6551', label: '6551' }, { id: 'X', label: 'X' }]} value={src} onChange={setSrc} />
        </div>
        <Tabs label="Skill categories" value={cat as any} onChange={setCat} items={(skills.data?.categories ?? ['All']).map((c: string) => ({ id: c, label: c }))} />
        <State loading={skills.loading} error={skills.error} onRetry={() => skills.reload()} empty={!list.length && 'No skills match.'}>
          <div className="skill-grid">{list.map((s: any) => <article key={s.id} className="skill-card">
            <div className="skill-top"><span className="skill-icon" aria-hidden="true">{s.icon}</span><div><h3>{s.title}</h3><span className="muted small">{s.source} · {s.category} · {s.id}</span></div></div>
            <p className="clamp2">{s.summary}</p>
            <div className="skill-foot"><span className={cls('b', s.status.demo.startsWith('implemented') ? 'pos' : 'warn')} title={s.blocker}>{STATUS_LABEL[s.status[me?.settings.mode === 'paper' ? 'paper' : 'demo']]}</span><span className="b" title="Live status">Live: {STATUS_LABEL[s.status.live]}</span><div className="grow" /><button className="btn sm" onClick={() => setDetail(s.id)}>Detail</button></div>
          </article>)}</div>
          <p className="muted small pad">{skills.data?.note}</p>
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
