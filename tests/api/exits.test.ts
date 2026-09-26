// Exit system, service level, PAPER mode: real quotes → intents → paper orders → fills, controlled trigger prices.
// Covers the owner's worked example end to end and the failure cases (revert, uncertain, crash/restart, stale, kill switch, DB invariants).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q1, qa, run } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import * as X from '../../apps/api/src/exits.ts';
import * as D from '../../packages/domain/src/index.ts';
import { fixtureTokens, priceAt, demoNow } from '../../packages/test-fixtures/src/index.ts';

const NOW = demoNow();
const POLICY = { maxPerTrade: '1', maxPerAssetExposure: '3', maxDailyGrossBuy: '10', maxRealizedDailyLoss: '5', maxOpenPositions: 20, maxSlippageBps: 1500, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false };
const CFG: D.ExitConfig = { stopLoss: { enabled: true, pct: '20' }, partialTp: { enabled: true, triggerPct: '100', sellPct: '50' }, trailing: { enabled: true, pct: '20', activation: 'after_partial' } };
const TOKENS = fixtureTokens('solana').filter(t => t.createdAt < NOW - 3_600_000 && priceAt(t, NOW) !== null && t.liquidityBase !== null);

function setup(tokenIdx = 0, qty = '100') {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  const tok = TOKENS[tokenIdx];
  run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) VALUES (?, ?, ?, ?)`, u, w, tok.address, qty); // 100 tokens held, bought at 100 (owner's example)
  let px: string | D.ExitState | any = '100';
  S._testing.setPriceOverride((t) => (t === tok.address ? px : undefined as any));
  const s = S.createStrategy(db, u, { kind: 'position_exit', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { exit: CFG, entryUsd: '100', qty } }, NOW);
  let t = NOW;
  const tick = (price: any, o: { fault?: any; dt?: number } = {}) => { px = price; t += o.dt ?? 1000; return S.evaluateAll(db, 'worker-1', t, { fault: o.fault }).find(r => r.id === s.id)?.outcome; };
  const view = () => S.strategyView(db, u, s.id);
  const held = () => q1(db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, tok.address)?.qty as string;
  const exitOrders = () => qa(db, `SELECT id, rule, qty, state, sold_qty, reason FROM exit_orders WHERE strategy_id = ? ORDER BY planned_at, id`, s.id);
  const sells = () => qa(db, `SELECT id, state, amount_in FROM orders WHERE strategy_id = ? AND side = 'sell' ORDER BY created_at`, s.id);
  const events = () => qa(db, `SELECT kind, detail FROM strategy_events WHERE strategy_id = ? ORDER BY id`, s.id).map(e => ({ kind: e.kind as string, detail: JSON.parse(e.detail ?? 'null') }));
  return { db, u, w, tok, s, tick, view, held, exitOrders, sells, events, get t() { return t; }, set t(v: number) { t = v; } };
}

test("PAPER, owner's worked example end to end: SL 80; +100% sells 50 tokens once; trail 20% from peak 250 → 200; recalculates on new peak", () => {
  const e = setup();
  const lv = e.view().exit!.levels; assert.equal(lv.stopLoss, '80'); assert.equal(lv.partialTp, '200');
  assert.equal(e.tick('150'), 'waiting');
  assert.equal(e.tick('200'), 'exit_partial_tp');
  assert.equal(e.held(), '50', '50 tokens sold, 50 held'); assert.equal(e.view().state.partial, 'done'); assert.equal(e.view().state.trailing.status, 'active');
  assert.equal(e.tick('200'), 'waiting'); assert.equal(e.view().state.trailing.trigger, '160');
  assert.equal(e.tick('250'), 'waiting'); assert.equal(e.view().state.trailing.trigger, '200', 'peak 250 → trigger 200');
  assert.equal(e.tick('260'), 'waiting'); assert.equal(e.view().state.trailing.trigger, '208', 'new peak → recalculated');
  assert.equal(e.tick('230'), 'waiting'); assert.equal(e.view().state.trailing.trigger, '208', 'never down');
  assert.equal(e.tick('208'), 'exit_trailing');
  assert.equal(e.held(), '0'); assert.equal(e.view().lifecycle, 'completed'); assert.equal(e.view().state.closeReason, 'TRAILING_STOP');
  assert.deepEqual(e.exitOrders().map(o => [o.rule, o.qty, o.state]), [['partial_tp', '50', 'filled'], ['trailing', '50', 'filled']]);
  assert.equal(e.sells().filter(o => o.state === 'finalized').length, 2);
  const kinds = e.events().map(x => x.kind);
  for (const k of ['exit.partial_triggered', 'exit.order_planned', 'exit.order_sent', 'exit.order_filled', 'exit.trailing_activated', 'exit.trailing_peak_started', 'exit.trailing_raised', 'exit.stop_triggered', 'exit.closed'])
    assert.ok(kinds.includes(k), `logged ${k}`);
});

test('PAPER: initial stop-loss at 80 sells all 100 tokens', () => {
  const e = setup(1);
  assert.equal(e.tick('80.5'), 'waiting'); assert.equal(e.tick('80'), 'exit_stop_loss'); assert.equal(e.held(), '0');
});

test('PAPER: reverted partial sale is retried with a new order id after backoff and sells exactly once', () => {
  const e = setup(2);
  assert.match(e.tick('200', { fault: 'revert' })!, /exit_failed/);
  assert.equal(e.held(), '100', 'nothing sold'); assert.equal(e.view().state.partial, 'armed', 'NOT marked done');
  assert.equal(e.tick('200', { dt: 500 }), 'waiting', 'inside backoff');
  assert.equal(e.tick('200', { dt: 3000 }), 'exit_partial_tp');
  const eo = e.exitOrders(); assert.deepEqual(eo.map(o => o.state), ['failed', 'filled']); assert.notEqual(eo[0].id, eo[1].id);
  assert.equal(e.held(), '50'); assert.equal(e.tick('300'), 'waiting'); assert.equal(e.held(), '50', 'never a second partial');
});

test('PAPER: uncertain submission is never resubmitted; reconciliation settles it; then protection continues', () => {
  const e = setup(3);
  assert.equal(e.tick('200', { fault: 'timeout_after_dispatch' }), 'pending:partial_tp');
  assert.equal(e.tick('50'), 'awaiting_reconciliation', 'price crashed through SL, but this coin has an uncertain order: wait, never a second order');
  assert.equal(e.sells().length, 1, 'no second order while uncertain');
  const o = e.sells()[0]; T.reconcileOrder(e.db, e.u, o.id, e.t);
  assert.equal(e.tick('50'), 'exit_stop_loss', 'after the partial settled, SL sells the rest');
  assert.equal(e.held(), '0'); assert.deepEqual(e.exitOrders().map(x => [x.rule, x.state]), [['partial_tp', 'filled'], ['stop_loss', 'filled']]);
});

test('PAPER: uncertain then NOT landed → expired → retried as a new order', () => {
  const e = setup(4);
  e.tick('70', { fault: 'timeout_not_landed' });
  T.reconcileOrder(e.db, e.u, e.sells()[0].id, e.t);
  assert.match(e.tick('70')!, /exit_failed|waiting/);
  assert.equal(e.tick('70', { dt: 5000 }), 'exit_stop_loss'); assert.equal(e.held(), '0');
  assert.deepEqual(e.exitOrders().map(x => x.state), ['failed', 'filled']);
});

test('PAPER restart: crash right after the write-ahead commit → nothing was sent → re-decided, sold once', () => {
  const e = setup(5);
  X._testHooks.crash = 'after_plan'; try { assert.match(e.tick('200')!, /error:SIMULATED_CRASH_AFTER_PLAN/); } finally { X._testHooks.crash = null; }
  assert.equal(e.exitOrders()[0].state, 'planned'); assert.equal(e.sells().length, 0);
  e.tick('200'); // recovery: no intent under this id → closed as not-sent
  assert.equal(e.exitOrders()[0].state, 'failed'); assert.equal(e.exitOrders()[0].reason, 'NOT_SENT_BEFORE_RESTART');
  assert.equal(e.tick('200', { dt: 3000 }), 'exit_partial_tp'); assert.equal(e.held(), '50'); assert.equal(e.sells().length, 1);
});

test('PAPER restart: crash right after the order was sent (before bookkeeping) → recovered from the idempotency record, NOT sold twice', () => {
  const e = setup(6);
  X._testHooks.crash = 'after_submit'; try { assert.match(e.tick('200')!, /error:SIMULATED_CRASH_AFTER_SUBMIT/); } finally { X._testHooks.crash = null; }
  assert.equal(e.held(), '50', 'the sale happened'); assert.equal(e.exitOrders()[0].order_id ?? null, null, 'but was not recorded before the crash');
  assert.equal(e.tick('200'), 'waiting');
  assert.ok(e.events().some(x => x.kind === 'exit.recovered_order'));
  assert.equal(e.view().state.partial, 'done'); assert.equal(e.sells().length, 1, 'exactly one sell'); assert.equal(e.held(), '50');
  assert.equal(e.tick('300'), 'waiting'); assert.equal(e.sells().length, 1);
});

test('PAPER: partial sells a share of tokens actually held (external sale of 30 before trigger)', () => {
  const e = setup(7);
  run(e.db, `UPDATE paper_balances SET qty = '70' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address);
  assert.equal(e.tick('200'), 'exit_partial_tp'); assert.equal(e.exitOrders()[0].qty, '35'); assert.equal(e.held(), '35');
  assert.ok(e.events().some(x => x.kind === 'exit.reconciled'));
});

