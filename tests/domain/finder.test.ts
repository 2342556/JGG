import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../packages/domain/src/index.ts';

const base: D.FinderInput = { address: 'A', symbol: 'AAA', ageMin: 30, liquidityUsd: 40_000, marketCapUsd: 200_000, volume1hUsd: 60_000, holders: 900, buys1h: 400, sells1h: 250,
  change5mBps: 400, change1hBps: 6_000, smartMoney: 5, kols: 2, top10Bps: 1_800, devHoldingBps: 200, insiderBps: 300, bundleBps: 500, snipers: 2,
  honeypot: 'safe', mintAuthority: 'safe', freezeAuthority: 'safe', rugRatio: 0.05, ddVerdict: 'pass', ddScore: 85 };

test('finder: hard gates exclude unsafe or unknown-safety tokens with a named reason', () => {
  const g = (x: Partial<D.FinderInput>) => { const r = D.finderScore({ ...base, ...x }); return r.passed ? 'PASS' : r.gate; };
  assert.equal(g({}), 'PASS');
  assert.equal(g({ honeypot: 'unknown' }), 'honeypot', 'unknown is never treated as safe');
  assert.equal(g({ honeypot: 'risky' }), 'honeypot');
  assert.equal(g({ liquidityUsd: null }), 'liquidity');
  assert.equal(g({ top10Bps: 4_500 }), 'concentration');
  assert.equal(g({ devHoldingBps: 2_000 }), 'dev_holding');
  assert.equal(g({ change1hBps: 90_000 }), 'overextended');
  assert.equal(g({ ageMin: 1 }), 'too_new');
  assert.equal(g({ rugRatio: 0.8 }), 'rug_ratio');
  assert.equal(g({ sells1h: 900 }), 'sell_pressure');
  assert.equal(g({ ddVerdict: 'fail' }), 'due_diligence');
  assert.equal(g({ smartMoney: null, kols: null, volume1hUsd: null, change1hBps: null, ddScore: null }), 'coverage');
});

test('finder: score is bounded, deterministic, and better signals rank higher', () => {
  const a = D.finderScore(base); const b = D.finderScore({ ...base, address: 'B', smartMoney: 0, kols: 0 });
  assert.ok(a.passed && b.passed);
  if (a.passed && b.passed) { assert.ok(a.score >= 0 && a.score <= 100); assert.ok(a.score > b.score); assert.equal(D.finderScore(base).passed && (D.finderScore(base) as any).score, a.score); }
  const r = D.runFinder([{ ...base, address: 'Z' }, { ...base, address: 'Y' }, { ...base, address: 'X', honeypot: 'risky' }]);
  assert.deepEqual(r.passed.map(p => p.address), ['Y', 'Z'], 'ties broken by address');
  assert.equal(r.excluded.honeypot, 1);
});

test('auto exit plan: 50% at +50% with trailing on the rest, remainder at +100%, hard stop', () => {
  const p = D.autoExitParams(D.DEFAULT_AUTO_EXIT);
  assert.deepEqual(p.stages, [{ percentBps: 5000, gain: '0.5' }, { percentBps: 5000, gain: '1' }]);
  assert.equal(p.trailActivation, '0.5'); assert.equal(p.stopLoss, '0.3');
  assert.deepEqual(D.stagedQuantities('1000', p.stages.map((s, i) => ({ id: 'tp' + i, percentBps: s.percentBps }))).map(x => x.qty), ['500', '500']);
  assert.throws(() => D.autoExitParams({ ...D.DEFAULT_AUTO_EXIT, tpGain: '0.4' }), /TP_MUST_BE_ABOVE/);
  assert.throws(() => D.autoExitParams({ ...D.DEFAULT_AUTO_EXIT, partialBps: 10_000 }), /PARTIAL/);
});
