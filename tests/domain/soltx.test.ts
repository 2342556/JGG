import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, randomBytes, createPublicKey } from 'node:crypto';
import * as X from '../../packages/providers/src/solana/tx.ts';
import { b58encode, b58decode } from '../../packages/providers/src/solana/pump.ts';

const kp = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: b58encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))), privateKey, publicKey }; };

test('compact-u16 matches the documented short_vec encodings', () => {
  const cases: [number, number[]][] = [[0, [0x00]], [0x7f, [0x7f]], [0x80, [0x80, 0x01]], [0xff, [0xff, 0x01]], [0x100, [0x80, 0x02]], [0x3fff, [0xff, 0x7f]], [0x4000, [0x80, 0x80, 0x01]], [0xffff, [0xff, 0xff, 0x03]]];
  for (const [n, bytes] of cases) { assert.deepEqual(X.encodeCompactU16(n), bytes, String(n)); assert.deepEqual(X.decodeCompactU16(Uint8Array.from(bytes), 0), [n, bytes.length]); }
  assert.throws(() => X.encodeCompactU16(65536));
});

test('SOL transfer: exact System Program layout, fee payer signs, signature verifies with ed25519', () => {
  const a = kp(); const to = kp().pub; const bh = b58encode(randomBytes(32));
  const msg = X.buildTransferMessage(a.pub, to, 123_456_789n, bh);
  const p = X.parseMessage(msg);
  assert.equal(p.version, 'legacy'); assert.deepEqual(p.header, { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 1 });
  assert.deepEqual(p.staticKeys, [a.pub, to, X.SYSTEM_PROGRAM]); assert.equal(p.recentBlockhash, bh);
  assert.equal(p.instructions.length, 1); assert.equal(p.instructions[0].programIdIndex, 2); assert.deepEqual(p.instructions[0].accounts, [0, 1]);
  const d = Buffer.from(p.instructions[0].data); assert.equal(d.readUInt32LE(0), 2); assert.equal(d.readBigUInt64LE(4), 123_456_789n);
  const signed = X.signTransaction(X.unsignedTransaction(msg), a.pub, m => new Uint8Array(sign(null, m, a.privateKey)));
  const t = X.parseTransaction(signed);
  assert.ok(verify(null, t.message, a.publicKey, t.signatures[0]), 'signature over the exact message bytes');
  assert.equal(X.txSignature(signed), b58encode(t.signatures[0]));
  assert.throws(() => X.buildTransferMessage(a.pub, a.pub, 1n, bh), /SAME_ACCOUNT/);
  assert.throws(() => X.buildTransferMessage(a.pub, to, 0n, bh), /LAMPORTS_RANGE/);
});

test('v0 message with lookup tables parses; signing a 2-signer tx fills only our slot; non-signers are refused', () => {
  const payer = kp(); const us = kp(); const prog = kp().pub; const table = kp().pub; const bh = b58encode(randomBytes(32));
  const key = (k: string) => Array.from(b58decode(k));
  const msg = Uint8Array.from([0x80, 2, 0, 1, ...X.encodeCompactU16(3), ...key(payer.pub), ...key(us.pub), ...key(prog), ...key(bh), ...X.encodeCompactU16(1), 2, ...X.encodeCompactU16(3), 0, 1, 3, ...X.encodeCompactU16(2), 9, 9,
    ...X.encodeCompactU16(1), ...key(table), ...X.encodeCompactU16(1), 4, ...X.encodeCompactU16(2), 5, 6]);
  const p = X.parseMessage(msg);
  assert.equal(p.version, 0); assert.deepEqual(p.lookups, [{ accountKey: table, writable: [4], readonly: [5, 6] }]);
  const payerSig = new Uint8Array(sign(null, msg, payer.privateKey));
  const wire = X.unsignedTransaction(msg, 2); wire.set(payerSig, 1); // payer (e.g. a gasless relayer) already signed slot 0
  const out = X.parseTransaction(X.signTransaction(wire, us.pub, m => new Uint8Array(sign(null, m, us.privateKey))));
  assert.deepEqual(out.signatures[0], payerSig); assert.ok(verify(null, out.message, us.publicKey, out.signatures[1]));
  assert.throws(() => X.signTransaction(wire, prog, () => new Uint8Array(64)), /SIGNER_NOT_REQUIRED/);
  assert.throws(() => X.parseMessage(Uint8Array.from([...msg, 0])), /TRAILING/);
  assert.throws(() => X.parseTransaction(X.unsignedTransaction(msg, 1)), /SIGNATURE_COUNT_MISMATCH/);
  void createPublicKey;
});