test('PAPER: stale price never triggers; logged and notified once; fresh price resumes', () => {
  const e = setup(8);
  assert.equal(e.tick({ usd: '10', at: NOW - 3_600_000, source: 'test', staleReason: null }), 'waiting');
  assert.equal(e.tick({ usd: '10', at: null, source: 'test', staleReason: 'INDEXER_DOWN' }), 'waiting');
  assert.equal(e.held(), '100'); assert.equal(e.events().filter(x => x.kind === 'exit.price_stale').length, 1);
  assert.ok(q1(e.db, `SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Exit protection waiting%'`, e.u));
  assert.equal(e.tick('10'), 'exit_stop_loss');
});

test('PAPER: kill switch stops exits (disclosed as unprotected); resume re-protects', () => {
  const e = setup(9);
  S.setKillSwitch(e.db, e.u, true, e.t);
  assert.equal(e.view().lifecycle, 'paused');
  S.setKillSwitch(e.db, e.u, false, e.t); S.setStrategyLifecycle(e.db, e.u, e.s.id, 'resume', e.t);
  assert.equal(e.tick('70'), 'exit_stop_loss'); assert.equal(e.held(), '0');
});

test('DB invariants: the partial take-profit can be filled only once; one exit order in flight per position', () => {
  const e = setup(10);
  e.tick('200');
  assert.throws(() => run(e.db, `INSERT INTO exit_orders (id, user_id, strategy_id, rule, qty, trigger_price, observed_price, state, planned_at, updated_at) VALUES ('dup', ?, ?, 'partial_tp', '1', '1', '1', 'filled', 1, 1)`, e.u, e.s.id), /UNIQUE/);
  run(e.db, `INSERT INTO exit_orders (id, user_id, strategy_id, rule, qty, trigger_price, observed_price, state, planned_at, updated_at) VALUES ('open1', ?, ?, 'stop_loss', '1', '1', '1', 'planned', 1, 1)`, e.u, e.s.id);
  assert.throws(() => run(e.db, `INSERT INTO exit_orders (id, user_id, strategy_id, rule, qty, trigger_price, observed_price, state, planned_at, updated_at) VALUES ('open2', ?, ?, 'trailing', '1', '1', '1', 'submitted', 1, 1)`, e.u, e.s.id), /UNIQUE/);
});

