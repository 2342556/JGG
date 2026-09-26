import { useState } from 'react';
import { Link, useQueryState, useRouter } from '../router.tsx';
import { api } from '../api.ts';
import { useApp, useApi, State, Tabs, Seg, I, usd, short, cls, signCls, toast, errMsg, SimTag, Copy, price, pct } from '../lib.tsx';
import { CopyDrawer } from './Token.tsx';

const PODIUM = ['🥇', '🥈', '🥉'];
const CT_TABS = [{ id: 'rank', label: 'Rank' }, { id: 'callers', label: 'TopCallers' }, { id: 'radar', label: 'Radar' }, { id: 'walletcopy', label: 'WalletCopy' }, { id: 'skyeye', label: 'SkyEyeCopy' }, { id: 'devsnipe', label: 'Dev Snipe' }, { id: 'tokensnipe', label: 'Token Snipe' }, { id: 'snipex', label: 'SnipeX' }];

export function CopyTrade({ tab }: { tab: string }) {
  const { chain } = useApp(); const { nav } = useRouter();
  return <div className="page copytrade">
    <h1 className="sr-only">CopyTrade</h1>
    <div className="subbar"><Tabs big label="CopyTrade views" value={tab as any} onChange={v => nav(`/copy-trade/${v}${location.search}`)} items={CT_TABS} /><div className="grow" /><SimTag /></div>
    {tab === 'rank' ? <Rank chain={chain} /> : tab === 'callers' ? <Callers chain={chain} /> : tab === 'radar' ? <Radar chain={chain} /> : tab === 'walletcopy' ? <MyCopyTasks kind="copy" chain={chain} /> : tab === 'skyeye' ? <Blocked what="SkyEyeCopy" why="The reference shows only the tab label. Its source universe and rules are unverified, so JGG does not invent a copy product. Use WalletCopy for addresses you choose." />
      : tab === 'devsnipe' ? <SnipeForm kind="dev_snipe" chain={chain} /> : tab === 'tokensnipe' ? <SnipeForm kind="token_snipe" chain={chain} /> : <Blocked what="SnipeX" why="SnipeX semantics are not specified beyond the S11 tab label; JGG will not invent them (spec §0.4). The API returns CAPABILITY_BLOCKED." />}
  </div>;
}
const Blocked = ({ what, why }: { what: string; why: string }) => <div className="state blocked"><I.lock /><h2>{what} — not available</h2><p>{why}</p><Link to="/status" className="link">Capability status</Link></div>;

function Rank({ chain }: { chain: string }) {
  const { dataSource } = useApp();
  const [period, setPeriod] = useQueryState('period', '7d'); const [cat, setCat] = useQueryState('cat', 'all'); const [copy, setCopy] = useState<string | null>(null);
  const d = useApi<any>(`/rank?chain=${chain}&period=${period}&category=${cat}`, [chain, period, cat]);
  const x = d.data?.data;
  return <>
    <div className="subbar"><Seg label="Category" items={dataSource === 'solana_live' ? [{ id: 'all', label: 'All' }, { id: 'smart_money', label: 'Smart money' }, { id: 'fomo', label: 'FOMO traders' }] : [{ id: 'all', label: 'All' }, { id: 'smart_money', label: 'Smart money' }, { id: 'kol', label: 'KOL' }, { id: 'sniper', label: 'Sniper' }, { id: 'fresh', label: 'Fresh' }, { id: 'launchpad_sm', label: 'Launchpad SM' }]} value={cat} onChange={setCat} /><div className="grow" /><Seg label="Period" items={['1d', '7d', '30d']} value={period} onChange={setPeriod} /></div>
    <State loading={d.loading} error={d.error} onRetry={() => d.reload()} rows={12}>{x && <>
      <div className="table-wrap"><table className="tbl rank"><caption className="sr-only">Wallet rank by realized P&amp;L, {period}</caption>
        <thead><tr><th>#</th><th>Wallet</th><th className="r">Realized P&amp;L</th><th className="r">Win rate</th><th className="r">Trades</th><th className="r">Balance</th><th className="r">Copy</th></tr></thead>
        <tbody>{x.rows.map((r: any, i: number) => <tr key={r.address} className={i < 3 ? `podium p${i + 1}` : ''}>
          <td>{i < 3 ? <span aria-label={`Rank ${i + 1}`}>{PODIUM[i]}</span> : i + 1}</td>
          <td><Link to={`/wallet/${chain}/${r.address}`} className="tok"><span className="avatar round sm" style={{ background: `hsl(${r.hue} 40% 22%)` }} aria-hidden="true">{r.name.slice(0, 1)}</span><span><strong>{r.name}</strong> {r.labels.map((l: string) => <span key={l} className="b">{l}</span>)}<br /><span className="mono muted small">{short(r.address, 5)}</span></span></Link></td>
          <td className={cls('r', signCls(Number(r.realizedPnlUsd)))}>{usd(r.realizedPnlUsd)}</td>
          <td className="r">{r.winRate === null ? '—' : `${r.winRate}%`}<br /><span className="muted small">{r.winRateDenominator ?? ''} closed</span></td>
          <td className="r">{r.trades ?? '—'}</td><td className="r">{r.nativeBalance}</td>
          <td className="r"><button className="btn sm" onClick={() => setCopy(r.address)}>Copy</button></td></tr>)}</tbody></table></div>
      <p className="muted small pad">{x.method} Interval {x.interval.from.slice(0, 10)} → {x.interval.to.slice(0, 10)}. Place markers reflect this ranking only, not verified winners.</p>
    </>}</State>
    {copy && <CopyDrawer open onClose={() => setCopy(null)} chain={chain} source={copy} />}
  </>;
}

