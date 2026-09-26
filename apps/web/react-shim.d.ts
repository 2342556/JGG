// Offline shim: @types/react is not installable here. React APIs are typed loosely; JGG web code is still
// checked for undefined names, wrong arities of our own functions, and strict nulls. Replace with @types/react online.
declare module 'react' {
  export type ReactNode = any; export type MouseEvent<T = any> = any; export type RefObject<T> = { current: T };
  export type PointerEvent<T = any> = any; export type KeyboardEvent<T = any> = any;
  export function useState<S>(init: S | (() => S)): [S, (v: S | ((p: S) => S)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useMemo<T>(fn: () => T, deps: unknown[]): T;
  export function useCallback<T extends (...a: any[]) => any>(fn: T, deps: unknown[]): T;
  export function useRef<T>(init: T | null): { current: T | null };
  export function useContext<T>(c: Context<T>): T;
  export type Context<T> = { Provider: any };
  export function createContext<T>(v: T): Context<T>;
  export const Fragment: any;
  export class Component<P = {}, S = {}> { props: P; state: S; setState(s: Partial<S>): void; constructor(p: P); }
  const React: any; export default React;
}
declare module 'react-dom' { export function createPortal(node: any, el: Element): any; }
declare module 'react-dom/client' { export function createRoot(el: Element): { render(n: any): void }; }
declare module 'react/jsx-runtime' { export const jsx: any; export const jsxs: any; export const Fragment: any; }
declare namespace React { type PointerEvent<T = any> = any; type MouseEvent<T = any> = any; type RefObject<T> = { current: T } }
declare namespace JSX { interface IntrinsicElements { [k: string]: any } type Element = any; interface ElementChildrenAttribute { children: {} } interface IntrinsicAttributes { key?: any } }
