import { useEffect, useState } from 'react';
import { Link, useQueryState } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, Tabs, Seg, I, usd, short, cls, signCls, toast, errMsg, ModeBadge, MODE_HELP, NATIVE, CHAINS, price, TokenAvatar, pct, Copy } from '../lib.tsx';
import { Tasks } from './Signals.tsx';

// ---------------- Portfolio (M06) ----------------
export function Portfolio() {
  const { me, chain, refresh } = useApp(); const [tab, setTab] = useQueryState('tab', 'holdings');
  const p = useApi<any>(me ? `/portfolio?chain=${chain}` : null, [me?.user.id, chain], 5000);
  const orders = useApi<any>(me && tab === 'orders' ? '/orders?limit=50' : null, [tab, me?.user.id], 5000);
  const strat = useApi<any[]>(me && tab === 'strategies' ? '/strategies' : null, [tab, me?.user.id], 5000);
  const journal = useApi<any[]>(me && tab === 'history' ? '/portfolio/journal' : null, [tab, me?.user.id]);
  if (!me) return <div className="page"><State signedOut /></div>;
  const x = p.data;
  async function kill() { try { const r = await api('/automation/stop', { method: 'POST', body: {} }); toast(`Automation stopped. ${r.pausedStrategies} strategies paused; ${r.unresolved.length} unresolved orders.`, 'warn'); refresh(); strat.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  async function reset() { if (!confirm('Reset virtual balances? Strategies are cancelled; history is kept.')) return; try { await api('/paper/reset', { method: 'POST', body: {} }); toast('Paper account reset', 'ok'); p.reload(); } catch (e) { toast(errMsg(e), 'err'); } }
  async function reconcile(id: string) { try { const r = await api(`/orders/${id}/reconcile`, { method: 'POST', body: {} }); toast(`Reconcile: ${r.action}`, 'info'); orders.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  const nat = (x?.balances ?? []).filter((b: any) => b.asset === NATIVE[chain]).reduce((a: number, b: any) => a + Number(b.qty), 0);
  return <div className="page portfolio">
    <div className="page-head"><h1>Portfolio</h1><ModeBadge mode={me.settings.mode} /><span className="muted small">{MODE_HELP[me.settings.mode]}</span><div className="grow" />
      {me.killSwitch ? <span className="b neg">Automation stopped</span> : <button className="btn danger" onClick={kill}>Stop all automation</button>}<button className="btn ghost" onClick={reset}>Reset paper</button><a className="btn ghost" href="/api/v1/portfolio/export.csv">Export CSV</a></div>
    <State loading={p.loading} error={p.error} onRetry={() => p.reload()}>{x && <>
      <div className="stat-grid">
        <div className="stat"><span>Equity (mark)</span><b>{usd(x.totals.equityUsd, 2)}</b><small className="muted">{x.totals.note}</small></div>
        <div className="stat"><span>Unrealized</span><b className={signCls(Number(x.totals.unrealizedUsd))}>{usd(x.totals.unrealizedUsd, 2)}</b></div>
        <div className="stat"><span>Realized</span><b className={signCls(Number(x.totals.realizedUsd))}>{usd(x.totals.realizedUsd, 2)}</b></div>
        <div className="stat"><span>{NATIVE[chain]} (all paper wallets)</span><b>{nat.toLocaleString(undefined, { maximumFractionDigits: 6 })}</b></div>
      </div>
      {x.totals.unpriced.length > 0 && <p className="note warn">Unpriced holdings excluded from totals: {x.totals.unpriced.map((a: string) => short(a)).join(', ')}</p>}
    </>}</State>
    <Tabs label="Portfolio sections" value={tab as any} onChange={setTab} items={[{ id: 'holdings', label: 'Holdings' }, { id: 'pnl', label: 'P&L' }, { id: 'orders', label: 'Orders' }, { id: 'strategies', label: 'Strategies' }, { id: 'history', label: 'Ledger' }, { id: 'wallets', label: 'Wallets' }]} />
    {tab === 'holdings' || tab === 'pnl' ? <div className="table-wrap"><table className="tbl"><thead><tr><th>Token</th><th>Bucket</th><th className="r">Qty</th><th className="r">Avg cost</th><th className="r">Price</th><th className="r">Value</th><th className="r">Unrealized</th><th className="r">Realized</th></tr></thead>
      <tbody>{(x?.positions ?? []).filter((r: any) => tab === 'pnl' || !r.closed).map((r: any) => <tr key={r.id}><td><Link className="link" to={`/token/${chain}/${r.token}`}>{r.symbol}</Link></td><td className="small">{r.bucket === 'manual' ? 'manual' : 'strategy'}</td><td className="r">{Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td className="r">{price(r.avgPriceUsd)}</td><td className="r">{price(r.priceUsd)}</td><td className="r">{usd(r.valueUsd)}</td><td className={cls('r', signCls(Number(r.unrealizedUsd)))}>{usd(r.unrealizedUsd, 2)}</td><td className={cls('r', signCls(Number(r.realizedUsd)))}>{usd(r.realizedUsd, 2)}</td></tr>)}</tbody></table>
      {!x?.positions?.length && <div className="state"><p>No positions yet. Buy something from Trenches or Trending — it's all simulated.</p><Link className="btn" to="/trenches">Open Trenches</Link></div>}</div>
    : tab === 'orders' ? <State loading={orders.loading} error={orders.error} empty={!orders.data?.rows.length && 'No orders yet.'}><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Time</th><th>Side</th><th>Token</th><th className="r">In</th><th className="r">Out</th><th>State</th><th>Tx</th><th /></tr></thead>
      <tbody>{(orders.data?.rows ?? []).map((o: any) => <tr key={o.id}><td>{o.createdAt.slice(5, 19).replace('T', ' ')}</td><td className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side}</td><td className="mono"><Link className="link" to={`/token/${o.chain}/${o.token}`}>{short(o.token)}</Link></td><td className="r">{o.amountIn}</td><td className="r">{o.filledOut ?? '—'}</td><td className={o.state === 'finalized' ? 'pos' : ['failed', 'expired'].includes(o.state) ? 'neg' : 'warn'}>{o.state.replace(/_/g, ' ')}{o.error && <span className="muted small"> · {o.error}</span>}</td><td className="mono small muted">{short(o.txRef, 5)}</td><td>{o.state === 'reconciliation_required' && <button className="btn sm" onClick={() => reconcile(o.id)}>Reconcile</button>}</td></tr>)}</tbody></table></div></State>
    : tab === 'strategies' ? <State loading={strat.loading} error={strat.error} empty={!strat.data?.length && 'No strategies. Add exits from a token page or copy a wallet.'}><Tasks rows={strat.data ?? []} reload={() => strat.reload(true)} /></State>
    : tab === 'history' ? <State loading={journal.loading} error={journal.error} empty={!journal.data?.length && 'No ledger entries.'}><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Time</th><th>Kind</th><th>Lines (balanced per asset)</th></tr></thead><tbody>{(journal.data ?? []).map(e => <tr key={e.id}><td>{new Date(e.at).toISOString().slice(5, 19).replace('T', ' ')}</td><td>{e.kind}</td><td className="small mono">{e.lines.map((l: any) => `${l.account} ${l.amount} ${l.asset.length > 12 ? short(l.asset) : l.asset}`).join(' | ')}</td></tr>)}</tbody></table></div></State>
    : <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Wallet</th><th>Address</th><th>Custody</th><th className="r">Balances</th></tr></thead><tbody>{(x?.wallets ?? []).map((w: any) => <tr key={w.id}><td>{w.label}</td><td className="mono">{short(w.address, 8)}</td><td>{w.custody === 'paper' ? 'virtual (paper)' : w.custody}</td><td className="r small">{(x.balances ?? []).filter((b: any) => b.wallet_id === w.id).map((b: any) => `${Number(b.qty).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${b.asset.length > 8 ? short(b.asset, 3) : b.asset}`).join(', ') || '—'}</td></tr>)}</tbody></table>
      <p className="muted small pad">Deposits/withdrawals: not available — Demo/Paper use virtual balances; live custody requires a verified signer (blocked).</p></div>}
  </div>;
}

// ---------------- Rewards (M07) ----------------
export function Rewards() {
  const { me } = useApp(); const d = useApi<any>(me ? '/rewards' : null, [me?.user.id]);
  if (!me) return <div className="page"><State signedOut /></div>;
  const r = d.data;
  return <div className="page rewards narrow-page"><div className="page-head"><h1>Rewards</h1></div>
    <State loading={d.loading} error={d.error}>{r && <>
      <div className="panel pad"><h2>Your invite link</h2><div className="row gap"><code className="grow">{r.inviteLink}</code><Copy text={r.inviteLink} label="Copy invite link" /></div><p className="muted small">{r.referredUsers} referred account(s).</p></div>
      <div className="stat-grid"><div className="stat"><span>Pending</span><b>{r.balances.pending}</b></div><div className="stat"><span>Available</span><b>{r.balances.available}</b></div><div className="stat"><span>Paid</span><b>{r.balances.paid}</b></div><div className="stat"><span>JGG fee</span><b>{r.jggFeeBps} bps</b></div></div>
      <div className="panel pad"><h2>Program terms</h2><p>{r.terms}</p><p className="muted">{r.payoutStatus}</p></div>
      <div className="panel pad"><h2>Payout history</h2><p className="muted">No payouts.</p></div>
    </>}</State></div>;
}

// ---------------- Watchlist (M14) ----------------
export function Watchlist() {
  const { me, chain } = useApp(); const d = useApi<any[]>(me ? '/watchlists' : null, [me?.user.id], 8000);
  const [sel, setSel] = useState<string | null>(null); const [name, setName] = useState(''); const [bulk, setBulk] = useState('');
  if (!me) return <div className="page"><State signedOut /></div>;
  const lists = d.data ?? []; const cur = lists.find(l => l.id === sel) ?? lists[0];
  async function create() { try { const r = await api('/watchlists', { method: 'POST', body: { name } }); setName(''); setSel(r.id); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  async function rename(l: any) { const n = prompt('New name', l.name); if (!n) return; try { await api(`/watchlists/${l.id}`, { method: 'PATCH', body: { name: n, version: l.version } }); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  async function del(l: any) { if (!confirm(`Delete group ${l.name}?`)) return; try { await api(`/watchlists/${l.id}`, { method: 'DELETE' }); setSel(null); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  async function importBulk() {
    const items = bulk.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(a => a.includes(':') ? { chain: a.split(':')[0], address: a.split(':')[1] } : { chain, address: a });
    try { const r = await api(`/watchlists/${cur.id}/items`, { method: 'POST', body: { items } }); toast(`Added ${r.added}; rejected ${r.rejected.length}${r.rejected.length ? ': ' + r.rejected.map((x: any) => `#${x.idx + 1} ${x.error}`).join('; ') : ''}`, r.rejected.length ? 'warn' : 'ok'); setBulk(''); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const remove = async (i: any) => { try { await api(`/watchlists/${cur.id}/items/${i.chain}/${i.address}`, { method: 'DELETE' }); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  const exportCsv = () => { const csv = ['chain,address,symbol', ...cur.items.map((i: any) => `${i.chain},${i.address},${(i.token?.symbol ?? '').replace(/[^A-Za-z0-9]/g, '')}`)].join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `jgg-watchlist-${cur.name}.csv`; a.click(); };
  return <div className="page watchlist"><div className="page-head"><h1>Watchlist</h1><div className="grow" /><input placeholder="New group" value={name} onChange={e => setName(e.target.value)} aria-label="New group name" /><button className="btn" disabled={!name} onClick={create}>Create</button></div>
    <State loading={d.loading} error={d.error}>{cur && <>
      <div className="row gap wrap">{lists.map(l => <button key={l.id} className={cls('chip', l.id === cur.id && 'on')} onClick={() => setSel(l.id)}>{l.name} ({l.items.length})</button>)}<div className="grow" /><button className="btn sm ghost" onClick={() => rename(cur)}>Rename</button><button className="btn sm ghost" onClick={() => del(cur)}>Delete</button><button className="btn sm ghost" onClick={exportCsv}>Export</button></div>
      <div className="table-wrap"><table className="tbl"><thead><tr><th>Token</th><th>Chain</th><th className="r">Price</th><th className="r">MC</th><th className="r">5m</th><th className="r">1h</th><th className="r">Liq</th><th /></tr></thead>
        <tbody>{cur.items.map((i: any) => <tr key={i.chain + i.address}><td>{i.token ? <Link to={`/token/${i.chain}/${i.address}`} className="tok"><TokenAvatar symbol={i.token.symbol} hue={i.token.hue} size={32} /><strong>{i.token.symbol}</strong></Link> : <span className="mono muted">{short(i.address)} (unknown)</span>}</td><td>{i.chain}</td><td className="r">{price(i.token?.priceUsd ?? null)}</td><td className="r">{usd(i.token?.mcUsd)}</td><td className={cls('r', signCls(i.token?.change['5m']))}>{pct(i.token?.change['5m'])}</td><td className={cls('r', signCls(i.token?.change['1h']))}>{pct(i.token?.change['1h'])}</td><td className="r">{usd(i.token?.liqUsd)}</td><td className="r"><button className="icon-btn sm" aria-label="Remove" onClick={() => remove(i)}><I.trash /></button></td></tr>)}</tbody></table>
        {!cur.items.length && <p className="state">Empty group. Star a token or import addresses below.</p>}</div>
      <div className="panel pad"><h3>Batch import</h3><textarea rows={3} value={bulk} onChange={e => setBulk(e.target.value)} placeholder={`One address per line (defaults to ${chain}), or chain:address`} aria-label="Addresses to import" /><button className="btn" disabled={!bulk.trim()} onClick={importBulk}>Validate &amp; import</button><p className="muted small">Each address is validated for its chain; invalid lines are reported, not silently dropped.</p></div>
    </>}</State></div>;
}

// ---------------- Settings (M15) ----------------
export function Settings() {
  const { me, refresh, chain } = useApp(); const [tab, setTab] = useQueryState('tab', 'mode');
  if (!me) return <div className="page"><State signedOut /></div>;
  return <div className="page settings narrow-page"><div className="page-head"><h1>Settings</h1></div>
    <Tabs label="Settings sections" value={tab as any} onChange={setTab} items={[{ id: 'mode', label: 'Mode' }, { id: 'wallet', label: 'Trading wallet' }, { id: 'presets', label: 'Presets' }, { id: 'risk', label: 'Risk & automation' }, { id: 'api', label: 'API keys' }, { id: 'notifications', label: 'Notifications' }, { id: 'account', label: 'Account' }]} />
    {tab === 'mode' ? <ModeSettings me={me} refresh={refresh} /> : tab === 'wallet' ? <TradingWallet refresh={refresh} /> : tab === 'presets' ? <Presets chain={chain} /> : tab === 'risk' ? <RiskSettings refresh={refresh} /> : tab === 'api' ? <ApiKeys /> : tab === 'notifications' ? <Notifications refresh={refresh} /> : <AccountInfo me={me} />}
  </div>;
}
function ModeSettings({ me, refresh }: { me: any; refresh: () => void }) {
  const set = async (mode: string) => { try { const r = await api('/mode', { method: 'POST', body: { mode } }); toast(`Mode: ${mode}${r.invalidated ? ` — ${r.invalidated} pending approvals invalidated` : ''}`, 'info'); refresh(); } catch (e) { toast(errMsg(e), 'err'); } };
  return <div className="mode-grid">{['demo', 'paper', 'live_readonly', 'live'].map(m => <button key={m} className={cls('mode-card', me.settings.mode === m && 'on')} onClick={() => set(m)} aria-pressed={me.settings.mode === m}><ModeBadge mode={m} /><p>{MODE_HELP[m]}</p>{m === 'live' && <p className="warn small">Real funds from your JGG trading wallet. Needs the server's live configuration, a wallet sign-in on the allow-list, and a funded trading wallet (Settings → Trading wallet).</p>}</button>)}</div>;
}
function Presets({ chain }: { chain: string }) {
  const d = useApi<any[]>('/presets', []); const [edit, setEdit] = useState<any>(null);
  useEffect(() => { const p = d.data?.find(x => x.chain === chain && x.slot === 'P1'); if (p && !edit) setEdit({ slot: 'P1', ...p.config, version: p.version, buyAmounts: p.config.buyAmounts.join(', ') }); }, [d.data, chain]);
  const pick = (slot: string) => { const p = d.data?.find(x => x.chain === chain && x.slot === slot); if (p) setEdit({ slot, ...p.config, version: p.version, buyAmounts: p.config.buyAmounts.join(', ') }); };
  async function save() { try { await api('/presets', { method: 'PUT', body: { version: edit.version, explicitHighSlippage: edit.slippageBps > 1500, preset: { slot: edit.slot, chain, buyAmounts: String(edit.buyAmounts).split(',').map((s: string) => s.trim()).filter(Boolean), slippageBps: Number(edit.slippageBps), maxFee: String(edit.maxFee), mevProtect: !!edit.mevProtect, exitTemplate: edit.exitTemplate } } }); toast('Preset saved', 'ok'); d.reload(true); setEdit(null); } catch (e) { toast(errMsg(e), 'err'); } }
  return <State loading={d.loading} error={d.error}>{edit && <div className="panel pad form">
    <Seg label="Preset slot" items={['P1', 'P2', 'P3']} value={edit.slot} onChange={pick} /><p className="muted small">Chain: {chain}</p>
    <label className="field"><span>Quick amounts ({NATIVE[chain]}, comma-separated)</span><input value={edit.buyAmounts} onChange={e => setEdit({ ...edit, buyAmounts: e.target.value })} /></label>
    <label className="field"><span>Slippage (bps)</span><input value={edit.slippageBps} onChange={e => setEdit({ ...edit, slippageBps: e.target.value.replace(/\D/g, '') })} /></label>
    <label className="field"><span>Max network+priority fee ({NATIVE[chain]})</span><input value={edit.maxFee} onChange={e => setEdit({ ...edit, maxFee: e.target.value })} /></label>
    <label className="check"><input type="checkbox" checked={edit.mevProtect} onChange={e => setEdit({ ...edit, mevProtect: e.target.checked })} /> MEV protection preference (applied only where the live route supports it)</label>
    <label className="field"><span>Default exits</span><select value={edit.exitTemplate} onChange={e => setEdit({ ...edit, exitTemplate: e.target.value })}><option value="none">None</option><option value="tp_sl_basic">TP/SL basic</option><option value="trailing_tp">Trailing TP</option><option value="trailing_sl">Trailing SL</option></select></label>
    <button className="btn" onClick={save}>Save {edit.slot}</button></div>}</State>;
}
function RiskSettings({ refresh }: { refresh: () => void }) {
  const d = useApi<any>('/risk-policy', []); const [f, setF] = useState<any>(null);
  useEffect(() => { if (d.data && !f) setF({ ...d.data.policy, allowedChains: d.data.policy.allowedChains }); }, [d.data]);
  async function save() { try { await api('/risk-policy', { method: 'PUT', body: { version: d.data.version, policy: { ...f, maxOpenPositions: Number(f.maxOpenPositions), maxSlippageBps: Number(f.maxSlippageBps), maxDataAgeMs: Number(f.maxDataAgeMs) } } }); toast('Risk policy saved', 'ok'); d.reload(true); setF(null); } catch (e) { toast(errMsg(e), 'err'); } }
  const ks = async (on: boolean) => { try { await api(on ? '/automation/stop' : '/automation/resume', { method: 'POST', body: {} }); refresh(); d.reload(true); setF(null); toast(on ? 'Kill switch ON' : 'Kill switch off', on ? 'warn' : 'ok'); } catch (e) { toast(errMsg(e), 'err'); } };
  if (!f) return <State loading={d.loading} error={d.error} />;
  const inp = (k: string, label: string) => <label className="field"><span>{label}</span><input value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>;
  return <div className="panel pad form">
    <p className={d.data.configured ? 'note ok' : 'note warn'}>{d.data.configured ? 'Policy configured — automation may run within these limits.' : 'Default policy denies all automated trades. Set limits and allowed chains to enable strategies.'}</p>
    <div className="form-grid">{inp('maxPerTrade', 'Max per trade (native)')}{inp('maxPerAssetExposure', 'Max exposure per asset (native)')}{inp('maxDailyGrossBuy', 'Max daily gross buy (native)')}{inp('maxRealizedDailyLoss', 'Max realized daily loss (native)')}{inp('maxOpenPositions', 'Max open positions')}{inp('maxSlippageBps', 'Max slippage (bps)')}{inp('maxFeeQuote', 'Max fee per order (native)')}{inp('maxDataAgeMs', 'Max data age (ms)')}</div>
    <fieldset><legend>Allowed chains</legend>{CHAINS.map(c => <label key={c} className="check"><input type="checkbox" checked={f.allowedChains.includes(c)} onChange={e => setF({ ...f, allowedChains: e.target.checked ? [...f.allowedChains, c] : f.allowedChains.filter((x: string) => x !== c) })} />{c}</label>)}</fieldset>
    <label className="check"><input type="checkbox" checked={f.entriesPaused} onChange={e => setF({ ...f, entriesPaused: e.target.checked })} /> Pause new entries (exits still allowed)</label>
    <div className="row gap"><button className="btn" onClick={save}>Save policy</button><div className="grow" />{d.data.policy.killSwitch ? <button className="btn" onClick={() => ks(false)}>Resume automation</button> : <button className="btn danger" onClick={() => ks(true)}>Kill switch — stop all automation</button>}</div>
  </div>;
}
function ApiKeys() {
  const d = useApi<any[]>('/api-keys', []); const [name, setName] = useState('agent'); const [scopes, setScopes] = useState<string[]>(['market:read']); const [secret, setSecret] = useState<string | null>(null);
  const ALL = ['market:read', 'wallet:read', 'signals:read', 'watchlist:write', 'trade:propose', 'strategy:manage', 'launch:propose'];
  async function create() { try { const r = await api('/api-keys', { method: 'POST', body: { name, scopes, ttlDays: 30 } }); setSecret(r.secret); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } }
  const revoke = async (id: string) => { try { await api(`/api-keys/${id}`, { method: 'DELETE' }); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  return <div className="panel pad form">
    {secret && <div className="note ok"><strong>Copy this key now — it will not be shown again.</strong><div className="row gap"><code className="grow break">{secret}</code><Copy text={secret} label="Copy API key" /></div><button className="link" onClick={() => setSecret(null)}>I saved it</button></div>}
    <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
    <fieldset><legend>Scopes</legend>{ALL.map(s => <label key={s} className="check"><input type="checkbox" checked={scopes.includes(s)} onChange={e => setScopes(e.target.checked ? [...scopes, s] : scopes.filter(x => x !== s))} />{s}</label>)}<p className="muted small">trade:execute keys are disabled until live execution and unattended signing are verified.</p></fieldset>
    <button className="btn" onClick={create} disabled={!scopes.length}>Create key (30 days)</button>
    <State loading={d.loading} error={d.error} empty={!d.data?.length && 'No API keys.'}><table className="tbl dense"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Used</th><th>Expires</th><th /></tr></thead><tbody>{(d.data ?? []).map(k => <tr key={k.id}><td>{k.name}</td><td className="mono">{k.prefix}…</td><td className="small">{k.scopes.join(', ')}</td><td>{k.used}/{k.request_budget}</td><td>{k.revoked_at ? <span className="neg">revoked</span> : new Date(k.expires_at).toISOString().slice(0, 10)}</td><td>{!k.revoked_at && <button className="btn sm ghost" onClick={() => revoke(k.id)}>Revoke</button>}</td></tr>)}</tbody></table></State>
  </div>;
}
function Notifications({ refresh }: { refresh: () => void }) {
  const d = useApi<any[]>('/notifications', [], 8000);
  const read = async () => { await api('/notifications/read', { method: 'POST', body: {} }); d.reload(true); refresh(); };
  return <div className="panel pad"><div className="row"><h3 className="grow">In-app notifications</h3><button className="btn sm ghost" onClick={read}>Mark all read</button></div>
    <State loading={d.loading} error={d.error} empty={!d.data?.length && 'No notifications yet.'}><ul className="plain notif">{(d.data ?? []).map(n => <li key={n.id} className={cls(!n.read_at && 'unread', n.kind === 'unprotected' && 'neg')}><strong>{n.title}</strong><span>{n.body}</span><span className="muted small">{new Date(n.at).toISOString().slice(5, 19).replace('T', ' ')} · {n.destination} · {n.delivery}</span></li>)}</ul></State>
    <p className="muted small">Telegram / browser push: not configured.</p></div>;
}
const AccountInfo = ({ me }: { me: any }) => <div className="panel pad"><dl className="kv"><dt>User</dt><dd>{me.user.display}</dd><dt>Type</dt><dd>{me.user.kind}</dd><dt>Verified wallets</dt><dd>{me.identities.length ? me.identities.map((i: any) => `${i.chain}:${short(i.address, 6)}`).join(', ') : 'none (demo)'}</dd><dt>Session</dt><dd>HttpOnly cookie, SameSite=Strict, CSRF protected</dd></dl></div>;

// ---------------- Status (M16) ----------------
export function Status() {
  const s = useApi<any>('/status', [], 5000); const c = useApi<any>('/capabilities', []);
  return <div className="page status narrow-page"><div className="page-head"><h1>Status</h1><span className="muted small">{s.data ? `v${s.data.version} · demo clock ${s.data.demoClock.slice(0, 19).replace('T', ' ')}` : ''}</span></div>
    <State loading={s.loading} error={s.error} onRetry={() => s.reload()}>{s.data && <>
      <div className="svc-grid">{s.data.services.map((x: any) => <div key={x.id} className="svc"><span className={cls('led', x.status === 'up' ? 'ok' : x.status === 'simulated' ? 'sim' : 'warn')} /><strong>{x.id}</strong><span className="muted">{x.status}{x.lastHeartbeatMsAgo != null ? ` · ${Math.round(x.lastHeartbeatMsAgo / 1000)}s ago` : ''}</span></div>)}</div>
      <p className="muted small">Outbox backlog {s.data.queues.outboxBacklog} · uncertain orders {s.data.queues.uncertainOrders} · incidents: {s.data.incidents.length || 'none'}</p>
    </>}</State>
    <State loading={c.loading} error={c.error}>{c.data && <>
      <h2>Chains</h2><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Chain</th><th>Demo</th><th>Paper</th><th>Live read</th><th>Live trade</th></tr></thead><tbody>{c.data.chains.map((x: any) => <tr key={x.chain}><td>{x.label}</td><td className="pos">{x.demo}</td><td className="pos">{x.paper}</td><td className="warn">{x.liveRead}</td><td className="warn">{x.liveTrade}</td></tr>)}</tbody></table></div>
      <h2>Providers</h2><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Provider</th><th>Interface</th><th>Status</th><th>Needs / reason</th></tr></thead><tbody>{c.data.providers.map((p: any) => <tr key={p.id}><td>{p.id}</td><td className="small">{p.interface}</td><td className={p.status === 'available' ? 'pos' : 'warn'}>{p.status}</td><td className="small">{p.reason ?? ''}{p.envVars?.length ? ` · env: ${p.envVars.join(', ')}` : ''}</td></tr>)}</tbody></table></div>
      <h2>Paper execution model</h2><pre className="code">{JSON.stringify(c.data.paperModel, null, 2)}</pre>
    </>}</State></div>;
}

// ---------------- Up/Down (M08), Perpetuals (M09) ----------------
export function UpDown() {
  const d = useApi<any>('/up-down', []);
  return <div className="page narrow-page"><div className="page-head"><h1>Up/Down</h1></div><div className="state blocked"><I.lock /><h2>Integration not available</h2><p>{d.data?.reason ?? 'Loading…'}</p><p className="muted">To enable: a documented product contract (market definition, settlement source, eligibility and jurisdiction rules) from a licensed provider.</p><Link className="link" to="/status">Status</Link></div></div>;
}
export function Perpetuals() {
  const [layout, setLayout] = useState('news'); const [busy, setBusy] = useState(false);
  const tryOrder = async () => { setBusy(true); try { await api('/derivatives/intents', { method: 'POST', body: {} }); } catch (e) { toast(errMsg(e), 'warn'); } finally { setBusy(false); } };
  return <div className="page perps"><div className="subbar"><h1 className="h-inline">Perpetual <sup className="beta">β</sup></h1><Seg label="Layout" items={[{ id: 'news', label: 'News' }, { id: 'classic', label: 'Classic' }]} value={layout} onChange={setLayout} /></div>
    <div className={cls('perps-grid', layout)}>
      {layout === 'news' && <section className="panel"><div className="panel-bar"><strong>News</strong></div><div className="state"><p>News needs a licensed news provider (e.g. 6551 OpenNews). Not configured — no headlines are fabricated.</p></div></section>}
      <section className="panel"><div className="panel-bar"><strong>Market</strong><span className="muted small">venue: none selected</span></div><div className="state"><I.chart /><p>No derivatives venue configured, so JGG shows no perpetual prices, funding, or liquidation data.</p></div></section>
      <section className="panel pad"><h3>Order</h3>
        <Seg label="Side" items={[{ id: 'long', label: 'Long' }, { id: 'short', label: 'Short' }]} value="long" onChange={() => {}} />
        <label className="field"><span>Leverage</span><input disabled value="—" /></label><label className="field"><span>Margin</span><input disabled value="—" /></label>
        <button className="btn" disabled={busy} onClick={tryOrder}>Preview order</button>
        <p className="muted small">Requires a selected venue with verified API, jurisdiction/eligibility checks, and a separate derivatives risk budget. Spot budgets never cover perps.</p></section>
    </div></div>;
}

// ---------------- Launch / Cooking (M10) ----------------
export function Launch() {
  const { me } = useApp(); const hist = useApi<any[]>(me ? '/launch-intents' : null, [me?.user.id]);
  const [f, setF] = useState<any>({ launchpad: 'pumpfun', name: '', symbol: '', description: '', website: '', twitter: '', initialBuy: '', buyTaxBps: '', sellTaxBps: '' });
  const [review, setReview] = useState<any>(null); const [busy, setBusy] = useState(false);
  const isTax = String(f.launchpad).endsWith('_tax');
  async function validate() {
    if (!me) return toast('Sign in first', 'warn');
    setBusy(true);
    try {
      const w = (await api<any[]>('/wallets')).find(x => x.chain === (['fourmeme', 'fourmeme_tax', 'flap_tax'].includes(f.launchpad) ? 'bsc' : f.launchpad === 'clanker' ? 'base' : 'solana'));
      const body: any = { launchpad: f.launchpad, name: f.name, symbol: f.symbol, description: f.description, walletId: w.id };
      for (const k of ['website', 'twitter', 'initialBuy']) if (f[k]) body[k] = f[k];
      if (isTax) { body.buyTaxBps = Number(f.buyTaxBps || 0); body.sellTaxBps = Number(f.sellTaxBps || 0); }
      setReview(await api('/launch-intents', { method: 'POST', body })); hist.reload(true);
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  async function submit() { try { await api(`/launch-intents/${review.launchIntentId}/submit`, { method: 'POST', body: {} }); } catch (e) { toast(errMsg(e), 'warn'); } }
  return <div className="page launch narrow-page"><div className="page-head"><h1>Cooking</h1><span className="muted">Token launch workspace — validate &amp; review only in this build</span></div>
    <div className="launch-grid"><div className="panel pad form">
      <label className="field"><span>Launchpad</span><select value={f.launchpad} onChange={e => setF({ ...f, launchpad: e.target.value })}><option value="pumpfun">Pump.fun (Solana)</option><option value="pumpfun_special">Pump.fun special modes (unverified)</option><option value="fourmeme">FourMeme (BSC)</option><option value="fourmeme_tax">FourMeme tax token (BSC)</option><option value="flap_tax">Flap tax token (BSC, unverified)</option><option value="clanker">Clanker (Base)</option></select></label>
      <label className="field"><span>Name</span><input maxLength={32} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Symbol</span><input maxLength={10} value={f.symbol} onChange={e => setF({ ...f, symbol: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} /></label>
      <label className="field"><span>Description</span><textarea maxLength={500} rows={3} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      <label className="field"><span>Website (https)</span><input value={f.website} onChange={e => setF({ ...f, website: e.target.value })} /></label>
      <label className="field"><span>X link</span><input value={f.twitter} onChange={e => setF({ ...f, twitter: e.target.value })} /></label>
      <label className="field"><span>Initial buy (optional)</span><input value={f.initialBuy} onChange={e => setF({ ...f, initialBuy: e.target.value })} /></label>
      {isTax && <div className="row gap"><label className="field"><span>Buy tax (bps)</span><input value={f.buyTaxBps} onChange={e => setF({ ...f, buyTaxBps: e.target.value.replace(/\D/g, '') })} /></label><label className="field"><span>Sell tax (bps)</span><input value={f.sellTaxBps} onChange={e => setF({ ...f, sellTaxBps: e.target.value.replace(/\D/g, '') })} /></label></div>}
      <button className="btn" disabled={busy} onClick={validate}>Validate &amp; review</button></div>
      <div className="panel pad">{review ? <>
        <h3>Review — {review.state}</h3>
        {review.review.issues.length ? <ul className="neg">{review.review.issues.map((i: string) => <li key={i}>{i}</li>)}</ul> : <p className="pos">Configuration valid.</p>}
        <h4>Irreversible</h4><ul>{review.review.irreversible.map((i: string) => <li key={i}>{i}</li>)}</ul>
        <p className="note warn">{review.review.blocker}</p>
        <button className="btn danger" onClick={submit}>Submit launch</button><p className="muted small">Submission returns CAPABILITY_BLOCKED until a verified adapter + signer exist and launches are authorized.</p>
      </> : <div className="state"><I.pot /><p>Fill the form and validate. JGG shows every irreversible field before anything could be submitted.</p></div>}</div></div>
    <h2>History</h2><State loading={hist.loading} error={hist.error} empty={!hist.data?.length && 'No launch drafts.'} signedOut={!me}><table className="tbl dense"><thead><tr><th>When</th><th>Launchpad</th><th>Name</th><th>State</th></tr></thead><tbody>{(hist.data ?? []).map(l => <tr key={l.id}><td>{new Date(l.created_at).toISOString().slice(5, 16).replace('T', ' ')}</td><td>{l.launchpad}</td><td>{l.config.name} (${l.config.symbol})</td><td>{l.state}</td></tr>)}</tbody></table></State>
  </div>;
}

// ---------------- Trading wallet (custody, real funds) ----------------
const GATE_TEXT: Record<string, string> = {
  LIVE_TRADING_DISABLED: 'Live trading is switched off on this server (JGG_LIVE_TRADING).', NO_CUSTODY_MASTER_KEY: 'Server has no custody master key configured.',
  NO_SOLANA_RPC: 'Server has no Solana RPC configured.', NO_JUPITER_KEY: 'Server has no Jupiter API key configured.', NO_ALLOWED_WALLETS: 'Server has no allow-listed wallets.',
  SIGN_IN_WITH_WALLET_REQUIRED: 'Sign in with your Solana wallet (Phantom). Demo accounts can never hold real funds.', WALLET_NOT_ALLOWLISTED: 'Your sign-in wallet is not on this server\'s allow-list.',
  NO_TRADING_WALLET: 'Create your trading wallet below.' };
function TradingWallet({ refresh }: { refresh: () => void }) {
  const { openAuth } = useApp(); const d = useApi<any>('/custody', [], 10000);
  const [amt, setAmt] = useState(''); const [confirmTxt, setConfirmTxt] = useState(''); const [busy, setBusy] = useState(false);
  const x = d.data;
  const create = async () => { if (!confirm('Create a JGG-held trading wallet? The server will hold its key (encrypted). Only deposit what you can afford to lose.')) return; try { await api('/custody/wallet', { method: 'POST', body: {} }); toast('Trading wallet created', 'ok'); d.reload(true); refresh(); } catch (e) { toast(errMsg(e), 'err'); } };
  const sync = async () => { try { await api('/custody/sync', { method: 'POST', body: {} }); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  const wd = async (all: boolean) => { setBusy(true); try { const r = await api('/custody/withdraw', { method: 'POST', body: { amountSol: all ? 'all' : amt, confirm: confirmTxt } }); toast(`Withdrawal ${r.status}: ${r.sol} SOL → your wallet`, r.status === 'failed' ? 'err' : 'ok'); setConfirmTxt(''); setAmt(''); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  return <State loading={d.loading} error={d.error} onRetry={() => d.reload()}>{x && <div className="panel pad form">
    <p className="note warn"><strong>Real money.</strong> The JGG server holds this wallet's key (AES-256-GCM encrypted). Every swap is simulated before signing and capped (max {x.limits?.maxTradeSol ?? '—'} SOL per trade, {x.limits?.maxDailySol ?? '—'} SOL per day). Withdrawals go only to your verified sign-in wallet. Meme coins can go to zero.</p>
    {!x.gate.ok && <ul className="plain">{x.gate.reasons.map((r: string) => <li key={r}><I.lock /> {GATE_TEXT[r] ?? r}{r === 'SIGN_IN_WITH_WALLET_REQUIRED' && <> <button className="link" onClick={openAuth}>Sign in with wallet</button></>}</li>)}</ul>}
    {x.address ? <>
      <h3>Deposit address (Solana, SOL only)</h3>
      <div className="row gap"><code className="grow break">{x.address}</code><Copy text={x.address} label="Copy deposit address" /></div>
      <p className="muted small">Send SOL from your own wallet. Tokens bought by JGG stay here until sold.</p>
      <div className="row gap"><h3 className="grow">Balances</h3><button className="btn sm ghost" onClick={sync} disabled={!x.serverConfigured}><I.refresh /> Refresh from chain</button></div>
      <table className="tbl dense"><tbody>{x.balances.map((b: any) => <tr key={b.asset}><td>{b.asset === 'SOL' ? 'SOL' : short(b.asset, 5)}</td><td className="r">{Number(b.qty).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td><td className="r muted small">{Number(b.reserved) > 0 ? `${b.reserved} reserved` : ''}</td></tr>)}</tbody></table>
      <h3>Withdraw SOL → {short(x.verifiedWallet, 6)}</h3>
      <div className="row gap wrap"><input inputMode="decimal" placeholder="Amount SOL" value={amt} onChange={e => setAmt(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Withdraw amount" />
        <input placeholder="Type WITHDRAW" value={confirmTxt} onChange={e => setConfirmTxt(e.target.value)} aria-label="Confirmation" />
        <button className="btn" disabled={busy || confirmTxt !== 'WITHDRAW' || !amt} onClick={() => wd(false)}>Withdraw</button>
        <button className="btn danger" disabled={busy || confirmTxt !== 'WITHDRAW'} onClick={() => wd(true)}>Withdraw all</button></div>
      <p className="muted small">Sell tokens to SOL first; token withdrawals are not supported yet.</p>
      {x.withdrawals.length > 0 && <table className="tbl dense"><tbody>{x.withdrawals.map((w: any) => <tr key={w.id}><td>{new Date(w.created_at).toISOString().slice(5, 16).replace('T', ' ')}</td><td className="r">{Number(w.lamports) / 1e9} SOL</td><td>{w.status}</td><td><a className="link" href={`https://solscan.io/tx/${w.signature}`} target="_blank" rel="noopener noreferrer">tx</a></td></tr>)}</tbody></table>}
      {x.liveOrders.length > 0 && <><h3>Live orders</h3><table className="tbl dense"><tbody>{x.liveOrders.map((o: any) => <tr key={o.id}><td className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side}</td><td className="mono">{short(o.token)}</td><td className="r">{o.amount_in}</td><td>{o.state.replace(/_/g, ' ')}</td><td>{o.signature ? <a className="link" href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noopener noreferrer">tx</a> : o.exec_status ?? ''}</td></tr>)}</tbody></table></>}
    </> : x.gate.reasons.every((r: string) => r === 'NO_TRADING_WALLET') && <button className="btn" onClick={create}>Create my trading wallet</button>}
  </div>}</State>;
}
