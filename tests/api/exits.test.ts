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
  assert.throws(() => X.overrideExit(db, u, s.id, { config: CFG, version: 5 }, NOW), /edited elsewhere/);
  const v2 = X.overrideExit(db, u, s.id, { config: { ...CFG, stopLoss: { enabled: true, pct: '10' } }, version: 0 }, NOW);
  assert.equal(v2.params.exitVersion, 1);
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

// ---------------- Regressions from the independent review (R1–R8): each asserts the FIXED behavior ----------------
test('R1 fixed: tokens reserved by an unapproved manual sell do not shrink or close the plan; stop waits, then sells', () => {
  const e = setup(17);
  const q = T.createQuote(e.db, e.u, { chain: 'solana', tokenAddress: e.tok.address, side: 'sell', amount: '100', slippageBps: 500, walletId: e.w }, e.t);
  T.createIntent(e.db, e.u, { quoteId: q.id, source: 'manual' }, e.t, 'r1-manual-sell');
  assert.equal(e.tick('150'), 'waiting'); assert.equal(e.view().state.managedQty, '100'); assert.equal(e.view().lifecycle, 'active');
  assert.equal(e.tick('50'), 'waiting', 'all 100 reserved: nothing sellable, the plan waits (it does not close)');
  assert.ok(e.events().some(x => x.kind === 'exit.waiting_reserved'));
  run(e.db, `UPDATE paper_balances SET reserved = '0' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address);
  assert.equal(e.tick('50'), 'exit_stop_loss'); assert.equal(e.held(), '0');
});

test('R1b: part of the tokens reserved → stop sells what is free now, and the rest once released', () => {
  const e = setup(18);
  run(e.db, `UPDATE paper_balances SET reserved = '40' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address);
  assert.equal(e.tick('50'), 'exit_stop_loss'); assert.equal(e.exitOrders()[0].qty, '60'); assert.equal(e.view().lifecycle, 'active', '40 still protected');
  run(e.db, `UPDATE paper_balances SET reserved = '0' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address);
  assert.equal(e.tick('50'), 'exit_stop_loss'); assert.equal(e.held(), '0'); assert.equal(e.view().lifecycle, 'completed');
});

test('R2 fixed: a second exit plan for the same coin in the same wallet is refused (code and DB)', () => {
  const e = setup(19);
  assert.throws(() => S.createStrategy(e.db, e.u, { kind: 'position_exit', chain: 'solana', tokenAddress: e.tok.address, walletId: e.w, params: { exit: CFG, entryUsd: '100', qty: '100' } }, NOW), /already has an exit plan/);
  assert.throws(() => run(e.db, `INSERT INTO strategies (id, user_id, mode, kind, chain, token, wallet_id, params, state, lifecycle, created_at, updated_at) VALUES ('dup', ?, 'paper', 'position_exit', 'solana', ?, ?, '{}', '{}', 'active', 1, 1)`, e.u, e.tok.address, e.w), /UNIQUE/);
});

test('R3 fixed: legacy TP/SL stop that could not be sent keeps protecting and sells when allowed again', () => {
  const e = setup(20, '100'); S.setStrategyLifecycle(e.db, e.u, e.s.id, 'cancel', e.t); // use only the legacy plan here
  const s = S.createStrategy(e.db, e.u, { kind: 'tp_sl', chain: 'solana', tokenAddress: e.tok.address, walletId: e.w, params: { stopLoss: '0.2', entryUsd: '100', qty: '100' } }, NOW);
  S._testing.setPriceOverride(() => '70');
  S.setRiskPolicy(e.db, e.u, { allowedChains: [] }, undefined);
  const out1 = S.evaluateAll(e.db, 'w', e.t + 1000).find(r => r.id === s.id)?.outcome;
  assert.match(out1!, /exit_blocked/); assert.equal(e.held(), '100');
  S.setRiskPolicy(e.db, e.u, { allowedChains: ['solana'] }, undefined);
  assert.equal(S.evaluateAll(e.db, 'w', e.t + 3000).find(r => r.id === s.id)?.outcome, 'exit_sl'); assert.equal(e.held(), '0');
});

test('R4 fixed: an owner edit made during an evaluation is never overwritten by the worker', () => {
  const e = setup(21);
  const row = q1(e.db, `SELECT * FROM strategies WHERE id = ?`, e.s.id);
  X.overrideExit(e.db, e.u, e.s.id, { config: { ...CFG, stopLoss: { enabled: true, pct: '5' } }, version: 0 }, NOW);
  assert.equal(X.evalPositionExit(e.db, row, NOW + 1000), 'conflict_retry');
  assert.equal(e.view().state.config.stopLoss.pct, '5'); assert.equal(e.view().exit!.levels.stopLoss, '95');
  assert.equal(e.tick('94'), 'exit_stop_loss', 'the owner\'s tighter stop is what fires');
  // a cancel during evaluation is not undone either
  const f = setup(22); const row2 = q1(f.db, `SELECT * FROM strategies WHERE id = ?`, f.s.id); S.setStrategyLifecycle(f.db, f.u, f.s.id, 'cancel', f.t);
  assert.equal(X.evalPositionExit(f.db, row2, NOW + 1000), 'conflict_retry'); assert.equal(f.view().lifecycle, 'cancelled');
});

test('R5 fixed: a paper order orphaned mid-dispatch is expired by the worker; the exit then retries and sells once', () => {
  const e = setup(23);
  X._testHooks.crash = 'after_submit'; try { e.tick('70'); } finally { X._testHooks.crash = null; }
  const o = q1(e.db, `SELECT id FROM orders WHERE strategy_id = ?`, e.s.id);
  run(e.db, `UPDATE orders SET state = 'submitting' WHERE id = ?`, o.id); run(e.db, `UPDATE paper_balances SET qty = '100' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address); // emulate: died before the outcome
  assert.equal(e.tick('10'), 'awaiting_settlement');
  assert.equal(T.expireInterruptedPaperOrders(e.db, e.t + 60_000), 1);
  assert.match(e.tick('10', { dt: 61_000 })!, /waiting|exit_failed/);
  assert.equal(e.tick('10', { dt: 5_000 }), 'exit_stop_loss'); assert.equal(e.held(), '0');
  assert.equal(e.sells().filter(x => x.state === 'finalized').length, 1, 'exactly one real sale');
});

