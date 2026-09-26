// Standalone Solana decoding: verified against official vectors where they exist, layout-driven otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as P from '../../packages/providers/src/solana/pump.ts';

// --- encoders used only by tests (mirror the documented borsh layouts) ---
const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
const i64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(x); return b; };
const str = (s: string) => { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); };
const pk = () => randomBytes(32);
const disc = (n: string) => createHash('sha256').update(`event:${n}`).digest().subarray(0, 8);

test('anchor discriminator derivation matches the official Anchor docs sample', () => {
  const sample = Buffer.from('Zb1eU3aiYdwOAAAASGVsbG8sIFNvbGFuYSE=', 'base64'); // CustomEvent { message: "Hello, Solana!" }
  assert.deepEqual(Buffer.from(P.eventDisc('CustomEvent')), sample.subarray(0, 8));
  const r = new P.Reader(sample.subarray(8)); assert.equal(r.str(), 'Hello, Solana!');
  assert.deepEqual(Buffer.from(P.EVENT_IX_TAG), Buffer.from('e445a52e51cb9a1d', 'hex'), 'EVENT_IX_TAG_LE on the wire');
  assert.equal(createHash('sha256').update('anchor:event').digest().subarray(0, 8).reverse().toString('hex'), 'e445a52e51cb9a1d');
});

test('base58 round-trips and matches the pump program id', () => {
  const id = P.b58decode(P.PUMP_PROGRAM_ID); assert.equal(id.length, 32); assert.equal(P.b58encode(id), P.PUMP_PROGRAM_ID);
  assert.equal(P.b58encode(Uint8Array.from([0, 0, 1])), '112');
  assert.throws(() => P.b58decode('0OIl'), /INVALID_BASE58/);
});

function tradeBytes(o: { mint: Buffer; sol: bigint; tok: bigint; buy: boolean; user: Buffer; ts: bigint; vs: bigint; vt: bigint; rs: bigint; rt: bigint; withFees?: boolean; extra?: Buffer }) {
  const parts = [disc('TradeEvent'), o.mint, u64(o.sol), u64(o.tok), Buffer.from([o.buy ? 1 : 0]), o.user, i64(o.ts), u64(o.vs), u64(o.vt), u64(o.rs), u64(o.rt)];
  if (o.withFees) parts.push(pk(), u64(95n), u64(o.sol * 95n / 10000n), pk(), u64(30n), u64(o.sol * 30n / 10000n));
  if (o.extra) parts.push(o.extra);
  return Buffer.concat(parts);
}

test('TradeEvent: 21-field layout decodes the documented prefix and tolerates appended fields', () => {
  const mint = pk(), user = pk();
  const bytes = tradeBytes({ mint, sol: 1_000_000_000n, tok: 34_000_000_000_000n, buy: true, user, ts: 1_790_000_000n, vs: 31_000_000_000n, vt: 1_039_000_000_000_000n, rs: 1_000_000_000n, rt: 759_100_000_000_000n, withFees: true,
    extra: Buffer.concat([Buffer.from([1]), u64(5n), u64(6n), u64(7n), i64(8n), str('buy'), Buffer.from([0, 0, 0])]) }); // track_volume… ix_name… future fields
  const e = P.decodeEvent(bytes) as P.TradeEvent;
  assert.equal(e.type, 'trade'); assert.equal(e.mint, P.b58encode(mint)); assert.equal(e.user, P.b58encode(user));
  assert.equal(e.solAmount, 1_000_000_000n); assert.equal(e.isBuy, true); assert.equal(e.realTokenReserves, 759_100_000_000_000n);
  assert.equal(e.feeBasisPoints, 95n); assert.equal(e.creatorFeeBasisPoints, 30n);
  const legacy = P.decodeEvent(tradeBytes({ mint, sol: 5n, tok: 6n, buy: false, user, ts: 1n, vs: 1n, vt: 1n, rs: 1n, rt: 1n })) as P.TradeEvent;
  assert.equal(legacy.feeBasisPoints, null, 'older events without fee fields still decode');
  assert.throws(() => P.decodeEvent(bytes.subarray(0, 50)), /SHORT_EVENT/);
  assert.equal(P.decodeEvent(Buffer.concat([disc('SomethingElse'), Buffer.alloc(40)])), null);
});

test('CreateEvent and CompleteEvent decode; strings are length-prefixed utf-8', () => {
  const mint = pk(), bc = pk(), user = pk(), creator = pk();
  const c = P.decodeEvent(Buffer.concat([disc('CreateEvent'), str('Cat 🐱'), str('CAT'), str('https://ipfs.io/x'), mint, bc, user, creator, i64(1n)])) as P.CreateEvent;
  assert.deepEqual([c.name, c.symbol, c.uri, c.mint, c.bondingCurve, c.creator], ['Cat 🐱', 'CAT', 'https://ipfs.io/x', P.b58encode(mint), P.b58encode(bc), P.b58encode(creator)]);
  const k = P.decodeEvent(Buffer.concat([disc('CompleteEvent'), user, mint, bc, i64(42n)])) as P.CompleteEvent;
  assert.equal(k.type, 'complete'); assert.equal(k.mint, P.b58encode(mint)); assert.equal(k.timestamp, 42n);
});

