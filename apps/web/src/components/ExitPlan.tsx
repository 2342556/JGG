// Exit plan editor (owner spec 2026-09-26): each rule on/off, validated percentages, when trailing starts, named presets,
// and a preview of the exact trigger prices and token quantities from the server (same math as execution).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp, useApi, cls, price, toast, errMsg } from '../lib.tsx';
import { validateExitConfig, DEFAULT_EXIT_CONFIG, type ExitConfig, type TrailActivation } from '../../../../packages/domain/src/exitPlan.ts';

export type { ExitConfig };
export const cloneCfg = (c: ExitConfig): ExitConfig => JSON.parse(JSON.stringify(c));
export { DEFAULT_EXIT_CONFIG };

const qtyFmt = (q: string | null | undefined) => q === null || q === undefined ? '—' : Number(q).toLocaleString('en-US', { maximumFractionDigits: 6 });
const numIn = (v: string) => v.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');

export type PreviewCtx = { chain: string; tokenAddress?: string; walletId?: string; amount?: string; strategyId?: string };

/** Plain-English one-liner for a plan (used in summaries). */
export function describeExit(c: ExitConfig): string {
  const parts: string[] = [];
  if (c.partialTp.enabled) parts.push(`At +${c.partialTp.triggerPct}% sells ${c.partialTp.sellPct}% of the tokens once`);
  if (c.trailing.enabled) parts.push(`${c.trailing.activation === 'after_partial' ? 'then follows the rest up' : c.trailing.activation === 'at_gain' ? `from +${c.trailing.activationGainPct ?? '?'}% follows the price up` : 'follows the price up from the start'} and sells if it drops ${c.trailing.pct}% from the top`);
  if (c.stopLoss.enabled) parts.push(`sells everything at −${c.stopLoss.pct}%`);
  const s = parts.join(', '); return s ? s[0].toUpperCase() + s.slice(1) + '.' : 'No exit rules on.';
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cls('switch', on && 'on')} onClick={() => onChange(!on)}><i /></button>;
}
function Pct({ value, onChange, label, invalid, prefix }: { value: string; onChange: (v: string) => void; label: string; invalid?: boolean; prefix?: string }) {
  return <span className={cls('pct-in', invalid && 'bad')}>{prefix}<input inputMode="decimal" aria-label={label} aria-invalid={invalid || undefined} value={value} style={{ width: `${Math.max(2, value.length) + 0.6}ch` }} onChange={e => onChange(numIn(e.target.value))} /><em>%</em></span>;
}

export function ExitPlanEditor({ value, onChange, ctx, presets = true }: { value: ExitConfig; onChange: (c: ExitConfig) => void; ctx: PreviewCtx | null; presets?: boolean }) {
  const issues = validateExitConfig(value);
  const bad = (f: string) => issues.some(i => i.field === f);
  const set = (fn: (c: ExitConfig) => void) => { const c = cloneCfg(value); fn(c); onChange(c); };
  const [pv, setPv] = useState<any>(null); const [pvErr, setPvErr] = useState<string | null>(null);
  const key = JSON.stringify([value, ctx]);
  useEffect(() => {
    if (!ctx || issues.length) { setPv(null); return; }
    const t = setTimeout(async () => { try { setPv(await api('/exits/preview', { method: 'POST', body: { config: value, ...ctx } })); setPvErr(null); } catch (e) { setPvErr(errMsg(e)); } }, 250);
    return () => clearTimeout(t);
  }, [key]);
  const act = value.trailing.activation;
  return <div className="exit-editor">
    {presets && <PresetBar value={value} onPick={onChange} />}

    <section className={cls('rule', !value.stopLoss.enabled && 'off')}>
      <header><b>Stop loss</b><Switch on={value.stopLoss.enabled} onChange={v => set(c => { c.stopLoss.enabled = v; })} label="Stop loss on/off" /></header>
      <p>Sell everything if the price falls <Pct value={value.stopLoss.pct} onChange={v => set(c => { c.stopLoss.pct = v; })} label="Stop loss percent below entry" invalid={bad('stopLoss.pct')} /> below my entry.</p>
    </section>

    <section className={cls('rule', !value.partialTp.enabled && 'off')}>
      <header><b>Take partial profit</b><Switch on={value.partialTp.enabled} onChange={v => set(c => { c.partialTp.enabled = v; })} label="Partial take profit on/off" /></header>
      <p>When the price is up <Pct prefix="+" value={value.partialTp.triggerPct} onChange={v => set(c => { c.partialTp.triggerPct = v; })} label="Take profit trigger percent gain" invalid={bad('partialTp.triggerPct')} />, sell <Pct value={value.partialTp.sellPct} onChange={v => set(c => { c.partialTp.sellPct = v; })} label="Percent of tokens to sell" invalid={bad('partialTp.sellPct')} /> of my tokens. <span className="muted">Once.</span></p>
    </section>

    <section className={cls('rule', !value.trailing.enabled && 'off')}>
      <header><b>Trailing stop</b><Switch on={value.trailing.enabled} onChange={v => set(c => { c.trailing.enabled = v; })} label="Trailing stop on/off" /></header>
      <p>Sell the rest if the price drops <Pct value={value.trailing.pct} onChange={v => set(c => { c.trailing.pct = v; })} label="Trailing distance percent" invalid={bad('trailing.pct')} /> from its highest point.</p>
      <div className="starts" role="radiogroup" aria-label="When the trailing stop starts">
        <span className="muted small">Starts</span>
        {([['after_partial', 'After partial profit'], ['at_gain', 'At a gain'], ['immediate', 'Right away']] as [TrailActivation, string][]).map(([id, l]) =>
          <button type="button" key={id} role="radio" aria-checked={act === id} className={cls('chip', act === id && 'on')} onClick={() => set(c => { c.trailing.activation = id; if (id === 'at_gain' && !c.trailing.activationGainPct) c.trailing.activationGainPct = '50'; })}>{l}</button>)}
        {act === 'at_gain' && <Pct prefix="+" value={value.trailing.activationGainPct ?? ''} onChange={v => set(c => { c.trailing.activationGainPct = v; })} label="Trailing starts at percent gain" invalid={bad('trailing.activationGainPct')} />}
      </div>
      {act !== 'after_partial' && <p className="fine muted">Earlier start (your choice): the trailing stop covers all tokens from {act === 'immediate' ? 'the start' : `+${value.trailing.activationGainPct ?? '?'}%`}, not just what is left after the partial profit.</p>}
    </section>

    {issues.length > 0 && <ul className="exit-issues" role="alert">{issues.map(i => <li key={i.field + i.code}>{i.message}</li>)}</ul>}
    {ctx && !issues.length && <ExitPreviewBox pv={pv} err={pvErr} />}
  </div>;
}

