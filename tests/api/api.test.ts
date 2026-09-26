// JGG API & service acceptance tests. Run: node --test 'tests/api/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, q1, qa, run, type DB } from '../../apps/api/src/db.ts';
import { createUser, b58encode, createApiKey } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import { runSkill, aiRun } from '../../apps/api/src/tools.ts';
import { startServer } from '../../apps/api/src/server.ts';
import { fixtureTokens, priceAt, num, demoNow, fixtureTrades, fixtureWallets } from '../../packages/test-fixtures/src/index.ts';
import * as D from '../../packages/domain/src/index.ts';

const NOW = demoNow();
const tok = fixtureTokens('solana').find(t => t.createdAt < NOW - 3_600_000 && priceAt(t, NOW) !== null && t.liquidityBase !== null)!;
const POLICY = { maxPerTrade: '1', maxPerAssetExposure: '3', maxDailyGrossBuy: '5', maxRealizedDailyLoss: '2', maxOpenPositions: 10, maxSlippageBps: 1000, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false };

function setup(db: DB = openDb(':memory:'), mode: 'paper' | 'demo' = 'paper') {
  const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, mode, NOW);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  return { db, u, w };
}
let k = 0; const key = () => `test-key-${++k}-${Date.now()}`;
function buy(db: DB, u: string, w: string, amount = '0.5', now = NOW, fault: any = 'none') {
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount, slippageBps: 500, walletId: w }, now);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, now, key());
  T.approveIntent(db, u, i.id, {}, now);
  return { q, i, o: T.executeIntent(db, u, i.id, now, key(), fault) };
}
const bal = (db: DB, w: string, a: string) => q1(db, `SELECT qty, reserved FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, a) ?? { qty: '0', reserved: '0' };
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return (e as any).code as string; } };

test('paper buy end-to-end: finalized, balances and balanced journal', () => {
  const { db, u, w } = setup();
  const { o } = buy(db, u, w);
  assert.equal(o.state, 'finalized');
  assert.deepEqual(o.events.map((e: any) => e.to_state), ['created', 'validated', 'awaiting_signature', 'prepared', 'submitting', 'submitted', 'confirmed', 'finalized']);
  assert.ok(D.lt(bal(db, w, 'SOL').qty, '9.5') && D.gt(bal(db, w, 'SOL').qty, '9.49'));
  assert.equal(bal(db, w, 'SOL').reserved, '0');
  assert.equal(bal(db, w, tok.address).qty, o.filledOut);
  for (const e of qa(db, `SELECT entry_id, asset, amount FROM journal_lines`)) void e;
  const sums = qa(db, `SELECT entry_id, asset, amount FROM journal_lines`).reduce((m: Map<string, D.Dec>, l: any) => m.set(l.entry_id + l.asset, D.add(m.get(l.entry_id + l.asset) ?? '0', l.amount)), new Map());
  for (const v of sums.values()) assert.ok(D.isZero(v), 'journal balanced per asset');
});

test('T19: repeated execute returns the same order; idempotency key reuse with different payload rejected', () => {
  const { db, u, w } = setup();
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW);
  const k1 = key(); const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, k1);
  assert.equal(T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, k1).id, i.id, 'same key+payload → same intent');
  assert.equal(code(() => T.createIntent(db, u, { quoteId: q.id, source: 'quick_buy' }, NOW, k1)), 'IDEMPOTENCY_KEY_REUSED');
  T.approveIntent(db, u, i.id, {}, NOW);
  const o1 = T.executeIntent(db, u, i.id, NOW, 'exec-aaaaaaaa'); const o2 = T.executeIntent(db, u, i.id, NOW, 'exec-aaaaaaaa'); const o3 = T.executeIntent(db, u, i.id, NOW, 'exec-bbbbbbbb');
  assert.equal(o1.id, o2.id); assert.equal(o1.id, o3.id);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM orders WHERE user_id = ?`, u).n, 1);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM fills`).n, 1);
});

test('T20: timeout after dispatch → reconciliation_required, never resubmitted; reconcile restores the fill', () => {
  const { db, u, w } = setup();
  const { o } = buy(db, u, w, '0.3', NOW, 'timeout_after_dispatch');
  assert.equal(o.state, 'reconciliation_required');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM order_attempts WHERE order_id = ?`, o.id).n, 1);
  assert.equal(bal(db, w, tok.address).qty, '0', 'no holdings before reconciliation');
  const r = T.reconcileOrder(db, u, o.id, NOW + 10_000);
  assert.equal(r.action, 'restored_fill');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM order_attempts WHERE order_id = ?`, o.id).n, 1, 'still one attempt');
  assert.ok(D.gt(bal(db, w, tok.address).qty, '0'));
  assert.equal(T.reconcileOrder(db, u, o.id, NOW + 20_000).action, 'none', 'reconcile is idempotent');
});

test('T20b: not-landed evidence → expired and reservation released', () => {
  const { db, u, w } = setup();
  const { o } = buy(db, u, w, '0.3', NOW, 'timeout_not_landed');
  assert.ok(D.gt(bal(db, w, 'SOL').reserved, '0'));
  assert.equal(T.reconcileOrder(db, u, o.id, NOW + 10_000).state, 'expired');
  assert.equal(bal(db, w, 'SOL').reserved, '0'); assert.equal(bal(db, w, 'SOL').qty, '10');
});

test('T21: expired quote is never executed and releases the reservation', () => {
  const { db, u, w } = setup();
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, key());
  T.approveIntent(db, u, i.id, {}, NOW);
  assert.equal(code(() => T.executeIntent(db, u, i.id, NOW + 20_000, key())), 'QUOTE_EXPIRED');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM orders`).n, 0); assert.equal(bal(db, w, 'SOL').reserved, '0');
});

