// JGG custody + live execution (owner decision 2026-09-25: Option 2, a JGG-held trading wallet).
// Safety model:
//  • Off by default. Requires JGG_LIVE_TRADING=enabled, a 32-byte JGG_CUSTODY_MASTER_KEY, RPC + Jupiter keys, and the user must be a
//    wallet-verified (SIWS) account whose address is in JGG_LIVE_ALLOWED_WALLETS. Demo accounts can never hold real funds.
//  • Keys: ed25519 generated server-side, stored only as AES-256-GCM ciphertext (AAD binds user + address). Never returned by any API.
//  • Withdrawals go ONLY to the user's own verified sign-in wallet (a stolen session cannot redirect funds).
//  • Every swap is simulated first; signing is refused if the simulation spends more SOL/tokens than approved or fails.
//  • Fills come from the chain (getTransaction balances), never from provider-reported amounts. Timeouts → reconciliation, never blind resubmission.
import { generateKeyPairSync, createPrivateKey, sign as edSign, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type DB, tx, q1, qa, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import * as D from '../../../packages/domain/src/index.ts';
import * as X from '../../../packages/providers/src/solana/tx.ts';
import { b58encode, b58decode, WSOL_MINT } from '../../../packages/providers/src/solana/pump.ts';
import type { Rpc } from '../../../packages/providers/src/solana/rpc.ts';
import { jupOrder, jupExecute } from '../../../packages/providers/src/solana/jupiterSwap.ts';
import { orderTransition, settleFailure, applyFill, transitionIntent, releaseReservation, notify, audit } from './trading.ts';

export type LiveEnv = Record<string, string | undefined>;
const FEE_BUFFER_LAMPORTS = 15_000_000n; // max extra SOL a swap may consume beyond the approved input (priority fees, ATA rent)
const RESUBMIT_WINDOW_MS = 110_000;      // Jupiter: same signedTransaction+requestId may be re-sent for ~2 minutes

export function liveConfig(env: LiveEnv) {
  const reasons: string[] = [];
  if (env.JGG_LIVE_TRADING !== 'enabled') reasons.push('LIVE_TRADING_DISABLED');
  let master: Buffer | null = null;
  try { const k = Buffer.from(env.JGG_CUSTODY_MASTER_KEY ?? '', 'base64'); if (k.length === 32) master = k; } catch { /* */ }
  if (!master) reasons.push('NO_CUSTODY_MASTER_KEY');
  if (!env.JGG_SOLANA_RPC_HTTP) reasons.push('NO_SOLANA_RPC');
  if (!env.JGG_JUPITER_API_KEY) reasons.push('NO_JUPITER_KEY');
  const allowed = new Set((env.JGG_LIVE_ALLOWED_WALLETS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  if (!allowed.size) reasons.push('NO_ALLOWED_WALLETS');
  const dec = (v: string | undefined, d: string) => (v && /^\d+(\.\d{1,9})?$/.test(v) ? v : d);
  return { reasons, master, allowed, maxTradeSol: dec(env.JGG_LIVE_MAX_TRADE_SOL, '0.05'), maxDailySol: dec(env.JGG_LIVE_MAX_DAILY_SOL, '0.5') };
}
const identityOf = (db: DB, userId: string) => q1(db, `SELECT address FROM identities WHERE user_id = ? AND chain = 'solana'`, userId)?.address as string | undefined;

export function liveGateFor(db: DB, env: LiveEnv) {
  const cfg = liveConfig(env);
  return (userId: string) => {
    const reasons = [...cfg.reasons]; const id = identityOf(db, userId);
    if (!id) reasons.push('SIGN_IN_WITH_WALLET_REQUIRED'); else if (!cfg.allowed.has(id)) reasons.push('WALLET_NOT_ALLOWLISTED');
    if (!q1(db, `SELECT 1 FROM custody_wallets WHERE user_id = ?`, userId)) reasons.push('NO_TRADING_WALLET');
    return { ok: reasons.length === 0, reasons };
  };
}

// ---------------- Keys ----------------
function aad(userId: string, address: string) { return Buffer.from(`jgg-custody:v1:${userId}:${address}`); }
export function createTradingWallet(db: DB, env: LiveEnv, userId: string, now: number) {
  const cfg = liveConfig(env);
  if (!cfg.master) throw new ApiError('CAPABILITY_BLOCKED', 'Custody is not configured on this server (JGG_CUSTODY_MASTER_KEY)', 409);
  const id = identityOf(db, userId);
  if (!id) throw new ApiError('FORBIDDEN', 'Sign in with your Solana wallet first: withdrawals can only go back to that wallet', 403);
  if (!cfg.allowed.has(id)) throw new ApiError('FORBIDDEN', 'This wallet is not allow-listed for live trading on this server (JGG_LIVE_ALLOWED_WALLETS)', 403);
  const existing = q1(db, `SELECT address FROM custody_wallets WHERE user_id = ?`, userId); if (existing) return { address: existing.address as string, created: false };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = b58encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', cfg.master, iv); c.setAAD(aad(userId, address));
  const enc = Buffer.concat([c.update(secret), c.final()]); const tag = c.getAuthTag(); secret.fill(0);
  tx(db, () => {
    run(db, `INSERT INTO custody_wallets (user_id, address, enc_secret, iv, tag, created_at) VALUES (?, ?, ?, ?, ?, ?)`, userId, address, enc.toString('base64'), iv.toString('base64'), tag.toString('base64'), now);
    run(db, `INSERT INTO wallets (id, user_id, chain, address, custody, label, verified_control, created_at) VALUES (?, ?, 'solana', ?, 'hosted', 'JGG trading wallet', 1, ?)`, newId('wal'), userId, address, now);
    run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) SELECT ?, id, 'SOL', '0' FROM wallets WHERE user_id = ? AND address = ?`, userId, userId, address);
  });
  audit(db, userId, 'user', 'custody.wallet_created', { address });
  return { address, created: true };
}
/** Sign with the user's key. The decrypted key exists only inside this call. */
function signWith(db: DB, env: LiveEnv, userId: string, message: Uint8Array): Uint8Array {
  const cfg = liveConfig(env); if (!cfg.master) throw new ApiError('CAPABILITY_BLOCKED', 'Custody not configured', 409);
  const r = q1(db, `SELECT * FROM custody_wallets WHERE user_id = ?`, userId); if (!r) throw new ApiError('NOT_FOUND', 'No trading wallet', 404);
  const d = createDecipheriv('aes-256-gcm', cfg.master, Buffer.from(r.iv, 'base64')); d.setAAD(aad(userId, r.address)); d.setAuthTag(Buffer.from(r.tag, 'base64'));
  const secret = Buffer.concat([d.update(Buffer.from(r.enc_secret, 'base64')), d.final()]);
  try { return new Uint8Array(edSign(null, message, createPrivateKey({ key: secret, format: 'der', type: 'pkcs8' }))); } finally { secret.fill(0); }
}
const custodyOf = (db: DB, userId: string) => q1(db, `SELECT c.address, w.id wallet_id FROM custody_wallets c JOIN wallets w ON w.user_id = c.user_id AND w.address = c.address WHERE c.user_id = ?`, userId);

// ---------------- Per-user spend lock (trades and withdrawals never overlap) ----------------
function lock(db: DB, userId: string, holder: string, now: number, ms = 60_000) {
  return Number(run(db, `INSERT INTO custody_locks (user_id, holder, until) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE custody_locks.until < ? OR custody_locks.holder = excluded.holder`, userId, holder, now + ms, now).changes) === 1;
}
const unlock = (db: DB, userId: string, holder: string) => run(db, `DELETE FROM custody_locks WHERE user_id = ? AND holder = ?`, userId, holder);

// ---------------- Balances from chain ----------------
export async function syncBalances(db: DB, rpc: Rpc, userId: string, mints: string[] = []) {
  const c = custodyOf(db, userId); if (!c) return null;
  const lamports = await rpc.getBalance(c.address);
  const tokens: Record<string, string> = {};
  const held = new Set([...mints, ...qa(db, `SELECT DISTINCT token FROM position_lots WHERE wallet_id = ?`, c.wallet_id).map(r => r.token as string)]);
  for (const mint of held) {
    const r = await rpc.getTokenAccountsByOwner(c.address, mint);
    let raw = 0n; let dec = 6;
    for (const a of r?.value ?? []) { const ta = a?.account?.data?.parsed?.info?.tokenAmount; if (ta) { raw += BigInt(ta.amount); dec = ta.decimals; } }
    tokens[mint] = D.str(D.rawToDec(raw.toString(), dec));
  }
  tx(db, () => {
    const up = (asset: string, qty: string) => { if (!Number(run(db, `UPDATE paper_balances SET qty = ?, version = version + 1 WHERE wallet_id = ? AND asset = ?`, qty, c.wallet_id, asset).changes)) run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) VALUES (?, ?, ?, ?)`, userId, c.wallet_id, asset, qty); };
    up('SOL', D.str(D.rawToDec(lamports.toString(), 9)));
    for (const [m, q] of Object.entries(tokens)) up(m, q);
  });
  return { address: c.address, sol: D.str(D.rawToDec(lamports.toString(), 9)), tokens };
}

