import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, errMsg, errCode, setOnAuthLost } from './api.ts';
import { useQueryState } from './router.tsx';

// ---------------- Formatting (display only — all math happens server-side as exact decimals) ----------------
export const CHAINS = ['solana', 'bsc', 'base', 'ethereum'] as const;
export type Chain = typeof CHAINS[number];
export const CHAIN_LABEL: Record<string, string> = { solana: 'SOL', bsc: 'BSC', base: 'Base', ethereum: 'ETH' };
export const NATIVE: Record<string, string> = { solana: 'SOL', bsc: 'BNB', base: 'ETH', ethereum: 'ETH' };
export function usd(v: string | number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v); if (!isFinite(n)) return '—';
  const a = Math.abs(n); const s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}B`; if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`; if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits)}K`;
  return `${s}$${a.toFixed(a < 10 ? 2 : 1)}`;
}
const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** Display price. Tiny prices use subscript-zero notation: $0.0₄1230 = $0.00001230 (the subscript counts the zeros). */
export function price(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'; const n = Number(v); if (!isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n >= 1000 ? 2 : 4 })}`;
  const [mant, ex] = n.toExponential(3).split('e'); const e = Number(ex); // rounding is already applied here
  const zeros = -e - 1;
  if (zeros >= 4) return `$0.0${String(zeros).split('').map(d => SUB[+d]).join('')}${mant.replace('.', '')}`;
  return `$${n.toPrecision(4)}`;
}
export const pct = (bps: number | null | undefined) => bps === null || bps === undefined ? '—' : `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(Math.abs(bps) >= 10000 ? 0 : 1)}%`;
export const bpsPct = (bps: number | null | undefined) => bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(bps < 100 ? 1 : 0)}%`;
export function age(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—'; if (sec < 0) return 'soon';
  if (sec < 60) return `${sec}s`; if (sec < 3600) return `${Math.floor(sec / 60)}m`; if (sec < 86400) return `${Math.floor(sec / 3600)}h`; return `${Math.floor(sec / 86400)}d`;
}
export const short = (a: string | null | undefined, n = 4) => !a ? '—' : a.length <= n * 2 + 2 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
export const num = (v: string | number | null | undefined, d = 2) => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
export const signCls = (n: number | null | undefined) => n === null || n === undefined ? 'muted' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';

// ---------------- App session context ----------------
export type Me = { dataSource?: string; user: { id: string; kind: string; display: string; referral_code: string }; settings: { mode: string; mode_version: number; chain: string; version: number; display: any; layout: any }; unreadNotifications: number; killSwitch: boolean; identities: any[] };
type AppState = { dataSource: string; offline: boolean; me: Me | null; loading: boolean; refresh: () => Promise<void>; signInDemo: () => Promise<void>; signOut: () => Promise<void>; chain: Chain; setChain: (c: Chain) => void; openAuth: () => void; authOpen: boolean; setAuthOpen: (b: boolean) => void };
const AppCtx = createContext<AppState>(null as any);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true); const [authOpen, setAuthOpen] = useState(false);
  const [chainQ, setChainQ] = useQueryState('chain', '');
  const [chainPref, setChainPref] = useState<Chain>(() => (localStorage.getItem('jgg.chain') as Chain) || 'solana');
  const chain: Chain = (CHAINS as readonly string[]).includes(chainQ) ? chainQ as Chain : chainPref;
  const [offline, setOffline] = useState(false); const [dataSource, setDataSource] = useState('fixture');
  const refresh = useCallback(async () => {
    try { const m = await api<any>('/me'); setMe(m.user ? m : null); setDataSource(m.dataSource ?? 'fixture'); setOffline(false); }
    catch (e) { if (e instanceof ApiError && e.e.status === 401) setMe(null); else if (e instanceof ApiError && e.e.code === 'DISCONNECTED') setOffline(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { setOnAuthLost(() => setMe(null)); refresh(); }, [refresh]);
  useEffect(() => { // re-check when the browser reports connectivity changes, and poll while offline
    const on = () => refresh(); const off = () => setOffline(true);
    addEventListener('online', on); addEventListener('offline', off);
    const iv = setInterval(() => { if (offline) refresh(); }, 5000);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); clearInterval(iv); };
  }, [offline, refresh]);
  const setChain = (c: Chain) => { localStorage.setItem('jgg.chain', c); setChainPref(c); setChainQ(c === 'solana' ? '' : c); };
  const signInDemo = async () => { await api('/auth/demo', { method: 'POST', body: {} }); await refresh(); setAuthOpen(false); toast('Signed in to a Demo account — all data and balances are simulated.', 'info'); };
  const signOut = async () => { try { await api('/session', { method: 'DELETE' }); } catch { /* ignore */ } setMe(null); toast('Signed out.', 'info'); };
  return <AppCtx.Provider value={{ dataSource, offline, me, loading, refresh, signInDemo, signOut, chain, setChain, openAuth: () => setAuthOpen(true), authOpen, setAuthOpen }}>{children}</AppCtx.Provider>;
}

// ---------------- Toasts ----------------
type Toast = { id: number; text: string; kind: 'info' | 'ok' | 'err' | 'warn' };
let pushToast: (t: Toast) => void = () => {};
let tid = 0;
export const toast = (text: string, kind: Toast['kind'] = 'info') => pushToast({ id: ++tid, text, kind });
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => { pushToast = t => { setItems(x => [...x.slice(-3), t]); setTimeout(() => setItems(x => x.filter(y => y.id !== t.id)), t.kind === 'err' ? 8000 : 4500); }; }, []);
  return <div className="toasts" role="status" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.kind}`}><span>{t.text}</span><button className="icon-btn" aria-label="Dismiss" onClick={() => setItems(x => x.filter(y => y.id !== t.id))}><I.x /></button></div>)}</div>;
}