test('T22: concurrent spend across two DB connections cannot overdraw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jgg-')); const path = join(dir, 'c.db');
  const a = openDb(path); const b = openDb(path);
  const { u, w } = setup(a);
  const qa1 = T.createQuote(a, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '6', slippageBps: 300, walletId: w }, NOW);
  const qb1 = T.createQuote(b, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '6', slippageBps: 300, walletId: w }, NOW);
  const r1 = code(() => T.createIntent(a, u, { quoteId: qa1.id, source: 'manual' }, NOW, key()));
  const r2 = code(() => T.createIntent(b, u, { quoteId: qb1.id, source: 'manual' }, NOW, key()));
  assert.deepEqual([r1, r2].sort(), ['INSUFFICIENT_BALANCE', 'OK']);
  assert.ok(D.lte(bal(a, w, 'SOL').reserved, '10'));
  a.close(); b.close();
});

test('T23/T24: cancel after dispatch → CANCEL_TOO_LATE; revert charges network fee without holdings', () => {
  const { db, u, w } = setup();
  const { o } = buy(db, u, w);
  assert.equal(code(() => T.cancelOrder(db, u, o.id, NOW)), 'CANCEL_TOO_LATE');
  const { o: r } = buy(db, u, w, '0.2', NOW, 'revert');
  assert.equal(r.state, 'failed'); assert.ok(D.gt(r.feeNative, '0'));
  assert.equal(q1(db, `SELECT COUNT(*) n FROM fills WHERE order_id = ?`, r.id).n, 0);
  assert.equal(bal(db, w, 'SOL').reserved, '0');
});

test('T14: tenant isolation — another user cannot read or act on my records', () => {
  const { db, u, w } = setup(); const other = setup(db);
  const { o, i } = buy(db, u, w);
  assert.equal(code(() => T.orderView(db, other.u, o.id)), 'NOT_FOUND');
  assert.equal(code(() => T.intentView(db, other.u, i.id)), 'NOT_FOUND');
  assert.equal(code(() => T.cancelOrder(db, other.u, o.id, NOW)), 'NOT_FOUND');
  assert.equal(code(() => T.createQuote(db, other.u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.1', slippageBps: 300, walletId: w }, NOW)), 'NOT_FOUND', 'cannot use my wallet');
  assert.equal(T.listOrders(db, other.u, null, 50).rows.length, 0);
  assert.equal(T.portfolio(db, other.u, 'solana', NOW).positions.length, 0);
});

test('modes: live blocked, live_readonly denies trading, mode change invalidates pending approvals', () => {
  const { db, u, w } = setup();
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, key());
  assert.equal(T.setMode(db, u, 'live_readonly', NOW).invalidated, 1);
  assert.equal(T.intentView(db, u, i.id).state, 'expired'); assert.equal(bal(db, w, 'SOL').reserved, '0');
  assert.equal(code(() => T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW)), 'POLICY_DENIED');
  T.setMode(db, u, 'live', NOW);
  assert.equal(code(() => T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 300, walletId: w }, NOW)), 'CAPABILITY_BLOCKED');
});