// ---------------- Dispatch ----------------
type Deps = { rpc: Rpc; env: LiveEnv; jupBase?: string; onFill?: (db: DB, orderId: string, now: number) => void };
async function tokenAccounts(rpc: Rpc, owner: string, mint: string) {
  const r = await rpc.getTokenAccountsByOwner(owner, mint);
  return (r?.value ?? []).map((a: any) => ({ address: a.pubkey as string, amount: BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0'), decimals: Number(a.account?.data?.parsed?.info?.tokenAmount?.decimals ?? 6) }));
}
const splAmount = (acc: any): bigint | null => { if (!acc) return 0n; const b = Buffer.from(acc.data?.[0] ?? '', 'base64'); return b.length >= 72 ? b.readBigUInt64LE(64) : null; }; // SPL token account: amount u64 at offset 64

/** Dispatch one live order. Safe to call from both the API request and the worker: the live_exec insert is the claim. */
export async function dispatchLive(db: DB, deps: Deps, orderId: string, now = Date.now()): Promise<string> {
  const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!o || o.mode !== 'live' || o.state !== 'submitting') return 'not_dispatchable';
  if (Number(run(db, `INSERT OR IGNORE INTO live_exec (order_id, user_id, status, updated_at) VALUES (?, ?, 'preparing', ?)`, orderId, o.user_id, now).changes) !== 1) return 'already_claimed';
  const cfg = liveConfig(deps.env); const c = custodyOf(db, o.user_id);
  const fail = (code: string, msg: string) => { tx(db, () => { run(db, `UPDATE live_exec SET status = 'failed', detail = ?, updated_at = ? WHERE order_id = ?`, JSON.stringify({ code, msg }), Date.now(), orderId); orderTransition(db, orderId, 'submitted', { notSent: true }, Date.now()); settleFailure(db, o.user_id, orderId, code, '0', Date.now()); }); notify(db, o.user_id, 'order_failed', 'Live order not sent', `${code}: ${msg}. No funds moved.`, `lf:${orderId}`); return `failed:${code}`; };
  if (cfg.reasons.length || !c) return fail('LIVE_UNAVAILABLE', cfg.reasons.join(',') || 'no trading wallet');
  if (!lock(db, o.user_id, orderId, now)) { run(db, `DELETE FROM live_exec WHERE order_id = ?`, orderId); return 'locked_retry_later'; } // lets the worker retry
  try {
    const intent = q1(db, `SELECT quote_id FROM trade_intents WHERE id = ?`, o.intent_id); const quote = JSON.parse(q1(db, `SELECT body FROM quotes WHERE id = ?`, intent.quote_id).body);
    const buy = o.side === 'buy'; const accts = await tokenAccounts(deps.rpc, c.address, o.token);
    const inDecimals = buy ? 9 : (accts[0]?.decimals ?? 6); const outDecimals = buy ? quote.decimalsOut ?? 6 : 9;
    const amountRaw = BigInt(D.decToRaw(D.str(D.rescale(o.amount_in, inDecimals, 'floor')), inDecimals));
    const minOutRaw = BigInt(D.decToRaw(D.str(D.rescale(o.min_out, outDecimals, 'floor')), outDecimals));
    if (buy) { // daily cap on live buys (finalized + in flight)
      const spent = qa(db, `SELECT amount_in FROM orders WHERE user_id = ? AND mode = 'live' AND side = 'buy' AND created_at > ? AND state NOT IN ('failed','expired','cancelled') AND id != ?`, o.user_id, now - 86_400_000, orderId).reduce((a: D.Dec, r: any) => D.add(a, r.amount_in), D.dec('0'));
      if (D.gt(D.add(spent, o.amount_in), cfg.maxDailySol)) return fail('DAILY_LIMIT', `Daily live buy limit ${cfg.maxDailySol} SOL reached`);
    }
    const order = await jupOrder({ inputMint: buy ? WSOL_MINT : o.token, outputMint: buy ? o.token : WSOL_MINT, amount: amountRaw.toString(), taker: c.address, apiKey: deps.env.JGG_JUPITER_API_KEY!, base: deps.jupBase })
      .catch(e => ({ error: e as Error & { code?: string } }));
    if ('error' in order) return fail((order.error as any).code ?? 'JUPITER_ERROR', order.error.message);
    const promised = BigInt(order.otherAmountThreshold ?? order.outAmount ?? '0');
    if (promised < minOutRaw) return fail('MIN_OUT_NOT_MET', `Route guarantees ${promised} < approved minimum ${minOutRaw}`);
    const unsigned = Uint8Array.from(Buffer.from(order.transaction!, 'base64'));
    const parsed = X.parseTransaction(unsigned);
    const myIdx = parsed.staticKeys.indexOf(c.address);
    if (myIdx < 0 || myIdx >= parsed.header.numRequiredSignatures) return fail('TX_NOT_FOR_THIS_WALLET', 'Jupiter transaction does not require this wallet');
    // Simulate: the wallet may not lose more SOL / tokens than approved.
    const preLamports = await deps.rpc.getBalance(c.address);
    const sim = await deps.rpc.simulate(order.transaction!, [c.address, ...accts.map((a: any) => a.address)]);
    const v = sim?.value; if (!v || v.err) return fail('SIMULATION_FAILED', JSON.stringify(v?.err ?? 'no result').slice(0, 200));
    const postLamports = BigInt(v.accounts?.[0]?.lamports ?? -1);
    if (postLamports < 0n) return fail('SIMULATION_INCOMPLETE', 'no post-state for wallet');
    const solOut = preLamports - postLamports; const solAllowed = (buy ? amountRaw : 0n) + FEE_BUFFER_LAMPORTS;
    if (solOut > solAllowed) return fail('SIMULATION_OVERSPEND', `simulated SOL out ${solOut} > allowed ${solAllowed}`);
    if (!buy) {
      const pre = accts.reduce((a: bigint, x: any) => a + x.amount, 0n);
      const post = (v.accounts ?? []).slice(1).reduce((a: bigint, acc: any) => { const n = splAmount(acc); return n === null ? a : a + n; }, 0n);
      if (pre - post > amountRaw) return fail('SIMULATION_OVERSPEND', `simulated token out ${pre - post} > ${amountRaw}`);
    }
    const signed = X.signTransaction(unsigned, c.address, m => signWith(db, deps.env, o.user_id, m));
    const signedB64 = Buffer.from(signed).toString('base64');
    const sig0 = X.parseTransaction(signed).signatures[0]; const expectedSig = sig0.some(b => b !== 0) ? b58encode(sig0) : null;
    // Persist BEFORE sending: reconciliation needs the exact signed bytes.
    run(db, `UPDATE live_exec SET request_id = ?, signed_tx = ?, signature = ?, submitted_at = ?, status = 'submitted', updated_at = ? WHERE order_id = ?`, order.requestId, signedB64, expectedSig, Date.now(), Date.now(), orderId);
    tx(db, () => orderTransition(db, orderId, 'submitted', { venue: 'jupiter-swap-v2', requestId: order.requestId }, Date.now()));
    let ex: Awaited<ReturnType<typeof jupExecute>> | null = null;
    try { ex = await jupExecute({ signedTransaction: signedB64, requestId: order.requestId, apiKey: deps.env.JGG_JUPITER_API_KEY!, base: deps.jupBase }); } catch { ex = null; }
    if (ex?.signature) run(db, `UPDATE live_exec SET signature = ?, detail = ?, updated_at = ? WHERE order_id = ?`, ex.signature, JSON.stringify({ status: ex.status, code: ex.code }), Date.now(), orderId);
    return await settleFromChain(db, deps, orderId, Date.now(), ex?.status ?? null);
  } finally { unlock(db, o.user_id, orderId); }
}

/** Read the landed transaction and book the real fill (or failure). Unknown → reconciliation_required (never resubmits blindly). */
async function settleFromChain(db: DB, deps: Deps, orderId: string, now: number, reportedStatus: string | null): Promise<string> {
  const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId); const le = q1(db, `SELECT * FROM live_exec WHERE order_id = ?`, orderId); const c = custodyOf(db, o.user_id);
  const toRecon = (why: string) => { tx(db, () => { if (o.state !== 'reconciliation_required') orderTransition(db, orderId, 'reconciliation_required', { reason: why }, now); run(db, `UPDATE live_exec SET status = 'reconciling', updated_at = ? WHERE order_id = ?`, now, orderId); }); return `reconciling:${why}`; };
  if (!le?.signature) return toRecon(reportedStatus ? `NO_SIGNATURE (${reportedStatus})` : 'EXECUTE_NO_RESPONSE');
  const t = await deps.rpc.getTransactionJson(le.signature).catch(() => null);
  if (!t) return toRecon('NOT_YET_VISIBLE');
  const keys: string[] = (t.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(c.address); const payer = keys[0] === c.address; const fee = BigInt(t.meta?.fee ?? 0);
  const solDelta = i >= 0 ? BigInt(t.meta.postBalances[i]) - BigInt(t.meta.preBalances[i]) : 0n;
  const tok = (arr: any[]) => (arr ?? []).filter(b => b.owner === c.address && b.mint === o.token).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const decs = (t.meta.postTokenBalances ?? []).find((b: any) => b.mint === o.token)?.uiTokenAmount?.decimals ?? 6;
  const tokDelta = tok(t.meta.postTokenBalances) - tok(t.meta.preTokenBalances);
  tx(db, () => {
    const cur = q1(db, `SELECT state FROM orders WHERE id = ?`, orderId).state;
    if (cur === 'reconciliation_required') orderTransition(db, orderId, 'submitted', { reconciled: true }, now);
    if (t.meta.err) { settleFailure(db, o.user_id, orderId, 'ONCHAIN_ERROR', D.str(D.rawToDec((payer ? fee : 0n).toString(), 9)), now); run(db, `UPDATE live_exec SET status = 'failed', detail = ?, updated_at = ? WHERE order_id = ?`, JSON.stringify(t.meta.err), now, orderId); return; }
    const inRaw = BigInt(D.decToRaw(D.str(D.rescale(o.amount_in, o.side === 'buy' ? 9 : decs, 'floor')), o.side === 'buy' ? 9 : decs));
    let filledOut: string; let feeNative: bigint;
    if (o.side === 'buy') { filledOut = D.str(D.rawToDec(tokDelta.toString(), decs)); feeNative = -solDelta - inRaw; } // everything beyond the input (fees, ATA rent) is cost
    else { filledOut = D.str(D.rawToDec((solDelta + (payer ? fee : 0n)).toString(), 9)); feeNative = payer ? fee : 0n; if (-tokDelta > inRaw) audit(db, o.user_id, 'reconciler', 'custody.anomaly', { orderId, soldRaw: String(-tokDelta), approvedRaw: String(inRaw) }); }
    applyFill(db, o.user_id, orderId, filledOut, D.str(D.rawToDec((feeNative > 0n ? feeNative : 0n).toString(), 9)), `${le.signature}:0`, now);
    run(db, `UPDATE live_exec SET status = 'filled', updated_at = ? WHERE order_id = ?`, now, orderId);
    run(db, `UPDATE orders SET tx_ref = ? WHERE id = ?`, le.signature, orderId);
  });
  if (!t.meta.err) deps.onFill?.(db, orderId, now);
  return t.meta.err ? 'failed:ONCHAIN_ERROR' : 'filled';
}

/** Reconcile uncertain live orders: re-read the chain; within Jupiter's window re-send the SAME signed tx (idempotent); afterwards expire. */
export async function reconcileLive(db: DB, deps: Deps, orderId: string, now = Date.now()) {
  const le = q1(db, `SELECT * FROM live_exec WHERE order_id = ?`, orderId); const o = q1(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!le || !o || o.state !== 'reconciliation_required') return 'none';
  if (le.signature) { const st = await deps.rpc.getSignatureStatus(le.signature).catch(() => null); if (st) return settleFromChain(db, deps, orderId, now, null); }
  if (le.signed_tx && now - le.submitted_at < RESUBMIT_WINDOW_MS) {
    const ex = await jupExecute({ signedTransaction: le.signed_tx, requestId: le.request_id, apiKey: deps.env.JGG_JUPITER_API_KEY!, base: deps.jupBase }).catch(() => null);
    if (ex?.signature) { run(db, `UPDATE live_exec SET signature = ?, updated_at = ? WHERE order_id = ?`, ex.signature, now, orderId); return settleFromChain(db, deps, orderId, now, ex.status); }
    return 'retry_later';
  }
  if (!le.signature) { notify(db, o.user_id, 'uncertain_execution', 'Live order needs a manual check', `Order ${orderId}: no transaction signature was returned. Check your trading wallet history before trading this coin again.`, `man:${orderId}`); return 'manual_check_required'; }
  // Signed with a recent blockhash that is now expired and never seen on chain → cannot land any more.
  tx(db, () => { orderTransition(db, orderId, 'expired', { reason: 'NOT_LANDED_BLOCKHASH_EXPIRED' }, now); const i = q1(db, `SELECT * FROM trade_intents WHERE id = ?`, o.intent_id); if (i?.reservation_id) releaseReservation(db, i.reservation_id); if (i) transitionIntent(db, i.id, 'completed', 'ORDER_EXPIRED', now); run(db, `UPDATE live_exec SET status = 'expired', updated_at = ? WHERE order_id = ?`, now, orderId); });
  return 'expired';
}

// ---------------- Withdraw (SOL only, to the user's own verified wallet) ----------------
export async function withdraw(db: DB, deps: Deps, userId: string, amountSol: string | 'all', now = Date.now()) {
  const c = custodyOf(db, userId); if (!c) throw new ApiError('NOT_FOUND', 'No trading wallet', 404);
  const to = identityOf(db, userId); if (!to) throw new ApiError('FORBIDDEN', 'No verified wallet to withdraw to', 403);
  if (!lock(db, userId, 'withdraw', now)) throw new ApiError('VERSION_CONFLICT', 'A trade or withdrawal is in progress; try again shortly', 409, true);
  const id = newId('wd');
  try {
    const bal = await deps.rpc.getBalance(c.address); const FEE = 5_000n;
    const lamports = amountSol === 'all' ? bal - FEE : BigInt(D.decToRaw(amountSol, 9));
    if (lamports <= 0n || lamports + FEE > bal) throw new ApiError('INSUFFICIENT_BALANCE', `Balance ${D.str(D.rawToDec(bal.toString(), 9))} SOL is not enough`, 409);
    const open = q1(db, `SELECT COUNT(*) n FROM orders WHERE user_id = ? AND mode = 'live' AND state IN ('submitting','submitted','reconciliation_required')`, userId).n;
    if (open) throw new ApiError('VERSION_CONFLICT', 'Settle in-flight live orders before withdrawing', 409, true);
    const { blockhash } = await deps.rpc.getLatestBlockhash();
    const msg = X.buildTransferMessage(c.address, to, lamports, blockhash);
    const signed = X.signTransaction(X.unsignedTransaction(msg), c.address, m => signWith(db, deps.env, userId, m));
    const b64 = Buffer.from(signed).toString('base64'); const sig = X.txSignature(signed);
    const sim = await deps.rpc.simulate(b64, [c.address]); if (sim?.value?.err) throw new ApiError('PROVIDER_UNAVAILABLE', `Withdrawal simulation failed: ${JSON.stringify(sim.value.err).slice(0, 120)}`, 422);
    run(db, `INSERT INTO custody_withdrawals (id, user_id, to_address, lamports, signature, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`, id, userId, to, lamports.toString(), sig, now, now);
    await deps.rpc.sendTransaction(b64).catch(e => { run(db, `UPDATE custody_withdrawals SET error = ?, updated_at = ? WHERE id = ?`, String((e as Error).message).slice(0, 200), Date.now(), id); });
    let status = 'sent';
    for (let k = 0; k < 20; k++) { const st = await deps.rpc.getSignatureStatus(sig).catch(() => null); if (st) { status = st.err ? 'failed' : (st.confirmationStatus ?? 'confirmed'); break; } await new Promise(r => setTimeout(r, 1500)); }
    run(db, `UPDATE custody_withdrawals SET status = ?, updated_at = ? WHERE id = ?`, status, Date.now(), id);
    audit(db, userId, 'user', 'custody.withdraw', { id, lamports: lamports.toString(), to, sig, status });
    return { id, to, sol: D.str(D.rawToDec(lamports.toString(), 9)), signature: sig, status, explorer: `https://solscan.io/tx/${sig}` };
  } finally { unlock(db, userId, 'withdraw'); }
}
export { b58decode };
