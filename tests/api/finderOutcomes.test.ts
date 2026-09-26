// Finder outcome tracking: proves whether the screener actually finds coins that go up, independent of any trade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q1, qa, run, type DB } from '../../apps/api/src/db.ts';
import * as L from '../../apps/api/src/live.ts';
import * as D from '../../packages/domain/src/index.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';

const feed = (db: DB, st: L.IngestStats, logs: string[], slot: number, at: number) => L.ingestLogs(db, { signature: newSig(), err: null, logs }, slot, at, st);
/** Seed a healthy, Finder-passable coin (enough history, liquidity, buy pressure) and return its curve. */
function seedPassable(db: DB, st: L.IngestStats, now: number, ageMin = 40, buyers = 30, buySol = 700_000_000n) {
  const c = new Curve(); let slot = Math.floor(Math.random() * 1e6); const t0 = now - ageMin * 60_000; feed(db, st, c.createLogs('Pass', 'PASS'), slot, t0);
  for (let i = 0; i < buyers; i++) feed(db, st, c.trade(newKey(), true, buySol, Math.floor((t0 + (i + 1) * (ageMin * 60_000 - 60_000) / buyers) / 1000)).logs, ++slot, t0 + (i + 1) * (ageMin * 60_000 - 60_000) / buyers);
  return { c, slot };
}
async function enrichSafe(db: DB, mint: string, bc: string, now: number) {
  const rpc = { getAccountInfoParsed: async () => ({ value: { owner: 'TokenkegQfeZyiNwAJbNbGQPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } }),
    getTokenLargestAccounts: async () => ({ value: [{ address: 'pool', amount: '600000000000000' }, { address: 'h1', amount: '10000000000000' }] }),
    getMultipleAccountsParsed: async () => ({ value: [{ data: { parsed: { info: { owner: bc } } } }, { data: { parsed: { info: { owner: newKey() } } } }] }) } as any;
  await L.enrichToken(db, rpc, mint, now);
}

test('recordFinderPasses: tracks a new pass exactly once, at the entry reserves; ignores non-passing coins', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); L.setSolUsd(db, '150', 't', now);
  const { c } = seedPassable(db, st, now);
  await enrichSafe(db, c.mint, c.bc, now);
  const thin = new Curve(); let s2 = 5000; feed(db, st, thin.createLogs('Thin', 'THN'), s2, now - 10 * 60_000); // too new / too little liquidity
  for (let i = 0; i < 3; i++) feed(db, st, thin.trade(newKey(), true, 10_000_000n, Math.floor((now - 5 * 60_000) / 1000)).logs, ++s2, now - 5 * 60_000);
  assert.equal(L.recordFinderPasses(db, now), 1);
  const row = q1(db, `SELECT * FROM finder_outcomes WHERE token = ?`, c.mint);
  assert.ok(row); assert.equal(row.status, 'tracking'); assert.equal(row.entry_v_sol, String(c.vs)); assert.equal(row.entry_v_tok, String(c.vt));
  assert.equal(q1(db, `SELECT COUNT(*) n FROM finder_outcomes`).n, 1, 'the thin coin did not pass');
  assert.equal(L.recordFinderPasses(db, now + 1000), 0, 'already tracked, not recorded twice');
});

test('updateFinderOutcomes: records horizon samples for a coin that pumped, with correct bps and hit-rate math', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); L.setSolUsd(db, '150', 't', now);
  const { c, slot: s0 } = seedPassable(db, st, now); await enrichSafe(db, c.mint, c.bc, now);
  L.recordFinderPasses(db, now);
  const entry = q1(db, `SELECT entry_v_sol, entry_v_tok FROM finder_outcomes WHERE token = ?`, c.mint);
  const entryPrice = Number(entry.entry_v_sol) / Number(entry.entry_v_tok);
  // +6 minutes: a big buy roughly doubles the price (slot must exceed the seeding slots so the update is not stale)
  let slot = s0; feed(db, st, c.trade(newKey(), true, c.vs, Math.floor((now + 6 * 60_000) / 1000)).logs, ++slot, now + 6 * 60_000);
  const afterPrice = Number(c.vs) / Number(c.vt);
  const expectedBps = Math.round((afterPrice - entryPrice) / entryPrice * 10_000);
  const r1 = L.updateFinderOutcomes(db, now + 6 * 60_000);
  assert.equal(r1.checked, 1);
  const sample5 = q1(db, `SELECT price_bps_change FROM finder_outcome_samples WHERE token = ? AND minutes_since = 5`, c.mint);
  assert.equal(sample5.price_bps_change, expectedBps);
  assert.ok(!q1(db, `SELECT 1 FROM finder_outcome_samples WHERE token = ? AND minutes_since = 15`, c.mint), '15m horizon not reached yet');
  const stats = L.finderOutcomeStats(db, now + 6 * 60_000);
  const h5 = stats.byHorizon.find(h => h.minutes === 5)!;
  assert.equal(h5.n, 1); assert.equal(h5.medianBps, expectedBps);
  assert.equal(h5.hit50Rate, expectedBps >= 5000 ? 100 : 0);
});