export function ExitPreviewBox({ pv, err }: { pv: any; err?: string | null }) {
  if (err) return <p className="note err">{err}</p>;
  if (!pv) return <div className="exit-preview loading"><span className="muted small">Calculating…</span></div>;
  if (pv.basis === 'none' || !pv.entry) return <div className="exit-preview"><p className="muted small">{pv.note || 'Exact prices appear once there is a position (entry fill and token quantity).'}</p></div>;
  const exact = pv.basis !== 'estimate';
  return <div className="exit-preview" aria-label="Exit preview">
    <div className="pv-head"><b>{exact ? 'Exact numbers' : 'Estimate'}</b><span className={cls('b', exact ? 'pos' : 'warn')}>{exact ? 'from your fills' : 'until the buy fills'}</span></div>
    <dl>
      <div><dt>Entry (avg fill)</dt><dd title={pv.entry}>{price(pv.entry)}</dd></div>
      <div><dt>Tokens</dt><dd title={pv.qty}>{qtyFmt(pv.qty)}</dd></div>
    </dl>
    <table className="pv-table"><tbody>
      {pv.stopLoss && <tr><td>Stop loss</td><td>price ≤ <b title={pv.stopLoss.trigger}>{price(pv.stopLoss.trigger)}</b></td><td>sells all left</td></tr>}
      {pv.partialTp && <tr><td>Partial profit</td><td>price ≥ <b title={pv.partialTp.trigger}>{price(pv.partialTp.trigger)}</b></td><td>sells <b title={pv.partialTp.sellsQty}>{qtyFmt(pv.partialTp.sellsQty)}</b> once</td></tr>}
      {pv.trailing && <tr><td>Trailing</td><td>{pv.trailing.activatesAt ? <>starts at <b>{price(pv.trailing.activatesAt)}</b>, first trigger <b>{price(pv.trailing.exampleTrigger)}</b></> : <>first trigger <b>{price(pv.trailing.exampleTrigger)}</b></>}</td><td>protects <b>{qtyFmt(pv.trailing.protectsQty)}</b></td></tr>}
    </tbody></table>
    <p className="fine muted">{pv.trailing ? `Trailing = highest price × ${100 - Number(pv.trailing.pct)}%, only moves up. ` : ''}Market sells in USD — a fast drop can fill below the trigger.{exact ? '' : ' Exact numbers come from the real fill.'}</p>
  </div>;
}

function PresetBar({ value, onPick }: { value: ExitConfig; onPick: (c: ExitConfig) => void }) {
  const { me } = useApp(); const list = useApi<any[]>(me ? '/exit-presets' : null, [me?.user.id]);
  const [name, setName] = useState(''); const [saving, setSaving] = useState(false); const [open, setOpen] = useState(false);
  const cur = JSON.stringify(value); const inputRef = useRef<HTMLInputElement>(null);
  async function save() {
    if (!name.trim()) return; setSaving(true);
    try { const existing = (list.data ?? []).find(p => !p.builtin && p.name === name.trim()); await api('/exit-presets', { method: 'PUT', body: { name: name.trim(), config: value, ...(existing ? { version: existing.version } : {}) } }); toast(`Saved preset “${name.trim()}”`, 'ok'); setName(''); setOpen(false); list.reload(true); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setSaving(false); }
  }
  async function del(p: any) { if (!confirm(`Delete preset “${p.name}”?`)) return; try { await api(`/exit-presets/${p.id}`, { method: 'DELETE' }); list.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  return <div className="preset-bar">
    <div className="chips" role="radiogroup" aria-label="Exit presets">{(list.data ?? []).map(p => { const on = JSON.stringify(p.config) === cur;
      return <span key={p.id} className="preset-chip"><button type="button" role="radio" aria-checked={on} className={cls('chip', on && 'on')} onClick={() => onPick(cloneCfg(p.config))}>{p.name}</button>{!p.builtin && <button type="button" className="chip-x" aria-label={`Delete preset ${p.name}`} onClick={() => del(p)}>×</button>}</span>; })}
      {me && !open && <button type="button" className="chip ghost" onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}>+ Save as preset</button>}
    </div>
    {open && <div className="row gap save-preset"><input ref={inputRef} value={name} maxLength={40} placeholder="Preset name" aria-label="Preset name" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); }} /><button type="button" className="btn sm" disabled={saving || !name.trim() || validateExitConfig(value).length > 0} onClick={save}>Save</button><button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button></div>}
  </div>;
}
