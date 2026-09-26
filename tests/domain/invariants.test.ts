import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../packages/domain/src/index.ts';

test('T11 decimal precision: uint256 max, tiny tokens, raw<->decimal exact', () => {
  const max = D.UINT256_MAX.toString();
  assert.equal(D.raw(max), D.UINT256_MAX);
  assert.throws(() => D.raw((D.UINT256_MAX + 1n).toString()), /OUT_OF_RANGE/);
  assert.throws(() => D.raw('1.5'), /INVALID_RAW/);
  assert.throws(() => D.raw('-1'), /INVALID_RAW/);
  assert.equal(D.str(D.rawToDec(max, 18)), '115792089237316195423570985008687907853269984665640564039457.584007913129639935');
  assert.equal(D.decToRaw('0.000000001', 9), 1n);
  assert.throws(() => D.decToRaw('0.0000000001', 9), /PRECISION/);
  assert.equal(D.str(D.add('0.1', '0.2')), '0.3');
  assert.equal(D.fixed(D.div('2', '3', 30), 6), '0.666667');
  assert.equal(D.str(D.div('-7', '2', 0, 'floor')), '-4');
  assert.equal(D.str(D.div('5', '2', 0, 'half_even')), '2');
  assert.equal(D.str(D.div('7', '2', 0, 'half_even')), '4');
});

test('property: buy/sell sequences conserve quantity and basis (randomized, seeded)', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 200; run++) {
    let b = D.emptyBucket(); let bought = D.dec('0'); let sold = D.dec('0'); let cost = D.dec('0'); let released = D.dec('0'); let proceeds = D.dec('0');
    for (let i = 0; i < 12; i++) {
      if (rnd() < 0.6 || D.isZero(b.knownQty)) {
        const q = String(1 + Math.floor(rnd() * 1000)); const p = (rnd() * 3).toFixed(6); const c = (rnd() * 0.5).toFixed(4);
        b = D.applyBuy(b, q, p, c); bought = D.add(bought, q); cost = D.add(cost, D.add(D.mul(q, p), c));
      } else {
        const q = D.str(D.div(D.mul(b.knownQty, (rnd()).toFixed(4)), '1', 6, 'floor'));
        if (!D.gt(q, '0')) continue;
        const p = (rnd() * 3).toFixed(6);
        const r = D.applySell(b, q, p, '0'); b = r.bucket; sold = D.add(sold, q); released = D.add(released, r.releasedBasis); proceeds = D.add(proceeds, r.netProceeds);
      }
    }
    assert.equal(D.cmp(D.sub(bought, sold), b.knownQty), 0, 'qty conserved');
    assert.ok(!D.isNeg(b.knownQty) && !D.isNeg(b.knownBasis), 'no negative inventory/basis');
    // realized = proceeds - released; basis = cost - released (within 1e-17 rounding of division)
    const diff = D.sub(D.sub(proceeds, released), b.realized);
    assert.ok(D.lte(D.mul(diff, diff), '0.0000000000000001'), 'realized consistent');
    const bdiff = D.sub(D.sub(cost, released), b.knownBasis);
    assert.ok(D.lte(D.mul(bdiff, bdiff), '0.0000000000000001'), 'basis consistent');
  }
});

test('T13 unknown basis: transfer-in retains unknown basis; selling it is blocked; owned match preserves basis', () => {
  let b = D.applyTransferIn(D.emptyBucket(), '10', null);
  assert.equal(D.markToMarket(b, '5')!.unrealized.int, 0n, 'no invented gains on unknown basis');
  assert.throws(() => D.applySell(b, '5', '1'), /UNKNOWN_COST_BASIS/);
  b = D.applyTransferIn(b, '10', '20');
  assert.equal(D.str(D.averageBasis(b)!), '2');
  assert.deepEqual(D.sellInitialPlan({ unrecoveredSpend: null, holdings: '10', netPricePerToken: '1' }), { ok: false, code: 'UNKNOWN_COST_BASIS' });
});