test('uncertain order on ANOTHER coin does not freeze this coin\'s stop-loss', () => {
  const e = setup(11);
  const other = TOKENS[12];
  const q = T.createQuote(e.db, e.u, { chain: 'solana', tokenAddress: other.address, side: 'buy', amount: '0.1', slippageBps: 500, walletId: e.w }, e.t);
  const i = T.createIntent(e.db, e.u, { quoteId: q.id, source: 'manual' }, e.t, 'other-buy-1'); T.approveIntent(e.db, e.u, i.id, {}, e.t);
  T.executeIntent(e.db, e.u, i.id, e.t, 'other-exec-1', 'timeout_after_dispatch');
  assert.ok(q1(e.db, `SELECT 1 FROM orders WHERE state = 'reconciliation_required' AND token = ?`, other.address));
  assert.equal(e.tick('70'), 'exit_stop_loss');
});

test('auto trader with an exit plan: each buy gets a position_exit whose entry is the ACTUAL fill price', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  S._testing.setPriceOverride(() => undefined as any);
  const a = S.createStrategy(db, u, { kind: 'auto_trader', chain: 'solana', walletId: w, params: { amount: '0.1', minScore: 0, maxPositions: 1, exit: CFG } }, NOW);
  S.evaluateAll(db, 'w', NOW + 60_000);
  const child = S.listStrategies(db, u).find(x => x.parentId === a.id);
  assert.ok(child, 'a position was opened'); assert.equal(child!.kind, 'position_exit');
  const buy = q1(db, `SELECT o.amount_in, o.filled_out, f.unit_usd FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.strategy_id = ? AND o.side = 'buy'`, a.id);
  assert.ok(D.eq(child!.state.entry, D.rescale(buy.unit_usd, 18)), 'entry = this buy\'s fill price (SOL in × SOL/USD ÷ tokens out)');
  assert.equal(child!.state.originalQty, D.floorQty(buy.filled_out, child!.state.decimals));
  const pv = X.exitPreview(db, u, { config: CFG, chain: 'solana', strategyId: child!.id }, NOW);
  assert.equal(pv.basis, 'strategy'); assert.equal(pv.stopLoss!.trigger, D.stopLossPrice(child!.state.entry, '20'));
});