test('logs: only "Program data" emitted while pump is the executing program is decoded', () => {
  const ev = tradeBytes({ mint: pk(), sol: 1n, tok: 1n, buy: true, user: pk(), ts: 1n, vs: 2n, vt: 2n, rs: 1n, rt: 1n }).toString('base64');
  const OTHER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const logs = [
    `Program ${OTHER} invoke [1]`,
    `Program data: ${ev}`, // emitted by Jupiter → must be ignored
    `Program ${P.PUMP_PROGRAM_ID} invoke [2]`, 'Program log: Instruction: Buy', `Program data: ${ev}`, `Program ${P.PUMP_PROGRAM_ID} consumed 1 of 2 compute units`, `Program ${P.PUMP_PROGRAM_ID} success`,
    `Program data: ${ev}`, // back in Jupiter → ignored
    `Program ${OTHER} success`,
    `Program ${P.PUMP_PROGRAM_ID} invoke [1]`, 'Program data: !!!notbase64', `Program ${P.PUMP_PROGRAM_ID} success`];
  assert.equal(P.eventsFromLogs(logs).length, 1);
});

test('emit_cpi: inner-instruction events need pump program id AND tag; failed transactions are ignored', () => {
  const ev = tradeBytes({ mint: pk(), sol: 7n, tok: 9n, buy: false, user: pk(), ts: 1n, vs: 2n, vt: 2n, rs: 1n, rt: 1n });
  const data = P.b58encode(Buffer.concat([Buffer.from(P.EVENT_IX_TAG), ev]));
  const plain = P.b58encode(ev); // self-CPI without tag → not an event
  const OTHER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const tx = (err: any) => ({ meta: { err, loadedAddresses: { writable: [], readonly: [P.PUMP_PROGRAM_ID] }, innerInstructions: [{ index: 0, instructions: [
    { programIdIndex: 1, data }, { programIdIndex: 2, data }, { programIdIndex: 2, data: plain }] }] }, transaction: { message: { accountKeys: ['payer1111111111111111111111111111111111111', OTHER] } } });
  const got = P.eventsFromTransaction(tx(null));
  assert.equal(got.length, 1, 'only the pump-program instruction with the tag'); assert.equal((got[0] as P.TradeEvent).solAmount, 7n);
  assert.equal(P.eventsFromTransaction(tx({ InstructionError: [0, 'Custom'] })).length, 0);
});

test('bonding curve: documented initial state → price, market cap, progress', () => {
  const d = P.PUMP_DEFAULTS;
  assert.equal(P.marketCapLamports(d.initialVirtualSolReserves, d.initialVirtualTokenReserves), 27_958_993_476n); // 30e9 * 1e15 / 1.073e15
  assert.ok(Math.abs(P.priceSol(d.initialVirtualSolReserves, d.initialVirtualTokenReserves) - 2.7958993476e-8) < 1e-15);
  assert.equal(P.progressBps(d.initialRealTokenReserves), 0); assert.equal(P.progressBps(0n), 10_000);
  assert.equal(P.progressBps(d.initialRealTokenReserves / 2n), 5_000);
});

test('bonding curve quotes: x*y=k with fees, integer floors, never exceed real reserves, round trip loses only fees+impact', () => {
  const d = P.PUMP_DEFAULTS;
  const b = P.quoteBuy(d.initialVirtualSolReserves, d.initialVirtualTokenReserves, d.initialRealTokenReserves, 1_000_000_000n, 125n);
  assert.equal(b.netLamports, 987_654_320n); // floor(1e9 * 10000 / 10125)
  assert.equal(b.tokensOut, (987_654_320n * d.initialVirtualTokenReserves) / (d.initialVirtualSolReserves + 987_654_320n));
  const vs = d.initialVirtualSolReserves + b.netLamports, vt = d.initialVirtualTokenReserves - b.tokensOut;
  const s = P.quoteSell(vs, vt, b.netLamports, b.tokensOut, 125n);
  assert.ok(s.lamportsOut < 1_000_000_000n && s.lamportsOut > 970_000_000n, `round trip ${s.lamportsOut}`);
  assert.equal(P.quoteBuy(1n, 1000n, 5n, 10_000n, 0n).tokensOut, 5n, 'capped by real token reserves');
  assert.throws(() => P.quoteBuy(1n, 1n, 1n, 0n, 0n), /AMOUNT_NOT_POSITIVE/);
});

test('curve self-check: a buy generated by x*y=k has ~0 model error', () => {
  const preS = 40_000_000_000n, preT = 800_000_000_000_000n, sol = 2_000_000_000n;
  const tok = (sol * preT) / (preS + sol);
  const e: P.TradeEvent = { type: 'trade', mint: 'm', solAmount: sol, tokenAmount: tok, isBuy: true, user: 'u', timestamp: 0n, virtualSolReserves: preS + sol, virtualTokenReserves: preT - tok, realSolReserves: 0n, realTokenReserves: 0n, feeBasisPoints: null, fee: null, creator: null, creatorFeeBasisPoints: null, creatorFee: null };
  assert.equal(P.curveModelError(e), 0);
});