function Callers({ chain }: { chain: string }) {
  const d = useApi<any>(`/signals/callouts?chain=${chain}`, [chain], 10000); const rows = d.data?.data ?? [];
  return <State loading={d.loading} error={d.error} empty={!rows.length && 'No callouts.'}><div className="table-wrap"><table className="tbl"><thead><tr><th>Caller</th><th>Token</th><th>Called</th><th className="r">Price at call</th><th className="r">Observed move</th></tr></thead>
    <tbody>{rows.map((c: any, i: number) => <tr key={i}><td>{c.caller}</td><td><Link className="link" to={`/token/${chain}/${c.token}`}>{c.symbol}</Link></td><td>{c.calledAt.slice(11, 16)}</td><td className="r">{price(c.priceAtCall)}</td><td className={cls('r', signCls(c.observedChangeBps))}>{pct(c.observedChangeBps)}</td></tr>)}</tbody></table>
    <p className="muted small pad">Observed post-call price move — not what a follower could have executed. Callers are fixture identities.</p></div></State>;
}

function Radar({ chain }: { chain: string }) {
  const [side, setSide] = useState('buy'); const [win, setWin] = useState('1h');
  const d = useApi<any>(`/signals/cluster?chain=${chain}&side=${side}&minWallets=2&window=${win}`, [chain, side, win], 8000); const rows = d.data?.data ?? [];
  return <><div className="subbar"><Seg label="Side" items={[{ id: 'buy', label: 'Buying' }, { id: 'sell', label: 'Exiting' }]} value={side} onChange={setSide} /><Seg label="Window" items={['15m', '1h', '6h']} value={win} onChange={setWin} /></div>
    <State loading={d.loading} error={d.error} empty={!rows.length && 'No token had 2+ smart wallets on this side in the window.'}><div className="radar-grid">{rows.map((r: any) => <Link key={r.token} to={`/token/${chain}/${r.token}`} className="radar-card"><strong>{r.symbol}</strong><span className="big">{r.distinctWallets}</span><span className="muted small">smart wallets {side === 'buy' ? 'bought' : 'sold'} · {win}</span></Link>)}</div>
    <p className="muted small pad">{rows[0]?.assumption ?? 'Distinct addresses; common ownership not inferred.'}</p></State></>;
}

