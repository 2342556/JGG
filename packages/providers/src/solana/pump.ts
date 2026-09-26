// Standalone Solana/pump.fun decoding for the JGG indexer (no third-party SDK).
// Sources (checked 2026-09-25):
//  - Program id, Global defaults, BondingCurve PDA/fields, `complete` rule: pump-fun/pump-public-docs PUMP_PROGRAM_README.md
//  - Market cap formula (vQuote * supply / vToken) and tiered fees: pump-fun/pump-public-docs FEE_PROGRAM_README.md
//  - TradeEvent field order (21 fields): carbon-pumpfun-decoder and pump-dump crates (independent, identical order)
//  - Event encodings: Anchor emit! → "Program data: <base64>" (8-byte discriminator = sha256("event:<Name>")[0..8]);
//    emit_cpi! → self-CPI inner instruction data = EVENT_IX_TAG (e445a52e51cb9a1d) + discriminator + borsh (Solana docs, Anchor Events)
// New fields are APPENDED by pump over time, so decoders read a documented prefix and ignore trailing bytes.
import { createHash } from 'node:crypto';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGQPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Global defaults documented by pump (used for progress when a curve's own initial values are not observed).
export const PUMP_DEFAULTS = { initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualSolReserves: 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n, tokenDecimals: 6, solDecimals: 9 };

// ---------------- base58 / base64 ----------------
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const AMAP = new Map([...ALPH].map((c, i) => [c, BigInt(i)]));
export function b58encode(b: Uint8Array): string {
  let n = 0n; for (const x of b) n = n * 256n + BigInt(x);
  let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = '1' + s; else break; }
  return s;
}
export function b58decode(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const v = AMAP.get(c); if (v === undefined) throw new Error('INVALID_BASE58'); n = n * 58n + v; }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return Uint8Array.from(out);
}
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

