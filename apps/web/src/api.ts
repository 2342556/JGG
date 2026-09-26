// Browser API client: same-origin, cookie session + CSRF double-submit, typed error envelope.
export type ApiErr = { code: string; message: string; retryable: boolean; correlationId: string; details?: unknown; status: number };
export class ApiError extends Error { e: ApiErr; constructor(e: ApiErr) { super(e.message); this.e = e; } }

const csrf = () => document.cookie.split('; ').find(c => c.startsWith('jgg_csrf='))?.slice(9) ?? '';
let onAuthLost: (() => void) | null = null;
export const setOnAuthLost = (f: () => void) => { onAuthLost = f; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idem?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.method && opts.method !== 'GET') headers['x-csrf-token'] = decodeURIComponent(csrf());
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  let res: Response;
  try { res = await fetch(`/api/v1${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: 'same-origin', signal: opts.signal }); }
  catch (err) { if ((err as Error).name === 'AbortError') throw err; throw new ApiError({ code: 'DISCONNECTED', message: 'Cannot reach the JGG server. Check your connection.', retryable: true, correlationId: '-', status: 0 }); }
  const text = await res.text(); let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = json?.error ?? { code: 'INTERNAL', message: `HTTP ${res.status}`, retryable: res.status >= 500, correlationId: '-' };
    if (res.status === 401 && onAuthLost) onAuthLost();
    throw new ApiError({ ...e, status: res.status });
  }
  return json as T;
}

export const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
export const errMsg = (e: unknown) => e instanceof ApiError ? e.e.message : (e as Error)?.message ?? 'Something went wrong';
export const errCode = (e: unknown) => e instanceof ApiError ? e.e.code : 'INTERNAL';