test('automation: deny-by-default, T28 exits from actual fill, T27 external reduction, T35 kill switch', () => {
  const { db, u, w } = setup();
  const target = num(priceAt(tok, NOW)! * 1.05);
  assert.equal(code(() => S.createStrategy(db, u, { kind: 'limit_buy', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { targetPrice: target, amount: '0.2' } }, NOW)), 'POLICY_DENIED');
  S.setRiskPolicy(db, u, POLICY, undefined);
  const p = S.createStrategy(db, u, { kind: 'limit_buy_tp_sl', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { targetPrice: target, amount: '0.2', stages: [{ percentBps: 5000, gain: '0.5' }], stopLoss: '0.5' } }, NOW);
  assert.equal(S.evaluateAll(db, 'w1', NOW).find(r => r.id === p.id)?.outcome, 'filled');
  const child = S.listStrategies(db, u).find(s => s.parentId === p.id)!;
  const order = q1(db, `SELECT filled_out FROM orders WHERE strategy_id = ?`, p.id);
  assert.equal(child.state.originalQty, order.filled_out, 'exits sized from actual filled quantity');
  // T27: manual sale of half reduces the coordinator's remaining inventory
  const half = D.str(D.rescale(D.div(order.filled_out, '2', 18), tok.decimals, 'floor'));
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'sell', amount: half, slippageBps: 500, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, key()); T.approveIntent(db, u, i.id, {}, NOW); T.executeIntent(db, u, i.id, NOW, key());
  S.evaluateAll(db, 'w1', NOW + 1000);
  const after = S.strategyView(db, u, child.id);
  assert.ok(D.lte(after.state.coord.remaining, D.sub(order.filled_out, half)), 'never plans to sell more than held');
  // T35: kill switch pauses active strategies and blocks new automation
  const ks = S.setKillSwitch(db, u, true, NOW);
  assert.ok(ks.pausedStrategies >= 1);
  assert.equal(code(() => S.createStrategy(db, u, { kind: 'limit_buy', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { targetPrice: target, amount: '0.1' } }, NOW)), 'AUTOMATION_STOPPED');
  assert.equal(S.evaluateAll(db, 'w1', NOW + 2000).length, 0, 'nothing active to evaluate');
});

test('T29: failure to activate exits after a fill raises an Unprotected notification', () => {
  const { db, u, w } = setup(); S.setRiskPolicy(db, u, POLICY, undefined);
  const s = { id: 'stg_x', user_id: u, chain: 'solana', token: tok.address, wallet_id: w, bucket: 'stg_x' };
  S._testing.activateChildExits(db, s, { amountIn: '0.1', filledOut: '1000' }, { stages: [{ percentBps: 20000, gain: '0.5' }] }, NOW); // 200% → invalid
  assert.equal(q1(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'unprotected'`, u).n, 1);
});

test('T30: leases prevent two workers evaluating the same strategy', () => {
  const { db, u, w } = setup(); S.setRiskPolicy(db, u, POLICY, undefined);
  const s = S.createStrategy(db, u, { kind: 'limit_buy', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { targetPrice: '0.0000000001', amount: '0.1' } }, NOW);
  assert.equal(S.claimLease(db, s.id, 'A', NOW), true); assert.equal(S.claimLease(db, s.id, 'B', NOW), false);
  assert.equal(S.claimLease(db, s.id, 'B', NOW + 20_000), true, 'expired lease can be taken over');
});

test('T31: copy task processes each source event once (at-least-once delivery)', () => {
  const { db, u, w } = setup(); S.setRiskPolicy(db, u, { ...POLICY, maxPerTrade: '1', maxDailyGrossBuy: '50', maxPerAssetExposure: '50', maxOpenPositions: 100 }, undefined);
  // pick a source wallet with at least one buy in the next window
  const from = NOW, to = NOW + 10 * 60_000;
  const src = fixtureWallets('solana').find(x => fixtureTrades('solana', from, to).some(t => t.wallet === x.address && t.side === 'buy'))!;
  const s = S.createStrategy(db, u, { kind: 'copy', chain: 'solana', walletId: w, params: { sourceWallet: src.address, sizing: 'fixed', amount: '0.01', maxEventAgeSec: 3600 } }, from);
  S.evaluateAll(db, 'w1', to);
  const n1 = q1(db, `SELECT COUNT(*) n FROM orders WHERE strategy_id = ?`, s.id).n;
  run(db, `UPDATE strategies SET state = json_set(state, '$.cursor', ?) WHERE id = ?`, from, s.id); // simulate redelivery of the same window
  S.evaluateAll(db, 'w1', to);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM orders WHERE strategy_id = ?`, s.id).n, n1, 'no duplicate copy orders');
  assert.ok(n1 >= 1);
});