test('updateFinderOutcomes: a genuine rug (price collapse + liquidity drain) is classified rugged and stops being tracked', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); L.setSolUsd(db, '150', 't', now);
  const { c, slot: s0 } = seedPassable(db, st, now); await enrichSafe(db, c.mint, c.bc, now);
  L.recordFinderPasses(db, now);
  let slot = s0;
  // dump: a huge sell that both craters price and drains real liquidity
  const drop = c.trade(newKey(), false, c.vt * 25n, Math.floor((now + 10 * 60_000) / 1000)); feed(db, st, drop.logs, ++slot, now + 10 * 60_000); // sell far more than the curve holds: virtual price collapses, real SOL drains to 0 (capped)
  const r = L.updateFinderOutcomes(db, now + 10 * 60_000);
  assert.equal(r.rugged, 1);
  const row = q1(db, `SELECT status, outcome FROM finder_outcomes WHERE token = ?`, c.mint);
  assert.equal(row.status, 'complete'); assert.equal(row.outcome, 'rugged');
  const before = q1(db, `SELECT COUNT(*) n FROM finder_outcome_samples WHERE token = ?`, c.mint).n;
  feed(db, st, c.trade(newKey(), true, 1_000_000_000n, Math.floor((now + 60 * 60_000) / 1000)).logs, ++slot, now + 60 * 60_000);
  L.updateFinderOutcomes(db, now + 60 * 60_000);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM finder_outcome_samples WHERE token = ?`, c.mint).n, before, 'no further samples once closed');
});

test('graduation freezes tracking (v1 does not follow post-migration price); a quiet coin times out at 24h', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); L.setSolUsd(db, '150', 't', now);
  const { c, slot } = seedPassable(db, st, now); await enrichSafe(db, c.mint, c.bc, now);
  const { c: c2 } = seedPassable(db, st, now); await enrichSafe(db, c2.mint, c2.bc, now);
  L.recordFinderPasses(db, now, 5);
  feed(db, st, c.completeLogs(newKey()), slot + 1, now + 30 * 60_000);
  const r1 = L.updateFinderOutcomes(db, now + 30 * 60_000);
  assert.equal(r1.graduated, 1);
  assert.equal(q1(db, `SELECT outcome FROM finder_outcomes WHERE token = ?`, c.mint).outcome, 'graduated');
  const r2 = L.updateFinderOutcomes(db, now + 25 * 3_600_000); // +25h: the other coin, never rugged nor graduated, times out
  assert.equal(r2.timedOut, 1);
  assert.equal(q1(db, `SELECT outcome FROM finder_outcomes WHERE token = ?`, c2.mint).outcome, 'timeout_24h');
});

test('finderOutcomeStats: honest small-sample caveat, and outcome counts add up', async () => {
  const db = openDb(':memory:'); const now = Date.now();
  const s0 = L.finderOutcomeStats(db, now);
  assert.equal(s0.totalTracked, 0); assert.match(s0.caveats[0], /too few/);
  run(db, `INSERT INTO finder_outcomes (token, scanned_at, score, coverage_bps, entry_v_sol, entry_v_tok, entry_liq_lamports, status, outcome, outcome_at, last_checked_at) VALUES ('a',?,60,9000,'1','1','1','complete','rugged',?,?)`, now, now, now);
  run(db, `INSERT INTO finder_outcomes (token, scanned_at, score, coverage_bps, entry_v_sol, entry_v_tok, entry_liq_lamports, status, outcome, outcome_at, last_checked_at) VALUES ('b',?,60,9000,'1','1','1','complete','graduated',?,?)`, now, now, now);
  const s1 = L.finderOutcomeStats(db, now);
  assert.equal(s1.totalTracked, 2); assert.deepEqual(s1.outcomeCounts, { rugged: 1, graduated: 1 });
});
