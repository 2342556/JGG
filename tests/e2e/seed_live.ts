// Seeds a DB with pump-shaped live data (for UI checks of the live mode without network). Usage: node tests/e2e/seed_live.ts <db>
import { openDb } from '../../apps/api/src/db.ts';
import * as L from '../../apps/api/src/live.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';
const db = openDb(process.argv[2]); const st = L.newStats(); const now = Date.now();
L.setSolUsd(db, '150', 'seed (test)', now);
const feed = (logs: string[], slot: number, at: number) => L.ingestLogs(db, { signature: newSig(), err: null, logs }, slot, at, st);
const mk = (name: string, sym: string, ageMin: number, buyers: number, lamports: bigint) => {
  const c = new Curve(); let slot = Math.floor(Math.random() * 1e6); const t0 = now - ageMin * 60_000; feed(c.createLogs(name, sym), slot, t0);
  for (let i = 0; i < buyers; i++) { const ts = t0 + Math.floor((i + 1) * (ageMin * 60_000 - 30_000) / buyers); feed(c.trade(newKey(), true, lamports, Math.floor(ts / 1000)).logs, ++slot, ts); }
  return c;
};
const good = mk('Sunny Otter', 'OTTER', 35, 40, 700_000_000n);
const risky = mk('Frozen Fox', 'FFOX', 25, 30, 800_000_000n);
mk('Thin Ant', 'TANT', 12, 8, 50_000_000n);
const rpc = (freeze: string | null, bc: string) => ({ getAccountInfoParsed: async () => ({ value: { owner: 'TokenkegQfeZyiNwAJbNbGQPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { supply: '1000000000000000', mintAuthority: null, freezeAuthority: freeze } } } } }),
  getTokenLargestAccounts: async () => ({ value: [{ address: 'pool', amount: '600000000000000' }, { address: 'h1', amount: '15000000000000' }] }),
  getMultipleAccountsParsed: async () => ({ value: [{ data: { parsed: { info: { owner: bc } } } }, { data: { parsed: { info: { owner: newKey() } } } }] }) }) as any;
await L.enrichToken(db, rpc(null, good.bc), good.mint, now);
await L.enrichToken(db, rpc('Frz1111111111111111111111111111111111111111', risky.bc), risky.mint, now);
L.recomputeSmart(db, now);
console.log(JSON.stringify({ seeded: st.creates, trades: st.trades, good: good.mint }));
db.close();
