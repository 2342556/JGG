// Real-funds path, exercised end-to-end against local fakes of Solana RPC and Jupiter Swap v2 (no network, no real money).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { openDb, q1, run, type DB } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as K from '../../apps/api/src/custody.ts';
import { createRpc } from '../../packages/providers/src/solana/rpc.ts';
import * as X from '../../packages/providers/src/solana/tx.ts';
import { b58encode, b58decode, WSOL_MINT } from '../../packages/providers/src/solana/pump.ts';
import { newKey } from '../helpers/pumpgen.ts';

const MASTER = randomBytes(32).toString('base64');
const MINT = newKey();
type World = { lamports: bigint; tokens: bigint; simPostLamports: bigint | null; simErr: any; executeMode: 'ok' | 'hang' | 'fail'; outAmount: string; threshold: string; landed: Map<string, any>; orders: number; executes: { tx: string; requestId: string }[]; sent: string[] };
async function fakeChain(owner: () => string) {
  const w: World = { lamports: 2_000_000_000n, tokens: 0n, simPostLamports: null, simErr: null, executeMode: 'ok', outAmount: '5000000000', threshold: '4900000000', landed: new Map(), orders: 0, executes: [], sent: [] };
  const srv = createServer((req, res) => {
    let body = ''; req.on('data', (d: any) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x'); const json = (o: any, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname === '/swap/v2/order') {
        w.orders++; assert.equal(req.headers['x-api-key'], 'jupkey');
        const taker = url.searchParams.get('taker')!; const bh = b58encode(randomBytes(32));
        const txb = Buffer.from(X.unsignedTransaction(X.buildTransferMessage(taker, newKey(), 1n, bh))).toString('base64'); // stand-in "swap" requiring the taker's signature
        return json({ requestId: 'req-' + w.orders, transaction: txb, inAmount: url.searchParams.get('amount'), outAmount: w.outAmount, otherAmountThreshold: w.threshold });
      }
      if (url.pathname === '/swap/v2/execute') {
        const b = JSON.parse(body); w.executes.push({ tx: b.signedTransaction, requestId: b.requestId });
        const t = X.parseTransaction(Uint8Array.from(Buffer.from(b.signedTransaction, 'base64')));
        const pk = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b58decode(owner()))]), format: 'der', type: 'spki' });
        assert.ok(verify(null, t.message, pk, t.signatures[0]), 'Jupiter received a valid custody signature');
        const sig = b58encode(t.signatures[0]);
        if (w.executeMode === 'hang') return; // connection never answers → client timeout
        if (w.executeMode === 'ok' && !w.landed.has(sig)) w.landed.set(sig, { preL: w.lamports, postL: w.lamports - 105_000_000n, preT: w.tokens, postT: w.tokens + BigInt(w.outAmount), fee: 5000n, err: null });
        return json({ status: w.executeMode === 'fail' ? 'Failed' : 'Success', signature: w.executeMode === 'fail' ? null : sig });
      }
      const m = JSON.parse(body); const r = (result: any) => json({ jsonrpc: '2.0', id: m.id, result });
      switch (m.method) {
        case 'getBalance': return r({ context: { slot: 1 }, value: Number(w.lamports) });
        case 'getTokenAccountsByOwner': return r({ value: w.tokens > 0n ? [{ pubkey: 'ata1111111111111111111111111111111111111111', account: { data: { parsed: { info: { tokenAmount: { amount: w.tokens.toString(), decimals: 6 } } } } } }] : [] });
        case 'getAccountInfo': return r({ value: { data: { parsed: { type: 'mint', info: { decimals: 6 } } } } });
        case 'simulateTransaction': return r({ value: { err: w.simErr, accounts: [{ lamports: Number(w.simPostLamports ?? w.lamports - 105_000_000n) }] } });
        case 'getLatestBlockhash': return r({ value: { blockhash: b58encode(randomBytes(32)), lastValidBlockHeight: 100 } });
        case 'sendTransaction': { w.sent.push(m.params[0]); return r(X.txSignature(Uint8Array.from(Buffer.from(m.params[0], 'base64')))); }
        case 'getSignatureStatuses': { const s = m.params[0][0]; return r({ value: [w.landed.has(s) || w.sent.some(x => X.txSignature(Uint8Array.from(Buffer.from(x, 'base64'))) === s) ? { confirmationStatus: 'confirmed', err: null } : null] }); }
        case 'getTransaction': { const l = w.landed.get(m.params[0]); if (!l) return r(null);
          return r({ meta: { err: l.err, fee: Number(l.fee), preBalances: [Number(l.preL)], postBalances: [Number(l.postL)], preTokenBalances: l.preT ? [{ owner: owner(), mint: MINT, uiTokenAmount: { amount: l.preT.toString(), decimals: 6 } }] : [],
            postTokenBalances: [{ owner: owner(), mint: MINT, uiTokenAmount: { amount: l.postT.toString(), decimals: 6 } }] }, transaction: { message: { accountKeys: [{ pubkey: owner() }] } } }); }
        default: return json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } });
      }
    });
  });
  await new Promise<void>(r => srv.listen(0, () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { w, base, close: () => new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
function liveUser(db: DB, env: Record<string, string>) {
  const u = createUser(db, 'wallet', Date.now(), 'owner'); const addr = newKey();
  run(db, `INSERT INTO identities (id, user_id, chain, address, verified_at) VALUES (?, ?, 'solana', ?, ?)`, 'idn_' + addr.slice(0, 8), u, addr, Date.now());
  env.JGG_LIVE_ALLOWED_WALLETS = addr; return { u, identity: addr };
}
const baseEnv = (rpc: string) => ({ JGG_LIVE_TRADING: 'enabled', JGG_CUSTODY_MASTER_KEY: MASTER, JGG_SOLANA_RPC_HTTP: rpc, JGG_JUPITER_API_KEY: 'jupkey', JGG_LIVE_MAX_TRADE_SOL: '0.2', JGG_LIVE_MAX_DAILY_SOL: '0.25' } as Record<string, string>);

async function placeLiveBuy(db: DB, u: string, env: Record<string, string>, deps: any, amount = '0.1') {
  T.setLiveGate(K.liveGateFor(db, env)); T.setLiveLimits({ maxTradeSol: '0.2', maxDailySol: '0.25' });
  T.setMode(db, u, 'live', Date.now());
  await K.syncBalances(db, deps.rpc, u, [MINT]);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND custody = 'hosted'`, u).id;
  const now = Date.now();
  const quote = { chain: 'solana' as const, token: MINT, side: 'buy' as const, amountIn: amount, assetIn: 'SOL', expectedOut: '5000', assetOut: 'TOKEN', minOut: '4800', slippageBps: 400, priceImpactBps: 0, executionPriceUsd: '0', route: 'test', fees: [], quotedAt: now, expiresAt: now + 15_000, model: 'test', decimalsOut: 6 };
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: MINT, side: 'buy', amount, slippageBps: 400, walletId: w }, now, quote);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, now, 'live-intent-' + randomBytes(4).toString('hex')); T.approveIntent(db, u, i.id, {}, now);
  const o = T.executeIntent(db, u, i.id, now, 'live-exec-' + randomBytes(4).toString('hex'));
  return { o, w };
}

test('custody gate: demo accounts and non-allow-listed wallets cannot hold funds; keys are only stored encrypted', async () => {
  const db = openDb(':memory:'); const env = baseEnv('http://127.0.0.1:1');
  const demo = createUser(db, 'demo', Date.now(), 'd');
  assert.throws(() => K.createTradingWallet(db, env, demo, Date.now()), /Sign in with your Solana wallet/);
  const { u } = liveUser(db, env);
  env.JGG_LIVE_ALLOWED_WALLETS = newKey(); assert.throws(() => K.createTradingWallet(db, env, u, Date.now()), /not allow-listed/);
  const { u: u2, identity } = liveUser(db, env);
  const r = K.createTradingWallet(db, env, u2, Date.now()); assert.equal(r.created, true); assert.equal(K.createTradingWallet(db, env, u2, Date.now()).address, r.address, 'idempotent');
  const row = q1(db, `SELECT * FROM custody_wallets WHERE user_id = ?`, u2);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'), 'no PEM/plaintext'); assert.equal(Buffer.from(row.enc_secret, 'base64').length, 48, 'PKCS8 ed25519 (48 bytes) encrypted');
  assert.deepEqual(K.liveGateFor(db, env)(u2), { ok: true, reasons: [] }); void identity;
  assert.ok(K.liveGateFor(db, { ...env, JGG_LIVE_TRADING: 'off' })(u2).reasons.includes('LIVE_TRADING_DISABLED'));
});

test('live buy: Jupiter order → simulation check → custody signature → execute → fill booked from chain balances', async () => {
  let owner = ''; const ch = await fakeChain(() => owner);
  try {
    const db = openDb(':memory:'); const env = baseEnv(ch.base); const { u } = liveUser(db, env);
    owner = K.createTradingWallet(db, env, u, Date.now()).address;
    const deps = { rpc: createRpc(ch.base, { maxRps: 100 }), env, jupBase: `${ch.base}/swap/v2` };
    const { o } = await placeLiveBuy(db, u, env, deps);
    assert.equal(o.state, 'submitting');
    assert.equal(await K.dispatchLive(db, deps, o.id), 'filled');
    const v = T.orderView(db, u, o.id); assert.equal(v.state, 'finalized'); assert.equal(v.filledOut, '5000', 'token delta from getTransaction (5,000,000,000 raw / 1e6)');
    assert.equal(v.feeNative, '0.005', 'SOL beyond the 0.1 input (fees, rent) is booked as cost');
    assert.equal(await K.dispatchLive(db, deps, o.id), 'not_dispatchable', 'never dispatched twice');
    assert.equal(ch.w.executes.length, 1);
  } finally { await ch.close(); }
});

test('live safety: overspending simulation, weak route, per-trade and daily caps all stop BEFORE signing', async () => {
  let owner = ''; const ch = await fakeChain(() => owner);
  try {
    const db = openDb(':memory:'); const env = baseEnv(ch.base); const { u } = liveUser(db, env);
    owner = K.createTradingWallet(db, env, u, Date.now()).address;
    const deps = { rpc: createRpc(ch.base, { maxRps: 100 }), env, jupBase: `${ch.base}/swap/v2` };
    ch.w.simPostLamports = ch.w.lamports - 900_000_000n; // the tx would drain 0.9 SOL for a 0.1 SOL buy
    let { o } = await placeLiveBuy(db, u, env, deps);
    assert.equal(await K.dispatchLive(db, deps, o.id), 'failed:SIMULATION_OVERSPEND');
    ch.w.simPostLamports = null; ch.w.threshold = '1000'; // route guarantees less than the approved minimum
    ({ o } = await placeLiveBuy(db, u, env, deps));
    assert.equal(await K.dispatchLive(db, deps, o.id), 'failed:MIN_OUT_NOT_MET');
    assert.equal(ch.w.executes.length, 0, 'nothing was signed or sent');
    assert.equal(T.orderView(db, u, o.id).state, 'failed');
    await assert.rejects(placeLiveBuy(db, u, env, deps, '0.3'), /per-trade limit/);
    ch.w.threshold = '4900000000';
    ({ o } = await placeLiveBuy(db, u, env, deps, '0.2')); assert.equal(await K.dispatchLive(db, deps, o.id), 'filled');
    ({ o } = await placeLiveBuy(db, u, env, deps, '0.1')); assert.equal(await K.dispatchLive(db, deps, o.id), 'failed:DAILY_LIMIT');
  } finally { await ch.close(); }
});

test('live uncertainty: execute timeout → reconciliation re-sends the SAME signed bytes (idempotent) → fill; unseen after window → expired', async () => {
  let owner = ''; const ch = await fakeChain(() => owner);
  try {
    const db = openDb(':memory:'); const env = baseEnv(ch.base); const { u } = liveUser(db, env);
    owner = K.createTradingWallet(db, env, u, Date.now()).address;
    const rpc = createRpc(ch.base, { maxRps: 100 });
    const deps = { rpc, env, jupBase: `${ch.base}/swap/v2` };
    ch.w.executeMode = 'hang';
    const origFetch = globalThis.fetch; // shorten the execute timeout for the test
    globalThis.fetch = ((url: any, init: any) => String(url).includes('/execute') && ch.w.executeMode === 'hang' ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) : origFetch(url, init)) as any;
    let { o } = await placeLiveBuy(db, u, env, deps);
    try { assert.match(await K.dispatchLive(db, deps, o.id), /^reconciling|^filled/); } finally { globalThis.fetch = origFetch; }
    // signature is known (we are fee payer) but not landed yet → reconcile re-sends the identical signed transaction
    ch.w.executeMode = 'ok';
    const first = q1(db, `SELECT signed_tx FROM live_exec WHERE order_id = ?`, o.id).signed_tx;
    assert.equal(await K.reconcileLive(db, deps, o.id), 'filled');
    assert.equal(ch.w.executes.at(-1)!.tx, first, 'same signed bytes → same signature → cannot double-execute');
    // second order: never lands; after the resubmission window it expires and releases the reservation
    ch.w.executeMode = 'fail';
    ({ o } = await placeLiveBuy(db, u, env, deps));
    assert.match(await K.dispatchLive(db, deps, o.id), /^reconciling/);
    assert.equal(await K.reconcileLive(db, deps, o.id, Date.now() + 200_000), 'expired');
    assert.equal(T.orderView(db, u, o.id).state, 'expired');
    assert.equal(q1(db, `SELECT reserved FROM paper_balances WHERE asset = 'SOL' AND user_id = ?`, u).reserved, '0');
  } finally { await ch.close(); }
});

test('withdraw: only to the verified sign-in wallet, exact System transfer, signed by the custody key', async () => {
  let owner = ''; const ch = await fakeChain(() => owner);
  try {
    const db = openDb(':memory:'); const env = baseEnv(ch.base); const { u, identity } = liveUser(db, env);
    owner = K.createTradingWallet(db, env, u, Date.now()).address;
    const deps = { rpc: createRpc(ch.base, { maxRps: 100 }), env };
    const r = await K.withdraw(db, deps, u, '0.5');
    assert.equal(r.to, identity); assert.equal(r.status, 'confirmed');
    const t = X.parseTransaction(Uint8Array.from(Buffer.from(ch.w.sent[0], 'base64')));
    assert.deepEqual(t.staticKeys.slice(0, 2), [owner, identity]);
    assert.equal(Buffer.from(t.instructions[0].data).readBigUInt64LE(4), 500_000_000n);
    await assert.rejects(K.withdraw(db, deps, u, '5'), /not enough/);
  } finally { await ch.close(); }
});
void WSOL_MINT;
