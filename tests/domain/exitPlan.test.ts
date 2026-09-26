// Exit plan state machine: the owner's worked example, every rule, and failure cases. Pure (no DB, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../packages/domain/src/index.ts';

const CFG: D.ExitConfig = { stopLoss: { enabled: true, pct: '20' }, partialTp: { enabled: true, triggerPct: '100', sellPct: '50' }, trailing: { enabled: true, pct: '20', activation: 'after_partial' } };
const STALE = 30_000;
/** Drive the machine like the worker does: observe → maybe an order → the test decides the order's outcome. */
function sim(cfg = CFG, entry = '100', qty = '100', decimals = 6) {
  let s = D.newExitState(cfg, entry, qty, decimals); let held = D.floorQty(qty, decimals); let t = 1_000_000; const log: D.ExitEvent[] = []; const orders: D.PendingExit[] = [];
  const api = {
    get s() { return s; }, get held() { return held; }, set held(v: string) { held = v; }, log, orders,
    tick(price: string | null, o: { age?: number; dust?: string } = {}) {
      t += 1000; const st = D.decideExit(s, { now: t, price, priceAt: price === null ? null : t - (o.age ?? 0), heldQty: held, staleAfterMs: STALE, dustQty: o.dust }, 'pos1');
      s = st.state; log.push(...st.events); if (st.order) orders.push(st.order); return st.order;
    },
    fill(sold?: string) { const p = s.pending!; const r = D.applyOrderResult(s, { id: p.id, outcome: 'filled', soldQty: sold ?? p.qty }, t); held = D.str(D.sub(held, sold ?? p.qty)); s = r.state; log.push(...r.events); return r; },
    fail(reason = 'REVERTED') { const r = D.applyOrderResult(s, { id: s.pending!.id, outcome: 'failed', reason }, t); s = r.state; log.push(...r.events); return r; },
    wait(ms: number) { t += ms; },
  };
  return api;
}

test("owner's worked example: 100 @ 100, SL 20% → 80; +100% sells 50 once; trail 20% from post-activation peak", () => {
  const pv = D.previewExitPlan(CFG, '100', '100', 6);
  assert.deepEqual(pv.issues, []);
  assert.equal(pv.stopLoss!.trigger, '80', 'initial stop trigger is 80');
  assert.equal(pv.partialTp!.trigger, '200', '+100% from 100 is 200');
  assert.equal(pv.partialTp!.sellsQty, '50'); assert.equal(pv.partialTp!.keepsQty, '50');
  assert.equal(pv.trailing!.activatesAt, '200'); assert.equal(pv.trailing!.protectsQty, '50'); assert.equal(pv.trailing!.exampleTrigger, '160');

  const m = sim();
  assert.equal(m.tick('150'), null); assert.equal(m.tick('80.000001'), null, 'just above the stop: nothing');
  const tp = m.tick('200');
  assert.ok(tp); assert.equal(tp!.rule, 'partial_tp'); assert.equal(tp!.qty, '50', 'sells 50 tokens (half the quantity), not half the profit');
  assert.equal(m.tick('210'), null, 'nothing else while the sale is pending');
  m.fill();
  assert.equal(m.s.partial, 'done'); assert.equal(m.s.managedQty, '50'); assert.equal(m.s.trailing.status, 'active', 'trailing activates after the partial is confirmed filled');
  assert.equal(m.s.trailing.peak, null, 'peak starts from prices observed after activation');
  assert.equal(m.tick('200'), null); assert.equal(m.s.trailing.trigger, '160');
  assert.equal(m.tick('200'), null, 'duplicate price event: no order'); assert.equal(m.orders.length, 1);
  assert.equal(m.tick('250'), null); assert.equal(m.s.trailing.peak, '250'); assert.equal(m.s.trailing.trigger, '200', 'peak 250 → trigger 200');
  assert.equal(m.tick('210'), null, 'above the trailing trigger');
  assert.equal(m.tick('260'), null); assert.equal(m.s.trailing.trigger, '208', 'price rose again: recalculated from the new peak');
  assert.equal(m.tick('230'), null); assert.equal(m.s.trailing.trigger, '208', 'trigger never moves down');
  assert.equal(m.tick('400'), null); assert.equal(m.tick('400'), null);
  assert.equal(m.orders.filter(o => o.rule === 'partial_tp').length, 1, 'partial take-profit executed once only');
  const out = m.tick('320');
  assert.ok(out); assert.equal(out!.rule, 'trailing'); assert.equal(out!.qty, '50', 'sells the remaining 50'); assert.equal(out!.triggerPrice, '320');
  m.fill(); assert.equal(m.s.status, 'closed'); assert.equal(m.s.closeReason, 'TRAILING_STOP');
  assert.equal(m.tick('1'), null, 'closed: nothing more');
});

