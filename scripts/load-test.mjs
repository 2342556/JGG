// T57 soak/load: concurrent demo users each run full paper trades + reads over HTTP. Records latency, errors, server RSS.
// Usage: node scripts/load-test.mjs [base=http://localhost:8790] [users=20] [tradesPerUser=10]
const base = process.argv[2] ?? 'http://localhost:8790'; const USERS = Number(process.argv[3] ?? 20); const TRADES = Number(process.argv[4] ?? 10);
const lat = {}; const errors = {}; const rec = (k, ms) => (lat[k] ??= []).push(ms);
async function call(k, path, opts = {}) {
  const t = performance.now(); const r = await fetch(base + '/api/v1' + path, opts); const body = await r.json().catch(() => null); rec(k, performance.now() - t);
  if (!r.ok) { const c = body?.error?.code ?? r.status; errors[`${k}:${c}`] = (errors[`${k}:${c}`] ?? 0) + 1; }
  return { ok: r.ok, body };
}
async function user(u) {
  const r = await fetch(base + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '); const { csrf } = await r.json();
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  await call('mode', '/mode', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'paper' }) });
  const w = (await call('wallets', '/wallets', { headers: H })).body.find(x => x.chain === 'solana' && x.custody === 'paper');
  const toks = (await call('markets', '/markets/migrated?chain=solana', { headers: H })).body.data.rows.filter(x => x.liqUsd);
  for (let i = 0; i < TRADES; i++) {
    const tok = toks[(u + i) % toks.length];
    await call('trending', '/markets/trending?chain=solana', { headers: H });
    const q = await call('quote', '/quotes', { method: 'POST', headers: H, body: JSON.stringify({ chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.05', slippageBps: 500, walletId: w.id }) });
    if (!q.ok) continue;
    const it = await call('intent', '/trade-intents', { method: 'POST', headers: { ...H, 'idempotency-key': `load-${u}-${i}-${Date.now()}` }, body: JSON.stringify({ quoteId: q.body.id, source: 'manual' }) });
    if (!it.ok) continue;
    await call('approve', `/trade-intents/${it.body.id}/approve`, { method: 'POST', headers: H, body: '{}' });
    const ex = await call('execute', `/trade-intents/${it.body.id}/execute`, { method: 'POST', headers: { ...H, 'idempotency-key': `loadx-${it.body.id}` }, body: '{}' });
    if (ex.ok && ex.body.state !== 'finalized') errors[`execute:${ex.body.state}`] = (errors[`execute:${ex.body.state}`] ?? 0) + 1;
    await call('portfolio', '/portfolio?chain=solana', { headers: H });
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: USERS }, (_, u) => user(u)));
const total = (performance.now() - t0) / 1000;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const summary = Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, { n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1), max: +Math.max(...xs).toFixed(1) }]));
const reqs = Object.values(lat).reduce((a, x) => a + x.length, 0);
const status = await (await fetch(base + '/api/v1/status')).json();
console.log(JSON.stringify({ users: USERS, tradesPerUser: TRADES, seconds: +total.toFixed(1), requests: reqs, rps: +(reqs / total).toFixed(1), latencyMs: summary, errors, queues: status.queues }, null, 1));
