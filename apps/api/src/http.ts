import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ErrorCode, Schema } from '../../../packages/contracts/src/index.ts';

export class ApiError extends Error {
  code: ErrorCode; status: number; retryable: boolean; details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, retryable = false, details?: unknown) {
    super(message); this.code = code; this.status = status; this.retryable = retryable; this.details = details;
  }
}

export type Ctx = {
  req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: any;
  correlationId: string; userId: string | null; authKind: 'session' | 'api_key' | null; scopes: Set<string> | null; csrfOk: boolean; now: number;
};
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean; write: boolean; scope?: string };

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, handler: Handler, opts: { auth?: boolean; scope?: string } = {}) {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, auth: opts.auth ?? false, write: method !== 'GET', scope: opts.scope });
    return this;
  }
  match(method: string, path: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path); if (!m) continue;
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

export async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new ApiError('VALIDATION_FAILED', 'Body too large', 413); chunks.push(c as Buffer); }
  if (!size) return {};
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new ApiError('VALIDATION_FAILED', 'Content-Type must be application/json', 415);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('VALIDATION_FAILED', 'Malformed JSON', 400); }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(s);
}

export function sendError(res: ServerResponse, e: unknown, correlationId: string) {
  const err = e instanceof ApiError ? e : null;
  if (!err) console.error(`[${correlationId}] internal error:`, (e as Error)?.message); // message only; no request bodies/secrets
  sendJson(res, err?.status ?? 500, { error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? 'Internal error', retryable: err?.retryable ?? false, correlationId, details: err?.details } });
}

export function validate<T>(schema: Schema<T>, v: unknown): T {
  const r = schema.parse(v);
  if (!r.ok) throw new ApiError('VALIDATION_FAILED', 'Invalid request', 400, false, r.issues);
  return r.value;
}

export const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