test('worked example, second path: peak 250 then a drop to exactly 200 sells the remaining 50', () => {
  const m = sim(); m.tick('200'); m.fill(); m.tick('250');
  assert.equal(m.s.trailing.trigger, '200');
  const o = m.tick('200'); assert.equal(o!.rule, 'trailing'); assert.equal(o!.qty, '50');
});

test('initial stop-loss: at 80 sells all 100; at 80.01 nothing', () => {
  const m = sim();
  assert.equal(m.tick('80.01'), null);
  const o = m.tick('80'); assert.equal(o!.rule, 'stop_loss'); assert.equal(o!.qty, '100'); assert.equal(o!.triggerPrice, '80');
  m.fill(); assert.equal(m.s.closeReason, 'STOP_LOSS');
});

test('stop-loss stays active after the partial; the higher stop wins', () => {
  const m = sim(); m.tick('200'); m.fill(); m.tick('200'); // trailing 160 > SL 80
  const o = m.tick('150'); assert.equal(o!.rule, 'trailing'); assert.equal(o!.triggerPrice, '160');
  const n = sim({ ...CFG, trailing: { enabled: true, pct: '90', activation: 'after_partial' } }); n.tick('200'); n.fill(); n.tick('200'); // trailing 20 < SL 80
  const o2 = n.tick('79'); assert.equal(o2!.rule, 'stop_loss', 'SL at 80 is higher than a 90% trail (20)');
});

test('failed partial take-profit is NOT marked done: retried after backoff with a new order id, still sold once', () => {
  const m = sim();
  const a = m.tick('200')!; m.fail('SIMULATED_REVERT');
  assert.equal(m.s.partial, 'armed'); assert.equal(m.s.managedQty, '100'); assert.equal(m.s.pending, null);
  assert.equal(m.tick('200'), null, 'inside the backoff window: no order');
  m.wait(2_000);
  const b = m.tick('200')!; assert.notEqual(b.id, a.id, 'new attempt → new idempotent order id'); assert.equal(b.qty, '50');
  m.fill(); assert.equal(m.tick('300'), null);
  assert.equal(m.log.filter(e => e.kind === 'order_filled').length, 1);
});

test('failed stop-loss is retried until it fills; position never marked closed while tokens are held', () => {
  const m = sim();
  m.tick('70'); m.fail(); assert.equal(m.s.status, 'active'); assert.equal(m.s.managedQty, '100');
  m.wait(2_000); m.tick('70'); m.fail(); m.wait(4_000); m.tick('70'); m.fail();
  assert.ok(m.log.some(e => e.kind === 'needs_attention'), 'third consecutive failure raises attention');
  m.wait(8_000); const o = m.tick('65')!; assert.equal(o.qty, '100'); m.fill(); assert.equal(m.s.status, 'closed');
});

test('uncertain order stays pending; no second order; duplicate or stale results are ignored', () => {
  const m = sim(); const o = m.tick('200')!;
  const u = D.applyOrderResult(m.s, { id: o.id, outcome: 'uncertain', reason: 'TIMEOUT' }, 0);
  assert.equal(u.state.pending!.id, o.id);
  assert.equal(D.decideExit(u.state, { now: 9e9, price: '10', priceAt: 9e9, heldQty: '100', staleAfterMs: STALE }, 'pos1').order, null, 'crash through SL while pending: still one order at a time');
  const f = D.applyOrderResult(u.state, { id: o.id, outcome: 'filled', soldQty: '50' }, 1);
  const dup = D.applyOrderResult(f.state, { id: o.id, outcome: 'filled', soldQty: '50' }, 2);
  assert.equal(dup.state.managedQty, '50', 'second delivery of the same fill changes nothing'); assert.equal(dup.events[0].kind, 'result_ignored');
});

test('conflict: price crashes through SL while the partial sale is pending → after it fills, SL sells only what is left', () => {
  const m = sim(); m.tick('200');
  assert.equal(m.tick('50'), null, 'pending partial blocks a second order');
  m.fill();
  const sl = m.tick('50')!; assert.equal(sl.rule, 'stop_loss'); assert.equal(sl.qty, '50', 'never more than held');
});

test('short fill on the partial is logged and never topped up (owner decision)', () => {
  const m = sim(); m.tick('200'); m.fill('48');
  assert.ok(m.log.some(e => e.kind === 'short_fill')); assert.equal(m.s.partialFilledQty, '48'); assert.equal(m.s.managedQty, '52');
  assert.equal(m.tick('300'), null); assert.equal(m.orders.length, 1);
});