// ---------------- Data hook with loading/error/stale states ----------------
export function useApi<T>(path: string | null, deps: unknown[] = [], pollMs = 0) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<unknown>(null); const [loading, setLoading] = useState(!!path); const [at, setAt] = useState(0);
  const ref = useRef<AbortController | null>(null);
  const load = useCallback(async (quiet = false) => {
    if (!path) { setLoading(false); return; }
    ref.current?.abort(); const ac = new AbortController(); ref.current = ac;
    if (!quiet) setLoading(true);
    try { const d = await api<T>(path, { signal: ac.signal }); setData(d); setError(null); setAt(Date.now()); }
    catch (e) { if ((e as Error).name !== 'AbortError') setError(e); } // keep previous data: shown as stale
    finally { if (!ac.signal.aborted) setLoading(false); }
  }, [path]);
  useEffect(() => { load(); return () => ref.current?.abort(); }, [load, ...deps]);
  useEffect(() => { if (!pollMs || !path) return; const iv = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, pollMs); return () => clearInterval(iv); }, [pollMs, load, path]);
  return { data, error, loading, reload: load, at, setData };
}

/** Standard states: loading, error (stale data kept), empty. */
export function State({ loading, error, empty, onRetry, children, signedOut, rows = 6 }: { loading?: boolean; error?: unknown; empty?: boolean | string; onRetry?: () => void; children?: ReactNode; signedOut?: boolean; rows?: number }) {
  const { openAuth } = useApp();
  if (signedOut) return <div className="state"><p>Sign in to see this. Demo accounts are free and fully simulated.</p><button className="btn pill" onClick={openAuth}>Log in</button></div>;
  if (error && (!children || empty)) return <ErrorState error={error} onRetry={onRetry} />; // an error is never shown as "empty"
  if (loading && !children) return <div className="state" aria-busy="true" aria-live="polite">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${70 + ((i * 37) % 30)}%` }} />)}<span className="sr-only">Loading…</span></div>;
  if (empty) return <div className="state"><p>{typeof empty === 'string' ? empty : 'Nothing here yet.'}</p></div>;
  return <>{error ? <StaleBanner error={error} onRetry={onRetry} /> : null}{children}</>;
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const code = errCode(error);
  const hint: Record<string, string> = { PROVIDER_UNAVAILABLE: 'Provider not configured — see Status for what is needed.', CAPABILITY_BLOCKED: 'This capability depends on an external integration that is not configured.', RATE_LIMITED: 'Rate limited — wait a moment and retry.', DISCONNECTED: 'Disconnected from the JGG server.', FORBIDDEN: 'You do not have permission for this.' };
  return <div className="state err" role="alert"><strong>{code.replace(/_/g, ' ').toLowerCase()}</strong><p>{errMsg(error)}</p>{hint[code] && <p className="muted">{hint[code]}</p>}{onRetry && <button className="btn" onClick={onRetry}>Retry</button>}</div>;
}
export const StaleBanner = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => <div className="stale" role="status">Showing last good data (stale): {errMsg(error)} {onRetry && <button className="link" onClick={onRetry}>Retry</button>}</div>;

// ---------------- Visual primitives ----------------
/** Original generated token avatar: deterministic geometric glyph from hue + symbol (no third-party logos). */
export function TokenAvatar({ symbol, hue, size = 56, chain }: { symbol: string; hue: number; size?: number; chain?: string }) {
  const h = hue ?? 200; const letters = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  const k = [...(symbol || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0);
  return <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <rect width="56" height="56" rx="10" fill={`hsl(${h} 45% 16%)`} />
      <path d={k % 3 === 0 ? 'M0 40 L28 12 L56 40 V56 H0Z' : k % 3 === 1 ? 'M0 56 A28 28 0 0 1 56 56Z' : 'M8 8 H48 V48 H8Z'} fill={`hsl(${(h + 40) % 360} 60% 38%)`} opacity=".75" />
      <text x="28" y="35" textAnchor="middle" fontSize="18" fontWeight="700" fill="#F3F5F6" fontFamily="system-ui, sans-serif">{letters}</text>
    </svg>
    {chain && <span className={`chain-dot ${chain}`} title={CHAIN_LABEL[chain]} />}
  </span>;
}
export const ModeBadge = ({ mode }: { mode: string }) => <span className={`mode-badge m-${mode}`} title={MODE_HELP[mode]}>{MODE_LABEL[mode] ?? mode}</span>;
export const MODE_LABEL: Record<string, string> = { demo: 'Demo', live_readonly: 'Live read-only', paper: 'Paper', live: 'Live' };
export const MODE_HELP: Record<string, string> = { demo: 'Demo: simulated market data, virtual balances, simulated execution.', paper: 'Paper trading: simulated execution with virtual balances; market data is JGG fixtures until a live provider is configured.', live_readonly: 'Live read-only: no trading. Live data needs a configured provider.', live: 'Live trading is blocked in this build.' };
export const SimTag = () => { const { dataSource } = useApp(); return dataSource === 'solana_live'
  ? <span className="sim-tag live" title="Live Solana data from the JGG indexer; executions are paper (virtual) fills priced on live reserves">live data · paper fills</span>
  : <span className="sim-tag" title="Deterministic JGG fixture data — not live market facts">simulated</span>; };
export function Copy({ text, label = 'Copy address' }: { text: string; label?: string }) {
  return <button className="icon-btn sm" aria-label={label} title={label} onClick={e => { e.preventDefault(); e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Clipboard unavailable', 'warn')); }}><I.copy /></button>;
}
export function Tip({ text, children }: { text: string; children: ReactNode }) { return <span className="tip" data-tip={text} tabIndex={0} aria-label={text}>{children}</span>; }

export function Drawer({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const prev = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return; prev.current = document.activeElement; setTimeout(() => ref.current?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus(), 0);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'Tab' && ref.current) { const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.hasAttribute('disabled')); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
    addEventListener('keydown', k); return () => { removeEventListener('keydown', k); (prev.current as HTMLElement | null)?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  // Portal to <body> and stop React event bubbling so dialogs opened from inside a row/card link never trigger its navigation.
  return createPortal(<div className="scrim" onClick={e => e.stopPropagation()} onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
    <div className={cls('drawer', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <header><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><I.x /></button></header>
      <div className="drawer-body">{children}</div>
    </div>
  </div>, document.body);
}

export function Tabs<T extends string>({ items, value, onChange, big, label }: { items: { id: T; label: ReactNode; badge?: ReactNode; disabled?: string }[]; value: T; onChange: (v: T) => void; big?: boolean; label: string }) {
  return <div className={cls('tabs', big && 'big')} role="tablist" aria-label={label} onKeyDown={e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const i = items.findIndex(x => x.id === value); const n = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]; onChange(n.id);
    setTimeout(() => (e.currentTarget.querySelector('[aria-selected="true"]') as HTMLElement)?.focus(), 0); }}>
    {items.map(t => <button key={t.id} role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} className={cls('tab', t.id === value && 'on')} title={t.disabled} onClick={() => onChange(t.id)}>{t.label}{t.badge}</button>)}
  </div>;
}

export function Seg<T extends string>({ items, value, onChange, label }: { items: T[] | { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  const xs = (items as any[]).map(x => typeof x === 'string' ? { id: x, label: x } : x);
  return <div className="seg" role="radiogroup" aria-label={label}>{xs.map(x => <button key={x.id} role="radio" aria-checked={x.id === value} className={cls(x.id === value && 'on')} onClick={() => onChange(x.id)}>{x.label}</button>)}</div>;
}

// ---------------- Icons (original, consistent 1.6px stroke) ----------------
const Svg = ({ d, size = 16, fill }: { d: ReactNode; size?: number; fill?: boolean }) => <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const I = {
  x: () => <Svg d={<path d="M6 6l12 12M18 6L6 18" />} />,
  search: () => <Svg d={<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>} />,
  gear: () => <Svg d={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>} />,
  star: ({ on }: { on?: boolean }) => <Svg fill={on} d={<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />} />,
  bolt: () => <Svg fill d={<path d="M13 2L4 14h7l-1 8 9-12h-7z" />} />,
  copy: () => <Svg d={<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>} />,
  filter: () => <Svg d={<path d="M4 5h16l-6 7v6l-4 2v-8z" />} />,
  pause: () => <Svg d={<path d="M8 5v14M16 5v14" />} />,
  play: () => <Svg fill d={<path d="M7 4l13 8-13 8z" />} />,
  chev: () => <Svg d={<path d="M6 9l6 6 6-6" />} />,
  user: () => <Svg d={<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></>} />,
  users: () => <Svg d={<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6" /></>} />,
  globe: () => <Svg d={<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></>} />,
  xlogo: () => <Svg d={<path d="M4 4l16 16M20 4L4 20" />} />,
  send: () => <Svg d={<path d="M21 3L3 11l7 3 3 7z" />} />,
  bell: () => <Svg d={<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0" />} />,
  chart: () => <Svg d={<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />} />,
  wallet: () => <Svg d={<><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M16 15h2" /></>} />,
  fire: () => <Svg d={<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-2 2-2 5-2 8 0 4 3 7 7 7z" />} />,
  trophy: () => <Svg d={<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3" />} />,
  signal: () => <Svg d={<><circle cx="12" cy="12" r="2" /><path d="M8 8a6 6 0 000 8M16 8a6 6 0 010 8M5 5a10 10 0 000 14M19 5a10 10 0 010 14" /></>} />,
  mega: () => <Svg d={<path d="M3 10v4h3l8 5V5L6 10zM18 8a5 5 0 010 8" />} />,
  eye: () => <Svg d={<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>} />,
  shield: () => <Svg d={<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />} />,
  warn: () => <Svg d={<path d="M12 3l10 18H2zM12 10v5M12 18v.5" />} />,
  panel: () => <Svg d={<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>} />,
  expand: () => <Svg d={<path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7" />} />,
  refresh: () => <Svg d={<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" />} />,
  menu: () => <Svg d={<path d="M4 7h16M4 12h16M4 17h16" />} />,
  mute: () => <Svg d={<path d="M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6" />} />,
  robot: () => <Svg d={<><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13v1M15 13v1M2 13v2M22 13v2" /></>} />,
  pot: () => <Svg d={<path d="M4 10h16v3a8 8 0 01-16 0zM2 10h2M20 10h2M9 6c0-1 1-2 1-3M14 6c0-1 1-2 1-3" />} />,
  key: () => <Svg d={<><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></>} />,
  status: () => <Svg d={<path d="M3 12h4l3-8 4 16 3-8h4" />} />,
  gift: () => <Svg d={<path d="M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9c-2-4-6-4-6-1s6 1 6 1zm0 0c2-4 6-4 6-1s-6 1-6 1z" />} />,
  swap: () => <Svg d={<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />} />,
  list: () => <Svg d={<path d="M8 6h13M8 12h13M8 18h13M3 6h.5M3 12h.5M3 18h.5" />} />,
  grid: () => <Svg d={<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>} />,
  plus: () => <Svg d={<path d="M12 5v14M5 12h14" />} />,
  trash: () => <Svg d={<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />} />,
  dollar: () => <Svg d={<path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />} />,
  pill: () => <Svg d={<><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-35 12 12)" /><path d="M9.5 8.5l5 7" /></>} />,
  lock: () => <Svg d={<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>} />,
};

// Keyboard: "/" focuses search unless typing.
export function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => { const f = (e: KeyboardEvent) => { const t = e.target as HTMLElement; if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); ref.current?.focus(); } }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [ref]);
}

// Live ticks via SSE (market:<chain>), merged over REST snapshots; exposes connection state.
export type Tick = { a: string; p: string | null; mc: string | null; v1h: string; c5m: number | null; c1h: number | null; tx: { buys: number; sells: number }; h: number };
export function useTicks(chain: string) {
  const [ticks, setTicks] = useState<Map<string, Tick>>(new Map()); const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting'); const [lastAt, setLastAt] = useState(0);
  useEffect(() => {
    let es: EventSource | null = null; let stopped = false; let retry = 1000; let lastSeq = 0n;
    const open = () => {
      es = new EventSource(`/api/v1/stream?topics=market:${chain}`);
      es.addEventListener('jgg', (ev: MessageEvent) => { const e = JSON.parse(ev.data); const s = BigInt(e.sequence); if (s <= lastSeq && lastSeq !== 0n) return; lastSeq = s; setConn('live'); retry = 1000; setLastAt(Date.now()); setTicks(new Map((e.data.ticks as Tick[]).map(t => [t.a, t]))); });
      es.addEventListener('resync', () => { es?.close(); lastSeq = 0n; if (!stopped) setTimeout(open, 200); });
      es.onerror = () => { es?.close(); setConn('reconnecting'); lastSeq = 0n; if (!stopped) setTimeout(open, retry = Math.min(retry * 2, 15000)); };
    };
    open(); return () => { stopped = true; es?.close(); };
  }, [chain]);
  return { ticks, conn, lastAt };
}
export { errMsg, errCode };
