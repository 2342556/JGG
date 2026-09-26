import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useRouter } from '../router.tsx';
import { api } from '../api.ts';
import { MARK_PATH, MARK_W, MARK_H, BRAND_BG, BRAND_FG } from '../brand.ts';
import { useApp, useApi, I, CHAINS, CHAIN_LABEL, ModeBadge, cls, short, usd, age, useSlashFocus, Drawer, Tabs, State, toast, errMsg, useTicks, TokenAvatar } from '../lib.tsx';

export const Logo = ({ size = 30 }: { size?: number }) => <Link to="/trenches" className="logo" aria-label="JGG home"><BrandMark size={size} /></Link>;

/** The owner's JGG monogram, white on black — same path as favicon and PWA icons (brand.ts). */
export function BrandMark({ size = 30 }: { size?: number }) {
  const s = 76 / MARK_W;
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <rect width="100" height="100" rx="22" fill={BRAND_BG} />
    <path transform={`translate(${(100 - MARK_W * s) / 2} ${(100 - MARK_H * s) / 2}) scale(${s})`} fill={BRAND_FG} d={MARK_PATH} />
  </svg>;
}

const NAV = [['/trenches', 'Trenches'], ['/auto', 'Auto'], ['/trending', 'Trending'], ['/copy-trade/rank', 'CopyTrade'], ['/monitor', 'Monitor'], ['/track', 'Track'], ['/portfolio', 'Portfolio'], ['/rewards', 'Rewards'], ['/up-down', 'Up/Down'], ['/perpetuals', 'Perpetual']] as const;

function Search() {
  const ref = useRef<HTMLInputElement>(null); useSlashFocus(ref);
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const [res, setRes] = useState<any[] | null>(null); const [err, setErr] = useState<string | null>(null); const [hi, setHi] = useState(0);
  const { chain } = useApp(); const { nav } = useRouter();
  useEffect(() => { if (!q.trim()) { setRes(null); return; } const t = setTimeout(async () => { try { const r = await api(`/search?q=${encodeURIComponent(q)}&chain=${chain}`); setRes(r.data); setErr(null); setHi(0); } catch (e) { setErr(errMsg(e)); } }, 180); return () => clearTimeout(t); }, [q, chain]);
  const go = (x: any) => { setOpen(false); setQ(''); nav(x.type === 'token' ? `/token/${x.chain}/${x.address}` : `/wallet/${x.chain}/${x.address}`); };
  return <div className="search" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
    <I.search /><input ref={ref} value={q} placeholder="Search token / address" aria-label="Search tokens and wallets (press /)" role="combobox" aria-expanded={open && !!res} aria-controls="search-results"
      onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true); }}
      onKeyDown={e => { if (!res?.length) return; if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, res.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); } if (e.key === 'Enter') go(res[hi]); if (e.key === 'Escape') setOpen(false); }} />
    <kbd>/</kbd>
    {open && (res || err) && <div className="search-pop" id="search-results" role="listbox">
      {err && <p className="muted pad">{err}</p>}
      {res && !res.length && <p className="muted pad">No match. Paste a full contract or wallet address for exact lookup.</p>}
      {res && res.length > 1 && res.filter(r => r.type === 'token').some((r, _i, a) => a.filter(x => x.symbol === r.symbol).length > 1) && <p className="note warn pad">Several tokens share a ticker — check chain and address before trading.</p>}
      {res?.map((x, i) => <button key={x.chain + x.address} role="option" aria-selected={i === hi} className={cls('search-row', i === hi && 'hi')} onMouseEnter={() => setHi(i)} onClick={() => go(x)}>
        <span className={`chain-tag ${x.chain}`}>{CHAIN_LABEL[x.chain]}</span>
        <span className="grow"><strong>{x.symbol ?? x.name}</strong> <span className="muted">{x.type === 'token' ? x.name : 'wallet'}</span><br /><span className="mono muted">{short(x.address, 6)}</span></span>
        {x.type === 'token' && <span className="muted">{usd(x.mcUsd)} · {age(x.ageSec)}</span>}{x.exact && <span className="pill-ok">exact</span>}
      </button>)}
    </div>}
  </div>;
}