test('partial sells a share of tokens HELD at trigger time (after an external reduction)', () => {
  const m = sim(); m.held = '70'; // user sold 30 manually
  const o = m.tick('200')!; assert.equal(o.qty, '35'); assert.ok(m.log.some(e => e.kind === 'reconciled'));
});

test('insufficient balance: stop sells only what is actually held; held 0 closes the plan', () => {
  const m = sim(); m.held = '12.5'; const o = m.tick('10')!; assert.equal(o.qty, '12.5');
  const n = sim(); n.held = '0'; assert.equal(n.tick('10'), null); assert.equal(n.s.closeReason, 'POSITION_GONE');
});

test('stale, missing and out-of-order prices never trigger or move the peak', () => {
  const m = sim();
  assert.equal(m.tick('10', { age: STALE + 1 }), null, 'stale price below SL: no sale');
  assert.equal(m.tick(null), null);
  assert.equal(m.log.filter(e => e.kind === 'price_stale').length, 1, 'logged once');
  assert.equal(m.tick('150'), null); assert.ok(m.log.some(e => e.kind === 'price_fresh'));
  const s1 = m.s; const older = D.decideExit(s1, { now: 5e9, price: '10', priceAt: s1.lastPrice!.at - 1, heldQty: '100', staleAfterMs: 9e9 }, 'pos1');
  assert.equal(older.order, null, 'an older observation than the last used is ignored');
  assert.equal(m.tick('0'), null, 'zero price is invalid');
});

test('same tick: trailing stop and partial trigger → protective stop sells all, partial skipped', () => {
  const cfg: D.ExitConfig = { ...CFG, trailing: { enabled: true, pct: '20', activation: 'immediate' } };
  const m = sim(cfg); const first = m.tick('300')!; assert.equal(first.rule, 'partial_tp', 'at 300 the partial fires first'); assert.equal(m.s.trailing.trigger, '240');
  m.fail(); m.wait(2_000); // partial failed → armed again
  const o = m.tick('230')!; assert.equal(o.rule, 'trailing', '230 is both ≥ TP 200 and ≤ trail 240: the stop wins'); assert.equal(o.qty, '100'); assert.equal(m.s.partial, 'skipped');
});

test('trailing activation options: at +X% gain, and immediately', () => {
  const g = sim({ ...CFG, trailing: { enabled: true, pct: '10', activation: 'at_gain', activationGainPct: '50' } });
  g.tick('140'); assert.equal(g.s.trailing.status, 'waiting'); g.tick('150'); assert.equal(g.s.trailing.status, 'active'); assert.equal(g.s.trailing.trigger, '135');
  assert.equal(D.previewExitPlan({ ...CFG, trailing: { enabled: true, pct: '10', activation: 'at_gain', activationGainPct: '50' } }, '100', '100', 6).trailing!.protectsQty, '100');
  const i = sim({ ...CFG, trailing: { enabled: true, pct: '10', activation: 'immediate' } }); i.tick('100'); assert.equal(i.s.trailing.trigger, '90');
});

test('rounding: quantities floor to token decimals; dust is not sold', () => {
  const pv = D.previewExitPlan(CFG, '100', '100.0000005', 6); assert.equal(pv.qty, '100'); assert.equal(pv.partialTp!.sellsQty, '50');
  assert.equal(D.partialSellQty('3', '33.33', 0), '0');
  const m = sim({ ...CFG, partialTp: { enabled: true, triggerPct: '100', sellPct: '30' } }, '1', '3', 0); // 30% of 3 = 0.9 → floors to 0
  assert.equal(m.tick('2'), null, 'partial rounds to 0 tokens → skipped'); assert.equal(m.s.partial, 'skipped'); assert.equal(m.s.trailing.status, 'active', 'trailing still protects the rest');
  const d = sim(); const o = d.tick('10', { dust: '101' }); assert.equal(o, null); assert.equal(d.s.closeReason, 'DUST_REMAINDER');
});

