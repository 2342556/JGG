// Test-only generator of pump.fun-shaped log notifications (documented borsh layouts, x*y=k curve).
import { createHash, randomBytes } from 'node:crypto';
import * as P from '../../packages/providers/src/solana/pump.ts';
const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
const i64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(x); return b; };
const str = (s: string) => { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); };
const disc = (n: string) => createHash('sha256').update(`event:${n}`).digest().subarray(0, 8);
export const newKey = () => P.b58encode(randomBytes(32));
const key = (s: string) => Buffer.from(P.b58decode(s));
let sigN = 0; export const newSig = () => P.b58encode(Buffer.concat([Buffer.from('sig'), Buffer.from(String(++sigN).padStart(8, '0')), randomBytes(53)]));
const wrap = (payload: Buffer) => [`Program ${P.PUMP_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Buy', `Program data: ${payload.toString('base64')}`, `Program ${P.PUMP_PROGRAM_ID} success`];

export class Curve {
  vs = P.PUMP_DEFAULTS.initialVirtualSolReserves; vt = P.PUMP_DEFAULTS.initialVirtualTokenReserves; rs = 0n; rt = P.PUMP_DEFAULTS.initialRealTokenReserves;
  mint = newKey(); bc = newKey(); creator = newKey();
  createLogs(name = 'Test Coin', symbol = 'TEST') {
    return [`Program ${P.PUMP_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Create',
      `Program data: ${Buffer.concat([disc('CreateEvent'), str(name), str(symbol), str('https://example.invalid/m.json'), key(this.mint), key(this.bc), key(this.creator), key(this.creator)]).toString('base64')}`, `Program ${P.PUMP_PROGRAM_ID} success`];
  }
  /** Buy `lamports` (net to curve) or sell `tokens`; returns log lines with post-trade reserves and 95+30 bps fee fields. */
  trade(user: string, isBuy: boolean, amount: bigint, tsSec: number) {
    let sol: bigint, tok: bigint;
    if (isBuy) { sol = amount; tok = (sol * this.vt) / (this.vs + sol); if (tok > this.rt) tok = this.rt; this.vs += sol; this.vt -= tok; this.rs += sol; this.rt -= tok; }
    else { tok = amount; sol = (tok * this.vs) / (this.vt + tok); if (sol > this.rs) sol = this.rs; this.vs -= sol; this.vt += tok; this.rs -= sol; this.rt += tok; }
    const payload = Buffer.concat([disc('TradeEvent'), key(this.mint), u64(sol), u64(tok), Buffer.from([isBuy ? 1 : 0]), key(user), i64(BigInt(tsSec)),
      u64(this.vs), u64(this.vt), u64(this.rs), u64(this.rt), randomBytes(32), u64(95n), u64(sol * 95n / 10_000n), key(this.creator), u64(30n), u64(sol * 30n / 10_000n), Buffer.from([0])]);
    return { logs: wrap(payload), sol, tok };
  }
  completeLogs(user: string) { return wrap(Buffer.concat([disc('CompleteEvent'), key(user), key(this.mint), key(this.bc), i64(1n)])); }
}
