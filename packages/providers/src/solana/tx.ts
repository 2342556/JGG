// Solana transaction wire format (solana.com/docs/core/transactions): compact-u16 signature count, 64-byte signatures,
// then the message. Legacy messages start with the header; v0 messages start with 0x80 | version.
import { b58decode, b58encode } from './pump.ts';

export function encodeCompactU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('COMPACT_U16_RANGE');
  const out: number[] = []; let v = n;
  for (;;) { let b = v & 0x7f; v >>= 7; if (v === 0) { out.push(b); return out; } b |= 0x80; out.push(b); }
}
export function decodeCompactU16(buf: Uint8Array, off: number): [number, number] {
  let v = 0; let size = 0;
  for (;;) { if (off + size >= buf.length || size > 2) throw new Error('COMPACT_U16_TRUNCATED'); const b = buf[off + size]; v |= (b & 0x7f) << (7 * size); size++; if ((b & 0x80) === 0) break; }
  return [v, size];
}

export type ParsedTx = {
  signatures: Uint8Array[]; message: Uint8Array; version: 'legacy' | 0;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  staticKeys: string[]; recentBlockhash: string;
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  lookups: { accountKey: string; writable: number[]; readonly: number[] }[];
};

export function parseTransaction(wire: Uint8Array): ParsedTx {
  let o = 0; const [nSig, s1] = decodeCompactU16(wire, o); o += s1;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < nSig; i++) { if (o + 64 > wire.length) throw new Error('TX_TRUNCATED'); signatures.push(wire.slice(o, o + 64)); o += 64; }
  const message = wire.slice(o); const m = parseMessage(message);
  if (m.header.numRequiredSignatures !== nSig) throw new Error('SIGNATURE_COUNT_MISMATCH');
  return { signatures, message, ...m };
}
export function parseMessage(msg: Uint8Array): Omit<ParsedTx, 'signatures' | 'message'> {
  let o = 0; let version: 'legacy' | 0 = 'legacy';
  if (msg[0] & 0x80) { const v = msg[0] & 0x7f; if (v !== 0) throw new Error('UNSUPPORTED_TX_VERSION'); version = 0; o = 1; }
  const need = (n: number) => { if (o + n > msg.length) throw new Error('MESSAGE_TRUNCATED'); };
  need(3); const header = { numRequiredSignatures: msg[o], numReadonlySigned: msg[o + 1], numReadonlyUnsigned: msg[o + 2] }; o += 3;
  const [nKeys, s2] = decodeCompactU16(msg, o); o += s2;
  const staticKeys: string[] = []; for (let i = 0; i < nKeys; i++) { need(32); staticKeys.push(b58encode(msg.subarray(o, o + 32))); o += 32; }
  need(32); const recentBlockhash = b58encode(msg.subarray(o, o + 32)); o += 32;
  const [nIx, s3] = decodeCompactU16(msg, o); o += s3;
  const instructions: ParsedTx['instructions'] = [];
  for (let i = 0; i < nIx; i++) {
    need(1); const programIdIndex = msg[o++];
    const [na, sa] = decodeCompactU16(msg, o); o += sa; need(na); const accounts = Array.from(msg.subarray(o, o + na)); o += na;
    const [nd, sd] = decodeCompactU16(msg, o); o += sd; need(nd); const data = msg.slice(o, o + nd); o += nd;
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups: ParsedTx['lookups'] = [];
  if (version === 0) {
    const [nl, sl] = decodeCompactU16(msg, o); o += sl;
    for (let i = 0; i < nl; i++) {
      need(32); const accountKey = b58encode(msg.subarray(o, o + 32)); o += 32;
      const [nw, sw] = decodeCompactU16(msg, o); o += sw; need(nw); const writable = Array.from(msg.subarray(o, o + nw)); o += nw;
      const [nr, sr] = decodeCompactU16(msg, o); o += sr; need(nr); const readonly = Array.from(msg.subarray(o, o + nr)); o += nr;
      lookups.push({ accountKey, writable, readonly });
    }
  }
  if (o !== msg.length) throw new Error('MESSAGE_TRAILING_BYTES');
  if (header.numRequiredSignatures > staticKeys.length) throw new Error('BAD_HEADER');
  return { version, header, staticKeys, recentBlockhash, instructions, lookups };
}

/** Insert `signer`'s signature over the message. The signer must be one of the required signers. Other signature slots are kept. */
export function signTransaction(wire: Uint8Array, signer: string, sign: (message: Uint8Array) => Uint8Array): Uint8Array {
  const tx = parseTransaction(wire);
  const idx = tx.staticKeys.indexOf(signer);
  if (idx < 0 || idx >= tx.header.numRequiredSignatures) throw new Error('SIGNER_NOT_REQUIRED');
  const sig = sign(tx.message); if (sig.length !== 64) throw new Error('BAD_SIGNATURE_LENGTH');
  const prefix = Uint8Array.from(encodeCompactU16(tx.signatures.length));
  const out = new Uint8Array(prefix.length + 64 * tx.signatures.length + tx.message.length);
  out.set(prefix, 0); tx.signatures.forEach((s, i) => out.set(i === idx ? sig : s, prefix.length + 64 * i)); out.set(tx.message, prefix.length + 64 * tx.signatures.length);
  return out;
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Legacy message with one System Program Transfer (instruction index 2, u64 lamports). Fee payer = from. */
export function buildTransferMessage(from: string, to: string, lamports: bigint, recentBlockhash: string): Uint8Array {
  if (from === to) throw new Error('SAME_ACCOUNT');
  if (lamports <= 0n || lamports > 0xffff_ffff_ffff_ffffn) throw new Error('LAMPORTS_RANGE');
  const key = (k: string) => { const b = b58decode(k); if (b.length !== 32) throw new Error('BAD_PUBKEY'); return Array.from(b); };
  const data = new Uint8Array(12); const dv = new DataView(data.buffer); dv.setUint32(0, 2, true); dv.setBigUint64(4, lamports, true);
  const bytes = [1, 0, 1, ...encodeCompactU16(3), ...key(from), ...key(to), ...key(SYSTEM_PROGRAM), ...key(recentBlockhash), ...encodeCompactU16(1), 2, ...encodeCompactU16(2), 0, 1, ...encodeCompactU16(12), ...data];
  return Uint8Array.from(bytes);
}
export const unsignedTransaction = (message: Uint8Array, numSigners = 1) => { const p = encodeCompactU16(numSigners); const out = new Uint8Array(p.length + 64 * numSigners + message.length); out.set(p, 0); out.set(message, p.length + 64 * numSigners); return out; };
/** Transaction id = base58 of the first (fee payer) signature. */
export const txSignature = (wire: Uint8Array) => b58encode(parseTransaction(wire).signatures[0]);