export function MyCopyTasks({ kind, chain }: { kind: string; chain: string }) {
  const { me } = useApp(); const d = useApi<any[]>(me ? '/strategies' : null, [me?.user.id], 5000); const [src, setSrc] = useState(''); const [open, setOpen] = useState(false);
  if (!me) return <State signedOut />;
  const rows = (d.data ?? []).filter(s => s.kind === kind);
  return <div className="pad">
    <div className="row gap"><input className="grow" placeholder="Source wallet address to copy" value={src} onChange={e => setSrc(e.target.value.trim())} aria-label="Source wallet" /><button className="btn" disabled={!src} onClick={() => setOpen(true)}>Set up copy</button></div>
    <State loading={d.loading} error={d.error} empty={!rows.length && 'No copy tasks yet. Pick a wallet from Rank or paste an address.'}><Tasks rows={rows} reload={() => d.reload(true)} /></State>
    {open && <CopyDrawer open onClose={() => { setOpen(false); d.reload(true); }} chain={chain} source={src} />}
  </div>;
}
export function Tasks({ rows, reload }: { rows: any[]; reload: () => void }) {
  const act = async (id: string, a: string) => { try { await api(`/strategies/${id}/${a}`, { method: 'POST', body: {} }); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  return <div className="table-wrap"><table className="tbl dense"><thead><tr><th>Kind</th><th>Token / source</th><th>State</th><th>Last events</th><th className="r">Actions</th></tr></thead><tbody>{rows.map(s => <tr key={s.id}>
    <td><span className="b">{s.kind}</span> <span className="muted small">{s.mode}</span></td>
    <td>{s.symbol ?? short(s.params.sourceWallet ?? s.params.creatorWallet ?? s.token ?? '', 5)}</td>
    <td className={s.lifecycle === 'active' ? 'pos' : s.lifecycle === 'failed' ? 'neg' : ''}>{s.lifecycle}{s.reason ? <span className="muted small"> · {s.reason}</span> : null}</td>
    <td className="small muted">{s.events.slice(0, 3).map((e: any) => e.kind).join(', ')}</td>
    <td className="r">{s.lifecycle === 'draft' && <button className="btn sm" onClick={() => act(s.id, 'activate')}>Activate</button>}{s.lifecycle === 'active' && <button className="btn sm ghost" onClick={() => act(s.id, 'pause')}>Pause</button>}{s.lifecycle === 'paused' && <button className="btn sm" onClick={() => act(s.id, 'resume')}>Resume</button>}{!['cancelled', 'completed', 'expired', 'failed'].includes(s.lifecycle) && <button className="btn sm ghost" onClick={() => act(s.id, 'cancel')}>Cancel</button>}</td>
  </tr>)}</tbody></table></div>;
}

function SnipeForm({ kind, chain }: { kind: 'dev_snipe' | 'token_snipe'; chain: string }) {
  const { me } = useApp(); const [target, setTarget] = useState(''); const [amount, setAmount] = useState('0.05'); const [busy, setBusy] = useState(false);
  if (!me) return <State signedOut />;
  async function go() {
    setBusy(true);
    try { const w = (await api<any[]>('/wallets')).find(x => x.chain === chain && x.custody === 'paper');
      const s = await api('/strategies', { method: 'POST', body: { kind, chain, walletId: w.id, ...(kind === 'token_snipe' ? { tokenAddress: target } : {}), params: { amount, ...(kind === 'dev_snipe' ? { creatorWallet: target } : {}) } } });
      await api(`/strategies/${s.id}/activate`, { method: 'POST', body: {} }); toast('Snipe armed (paper).', 'ok'); setTarget('');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return <div className="pad narrow">
    <h2>{kind === 'dev_snipe' ? 'Dev Snipe' : 'Token Snipe'} <span className="muted small">paper</span></h2>
    <p className="muted">{kind === 'dev_snipe' ? 'Buys the next token created by a creator wallet after you arm it.' : 'Buys a token as soon as it exists / has a price.'} Honest caveat: in Demo/Paper this fires on fixture launches; live sniping needs a verified launch feed + signer.</p>
    <label className="field"><span>{kind === 'dev_snipe' ? 'Creator wallet' : 'Token address'}</span><input value={target} onChange={e => setTarget(e.target.value.trim())} /></label>
    <label className="field"><span>Amount</span><input value={amount} onChange={e => setAmount(e.target.value)} /></label>
    <button className="btn buy" disabled={busy || !target} onClick={go}>Arm snipe</button>
    <MyCopyTasks kind={kind} chain={chain} />
  </div>;
}

// ---------------- Monitor (M04) ----------------
export function Monitor() {
  const { chain, me } = useApp(); const [tab, setTab] = useQueryState('tab', 'smart');
  const path = tab === 'smart' ? `/signals/label_trades?chain=${chain}&label=smart_money` : tab === 'fomo' ? `/signals/label_trades?chain=${chain}&label=fomo` : tab === 'kol' ? `/signals/label_trades?chain=${chain}&label=kol` : tab === 'cluster' ? `/signals/cluster?chain=${chain}&minWallets=2` : tab === 'exit' ? `/signals/cluster?chain=${chain}&minWallets=2&side=sell` : tab === 'surge' ? `/signals/surge?chain=${chain}&minChangeBps=1000` : tab === 'claims' ? `/signals/claims?chain=${chain}` : tab === 'callouts' ? `/signals/callouts?chain=${chain}` : null;
  const d = useApi<any>(path, [path], 6000); const rows = d.data?.data ?? [];
  return <div className="page monitor">
    <h1 className="sr-only">Monitor</h1>
    <div className="subbar"><Tabs big label="Signal types" value={tab as any} onChange={setTab} items={[{ id: 'smart', label: 'Smart Money' }, { id: 'fomo', label: 'FOMO traders' }, { id: 'kol', label: 'KOL' }, { id: 'cluster', label: 'Buy clusters' }, { id: 'exit', label: 'Exits' }, { id: 'surge', label: 'Surge' }, { id: 'claims', label: 'Claims' }, { id: 'callouts', label: 'Callouts' }, { id: 'rules', label: 'My rules' }]} /><div className="grow" /><SimTag /></div>
    {tab === 'rules' ? (me ? <Rules /> : <State signedOut />) :
      <State loading={d.loading} error={d.error} onRetry={() => d.reload()} empty={!rows.length && 'No events in this window.'} rows={10}><ul className="signal-list">{rows.slice(0, 80).map((x: any, i: number) => <li key={x.eventId ?? x.token + i}>
        {x.eventId ? <><span className={cls('side', x.side)}>{x.side}</span><Link className="link" to={`/wallet/${chain}/${x.wallet}`}>{x.walletName ?? short(x.wallet)}</Link><span>{x.side === 'buy' ? 'bought' : 'sold'} {usd(x.amountUsd)} of</span><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span className="muted small">{new Date(x.ts).toISOString().slice(11, 19)}</span></>
          : x.distinctWallets ? <><I.users /><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span>{x.distinctWallets} smart wallets {x.side === 'buy' ? 'bought' : 'sold'} within the window</span></>
          : x.changeBps !== undefined ? <><I.fire /><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span className="pos">{pct(x.changeBps)} vs 5m ago</span><span className="muted small">risk {x.risk}</span></>
          : x.beneficiary ? <><I.dollar /><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span>{x.type}: {x.amount}</span><span className="mono muted small">{short(x.beneficiary)}</span></>
          : <><I.mega /><span>{x.caller}</span><span>called</span><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span className={signCls(x.observedChangeBps)}>{pct(x.observedChangeBps)} since</span></>}
      </li>)}</ul></State>}
  </div>;
}

function Rules() {
  const { chain } = useApp(); const d = useApi<any[]>('/alerts', [], 8000);
  const [f, setF] = useState({ name: 'Watchlist swing', kind: 'price_swing', thresholdBps: '1000', windowSec: '300', cooldownSec: '600' });
  async function add() { try { await api('/alerts', { method: 'POST', body: { name: f.name, chain, kind: f.kind, thresholdBps: Number(f.thresholdBps), windowSec: Number(f.windowSec), cooldownSec: Number(f.cooldownSec), destination: 'in_app' } }); d.reload(true); toast('Rule saved', 'ok'); } catch (e) { toast(errMsg(e), 'err'); } }
  const del = async (id: string) => { try { await api(`/alerts/${id}`, { method: 'DELETE' }); d.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  return <div className="pad">
    <div className="form-row">
      <label className="field"><span>Name</span><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Kind</span><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}><option value="price_swing">Watchlist price swing</option><option value="smart_buy_cluster">Smart buy cluster</option><option value="smart_exit">Smart exit</option><option value="surge">Surge</option><option value="wallet_trade">Tracked wallet trade</option><option value="dev_sell">Dev sell</option></select></label>
      <label className="field"><span>Threshold (bps)</span><input value={f.thresholdBps} onChange={e => setF({ ...f, thresholdBps: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field"><span>Window (s)</span><input value={f.windowSec} onChange={e => setF({ ...f, windowSec: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field"><span>Cooldown (s)</span><input value={f.cooldownSec} onChange={e => setF({ ...f, cooldownSec: e.target.value.replace(/\D/g, '') })} /></label>
      <button className="btn" onClick={add}>Add rule</button>
    </div>
    <p className="muted small">Delivery: in-app. Telegram and browser push need a bot token / VAPID keys (not configured).</p>
    <State loading={d.loading} error={d.error} empty={!d.data?.length && 'No rules yet.'}><div className="table-wrap"><table className="tbl dense"><thead><tr><th>Rule</th><th>Kind</th><th>Last fired</th><th>Delivery log</th><th /></tr></thead><tbody>{(d.data ?? []).map(a => <tr key={a.id}><td>{a.config.name}</td><td>{a.config.kind}</td><td>{a.last_fired ? new Date(a.last_fired).toISOString().slice(11, 19) : '—'}</td><td className="small">{a.events.slice(0, 3).map((e: any) => e.title).join(' · ') || '—'}</td><td className="r"><button className="icon-btn sm" aria-label="Delete rule" onClick={() => del(a.id)}><I.trash /></button></td></tr>)}</tbody></table></div></State>
  </div>;
}

// ---------------- Track (M05) ----------------
export function Track() {
  const { chain, me } = useApp(); const [tab, setTab] = useQueryState('tab', 'track');
  const tracked = useApi<any[]>(me ? '/tracked-wallets' : null, [me?.user.id]);
  const [addr, setAddr] = useState(''); const [nick, setNick] = useState('');
  const feedPath = tab === 'track' ? (me ? `/signals/wallet_trades?chain=${chain}` : null) : tab === 'smart' ? `/signals/label_trades?chain=${chain}&label=smart_money` : tab === 'kol' ? `/signals/label_trades?chain=${chain}&label=kol` : null;
  const feed = useApi<any>(feedPath, [feedPath], 4000);
  async function add() { try { await api('/tracked-wallets', { method: 'POST', body: { chain, address: addr, nickname: nick || undefined } }); setAddr(''); setNick(''); tracked.reload(true); toast('Tracking wallet', 'ok'); } catch (e) { toast(errMsg(e), 'err'); } }
  const mute = async (w: any) => { try { await api(`/tracked-wallets/${w.chain}/${w.address}`, { method: 'PATCH', body: { muted: !w.muted } }); tracked.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  const rm = async (w: any) => { try { await api(`/tracked-wallets/${w.chain}/${w.address}`, { method: 'DELETE' }); tracked.reload(true); } catch (e) { toast(errMsg(e), 'err'); } };
  const rows = feed.data?.data ?? [];
  return <div className="page track">
    <h1 className="sr-only">Track</h1>
    <div className="subbar"><Tabs big label="Tracker" value={tab as any} onChange={setTab} items={[{ id: 'track', label: 'Track' }, { id: 'smart', label: 'Smart' }, { id: 'kol', label: 'KOL' }, { id: 'skyeye', label: 'SkyEye' }, { id: 'social', label: 'X / TG' }]} /><div className="grow" /><SimTag /></div>
    {tab === 'skyeye' ? <Blocked what="SkyEye" why="SkyEye's wallet universe is not defined in the references; JGG will not invent one. Smart and KOL tabs use disclosed fixture labels." />
      : tab === 'social' ? <Blocked what="Social tracker" why="Needs an authorized X API / 6551 OpenTwitter key or a Telegram bot token. Not configured." />
      : <div className="track-split">
        <section className="panel"><div className="panel-bar"><strong>Feed</strong></div>
          {tab === 'track' && !me ? <State signedOut /> : <State loading={feed.loading} error={feed.error} empty={!rows.length && (tab === 'track' ? 'No trades from tracked wallets in the last hour.' : 'No trades.')}><ul className="signal-list">{rows.slice(0, 100).map((x: any) => <li key={x.eventId}><span className={cls('side', x.side)}>{x.side}</span><Link className="link" to={`/wallet/${chain}/${x.wallet}`}>{x.walletName ?? short(x.wallet)}</Link><span>{usd(x.amountUsd)}</span><Link className="link strong" to={`/token/${chain}/${x.token}`}>{x.symbol}</Link><span className="muted small">{new Date(x.ts).toISOString().slice(11, 19)}</span></li>)}</ul></State>}
        </section>
        <section className="panel"><div className="panel-bar"><strong>Tracked wallets</strong> <span className="muted small">{tracked.data?.length ?? 0}/500</span></div>
          {!me ? <State signedOut /> : <div className="pad">
            <div className="row gap wrap"><input placeholder="Wallet address" value={addr} onChange={e => setAddr(e.target.value.trim())} aria-label="Wallet address" className="grow" /><input placeholder="Nickname" value={nick} onChange={e => setNick(e.target.value)} aria-label="Nickname" /><button className="btn" disabled={!addr} onClick={add}>Track</button></div>
            <State loading={tracked.loading} error={tracked.error} empty={!tracked.data?.length && 'Not tracking any wallets yet.'}><ul className="plain">{(tracked.data ?? []).filter(w => w.chain === chain).map(w => <li key={w.address} className="row gap"><Link className="link grow" to={`/wallet/${w.chain}/${w.address}`}>{w.nickname ?? short(w.address, 6)}</Link><Copy text={w.address} /><button className={cls('icon-btn sm', w.muted && 'on')} aria-pressed={!!w.muted} aria-label={w.muted ? 'Unmute' : 'Mute'} onClick={() => mute(w)}><I.mute /></button><button className="icon-btn sm" aria-label="Stop tracking" onClick={() => rm(w)}><I.trash /></button></li>)}</ul></State>
          </div>}
        </section>
      </div>}
  </div>;
}