function ChainPicker() {
  const { chain, setChain } = useApp(); const [open, setOpen] = useState(false);
  return <div className="menu-wrap" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
    <button className="chain-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={`Chain: ${chain}`} onClick={() => setOpen(!open)}><span className={`chain-dot static ${chain}`} />{CHAIN_LABEL[chain]}<I.chev /></button>
    {open && <div className="menu" role="listbox">{CHAINS.map(c => <button key={c} role="option" aria-selected={c === chain} onClick={() => { setChain(c); setOpen(false); }}><span className={`chain-dot static ${c}`} />{c === 'bsc' ? 'BNB Chain' : c[0].toUpperCase() + c.slice(1)}</button>)}</div>}
  </div>;
}

function Account() {
  const { me, openAuth, signOut } = useApp(); const [open, setOpen] = useState(false);
  if (!me) return <><button className="btn pill ghost hide-sm" onClick={openAuth}>Sign Up</button><button className="btn pill" onClick={openAuth}>Log In</button></>;
  return <div className="menu-wrap" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
    <button className="acct" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><I.user /><span className="hide-sm">{me.user.display}</span>{me.unreadNotifications > 0 && <span className="dot-badge" aria-label={`${me.unreadNotifications} unread`}>{me.unreadNotifications}</span>}</button>
    {open && <div className="menu right" role="menu">
      <div className="pad muted">Mode: <ModeBadge mode={me.settings.mode} /></div>
      <Link to="/portfolio" onClick={() => setOpen(false)}>Portfolio</Link><Link to="/settings" onClick={() => setOpen(false)}>Settings</Link><Link to="/settings?tab=notifications" onClick={() => setOpen(false)}>Notifications ({me.unreadNotifications})</Link>
      <button onClick={signOut}>Sign out</button>
    </div>}
  </div>;
}

export function TopNav({ onMenu }: { onMenu: () => void }) {
  const { me } = useApp();
  return <header className="topnav">
    <button className="icon-btn show-md" aria-label="Open menu" onClick={onMenu}><I.menu /></button>
    <Logo />
    <nav className="mainnav hide-md" aria-label="Primary">{NAV.map(([to, label]) => <Link key={to} to={to} className="navlink">{label}{label === 'Perpetual' && <sup className="beta">β</sup>}</Link>)}</nav>
    <div className="grow" />
    <Search />
    <Link to="/launch" className="navbtn hide-md" title="Cooking — token launch"><I.pot /><span className="hide-lg">Cooking</span></Link>
    <Link to="/ai" className="navbtn ai hide-sm" title="AI & API"><I.robot /><span>AI</span></Link>
    <ChainPicker />
    <Link to="/watchlist" className="icon-btn hide-sm" aria-label="Watchlist" title="Watchlist"><I.star /></Link>
    <Link to="/settings" className="icon-btn hide-sm" aria-label="Settings" title="Settings"><I.gear /></Link>
    {me && <ModeBadge mode={me.settings.mode} />}
    <Account />
  </header>;
}

export function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Drawer open={open} onClose={onClose} title="JGG menu">
    <nav className="mobile-menu" aria-label="All sections">{[...NAV, ['/launch', 'Cooking'], ['/ai', 'AI & Skills'], ['/watchlist', 'Watchlist'], ['/settings', 'Settings'], ['/status', 'Status']].map(([to, l]) => <Link key={to} to={to} onClick={onClose}>{l}</Link>)}</nav>
  </Drawer>;
}

export function MobileTabs() {
  return <nav className="mobile-tabs" aria-label="Main">
    {[['/trenches', 'Trenches', <I.fire />], ['/auto', 'Auto', <I.bolt />], ['/trending', 'Trending', <I.chart />], ['/ai', 'AI', <I.robot />], ['/portfolio', 'Portfolio', <I.wallet />]].map(([to, l, ic]) => <Link key={to as string} to={to as string}>{ic}<span>{l}</span></Link>)}
  </nav>;
}