test('R6 fixed: a price observed before trailing activation never sets the peak', () => {
  let st = D.newExitState(CFG, '100', '100', 6);
  let step = D.decideExit(st, { now: 10_000, price: '200', priceAt: 10_000, heldQty: '100', staleAfterMs: 30_000 }, 'x');
  st = D.applyOrderResult(step.state, { id: step.order!.id, outcome: 'filled', soldQty: '50' }, 40_000).state;
  step = D.decideExit(st, { now: 41_000, price: '300', priceAt: 15_000, heldQty: '50', staleAfterMs: 30_000 }, 'x');
  assert.equal(step.state.trailing.peak, null, 'pre-activation spike ignored');
  step = D.decideExit(step.state, { now: 42_000, price: '210', priceAt: 42_000, heldQty: '50', staleAfterMs: 30_000 }, 'x');
  assert.equal(step.state.trailing.peak, '210'); assert.equal(step.state.trailing.trigger, '168');
});

test('R7 fixed: crash after the sell intent was created but before approval → recovery expires it and re-decides; sells once', () => {
  const e = setup(24);
  X._testHooks.crash = 'after_plan'; try { e.tick('70'); } finally { X._testHooks.crash = null; }
  const eo = q1(e.db, `SELECT id, qty FROM exit_orders WHERE strategy_id = ?`, e.s.id);
  const q = T.createQuote(e.db, e.u, { chain: 'solana', tokenAddress: e.tok.address, side: 'sell', amount: eo.qty, slippageBps: 500, walletId: e.w }, e.t + 1000);
  T.createIntent(e.db, e.u, { quoteId: q.id, source: 'strategy', strategyId: e.s.id }, e.t + 1000, `${eo.id}:intent`); // what submit() did before dying
  e.tick('70'); // recovery: the unapproved intent is expired (reservation released), never approved outside the risk path
  assert.ok(e.events().some(x => x.kind === 'exit.recovered_unapproved_expired'));
  assert.equal(q1(e.db, `SELECT reserved FROM paper_balances WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address).reserved, '0');
  assert.equal(e.tick('70', { dt: 3000 }), 'exit_stop_loss', 're-decided through the full risk path; sells once');
  assert.equal(e.held(), '0'); assert.equal(e.sells().length, 1);
});

test('R8 fixed: a future-dated price is treated as stale and cannot block later real prices', () => {
  const e = setup(25);
  assert.equal(e.tick({ usd: '150', at: NOW + 3_600_000, source: 'skewed', staleReason: null }), 'waiting');
  assert.equal(e.events().find(x => x.kind === 'exit.price_stale')?.detail.reason, 'PRICE_FROM_FUTURE');
  assert.equal(e.tick('10'), 'exit_stop_loss', 'the next real price still triggers the stop');
});

// ---------------- Second review round (N1–N8) ----------------
test('N8 fixed: routine price ticks do not invalidate the owner\'s edit (edits have their own version)', () => {
  const e = setup(26);
  for (const p of ['110', '120', '130', '140']) e.tick(p); // worker writes while the owner is editing
  const v = X.overrideExit(e.db, e.u, e.s.id, { config: { ...CFG, stopLoss: { enabled: true, pct: '10' } }, version: 0 }, NOW);
  assert.equal(v.exit!.levels.stopLoss, '90');
  assert.throws(() => X.overrideExit(e.db, e.u, e.s.id, { config: CFG, version: 0 }, NOW), /edited elsewhere/, 'a second editor with the old version is refused');
});

test('N2 fixed: a pause/cancel that lands between the write-ahead and sending means nothing is sent', () => {
  const e = setup(28);
  const row = q1(e.db, `SELECT * FROM strategies WHERE id = ?`, e.s.id);
  S._testing.setPriceOverride(() => '70');
  X._testHooks.afterPlanCommit = () => S.setStrategyLifecycle(e.db, e.u, e.s.id, 'pause', e.t); // the API process pauses the plan in that window
  let out: string;
  try { out = X.evalPositionExit(e.db, row, NOW + 1000); } finally { X._testHooks.afterPlanCommit = null; }
  assert.equal(out, 'conflict_retry'); const paused = e.view().lifecycle === 'paused';
  assert.equal(q1(e.db, `SELECT state, reason FROM exit_orders WHERE strategy_id = ?`, e.s.id).reason, 'NOT_SENT_PLAN_CHANGED');
  assert.ok(paused); assert.equal(e.sells().length, 0, 'nothing sent'); assert.equal(e.held(), '100');
});

test('N3 fixed: a legacy TP/SL and a new exit plan cannot both manage the same coin', () => {
  const e = setup(29);
  assert.throws(() => S.createStrategy(e.db, e.u, { kind: 'tp_sl', chain: 'solana', tokenAddress: e.tok.address, walletId: e.w, params: { stopLoss: '0.2', entryUsd: '100', qty: '100' } }, NOW), /already has an exit plan/);
  S.setStrategyLifecycle(e.db, e.u, e.s.id, 'cancel', e.t);
  const legacy = S.createStrategy(e.db, e.u, { kind: 'tp_sl', chain: 'solana', tokenAddress: e.tok.address, walletId: e.w, params: { stopLoss: '0.2', entryUsd: '100', qty: '100' } }, NOW);
  assert.throws(() => S.createStrategy(e.db, e.u, { kind: 'position_exit', chain: 'solana', tokenAddress: e.tok.address, walletId: e.w, params: { exit: CFG, entryUsd: '100', qty: '100' } }, NOW), /already has an exit plan/);
  void legacy;
});

test('N5 fixed: an interrupted paper order with simulated-chain evidence is reconciled, not expired', () => {
  const e = setup(30);
  e.tick('70', { fault: 'timeout_after_dispatch' }); // paper_chain has the landed truth
  const o = q1(e.db, `SELECT id FROM orders WHERE strategy_id = ?`, e.s.id);
  run(e.db, `UPDATE orders SET state = 'submitting', tx_ref = NULL WHERE id = ?`, o.id); // emulate: died after the paper_chain write
  assert.equal(T.expireInterruptedPaperOrders(e.db, e.t + 60_000), 1);
  assert.equal(q1(e.db, `SELECT state FROM orders WHERE id = ?`, o.id).state, 'reconciliation_required');
  T.reconcileOrder(e.db, e.u, o.id, e.t + 61_000);
  assert.equal(q1(e.db, `SELECT state FROM orders WHERE id = ?`, o.id).state, 'finalized', 'the simulated landing is honored');
  assert.match(e.tick('70', { dt: 61_000 })!, /closed:STOP_LOSS|waiting/); assert.equal(e.sells().length, 1, 'no second sale');
});

test('N7 fixed: a stop blocked by reserved tokens logs and notifies once per episode', () => {
  const e = setup(31);
  run(e.db, `UPDATE paper_balances SET reserved = '100' WHERE wallet_id = ? AND asset = ?`, e.w, e.tok.address);
  for (let k = 0; k < 5; k++) e.tick('50');
  assert.equal(e.events().filter(x => x.kind === 'exit.waiting_reserved').length, 1);
  assert.equal(e.events().filter(x => x.kind === 'exit.stop_triggered').length, 1);
  assert.equal(qa(e.db, `SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Exit waiting — tokens reserved'`, e.u).length, 1);
});

test('auto trader never opens a position its exit plan cannot protect (stale exit price → no buy, named reason)', () => {
  const db = openDb(':memory:'); const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', NOW); S.setRiskPolicy(db, u, POLICY, undefined);
  const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
  S._testing.setPriceOverride(() => ({ usd: '1', at: null, source: 'test', staleReason: 'INDEXER_DOWN' }));
  const a = S.createStrategy(db, u, { kind: 'auto_trader', chain: 'solana', walletId: w, params: { amount: '0.1', minScore: 0, maxPositions: 1, exit: CFG } }, NOW);
  S.evaluateAll(db, 'w', NOW + 60_000);
  const d1 = S.strategyView(db, u, a.id).state.decisions[0];
  assert.equal(d1.pick, null); assert.ok(d1.passed > 0 && d1.excluded.exit_price_not_fresh >= 1);
  assert.equal(q1(db, `SELECT COUNT(*) n FROM orders WHERE strategy_id = ?`, a.id).n, 0);
  S._testing.setPriceOverride(() => undefined as any); // fresh prices again
  S.evaluateAll(db, 'w', NOW + 120_000);
  assert.ok(S.strategyView(db, u, a.id).state.decisions[0].pick, 'buys once protection can work');
});