test('sell-initial: full recovery vs capped by holdings', () => {
  const a = D.sellInitialPlan({ unrecoveredSpend: '50', holdings: '100', netPricePerToken: '2' });
  assert.deepEqual(a, { ok: true, sellQty: '25', expectedProceeds: '50', fullRecovery: true, residualQty: '75' });
  const b = D.sellInitialPlan({ unrecoveredSpend: '500', holdings: '100', netPricePerToken: '2' }) as any;
  assert.equal(b.fullRecovery, false); assert.equal(b.sellQty, '100'); assert.equal(b.expectedProceeds, '200');
});

test('order state machine: timeout goes to reconciliation, never straight to failed; terminal states frozen', () => {
  assert.ok(D.canTransition(D.ORDER_TRANSITIONS, 'submitting', 'reconciliation_required'));
  assert.ok(!D.canTransition(D.ORDER_TRANSITIONS, 'submitting', 'failed'));
  assert.ok(!D.canTransition(D.ORDER_TRANSITIONS, 'submitted', 'cancelled'), 'cannot cancel a submitted tx');
  for (const s of D.TERMINAL_ORDER_STATES) assert.equal(D.ORDER_TRANSITIONS[s].length, 0);
  // every target is a known state
  for (const [f, tos] of Object.entries(D.ORDER_TRANSITIONS)) for (const t of tos) assert.ok((D.ORDER_STATES as readonly string[]).includes(t), `${f}->${t}`);
  const v = D.transition(D.ORDER_TRANSITIONS, { state: 'created', version: 0 }, 'validated', 0);
  assert.deepEqual(v, { state: 'validated', version: 1 });
  assert.throws(() => D.transition(D.ORDER_TRANSITIONS, v, 'waiting_trigger', 0), /VERSION_CONFLICT/);
  assert.throws(() => D.transition(D.ORDER_TRANSITIONS, v, 'finalized', 1), /INVALID_TRANSITION/);
  assert.ok(!D.canTransition(D.COPY_TASK_TRANSITIONS, 'completed', 'active'));
  assert.ok(!D.canTransition(D.LAUNCH_TRANSITIONS, 'draft', 'submitted'));
});

test('slippage bounds and fee rounding', () => {
  assert.throws(() => D.validateSlippageBps(0), /OUT_OF_RANGE/);
  assert.throws(() => D.validateSlippageBps(2000), /EXPLICIT/);
  D.validateSlippageBps(2000, true);
  assert.throws(() => D.validateSlippageBps(6000, true), /OUT_OF_RANGE/);
  assert.equal(D.bpsFeeRaw('1001', 100), 11n, 'fee rounds up');
  assert.deepEqual(D.additionalCostsByAsset([
    { kind: 'provider', amount: '0.01', asset: 'SOL', includedInQuotedOutput: true },
    { kind: 'network', amount: '0.000005', asset: 'SOL', includedInQuotedOutput: false },
    { kind: 'priority', amount: '0.0001', asset: 'SOL', includedInQuotedOutput: false },
  ]), { SOL: '0.000105' }, 'embedded fee not double counted');
});