test('validation rejects bad input instead of substituting', () => {
  const codes = (c: D.ExitConfig) => D.validateExitConfig(c).map(x => x.code);
  assert.deepEqual(codes(CFG), []);
  assert.ok(codes({ ...CFG, stopLoss: { enabled: true, pct: '0' } }).includes('OUT_OF_RANGE'));
  assert.ok(codes({ ...CFG, stopLoss: { enabled: true, pct: '100' } }).includes('OUT_OF_RANGE'));
  assert.ok(codes({ ...CFG, stopLoss: { enabled: true, pct: 'abc' } }).includes('NOT_A_NUMBER'));
  assert.ok(codes({ ...CFG, partialTp: { enabled: true, triggerPct: '100', sellPct: '0' } }).includes('OUT_OF_RANGE'));
  assert.ok(codes({ ...CFG, partialTp: { enabled: false, triggerPct: '100', sellPct: '50' } }).includes('TRAIL_NEEDS_PARTIAL'));
  assert.ok(codes({ ...CFG, partialTp: { enabled: true, triggerPct: '100', sellPct: '100' } }).includes('TRAIL_NOTHING_LEFT'));
  assert.ok(codes({ stopLoss: { enabled: false, pct: '20' }, partialTp: { enabled: false, triggerPct: '1', sellPct: '1' }, trailing: { enabled: false, pct: '1', activation: 'immediate' } }).includes('NO_RULES'));
  assert.throws(() => D.newExitState({ ...CFG, trailing: { enabled: true, pct: '0', activation: 'immediate' } }, '100', '100', 6), /EXIT_CONFIG_INVALID/);
  assert.deepEqual(D.normalizeExitConfig({ stopLoss: { enabled: true, pct: 20, junk: 1 }, partialTp: { enabled: false }, trailing: { enabled: false } }).stopLoss, { enabled: true, pct: '20' });
});

test('override: done partial stays done; loosening an active trail keeps the higher trigger', () => {
  const m = sim(); m.tick('200'); m.fill(); m.tick('250'); assert.equal(m.s.trailing.trigger, '200');
  const r = D.overrideExitConfig(m.s, { ...CFG, trailing: { enabled: true, pct: '30', activation: 'after_partial' } }, 0);
  assert.equal(r.state.partial, 'done'); assert.equal(r.state.trailing.trigger, '200'); assert.ok(r.events.some(e => e.kind === 'trailing_kept_higher'));
  const t = D.decideExit(r.state, { now: 9e9, price: '260', priceAt: 9e9, heldQty: '50', staleAfterMs: STALE }, 'pos1');
  assert.equal(t.state.trailing.trigger, '200', 'new peak 260 × 0.7 = 182 would be lower → trigger stays 200');
  const tight = D.overrideExitConfig(m.s, { ...CFG, trailing: { enabled: true, pct: '10', activation: 'after_partial' } }, 0);
  assert.equal(tight.state.trailing.trigger, '225', 'tightening applies immediately from the current peak');
});

test('property: random walks never sell more than held, never sell the partial twice, and the trailing trigger never falls', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 300; run++) {
    const cfg: D.ExitConfig = { stopLoss: { enabled: rnd() < 0.8, pct: String(5 + Math.floor(rnd() * 40)) }, partialTp: { enabled: true, triggerPct: String(10 + Math.floor(rnd() * 200)), sellPct: String(10 + Math.floor(rnd() * 80)) },
      trailing: { enabled: rnd() < 0.9, pct: String(5 + Math.floor(rnd() * 40)), activation: (['after_partial', 'immediate', 'at_gain'] as const)[Math.floor(rnd() * 3)], activationGainPct: '20' } };
    const m = sim(cfg, '1', String(1000 + Math.floor(rnd() * 1e6)) + '.123456', 6); let px = 1; let lastTrig: string | null = null; let soldTotal = D.dec('0');
    for (let k = 0; k < 400 && m.s.status === 'active'; k++) {
      px = Math.max(0.0001, px * (1 + (rnd() - 0.48) * 0.2)); if (rnd() < 0.05) m.held = D.str(D.floorQty(D.mul(m.held, '0.9'), 6)); // occasional external reduction
      const o = m.tick(px.toFixed(8));
      if (m.s.trailing.trigger) { if (lastTrig) assert.ok(D.gte(m.s.trailing.trigger, lastTrig), 'trigger never falls'); lastTrig = m.s.trailing.trigger; }
      if (o) {
        assert.ok(D.lte(o.qty, m.held), 'order qty ≤ held'); const roll = rnd();
        if (roll < 0.15) m.fail(); else if (roll < 0.2) { m.fill(D.floorQty(D.mul(o.qty, '0.9'), 6)); soldTotal = D.add(soldTotal, D.floorQty(D.mul(o.qty, '0.9'), 6)); } else { m.fill(); soldTotal = D.add(soldTotal, o.qty); }
        m.wait(60_000);
      }
    }
    assert.ok(D.lte(soldTotal, m.s.originalQty)); assert.ok(m.orders.filter(o => o.rule === 'partial_tp').length <= 1 + m.log.filter(e => e.kind === 'order_failed' && (e.detail as any).rule === 'partial_tp').length);
    assert.ok(m.log.filter(e => e.kind === 'order_filled' && (e.detail as any).rule === 'partial_tp').length <= 1, 'partial filled at most once');
  }
});