test('API services: presets CRUD, exact preview for a manual position, override with version check', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  S._testing.setPriceOverride(() => undefined as any);
  const tok = TOKENS[13];
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.2', slippageBps: 500, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, 'pv-buy-1'); T.approveIntent(db, u, i.id, {}, NOW); const o = T.executeIntent(db, u, i.id, NOW, 'pv-exec-1');
  const pv = X.exitPreview(db, u, { config: CFG, chain: 'solana', tokenAddress: tok.address, walletId: w }, NOW);
  assert.equal(pv.basis, 'position'); assert.equal(pv.qty, D.floorQty(o.filledOut, tok.decimals));
  const fill = q1(db, `SELECT unit_usd FROM fills WHERE order_id = ?`, o.id).unit_usd;
  assert.ok(D.eq(pv.entry!, D.rescale(fill, 18)), 'entry is the fill price, not cost basis with fees');
  assert.equal(pv.partialTp!.sellsQty, D.partialSellQty(pv.qty!, '50', tok.decimals));
  const est = X.exitPreview(db, u, { config: CFG, chain: 'solana', tokenAddress: TOKENS[14].address, amount: '0.1' }, NOW); assert.equal(est.basis, 'estimate');
  const bad = X.exitPreview(db, u, { config: { ...CFG, stopLoss: { enabled: true, pct: '0' } }, chain: 'solana', tokenAddress: tok.address, walletId: w }, NOW); assert.ok(bad.issues.length > 0);
  // presets
  const p1 = X.saveExitPreset(db, u, { name: 'My tight', config: { ...CFG, stopLoss: { enabled: true, pct: '10' } } }, NOW)!;
  assert.equal(p1.version, 1); assert.throws(() => X.saveExitPreset(db, u, { name: 'My tight', config: CFG, version: 0 }, NOW), /changed elsewhere/);
  assert.equal(X.saveExitPreset(db, u, { name: 'My tight', config: CFG, version: 1 }, NOW)!.version, 2);
  assert.throws(() => X.saveExitPreset(db, u, { name: 'balanced', config: CFG }, NOW), /built-in/);
  assert.throws(() => X.saveExitPreset(db, u, { name: 'x', config: { ...CFG, trailing: { enabled: true, pct: '150', activation: 'immediate' } } }, NOW), /Trailing distance/);
  assert.equal(X.listExitPresets(db, u).filter(p => !p.builtin).length, 1); X.deleteExitPreset(db, u, p1.id); assert.equal(X.listExitPresets(db, u).filter(p => !p.builtin).length, 0);
  // manual position exit via the API path (entry/qty from the real position) + override
  const s = S.createStrategy(db, u, { kind: 'position_exit', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { exit: CFG } }, NOW);
  assert.equal(s.params.entrySource, 'fills'); assert.ok(D.eq(s.state.entry, D.rescale(fill, 18)));
  assert.throws(() => X.overrideExit(db, u, s.id, { config: CFG, version: s.version + 5 }, NOW), /changed since you opened it/);
  const v2 = X.overrideExit(db, u, s.id, { config: { ...CFG, stopLoss: { enabled: true, pct: '10' } }, version: s.version }, NOW);
  assert.equal(v2.exit!.levels.stopLoss, D.stopLossPrice(s.state.entry, '10'));
  assert.throws(() => S.createStrategy(db, u, { kind: 'position_exit', chain: 'solana', tokenAddress: TOKENS[15].address, walletId: w, params: { exit: CFG } }, NOW), /No position/);
});

test('legacy TP/SL regression: a reverted stop-loss is retried, not marked done', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  const tok = TOKENS[16];
  const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: tok.address, side: 'buy', amount: '0.5', slippageBps: 500, walletId: w }, NOW);
  const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, NOW, 'leg-buy-1'); T.approveIntent(db, u, i.id, {}, NOW); const o = T.executeIntent(db, u, i.id, NOW, 'leg-exec-1');
  let px = '1'; S._testing.setPriceOverride((t) => (t === tok.address ? px : undefined as any));
  const s = S.createStrategy(db, u, { kind: 'tp_sl', chain: 'solana', tokenAddress: tok.address, walletId: w, params: { stopLoss: '0.2', entryUsd: '1', qty: o.filledOut } }, NOW);
  px = '0.7';
  assert.equal(S.evaluateAll(db, 'w', NOW + 1000, { fault: 'revert' }).find(r => r.id === s.id)?.outcome, 'exit_failed:sl');
  assert.equal(S.strategyView(db, u, s.id).lifecycle, 'active');
  assert.equal(S.evaluateAll(db, 'w', NOW + 3000).find(r => r.id === s.id)?.outcome, 'exit_sl');
  assert.equal(q1(db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, tok.address).qty, '0');
});