test('T36 risk: entries blocked by budgets but risk-reducing exits allowed; kill switch blocks all', () => {
  const p: D.RiskPolicy = { ...D.DENY_ALL_POLICY, maxPerTrade: '100', maxPerAssetExposure: '300', maxDailyGrossBuy: '500', maxRealizedDailyLoss: '50',
    maxOpenPositions: 3, maxSlippageBps: 500, maxFeeQuote: '2', maxDataAgeMs: 10_000, allowedChains: ['solana'], entriesPaused: false };
  const u: D.RiskUsage = { dailyGrossBuy: '450', realizedDailyLoss: '0', assetExposure: '0', openPositions: 1 };
  const base: D.RiskCheckInput = { side: 'buy', amountQuote: '60', slippageBps: 100, feeQuote: '0.1', dataAgeMs: 100, chain: 'solana', riskReducing: false, policyVersionSeen: 1 };
  assert.deepEqual(D.checkRisk(p, u, base), { ok: false, code: 'BUDGET_EXCEEDED:DAILY_BUY' });
  assert.deepEqual(D.checkRisk(p, { ...u, realizedDailyLoss: '60' }, { ...base, side: 'sell', riskReducing: true }), { ok: true });
  assert.deepEqual(D.checkRisk({ ...p, killSwitch: true }, u, { ...base, side: 'sell', riskReducing: true }), { ok: false, code: 'AUTOMATION_STOPPED' });
  assert.deepEqual(D.checkRisk(p, u, { ...base, chain: 'bsc' }), { ok: false, code: 'CHAIN_NOT_ALLOWED' });
  assert.deepEqual(D.checkRisk(p, u, { ...base, policyVersionSeen: 0 }), { ok: false, code: 'POLICY_VERSION_CHANGED' });
  assert.deepEqual(D.checkRisk(D.DENY_ALL_POLICY, u, base), { ok: false, code: 'CHAIN_NOT_ALLOWED' }, 'deny by default');
});

test('T31 copy buy: duplicate suppressed, stale not chased, unconfirmed skipped, sizing capped', () => {
  const cfg: D.CopyBuyConfig = { sizing: { mode: 'ratio', ratio: '0.1' }, maxEventAgeMs: 30_000, minAmount: '0.01', maxAmount: '1', requireConfirmed: true };
  const ev: D.CopyBuyEvent = { sourceEventId: 'sig1:0', observedAt: 1000, sourceAmount: '50', commitment: 'confirmed' };
  const seen = new Set<string>();
  const d1 = D.copyBuyDecision(cfg, ev, 2000, seen, 'A'); assert.deepEqual(d1, { action: 'buy', amount: '1' });
  seen.add(D.copyDedupeKey('A', 'sig1:0', 'buy'));
  assert.deepEqual(D.copyBuyDecision(cfg, ev, 2000, seen, 'A'), { action: 'skip', reason: 'DUPLICATE_SOURCE_EVENT' });
  assert.deepEqual(D.copyBuyDecision(cfg, { ...ev, sourceEventId: 'x' }, 100_000, seen, 'A'), { action: 'skip', reason: 'STALE_SOURCE_EVENT' });
  assert.deepEqual(D.copyBuyDecision(cfg, { ...ev, sourceEventId: 'y', commitment: 'processed' }, 2000, seen, 'A'), { action: 'skip', reason: 'EVENT_NOT_CONFIRMED' });
});

test('T33 batches: independent children, retry only failed, never succeeded/uncertain; not atomic', () => {
  D.validateBatch([{ walletId: 'w1', amount: '1' }, { walletId: 'w2', amount: '2' }]);
  assert.throws(() => D.validateBatch([{ walletId: 'w1', amount: '1' }, { walletId: 'w1', amount: '2' }]), /DUPLICATE/);
  assert.throws(() => D.validateBatch(Array.from({ length: 101 }, (_, i) => ({ walletId: 'w' + i, amount: '1' }))), /SIZE/);
  const ch: D.BatchChild[] = [
    { walletId: 'a', amount: '1', status: 'succeeded', attempts: 1 }, { walletId: 'b', amount: '1', status: 'failed', attempts: 1 },
    { walletId: 'c', amount: '1', status: 'uncertain', attempts: 1 }, { walletId: 'd', amount: '1', status: 'failed', attempts: 3 }];
  assert.deepEqual(D.retryableChildren(ch, 3).map(c => c.walletId), ['b']);
  assert.equal(D.summarizeBatch(ch).atomic, false);
});

