// Jupiter Swap API v2 Meta-Aggregator (developers.jup.ag/docs/swap): GET https://api.jup.ag/swap/v2/order (inputMint, outputMint,
// amount, taker) → assembled base64 transaction + requestId; POST /swap/v2/execute { signedTransaction, requestId } → status + signature.
// All endpoints need `x-api-key`. Per Jupiter: re-submitting the same signedTransaction+requestId within ~2 minutes cannot double-execute
// (same signature) — JGG uses that only for reconciliation. JGG never trusts reported amounts: fills are read from the chain.
export const JUP_SWAP_BASE = 'https://api.jup.ag/swap/v2';
export type JupOrder = { requestId: string; transaction: string | null; inAmount: string | null; outAmount: string | null; otherAmountThreshold: string | null; raw: any };
export class JupError extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
const intStr = (v: any) => (typeof v === 'string' && /^\d+$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null);

export async function jupOrder(o: { inputMint: string; outputMint: string; amount: string; taker?: string; apiKey: string; base?: string; timeoutMs?: number }): Promise<JupOrder> {
  if (!o.apiKey) throw new JupError('NOT_CONFIGURED', 'JGG_JUPITER_API_KEY not set');
  if (!/^\d+$/.test(o.amount) || o.amount === '0') throw new JupError('BAD_AMOUNT', 'amount must be a positive integer in base units');
  const q = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount, ...(o.taker ? { taker: o.taker } : {}) });
  const j = await req(`${o.base ?? JUP_SWAP_BASE}/order?${q}`, { headers: { 'x-api-key': o.apiKey } }, o.timeoutMs);
  if (typeof j.requestId !== 'string' || !j.requestId) throw new JupError('NO_ROUTE', j.errorMessage ?? j.error ?? 'Jupiter returned no order');
  if (o.taker && typeof j.transaction !== 'string') throw new JupError('NO_ROUTE', j.errorMessage ?? j.error ?? 'No executable route for this token (e.g. not routable yet)');
  return { requestId: j.requestId, transaction: typeof j.transaction === 'string' ? j.transaction : null, inAmount: intStr(j.inAmount), outAmount: intStr(j.outAmount), otherAmountThreshold: intStr(j.otherAmountThreshold), raw: j };
}
export async function jupExecute(o: { signedTransaction: string; requestId: string; apiKey: string; base?: string; timeoutMs?: number }) {
  const j = await req(`${o.base ?? JUP_SWAP_BASE}/execute`, { method: 'POST', headers: { 'x-api-key': o.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: o.signedTransaction, requestId: o.requestId }) }, o.timeoutMs ?? 30_000);
  return { status: String(j.status ?? ''), signature: typeof j.signature === 'string' ? j.signature : null, error: j.error ?? null, code: j.code ?? null, raw: j };
}
async function req(url: string, init: RequestInit, timeoutMs = 10_000): Promise<any> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' }); // never follow redirects with a signed tx or key
    const text = await res.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
    if (res.status === 401 || res.status === 403) throw new JupError('AUTH', 'Jupiter rejected the API key');
    if (res.status === 429) throw new JupError('RATE_LIMITED', 'Jupiter rate limited');
    if (!res.ok) throw new JupError(res.status >= 500 ? 'UPSTREAM' : 'REJECTED', (j?.error ?? j?.errorMessage ?? `Jupiter HTTP ${res.status}`).toString().slice(0, 200));
    if (!j || typeof j !== 'object') throw new JupError('BAD_RESPONSE', 'Jupiter returned non-JSON');
    return j;
  } catch (e) { if ((e as Error).name === 'AbortError') throw new JupError('TIMEOUT', 'Jupiter timed out'); throw e; } finally { clearTimeout(t); }
}