test('T38–T40: AI produces proposals only, cannot launch, and cannot exceed caller scopes', () => {
  const { db, u } = setup();
  const r = aiRun(db, u, `buy 0.1 sol of ${tok.address}`, 'solana', NOW, null);
  const prop = r.steps.find((s: any) => s.tool === 'trade.marketBuy');
  assert.equal(prop.status, 'succeeded'); assert.equal(prop.result.requiresApproval, true);
  assert.equal(T.intentView(db, u, prop.result.intentId).state, 'awaiting_approval');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM orders WHERE user_id = ?`, u).n, 0, 'nothing executed');
  assert.equal(aiRun(db, u, 'launch a token', 'solana', NOW, null).steps[0].status, 'denied');
  const ro = aiRun(db, u, `buy 0.1 sol of ${tok.address}`, 'solana', NOW, new Set(['market:read']));
  assert.equal(ro.steps.find((s: any) => s.tool === 'trade.marketBuy').status, 'denied');
  assert.equal(runSkill(db, u, 'C11', { handle: 'x' }, NOW, 'user', null).status, 'blocked', 'no fabricated social data');
});

test('T49/T55: paper trades never accrue referral commissions', () => {
  const { db, u, w } = setup(); buy(db, u, w);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM commission_entries`).n, 0);
});

// ---------------- HTTP-level ----------------
test('HTTP: CSRF, API-key scopes, SIWS replay/domain, error envelope, security headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jgg-')); const port = 18000 + Math.floor(Math.random() * 2000);
  const srv = startServer({ port, dbPath: join(dir, 'h.db'), webDir: dir, env: { JGG_ENV: 'test', JGG_ORIGIN: `http://localhost:${port}` } });
  const base = `http://localhost:${port}/api/v1`;
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.headers.get('x-frame-options'), 'DENY'); assert.ok(h.headers.get('content-security-policy')?.includes("default-src 'self'"));
    const nf = await (await fetch(`${base}/nope`)).json();
    assert.equal(nf.error.code, 'NOT_FOUND'); assert.ok(nf.error.correlationId); assert.equal(nf.error.stack, undefined);
    const demo = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookies = demo.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    assert.ok(demo.headers.getSetCookie()[0].includes('HttpOnly') && demo.headers.getSetCookie()[0].includes('SameSite=Strict'));
    const { csrf } = await demo.json();
    const noCsrf = await fetch(`${base}/mode`, { method: 'POST', headers: { cookie: cookies, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/mode`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) });
    assert.equal(ok.status, 200);
    const live = await (await fetch(`${base}/mode`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'live' }) })).json();
    assert.equal(live.error.code, 'CAPABILITY_BLOCKED');
    // API key: market:read cannot quote; key cannot be created with trade:execute
    const me = await (await fetch(`${base}/me`, { headers: { cookie: cookies } })).json();
    const k = createApiKey(srv.db, me.user.id, 't', ['market:read'], 1, Date.now());
    const wallets = await (await fetch(`${base}/wallets`, { headers: { authorization: `Bearer ${k.secret}` } })).json();
    const sw = wallets.find((x: any) => x.chain === 'solana');
    const q = await fetch(`${base}/quotes`, { method: 'POST', headers: { authorization: `Bearer ${k.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.1', slippageBps: 300, walletId: sw.id }) });
    assert.equal(q.status, 403);
    const exec = await fetch(`${base}/api-keys`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ scopes: ['trade:execute'] }) });
    assert.equal(exec.status, 403);
    // SIWS with a real ed25519 key
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const address = b58encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
    const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const ch = await (await post('/auth/challenge', { chain: 'solana', address })).json();
    const sig = sign(null, Buffer.from(ch.message), privateKey).toString('base64');
    const wrongDomain = await post('/auth/verify', { nonce: ch.nonce, address, signature: sig, domain: 'evil.example' });
    assert.equal(wrongDomain.status, 401);
    const ch2 = await (await post('/auth/challenge', { chain: 'solana', address })).json();
    const sig2 = sign(null, Buffer.from(ch2.message), privateKey).toString('base64');
    const good = await post('/auth/verify', { nonce: ch2.nonce, address, signature: sig2 });
    assert.equal(good.status, 200);
    const replay = await (await post('/auth/verify', { nonce: ch2.nonce, address, signature: sig2 })).json();
    assert.match(replay.error.message, /replay/i);
    const ch3 = await (await post('/auth/challenge', { chain: 'solana', address })).json();
    assert.equal((await post('/auth/verify', { nonce: ch3.nonce, address, signature: sig2 })).status, 401, 'signature for another nonce rejected');
    assert.match((await (await post('/auth/verify', { nonce: ch3.nonce, address, signature: sign(null, Buffer.from(ch3.message), privateKey).toString('base64') })).json()).error.message, /replay/i, 'bad signature burns the nonce');
    assert.equal((await (await post('/auth/challenge', { chain: 'base', address: '0x' + '1'.repeat(40) })).json()).error.code, 'CHAIN_UNSUPPORTED');
  } finally { await srv.close(); }
});
