// Exit prices on live data (paper execution, seeded pump.fun events — no network): freshness rules, graduated coins, number parsing,
// and an end-to-end position exit on live-shaped data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q1, run, type DB } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import * as L from '../../apps/api/src/live.ts';
import * as D from '../../packages/domain/src/index.ts';
import { setMarketSource } from '../../packages/providers/src/execution.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';

const POLICY = { maxPerTrade: '1', maxPerAssetExposure: '5', maxDailyGrossBuy: '20', maxRealizedDailyLoss: '5', maxOpenPositions: 20, maxSlippageBps: 1500, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false };
const feed = (db: DB, st: L.IngestStats, logs: string[], slot: number, at: number) => L.ingestLogs(db, { signature: newSig(), err: null, logs }, slot, at, st);
const beat = (db: DB, at: number, conn = 'live', liveSince: number | null = null) => run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('indexer', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify({ conn, liveSince }), at);
function seeded() {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  L.setSolUsd(db, '150', 'test', now);
  const c = new Curve(); feed(db, st, c.createLogs('Exit Coin', 'EXIT'), 1, now - 60_000);
  for (let i = 0; i < 6; i++) feed(db, st, c.trade(newKey(), true, 500_000_000n, Math.floor((now - 50_000 + i * 5_000) / 1000)).logs, 2 + i, now - 50_000 + i * 5_000);
  return { db, st, c, now, mint: c.mint };
}

test('live exit price freshness: stream live + heartbeat + trade since reconnect + fresh SOL/USD → usable; otherwise a named reason', () => {
  const { db, now, mint } = seeded();
  beat(db, now, 'live', now - 120_000);
  const ok = L.livePriceObs(db, 'solana', mint, now); assert.equal(ok.staleReason, null); assert.ok(ok.usd && D.gt(ok.usd, '0'));
  beat(db, now - 20_000, 'live', now - 120_000); assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'INDEXER_DOWN');
  beat(db, now, 'reconnecting', now - 120_000); assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'STREAM_NOT_LIVE');
  beat(db, now, 'live', now - 1_000); assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'NO_TRADE_SINCE_RECONNECT', 'reserves older than the current stream are not trusted');
  beat(db, now, 'live', now - 120_000); L.setSolUsd(db, '150', 'test', now - 200_000);
  assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'SOL_USD_STALE', 'USD triggers need a fresh SOL/USD too');
  assert.equal(L.livePriceObs(db, 'solana', 'So11111111111111111111111111111111111111112', now).staleReason, 'TOKEN_NOT_INDEXED');
});

test('graduated coin: Jupiter price when fresh, otherwise stale; paper sells priced from it (impact not modeled, disclosed)', () => {
  const { db, now, mint } = seeded();
  run(db, `UPDATE live_tokens SET complete = 1 WHERE mint = ?`, mint); L.setSolUsd(db, '150', 'test', now);
  assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'GRADUATED_NO_EXTERNAL_PRICE');
  const src = L.createLiveSource(db);
  assert.equal((src.quote('solana', mint, 'sell', '1000', 500, now) as any).code, 'CURVE_COMPLETE', 'paper cannot sell a graduated coin without a real price');
  L.setExtPrice(db, mint, L.numToDec(0.00000345), 'jupiter-price-v3', now - 5_000);
  const o = L.livePriceObs(db, 'solana', mint, now); assert.equal(o.staleReason, null); assert.equal(o.usd, '0.00000345');
  const q = src.quote('solana', mint, 'sell', '1000000', 500, now); assert.ok(q.ok);
  if (q.ok) { assert.match(q.quote.route, /Jupiter price/); assert.ok(D.eq(q.quote.expectedOut, '0.023'), '1,000,000 × $0.00000345 ÷ $150 = 0.023 SOL'); }
  L.setExtPrice(db, mint, '0.00000345', 'jupiter-price-v3', now - 120_000);
  assert.equal(L.livePriceObs(db, 'solana', mint, now).staleReason, 'EXTERNAL_PRICE_STALE');
  L.setExtPrice(db, mint, '0', 'bad', now); assert.equal(q1(db, `SELECT usd FROM ext_prices WHERE mint = ?`, mint).usd, '0.00000345', 'a zero price is never stored');
});

test('numToDec: no exponent notation reaches exact math', () => {
  assert.equal(L.numToDec(1.234e-7), '0.0000001234'); assert.equal(L.numToDec(2.5e-12), '0.0000000000025'); assert.equal(L.numToDec(150.23), '150.23'); assert.equal(L.numToDec(0.1 + 0.2), '0.3');
  assert.throws(() => L.numToDec(0)); assert.throws(() => L.numToDec(NaN)); assert.throws(() => L.numToDec(-1));
});

test('position exit on live-shaped data (paper): buy on the curve, stop-loss fires on a fresh price, never on a stale one', () => {
  const { db, st, c, now, mint } = seeded();
  setMarketSource(L.createLiveSource(db));
  try {
    beat(db, now, 'live', now - 3_600_000);
    const whales: { k: string; tok: bigint }[] = []; // 5 × 2 SOL buyers who will dump 90% after our buy
    for (let k = 0; k < 5; k++) { const who = newKey(); const r = c.trade(who, true, 2_000_000_000n, Math.floor((now - 20_000 + k * 1_000) / 1000)); feed(db, st, r.logs, 20 + k, now - 20_000 + k * 1_000); whales.push({ k: who, tok: r.tok }); }
    const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', now); S.setRiskPolicy(db, u, POLICY, undefined);
    const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string;
    const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: mint, side: 'buy', amount: '0.2', slippageBps: 500, walletId: w }, now);
    const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, now, 'live-exit-buy'); T.approveIntent(db, u, i.id, {}, now); T.executeIntent(db, u, i.id, now, 'live-exit-exec');
    const s = S.createStrategy(db, u, { kind: 'position_exit', chain: 'solana', tokenAddress: mint, walletId: w, params: { exit: { stopLoss: { enabled: true, pct: '20' }, partialTp: { enabled: false, triggerPct: '100', sellPct: '50' }, trailing: { enabled: false, pct: '20', activation: 'immediate' } } } }, now);
    const sl = S.strategyView(db, u, s.id).exit!.levels.stopLoss!;
    // big sells crash the curve price below the stop
    let t = now + 1_000;
    for (const [k, wh] of whales.entries()) { t += 1_000; feed(db, st, c.trade(wh.k, false, (wh.tok * 9n) / 10n, Math.floor(t / 1000)).logs, 100 + k, t); }
    const px = L.livePriceObs(db, 'solana', mint, t).usd!; assert.ok(D.lt(px, sl), `price ${px} < stop ${sl}`);
    beat(db, t - 60_000, 'live', now - 3_600_000); // indexer silent for a minute → stale
    assert.equal(S.evaluateAll(db, 'w', t).find(r => r.id === s.id)?.outcome, 'waiting', 'no sale on a stale price');
    beat(db, t, 'live', now - 3_600_000); L.setSolUsd(db, '150', 'test', t);
    assert.equal(S.evaluateAll(db, 'w', t + 500).find(r => r.id === s.id)?.outcome, 'exit_stop_loss');
    assert.equal(q1(db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, mint).qty, '0');
  } finally { setMarketSource(null); }
});
