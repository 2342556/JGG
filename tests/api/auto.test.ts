// Auto trader + auto exit plan (service level, controlled prices).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q1 } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import * as D from '../../packages/domain/src/index.ts';
import { fixtureTokens, priceAt, demoNow } from '../../packages/test-fixtures/src/index.ts';

const NOW = demoNow();
const POLICY = { maxPerTrade: '1', maxPerAssetExposure: '3', maxDailyGrossBuy: '10', maxRealizedDailyLoss: '5', maxOpenPositions: 20, maxSlippageBps: 1500, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false };
function setup() {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  return { db, u, w };
}

test('auto exits: TP1 at +50% sells half, trailing then sells the rest on retrace; never oversells', () => {
  const { db, u, w } = setup();
  const tok = fixtureTokens('solana').find(t => t.createdAt < NOW - 3_600_000 && priceAt(t, NOW) !== null && t.liquidityBase !== null)!;
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.5', slippageBps: 500, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, 'auto-exit-buy-1'); T.approveIntent(db, u, i.id, {}, NOW);
  const o = T.executeIntent(db, u, i.id, NOW, 'auto-exit-exec-1');
  const qty = o.filledOut as string;
  let px = '1';
  S._testing.setPriceOverride((t) => (t === tok.address ? px : undefined as any));
  try {
    const s = S.createStrategy(db, u, { kind: 'tp_sl', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { ...D.autoExitParams(D.DEFAULT_AUTO_EXIT), entryUsd: '1', qty } }, NOW);
    const step = (p: string, t: number) => { px = p; return S.evaluateAll(db, 'w', NOW + t).find(r => r.id === s.id)?.outcome; };
    assert.equal(step('1.2', 1000), 'waiting');
    assert.equal(step('1.5', 2000), 'exit_tp1', 'partial take-profit at +50%');
    let v = S.strategyView(db, u, s.id);
    assert.equal(v.state.trailing.active, true, 'trailing armed at +50%');
    assert.ok(D.eq(v.state.coord.remaining, D.sub(qty, v.state.tp[0].qty)));
    step('1.8', 3000); v = S.strategyView(db, u, s.id);
    assert.equal(v.state.trailing.peak, '1.8'); assert.equal(v.state.stop, '1.53');
    assert.equal(step('1.6', 4000), 'waiting', 'above stop');
    assert.equal(step('1.52', 5000), 'exit_trailing', 'retrace below peak×(1−15%) sells the rest');
    v = S.strategyView(db, u, s.id);
    assert.equal(v.lifecycle, 'completed'); assert.ok(D.isZero(v.state.coord.remaining));
    const sold = q1(db, `SELECT COUNT(*) n FROM orders WHERE strategy_id = ? AND side = 'sell'`, s.id).n;
    assert.equal(sold, 2);
    const bal = q1(db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, tok.address);
    assert.ok(D.gte(bal.qty, '0'), 'never negative');
  } finally { S._testing.setPriceOverride(null); }
});

test('auto exits: price runs to +100% → remainder taken at TP2; crash → stop-loss sells everything', () => {
  for (const path of [['1.5', '2.0'], ['0.69']]) {
    const { db, u, w } = setup();
    const tok = fixtureTokens('solana').filter(t => t.createdAt < NOW - 3_600_000 && priceAt(t, NOW) !== null && t.liquidityBase !== null)[1];
    const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.3', slippageBps: 500, walletId: w }, NOW);
    const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, `auto-exit-${path.join()}`); T.approveIntent(db, u, i.id, {}, NOW);
    const o = T.executeIntent(db, u, i.id, NOW, `auto-exit-x-${path.join()}`);
    let px = '1'; S._testing.setPriceOverride((t) => (t === tok.address ? px : undefined as any));
    try {
      const s = S.createStrategy(db, u, { kind: 'tp_sl', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { ...D.autoExitParams(D.DEFAULT_AUTO_EXIT), entryUsd: '1', qty: o.filledOut } }, NOW);
      const outs = path.map((p, k) => { px = p; return S.evaluateAll(db, 'w', NOW + (k + 1) * 1000).find(r => r.id === s.id)?.outcome; });
      if (path.length === 2) assert.deepEqual(outs, ['exit_tp1', 'exit_tp2']); else assert.deepEqual(outs, ['exit_sl']);
      assert.equal(S.strategyView(db, u, s.id).lifecycle, 'completed');
    } finally { S._testing.setPriceOverride(null); }
  }
});

test('auto trader: buys the top finder pick within policy, attaches the exit plan, never re-buys, honours maxPositions', () => {
  const { db, u, w } = setup();
  assert.equal(((): string => { try { S.createStrategy(db, u, { kind: 'auto_trader', chain: 'solana', walletId: w, params: { amount: '0.1', tpGain: '0.3' } }, NOW); return 'OK'; } catch (e) { return (e as any).code; } })(), 'VALIDATION_FAILED', 'invalid exit plan rejected');
  const s = S.createStrategy(db, u, { kind: 'auto_trader', chain: 'solana', walletId: w, params: { amount: '0.1', minScore: 0, maxPositions: 2, scanEverySec: 5 } }, NOW);
  const r1 = S.evaluateAll(db, 'w', NOW).find(r => r.id === s.id)!.outcome;
  assert.match(r1, /^bought:/);
  const child = S.listStrategies(db, u).find(x => x.parentId === s.id)!;
  assert.equal(child.kind, 'tp_sl');
  assert.deepEqual(child.params.stages, [{ percentBps: 5000, gain: '0.5' }, { percentBps: 5000, gain: '1' }]);
  assert.equal(child.state.trailing.kind, 'trailing_tp'); assert.equal(child.params.stopLoss, '0.3');
  const r2 = S.evaluateAll(db, 'w', NOW + 6000).find(r => r.id === s.id)!.outcome;
  const r3 = S.evaluateAll(db, 'w', NOW + 12_000).find(r => r.id === s.id)!.outcome;
  const bought = q1(db, `SELECT COUNT(DISTINCT token) n, COUNT(*) c FROM orders WHERE strategy_id = ? AND side = 'buy'`, s.id);
  assert.equal(bought.n, bought.c, 'each token bought at most once');
  assert.ok(bought.c <= 2, 'maxPositions respected'); assert.ok([r2, r3].includes('max_positions') || bought.c < 2);
  const perf = S.autoPerformance(db, u, s.id);
  assert.equal(perf.closedTrades, 0); assert.equal(perf.winRate, null, 'no win rate claimed without closed trades'); assert.match(perf.sampleNote, /too few/);
  S.setKillSwitch(db, u, true, NOW + 13_000);
  assert.equal(S.strategyView(db, u, s.id).lifecycle, 'paused', 'kill switch stops the auto trader');
});
