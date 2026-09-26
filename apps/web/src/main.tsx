import { createRoot } from 'react-dom/client';
import { useEffect, useState, Component, type ReactNode } from 'react';
import { RouterProvider, useRouter, match, Link } from './router.tsx';
import { AppProvider, Toasts, useApp } from './lib.tsx';
import { api } from './api.ts';
import { TopNav, Dock, UtilityBar, AuthModal, MobileMenu, MobileTabs } from './components/Shell.tsx';
import { Trenches, Trending } from './pages/Market.tsx';
import { TokenPage, WalletPage } from './pages/Token.tsx';
import { CopyTrade, Monitor, Track } from './pages/Signals.tsx';
import { Portfolio, Rewards, Watchlist, Settings, Status, UpDown, Perpetuals, Launch } from './pages/Account.tsx';
import { AIPage } from './pages/AI.tsx';
import { AutoPage } from './pages/Auto.tsx';

const DOCK_ROUTES = ['/trenches', '/trending', '/copy-trade', '/monitor'];

class Boundary extends Component<{ children: ReactNode; k: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidUpdate(p: { k: string }) { if (p.k !== this.props.k && this.state.err) this.setState({ err: null }); }
  render() { return this.state.err ? <div className="state err" role="alert"><strong>This view crashed</strong><p>{this.state.err.message}</p><button className="btn" onClick={() => this.setState({ err: null })}>Retry</button></div> : this.props.children; }
}

function Page() {
  const { loc } = useRouter(); const p = loc.path;
  let m;
  if (p === '/' || p === '/trenches') return <Trenches />;
  if (p === '/trending') return <Trending />;
  if (p === '/copy-trade') return <CopyTrade tab="rank" />;
  if ((m = match('/copy-trade/:tab', p))) return <CopyTrade tab={m.tab} />;
  if (p === '/monitor') return <Monitor />;
  if (p === '/track') return <Track />;
  if (p === '/portfolio') return <Portfolio />;
  if (p === '/rewards') return <Rewards />;
  if (p === '/up-down') return <UpDown />;
  if (p === '/perpetuals') return <Perpetuals />;
  if (p === '/launch') return <Launch />;
  if (p === '/ai') return <AIPage />;
  if (p === '/auto') return <AutoPage />;
  if ((m = match('/token/:chain/:address', p))) return <TokenPage key={p} chain={m.chain} address={m.address} />;
  if ((m = match('/wallet/:chain/:address', p))) return <WalletPage key={p} chain={m.chain} address={m.address} />;
  if (p === '/watchlist') return <Watchlist />;
  if (p === '/settings') return <Settings />;
  if (p === '/status') return <Status />;
  return <div className="state"><h1>Not found</h1><p>No JGG page at {p}.</p><Link className="btn" to="/trenches">Go to Trenches</Link></div>;
}

function Layout() {
  const { loc } = useRouter(); const { loading, offline } = useApp();
  const [dock, setDock] = useState(() => localStorage.getItem('jgg.dock') !== '0'); const [menu, setMenu] = useState(false);
  const [dockW, setDockW] = useState(() => Number(localStorage.getItem('jgg.dockW') ?? 0) || 0);
  useEffect(() => localStorage.setItem('jgg.dock', dock ? '1' : '0'), [dock]);
  // T05: layout also saved per user + device class on the server (no secrets in layout).
  const { me } = useApp(); const device = typeof innerWidth === 'number' && innerWidth < 768 ? 'mobile' : innerWidth < 1280 ? 'tablet' : 'desktop';
  useEffect(() => { const l = me?.settings.layout?.[device]; if (l) { if (typeof l.dock === 'boolean') setDock(l.dock); if (l.dockW) setDockW(l.dockW); } }, [me?.user.id]);
  useEffect(() => { if (!me) return; const t = setTimeout(() => { api('/settings', { method: 'PATCH', body: { layout: { ...(me.settings.layout ?? {}), [device]: { dock, dockW } } } }).catch(() => {}); }, 800); return () => clearTimeout(t); }, [dock, dockW, me?.user.id]);
  const showDock = dock && DOCK_ROUTES.some(r => loc.path === r || loc.path.startsWith(r + '/') || (r === '/trenches' && loc.path === '/'));
  const drag = (e: React.PointerEvent) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const mv = (ev: PointerEvent) => { const w = Math.min(620, Math.max(280, ev.clientX)); setDockW(w); localStorage.setItem('jgg.dockW', String(w)); }; const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); };
  return <div className="app">
    <a href="#main" className="skip">Skip to content</a>
    <TopNav onMenu={() => setMenu(true)} />
    <div className="workspace" style={showDock && dockW ? { ['--dock-w' as any]: `${dockW}px` } : undefined}>
      {showDock && <><Dock onCollapse={() => setDock(false)} /><div className="vsplit" role="separator" aria-orientation="vertical" aria-label="Resize dock" tabIndex={0} onPointerDown={drag} onKeyDown={e => { const cur = dockW || 460; if (e.key === 'ArrowLeft') setDockW(Math.max(280, cur - 20)); if (e.key === 'ArrowRight') setDockW(Math.min(620, cur + 20)); }} /></>}
      <main id="main" className="main" tabIndex={-1} aria-busy={loading}>{offline && <div className="offline-banner" role="alert">Can't reach the JGG server. You're seeing the cached app shell — data, sign-in and trading are unavailable until the connection returns. Nothing is queued or replayed.</div>}<Boundary k={loc.path}><Page /></Boundary></main>
    </div>
    <UtilityBar dockOpen={dock} toggleDock={() => setDock(!dock)} />
    <MobileTabs />
    <MobileMenu open={menu} onClose={() => setMenu(false)} />
    <AuthModal /><Toasts />
  </div>;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => { /* shell caching is optional */ });

createRoot(document.getElementById('root')!).render(<RouterProvider><AppProvider><Layout /></AppProvider></RouterProvider>);