// ---------------- Left dock (S01/S09): two resizable tracker panels ----------------
export function Dock({ onCollapse }: { onCollapse: () => void }) {
  const { chain, me } = useApp();
  const [tab, setTab] = useState<'wallet' | 'track' | 'callout' | 'monitor' | 'renames'>('wallet');
  const [split, setSplit] = useState(() => Number(localStorage.getItem('jgg.dockSplit') ?? 58));
  const box = useRef<HTMLDivElement>(null);
  const path = tab === 'wallet' ? (me ? `/signals/wallet_trades?chain=${chain}` : null) : tab === 'track' ? `/signals/label_trades?chain=${chain}&label=smart_money` : tab === 'callout' ? `/signals/callouts?chain=${chain}` : tab === 'monitor' ? `/signals/cluster?chain=${chain}&minWallets=2` : null;
  const feed = useApi<any>(path, [path], 4000);
  const drag = (e: React.PointerEvent) => {
    const el = box.current; if (!el) return; (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); const v = Math.min(85, Math.max(20, ((ev.clientY - r.top) / r.height) * 100)); setSplit(v); localStorage.setItem('jgg.dockSplit', String(Math.round(v))); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  const rows: any[] = feed.data?.data ?? [];
  return <aside className="dock" aria-label="Trackers" ref={box}>
    <section className="dock-panel" style={{ height: `${split}%` }}>
      <div className="dock-head">
        <Tabs label="Tracker" value={tab} onChange={setTab} items={[{ id: 'wallet', label: 'Wallet' }, { id: 'track', label: 'Track' }, { id: 'callout', label: 'Callout' }, { id: 'monitor', label: 'Monitor' }, { id: 'renames', label: 'Renames' }]} />
        <Link to="/track" className="icon-btn sm" aria-label="Open full tracker"><I.expand /></Link>
        <button className="icon-btn sm" aria-label="Collapse dock" onClick={onCollapse}><I.panel /></button>
      </div>
      <div className="dock-body">
        {tab === 'renames' ? <div className="state"><p>Renames needs a metadata-change feed (token name/symbol updates) from a live indexer. Not configured — JGG will not invent rename events.</p></div>
          : tab === 'wallet' && !me ? <State signedOut />
          : <State loading={feed.loading} error={feed.error} onRetry={() => feed.reload()} empty={!rows.length && (tab === 'wallet' ? 'No trades from your tracked wallets in the last hour. Track wallets from CopyTrade or any wallet page.' : 'No events in this window.')}>
            <ul className="feed">{rows.slice(0, 60).map((x, i) => tab === 'callout'
              ? <li key={i}><Link to={`/token/${chain}/${x.token}`} className="feed-row"><span className="who">{x.caller}</span><span>called <strong>{x.symbol}</strong></span><span className={cls('num', (x.observedChangeBps ?? 0) >= 0 ? 'pos' : 'neg')}>{x.observedChangeBps === null ? '—' : `${x.observedChangeBps > 0 ? '+' : ''}${(x.observedChangeBps / 100).toFixed(1)}%`}</span></Link></li>
              : tab === 'monitor' ? <li key={i}><Link to={`/token/${chain}/${x.token}`} className="feed-row"><I.users /><span><strong>{x.symbol}</strong> · {x.distinctWallets} smart wallets {x.side}</span></Link></li>
              : <li key={x.eventId}><Link to={`/token/${chain}/${x.token}`} className="feed-row"><span className={cls('side', x.side)}>{x.side === 'buy' ? 'B' : 'S'}</span><span className="who">{x.walletName ?? short(x.wallet)}</span><span><strong>{x.symbol}</strong></span><span className="num">{usd(x.amountUsd)}</span><span className="muted num">{new Date(x.ts).toISOString().slice(11, 16)}</span></Link></li>)}</ul>
          </State>}
      </div>
    </section>
    <div className="splitter" role="separator" aria-orientation="horizontal" aria-valuenow={Math.round(split)} tabIndex={0} aria-label="Resize tracker panels"
      onPointerDown={drag} onKeyDown={e => { if (e.key === 'ArrowUp') setSplit(s => Math.max(20, s - 5)); if (e.key === 'ArrowDown') setSplit(s => Math.min(85, s + 5)); }} />
    <section className="dock-panel" style={{ height: `${100 - split}%` }}>
      <div className="dock-head"><strong className="panel-title">X / TG tracker</strong></div>
      <div className="dock-body"><div className="state"><I.xlogo /><p>Social tracking needs an authorized X API or 6551 OpenTwitter key, or a Telegram bot. None configured, so nothing is shown rather than invented posts.</p><Link to="/status" className="link">See provider status</Link></div></div>
    </section>
  </aside>;
}

// ---------------- Bottom utility bar ----------------
export function UtilityBar({ dockOpen, toggleDock }: { dockOpen: boolean; toggleDock: () => void }) {
  const { chain, dataSource } = useApp(); const { conn } = useTicks(chain);
  const ticker = useApi<any>('/ticker', [], 30000);
  const st = useApi<any>('/status', [], 15000);
  const worker = st.data?.services?.find((s: any) => s.id === 'worker');
  return <footer className="utilbar" aria-label="Utility bar">
    <button className={cls('util', dockOpen && 'on')} onClick={toggleDock} aria-pressed={dockOpen} title="Toggle tracker dock"><I.panel /><span>Layout</span></button>
    {[['/trenches', 'Trenches', <I.fire />], ['/track', 'Wallet Tracker', <I.eye />], ['/track?tab=social', 'Social Tracker', <I.xlogo />], ['/portfolio', 'Holdings', <I.wallet />], ['/watchlist', 'Watchlist', <I.star />], ['/trending', 'Trending', <I.chart />], ['/copy-trade/rank', 'Leaderboard', <I.trophy />], ['/portfolio?tab=pnl', 'P&L', <I.dollar />], ['/monitor', 'Signals', <I.signal />], ['/monitor?tab=callouts', 'Callouts', <I.mega />]].map(([to, l, ic]) => <Link key={l as string} to={to as string} className="util">{ic}<span>{l}</span></Link>)}
    <div className="grow" />
    {ticker.data && <span className="util static" title="Fixture native price (not live)">{ticker.data.data.find((t: any) => t.chain === chain)?.native} ${ticker.data.data.find((t: any) => t.chain === chain)?.usd}</span>}
    <Link to="/status" className="util static conn" title="Connection and data freshness"><span className={cls('led', conn === 'live' ? 'ok' : 'warn')} />{conn === 'live' ? (dataSource === 'solana_live' ? 'Stream live (Solana indexer)' : 'Stream live (simulated data)') : conn === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}{worker && worker.status !== 'up' && <span className="neg"> · worker {worker.status}</span>}</Link>
  </footer>;
}

// ---------------- Auth modal ----------------
export function AuthModal() {
  const { authOpen, setAuthOpen, signInDemo, refresh } = useApp(); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const hasPhantom = typeof window !== 'undefined' && !!(window as any).solana?.isPhantom;
  async function wallet() {
    setBusy(true); setMsg(null);
    try {
      const prov = (window as any).solana; if (!prov) throw new Error('No Solana wallet extension detected.');
      const { publicKey } = await prov.connect(); const address = publicKey.toString();
      const ch = await api('/auth/challenge', { method: 'POST', body: { chain: 'solana', address } });
      const signed = await prov.signMessage(new TextEncoder().encode(ch.message), 'utf8');
      const sig = btoa(String.fromCharCode(...signed.signature));
      await api('/auth/verify', { method: 'POST', body: { nonce: ch.nonce, address, signature: sig, domain: location.host } });
      await refresh(); setAuthOpen(false); toast('Signed in with your Solana wallet (no transaction was sent).', 'ok');
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  }
  return <Drawer open={authOpen} onClose={() => setAuthOpen(false)} title="Log in to JGG">
    <div className="auth">
      <div className="auth-brand"><BrandMark size={56} /></div>
      <button className="btn big" disabled={busy} onClick={async () => { setBusy(true); try { await signInDemo(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); } }}>Continue with a Demo account</button>
      <p className="muted fine">Demo: simulated data, virtual balances (10 SOL · 5 BNB · 1 ETH per chain), no real funds.</p>
      <hr />
      <button className="btn big ghost" disabled={busy || !hasPhantom} onClick={wallet}>Sign in with Solana wallet</button>
      <p className="muted fine">{hasPhantom ? 'You will sign a message bound to this domain with a single-use nonce. It never triggers a transaction.' : 'No Solana wallet extension detected in this browser.'}</p>
      <button className="btn big ghost" disabled title="EVM sign-in (SIWE) is blocked: this build lacks an audited secp256k1/keccak verifier.">Sign in with EVM wallet (unavailable)</button>
      <p className="muted fine">EVM sign-in (SIWE) needs an audited signature library not available in this offline build.</p>
      {msg && <p className="note err" role="alert">{msg}</p>}
    </div>
  </Drawer>;
}

export function PageHead({ title, children, sub }: { title: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return <div className="page-head"><h1>{title}</h1>{sub && <span className="muted">{sub}</span>}<div className="grow" />{children}</div>;
}
export { TokenAvatar };
