// Tiny history router: deep links, query params, back/forward, refresh-safe.
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode, type MouseEvent } from 'react';

type Loc = { path: string; query: URLSearchParams };
const read = (): Loc => ({ path: location.pathname, query: new URLSearchParams(location.search) });
const RouterCtx = createContext<{ loc: Loc; nav: (to: string, replace?: boolean) => void }>({ loc: read(), nav: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Loc>(read);
  useEffect(() => { const f = () => setLoc(read()); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const nav = useCallback((to: string, replace = false) => {
    if (to === location.pathname + location.search) return;
    (replace ? history.replaceState : history.pushState).call(history, null, '', to); setLoc(read());
    if (!replace) document.getElementById('main')?.scrollTo?.(0, 0);
  }, []);
  return <RouterCtx.Provider value={{ loc, nav }}>{children}</RouterCtx.Provider>;
}
export const useRouter = () => useContext(RouterCtx);
/** Update query params in place (replace), preserving the others. */
export function useQueryState(key: string, def: string): [string, (v: string) => void] {
  const { loc, nav } = useRouter();
  const v = loc.query.get(key) ?? def;
  return [v, (nv: string) => { const q = new URLSearchParams(location.search); if (nv === def) q.delete(key); else q.set(key, nv); const s = q.toString(); nav(location.pathname + (s ? `?${s}` : ''), true); }];
}
export function Link({ to, children, className, title, onClick, ...rest }: { to: string; children: ReactNode; className?: string; title?: string; onClick?: () => void; [k: string]: any }) {
  const { nav, loc } = useRouter();
  const active = loc.path === to.split('?')[0] || (to !== '/' && loc.path.startsWith(to.split('?')[0] + '/'));
  return <a href={to} className={className} title={title} aria-current={active ? 'page' : undefined} {...rest}
    onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onClick?.(); nav(to); }}>{children}</a>;
}
export function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/'), xs = path.split('/'); if (pp.length !== xs.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) { if (pp[i].startsWith(':')) out[pp[i].slice(1)] = decodeURIComponent(xs[i]); else if (pp[i] !== xs[i]) return null; }
  return out;
}
