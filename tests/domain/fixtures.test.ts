// Spec §14.2 arithmetic fixtures A01–A07 and §12.3 trailing example (T12, T28, T30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../packages/domain/src/index.ts';

const S = D.str;

test('A01 buy 100 @ $1 + $2 cost -> qty 100, basis 102, avg 1.02', () => {
  const b = D.applyBuy(D.emptyBucket(), '100', '1', '2');
  assert.equal(S(b.knownQty), '100'); assert.equal(S(b.knownBasis), '102'); assert.equal(S(D.averageBasis(b)!), '1.02');
});

test('A02 sell 50 @ $1.50, $1 cost -> proceeds 74, released 51, realized 23, remaining 50/51', () => {
  const b = D.applyBuy(D.emptyBucket(), '100', '1', '2');
  const r = D.applySell(b, '50', '1.50', '1');
  assert.equal(S(r.netProceeds), '74'); assert.equal(S(r.releasedBasis), '51'); assert.equal(S(r.realizedPnl), '23');
  assert.equal(S(r.bucket.knownQty), '50'); assert.equal(S(r.bucket.knownBasis), '51');
});

test('A03 mark remainder @ $1.40 -> value 70, unrealized 19, total 42', () => {
  const r = D.applySell(D.applyBuy(D.emptyBucket(), '100', '1', '2'), '50', '1.50', '1');
  const m = D.markToMarket(r.bucket, '1.40')!;
  assert.equal(S(m.markValue), '70'); assert.equal(S(m.unrealized), '19');
  assert.equal(S(D.add(m.unrealized, r.bucket.realized)), '42');
});

test('A04 equity P&L = 1600 - 1000 - 500 = 100 (not 600)', () => {
  assert.equal(S(D.equityPnl('1000', '1600', '500')), '100');
});

test('A05 minimumOutRaw(1,000,000, 100 bps) = 990,000', () => {
  assert.equal(D.minimumOutRaw('1000000', 100), 990000n);
  assert.equal(D.minimumOutRaw('999', 100), 989n); // floor
});

test('A06 staged exits 40/30/30 of original 100 -> 40,30,30; never > 100 with competing exits', () => {
  const q = D.stagedQuantities('100', [{ id: 'tp1', percentBps: 4000 }, { id: 'tp2', percentBps: 3000 }, { id: 'tp3', percentBps: 3000 }]);
  assert.deepEqual(q.map(x => x.qty), ['40', '30', '30']);
  assert.throws(() => D.stagedQuantities('100', [{ id: 'a', percentBps: 6000 }, { id: 'b', percentBps: 5000 }]), /STAGES_EXCEED_100_PERCENT/);
  let st: D.CoordinatorState = { remaining: '100', claimed: [], version: 0 };
  const r1 = D.claimExit(st, { exitId: 'tp1', kind: 'tp_stage', requestedQty: '40' }, 0); assert.ok(r1.ok); st = (r1 as any).state;
  const sl = D.claimExit(st, { exitId: 'sl', kind: 'stop', requestedQty: '100' }, 1); assert.ok(sl.ok); st = (sl as any).state;
  assert.equal((sl as any).qty, '60'); assert.equal((sl as any).reduced, true);
  const r2 = D.claimExit(st, { exitId: 'tp2', kind: 'tp_stage', requestedQty: '30' }, 2);
  assert.deepEqual(r2, { ok: false, code: 'NOTHING_REMAINING' });
  const total = st.claimed.reduce((a, c) => D.add(a, c.qty), D.dec('0'));
  assert.equal(S(total), '100');
});

test('A07/T30 copy fraction: source 1000 sells 250 -> task A 40 sells 10 (A=30, B=60)', () => {
  const r = D.followSell({ A: '40', B: '60' }, 'A', { sourcePreSellBalance: '1000', sourceSellQty: '250' });
  assert.ok(r.ok); assert.equal((r as any).sellQty, '10'); assert.deepEqual((r as any).after, { A: '30', B: '60' });
  assert.deepEqual(D.followSell({ A: '40' }, 'A', { sourcePreSellBalance: null, sourceSellQty: '250' }), { ok: false, code: 'SOURCE_POSITION_UNKNOWN' });
});

test('§12.3 trailing TP example E=100 a=20% d=10%: 119 inactive, 120 act@108, 150 ->135, 140 hold, 135 trigger once', () => {
  let s = D.newTrailingTp('100', '0.2', '0.1');
  let r = D.evalTrailingTp(s, '119'); assert.equal(r.state.active, false); assert.equal(r.triggered, false); s = r.state;
  r = D.evalTrailingTp(s, '120'); assert.equal(r.event, 'activated'); assert.equal(r.stop, '108'); s = r.state;
  r = D.evalTrailingTp(s, '150'); assert.equal(r.stop, '135'); assert.equal(r.event, 'raised'); s = r.state;
  r = D.evalTrailingTp(s, '140'); assert.equal(r.stop, '135'); assert.equal(r.triggered, false); s = r.state;
  s = JSON.parse(JSON.stringify(s)); // restart: durable JSON round-trip
  r = D.evalTrailingTp(s, '135'); assert.equal(r.triggered, true); s = r.state;
  r = D.evalTrailingTp(s, '130'); assert.equal(r.triggered, false, 'fires once');
});

test('trailing SL never moves down; fixed TP/SL from entry', () => {
  let s = D.newTrailingSl('100', '0.1');
  let r = D.evalTrailingSl(s, '120'); assert.equal(r.stop, '108'); s = r.state;
  r = D.evalTrailingSl(s, '110'); assert.equal(r.stop, '108'); assert.equal(r.triggered, false); s = r.state;
  r = D.evalTrailingSl(s, '108'); assert.equal(r.triggered, true);
  assert.equal(D.fixedTakeProfitPrice('100', '0.5'), '150'); assert.equal(D.fixedStopLossPrice('100', '0.25'), '75');
});