// ---------------- Borsh prefix reader ----------------
export class Reader {
  o = 0; b: Uint8Array; v: DataView;
  constructor(b: Uint8Array) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  left() { return this.b.length - this.o; }
  need(n: number) { if (this.left() < n) throw new Error('SHORT_EVENT'); }
  u8() { this.need(1); return this.b[this.o++]; }
  bool() { const x = this.u8(); if (x > 1) throw new Error('BAD_BOOL'); return x === 1; }
  u64() { this.need(8); const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { this.need(8); const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  pubkey() { this.need(32); const x = b58encode(this.b.subarray(this.o, this.o + 32)); this.o += 32; return x; }
  str() { this.need(4); const n = this.v.getUint32(this.o, true); this.o += 4; if (n > 10_000) throw new Error('BAD_STRING'); this.need(n); const s = new TextDecoder('utf-8', { fatal: false }).decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
}

export const eventDisc = (name: string) => Uint8Array.from(createHash('sha256').update(`event:${name}`).digest().subarray(0, 8));
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DISC = { CreateEvent: eventDisc('CreateEvent'), TradeEvent: eventDisc('TradeEvent'), CompleteEvent: eventDisc('CompleteEvent') };
const same = (a: Uint8Array, b: Uint8Array, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };

export type CreateEvent = { type: 'create'; name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string | null };
export type TradeEvent = { type: 'trade'; mint: string; solAmount: bigint; tokenAmount: bigint; isBuy: boolean; user: string; timestamp: bigint;
  virtualSolReserves: bigint; virtualTokenReserves: bigint; realSolReserves: bigint; realTokenReserves: bigint;
  feeBasisPoints: bigint | null; fee: bigint | null; creator: string | null; creatorFeeBasisPoints: bigint | null; creatorFee: bigint | null };
export type CompleteEvent = { type: 'complete'; user: string; mint: string; bondingCurve: string; timestamp: bigint };
export type PumpEvent = CreateEvent | TradeEvent | CompleteEvent;

/** Decode one event payload (discriminator + borsh). Returns null for events JGG does not index. */
export function decodeEvent(bytes: Uint8Array): PumpEvent | null {
  if (bytes.length < 8) return null;
  const r = new Reader(bytes.subarray(8));
  if (same(bytes, DISC.TradeEvent)) {
    const t: TradeEvent = { type: 'trade', mint: r.pubkey(), solAmount: r.u64(), tokenAmount: r.u64(), isBuy: r.bool(), user: r.pubkey(), timestamp: r.i64(),
      virtualSolReserves: r.u64(), virtualTokenReserves: r.u64(), realSolReserves: r.u64(), realTokenReserves: r.u64(),
      feeBasisPoints: null, fee: null, creator: null, creatorFeeBasisPoints: null, creatorFee: null };
    if (r.left() >= 32 + 8 + 8 + 32 + 8 + 8) { r.pubkey(); t.feeBasisPoints = r.u64(); t.fee = r.u64(); t.creator = r.pubkey(); t.creatorFeeBasisPoints = r.u64(); t.creatorFee = r.u64(); } // fee fields (appended in 2025)
    return t;
  }
  if (same(bytes, DISC.CreateEvent)) {
    const c: CreateEvent = { type: 'create', name: r.str(), symbol: r.str(), uri: r.str(), mint: r.pubkey(), bondingCurve: r.pubkey(), user: r.pubkey(), creator: null };
    if (r.left() >= 32) c.creator = r.pubkey();
    return c;
  }
  if (same(bytes, DISC.CompleteEvent)) return { type: 'complete', user: r.pubkey(), mint: r.pubkey(), bondingCurve: r.pubkey(), timestamp: r.i64() };
  return null;
}

/** Events from log messages, attributing each "Program data:" line to the program currently executing
 *  (invoke/success/failed stack), so another program's data is never decoded as pump's. */
export function eventsFromLogs(logs: string[]): PumpEvent[] {
  const stack: string[] = []; const out: PumpEvent[] = [];
  for (const line of logs) {
    let m: RegExpExecArray | null;
    if ((m = /^Program (\w{32,44}) invoke \[\d+\]$/.exec(line))) { stack.push(m[1]); continue; }
    if ((m = /^Program (\w{32,44}) (success|failed)/.exec(line))) { if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === PUMP_PROGRAM_ID) {
      try { const e = decodeEvent(b64(line.slice(14).trim())); if (e) out.push(e); } catch { /* malformed → skipped, counted by caller */ }
    }
  }
  return out;
}

/** Events from a getTransaction(json) result's inner instructions (emit_cpi!). Rejects failed transactions. */
export function eventsFromTransaction(tx: any): PumpEvent[] {
  if (!tx?.meta || tx.meta.err !== null) return []; // failed txs can retain event bytes — never index them
  const keys: string[] = [...(tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey)),
    ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const out: PumpEvent[] = [];
  for (const group of tx.meta.innerInstructions ?? []) for (const ix of group.instructions ?? []) {
    if (keys[ix.programIdIndex] !== PUMP_PROGRAM_ID || typeof ix.data !== 'string') continue;
    let d: Uint8Array; try { d = b58decode(ix.data); } catch { continue; }
    if (d.length < 16 || !same(d, EVENT_IX_TAG)) continue; // program id AND tag must match (not an ordinary self-CPI)
    try { const e = decodeEvent(d.subarray(8)); if (e) out.push(e); } catch { /* skip */ }
  }
  return out;
}

// ---------------- Bonding-curve math (exact integers) ----------------
/** Market cap in lamports as pump computes it: virtual_quote * supply / virtual_token (FEE_PROGRAM_README). */
export const marketCapLamports = (vSol: bigint, vTok: bigint, supply = PUMP_DEFAULTS.tokenTotalSupply) => (vTok === 0n ? 0n : (vSol * supply) / vTok);
/** Price of 1 whole token in SOL (display only). */
export const priceSol = (vSol: bigint, vTok: bigint) => (vTok === 0n ? 0 : (Number(vSol) / 1e9) / (Number(vTok) / 1e6));
export const progressBps = (realTok: bigint, initialRealTok = PUMP_DEFAULTS.initialRealTokenReserves) =>
  realTok >= initialRealTok ? 0 : Number(((initialRealTok - realTok) * 10_000n) / initialRealTok);
/** Paper buy with `lamportsIn` total spend; total fee bps (protocol + creator) is taken from the spend. */
export function quoteBuy(vSol: bigint, vTok: bigint, realTok: bigint, lamportsIn: bigint, feeBps: bigint) {
  if (lamportsIn <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');
  const net = (lamportsIn * 10_000n) / (10_000n + feeBps); // floor: never overstates what reaches the curve
  let out = (net * vTok) / (vSol + net);                    // floor(Δy) of x*y=k
  if (out > realTok) out = realTok;                          // cannot buy more than the curve still holds
  return { tokensOut: out, feeLamports: lamportsIn - net, netLamports: net };
}
/** Paper sell of `tokensIn`; fee is charged on the gross SOL out (rounded up against the user). */
export function quoteSell(vSol: bigint, vTok: bigint, realSol: bigint, tokensIn: bigint, feeBps: bigint) {
  if (tokensIn <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');
  let gross = (tokensIn * vSol) / (vTok + tokensIn);
  if (gross > realSol) gross = realSol;
  const fee = (gross * feeBps + 9_999n) / 10_000n;
  return { lamportsOut: gross - fee, feeLamports: fee, grossLamports: gross };
}
/** Self-check used by the indexer on live data: does x*y=k reproduce the event's token amount for a buy?
 *  Pre-trade reserves are reconstructed from post-trade reserves. Returns relative error (0 = exact). */
export function curveModelError(t: TradeEvent): number | null {
  if (!t.isBuy || t.tokenAmount === 0n) return null;
  const preSol = t.virtualSolReserves - t.solAmount; const preTok = t.virtualTokenReserves + t.tokenAmount;
  if (preSol <= 0n) return null;
  const predicted = (t.solAmount * preTok) / (preSol + t.solAmount);
  const diff = predicted > t.tokenAmount ? predicted - t.tokenAmount : t.tokenAmount - predicted;
  return Number(diff) / Number(t.tokenAmount);
}