test('T18 ranking reproducible and versioned; absent inputs penalised, not imputed', () => {
  const items: D.RankInput[] = [
    { id: 'b', volumeUsd: '500000', priceChangeBps: 2500, liquidityUsd: '80000', txCount: 4000, holders: 900 },
    { id: 'a', volumeUsd: '500000', priceChangeBps: 2500, liquidityUsd: '80000', txCount: 4000, holders: 900 },
    { id: 'c', volumeUsd: null, priceChangeBps: 9000, liquidityUsd: null, txCount: null, holders: null },
  ];
  const r1 = D.rank(items), r2 = D.rank([...items].reverse());
  assert.deepEqual(r1, r2); assert.deepEqual(r1.map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(r1[2].missing, ['volume', 'liquidity', 'participation']);
  assert.equal(D.JGG_RANKING_VERSION, 'jgg-ranking-v1');
});

test('DD score: missing data -> insufficient_data, never "pass" by default', () => {
  const unknown = D.dueDiligence({ mintAuthority: 'unknown', freezeAuthority: 'unknown', honeypot: 'unknown', lpLockedOrBurned: 'unknown', openSource: 'unknown',
    top10ConcentrationBps: null, devHoldingBps: null, liquidityUsd: null, ageMinutes: null, buyTaxBps: null, sellTaxBps: null });
  assert.equal(unknown.verdict, 'insufficient_data'); assert.equal(unknown.score, null);
  const good = D.dueDiligence({ mintAuthority: 'safe', freezeAuthority: 'safe', honeypot: 'safe', lpLockedOrBurned: 'safe', openSource: 'not_applicable',
    top10ConcentrationBps: 1200, devHoldingBps: 50, liquidityUsd: '60000', ageMinutes: 90, buyTaxBps: 0, sellTaxBps: 0 });
  assert.equal(good.verdict, 'pass'); assert.equal(good.score, 100);
  assert.equal(D.dueDiligence({ ...(good as any), mintAuthority: 'safe', freezeAuthority: 'safe', honeypot: 'risky', lpLockedOrBurned: 'safe', openSource: 'not_applicable', top10ConcentrationBps: 1200, devHoldingBps: 50, liquidityUsd: '60000', ageMinutes: 90, buyTaxBps: 0, sellTaxBps: 0 }).verdict, 'fail');
});

test('T17 candles: multi-hop legs counted once, duplicates ignored, gaps explicit', () => {
  const t: D.Trade[] = [
    { eventId: 'e1', swapId: 's1', ts: 0, price: '1', volumeQuote: '10', legIndex: 0 },
    { eventId: 'e2', swapId: 's1', ts: 0, price: '1', volumeQuote: '10', legIndex: 1 }, // second hop of same swap
    { eventId: 'e1', swapId: 's1', ts: 0, price: '1', volumeQuote: '10', legIndex: 0 }, // duplicate delivery
    { eventId: 'e3', swapId: 's2', ts: 30_000, price: '1.2', volumeQuote: '5', legIndex: 0 },
    { eventId: 'e4', swapId: 's3', ts: 125_000, price: '0.9', volumeQuote: '1', legIndex: 0 },
  ];
  const c = D.aggregateCandles(t, 60_000, 0, 180_000);
  assert.equal(c.length, 3);
  assert.deepEqual(c[0], { t: 0, o: '1', h: '1.2', l: '1', c: '1.2', v: '15', trades: 2 });
  assert.deepEqual(c[1], { t: 60_000, gap: true });
  assert.equal((c[2] as any).v, '1');
});

test('concentration excludes pool/burn and reports denominator', () => {
  const r = D.concentration([{ address: 'pool', raw: '500', system: 'pool' }, { address: 'a', raw: '100' }, { address: 'b', raw: '50' }], '1000', 10);
  assert.equal(r.denominatorRaw, '500'); assert.equal(r.bps, 3000); assert.equal(r.excluded.length, 1);
});

test('canonical JSON stable across key order (idempotency payload hash basis)', () => {
  assert.equal(D.canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }), D.canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }));
});
