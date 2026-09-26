// Minimal Solana JSON-RPC client (HTTP + WebSocket) — standard methods only (solana.com/docs/rpc).
// Read-only. Timeouts, bounded retries for idempotent reads, client-side pacing, 429 back-off.
export class RpcError extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }

export function createRpc(httpUrl: string, opts: { maxRps?: number; timeoutMs?: number } = {}) {
  const gap = 1000 / (opts.maxRps ?? 8); let next = 0; let id = 0; let pauseUntil = 0;
  async function call<T = any>(method: string, params: unknown[], attempt = 0): Promise<T> {
    const now = Date.now(); const wait = Math.max(0, next - now, pauseUntil - now); next = Math.max(now, next) + gap;
    if (wait) await new Promise(r => setTimeout(r, wait));
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(httpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: ac.signal });
      if (res.status === 429) { pauseUntil = Date.now() + 2000 * 2 ** attempt; throw new RpcError('RATE_LIMITED', 'RPC 429'); }
      if (!res.ok) throw new RpcError('HTTP_' + res.status, `RPC HTTP ${res.status}`);
      const j: any = await res.json();
      if (j.error) throw new RpcError('RPC_' + j.error.code, String(j.error.message));
      return j.result as T;
    } catch (e) {
      const err = e as Error & { code?: string };
      const retryable = err.name === 'AbortError' || err.code === 'RATE_LIMITED' || /^HTTP_5/.test(err.code ?? '') || err instanceof TypeError;
      if (retryable && attempt < 2) return call(method, params, attempt + 1); // reads only — safe to retry (sends pass attempt=99)
      throw err.name === 'AbortError' ? new RpcError('TIMEOUT', `${method} timed out`) : err;
    } finally { clearTimeout(t); }
  }
  return {
    call,
    getAccountInfoParsed: (addr: string) => call<any>('getAccountInfo', [addr, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    getMultipleAccountsParsed: (addrs: string[]) => call<any>('getMultipleAccounts', [addrs, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    getTokenLargestAccounts: (mint: string) => call<any>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
    getTransaction: (sig: string) => call<any>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
    getSlot: () => call<number>('getSlot', [{ commitment: 'confirmed' }]),
    getBalance: async (addr: string) => BigInt((await call<any>('getBalance', [addr, { commitment: 'confirmed' }]))?.value ?? 0),
    getLatestBlockhash: async () => { const r = await call<any>('getLatestBlockhash', [{ commitment: 'confirmed' }]); return { blockhash: r.value.blockhash as string, lastValidBlockHeight: Number(r.value.lastValidBlockHeight) }; },
    getTokenAccountsByOwner: (owner: string, mint: string) => call<any>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    /** Simulation never needs our signature; returns post-state of the requested accounts. */
    simulate: (txBase64: string, addresses: string[]) => call<any>('simulateTransaction', [txBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } }]),
    sendTransaction: (txBase64: string) => call<string>('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }], 99), // 99 = no automatic retry of a send
    getSignatureStatus: async (sig: string) => (await call<any>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]))?.value?.[0] ?? null,
    getTransactionJson: (sig: string) => call<any>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
  };
}
export type Rpc = ReturnType<typeof createRpc>;

/** logsSubscribe({ mentions: [program] }) with auto-reconnect + resubscribe and an idle watchdog. */
export function subscribeLogs(wsUrl: string, program: string, onLogs: (v: { signature: string; err: unknown; logs: string[] }, slot: number) => void,
  hooks: { onState?: (s: 'connecting' | 'live' | 'reconnecting', info?: string) => void; idleMs?: number } = {}) {
  let ws: WebSocket | null = null; let stopped = false; let backoff = 1000; let lastMsg = Date.now();
  const open = () => {
    hooks.onState?.('connecting');
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { backoff = 1000; lastMsg = Date.now(); ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment: 'confirmed' }] })); };
    ws.onmessage = (m: MessageEvent) => {
      lastMsg = Date.now();
      let j: any; try { j = JSON.parse(String(m.data)); } catch { return; }
      if (j.id === 1) { if (j.error) hooks.onState?.('reconnecting', `subscribe failed: ${j.error.message}`); else hooks.onState?.('live'); return; }
      if (j.method === 'logsNotification') { const r = j.params?.result; if (r?.value?.signature) onLogs(r.value, r.context?.slot ?? 0); }
    };
    ws.onclose = () => { if (stopped) return; hooks.onState?.('reconnecting', 'socket closed'); setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30_000); };
    ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
  };
  open();
  const watchdog = setInterval(() => { if (!stopped && Date.now() - lastMsg > (hooks.idleMs ?? 60_000)) { lastMsg = Date.now(); try { ws?.close(); } catch { /* */ } } }, 5_000);
  return { stop: () => { stopped = true; clearInterval(watchdog); try { ws?.close(); } catch { /* */ } } };
}
