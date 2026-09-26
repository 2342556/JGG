// FOMO labels (optional third-party) + live copy trade / snipes / rank / signals / wallet detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, q1, qa, type DB } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import * as L from '../../apps/api/src/live.ts';
import { fomoLeaderboard } from '../../packages/providers/src/fomo.ts';
import { setMarketSource } from '../../packages/providers/src/execution.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';

const POLICY = { maxPerTrade: '1', maxPerAssetExposure: '5', maxDailyGrossBuy: '20', maxRealizedDailyLoss: '5', maxOpenPositions: 20, maxSlippageBps: 1500, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false };
const feed = (db: DB, st: L.IngestStats, logs: string[], slot: number, at: number) => L.ingestLogs(db, { signature: newSig(), err: null, logs }, slot, at, st);
function liveUser(db: DB, now: number) {
  const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', now); S.setRiskPolicy(db, u, POLICY, undefined);
  return { u, w: q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id as string };
}

test('fomoapi.io client: bearer auth, Solana wallets only, malformed rows dropped, credit reserve + 402 handled', async () => {
  let seenAuth = ''; let mode = 'ok';
  const good = newKey();
  const srv = createServer((req, res) => {
    seenAuth = String(req.headers.authorization);
    if (mode === '402') { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":"credits_exhausted"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'x-credits-remaining': '4000' });
    res.end(JSON.stringify({ window: '7d', capturedAt: '2026-09-25T00:00:00Z', count: 3, traders: [
      { rank: 1, handle: 'alpha', userId: 'u-1', pnlUsd: 1234.5, volumeUsd: 9, wallets: { solana: good, evm: '0xabc' }, verified: true },
      { rank: 2, handle: 'evmonly', wallets: { evm: '0xdef' } },
      { rank: 3, handle: 'bad', wallets: { solana: 'not a wallet; DROP TABLE' } }] }));
  });
  await new Promise<void>(r => srv.listen(0, () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const r = await fomoLeaderboard('k123', '7d', { base });
    assert.equal(seenAuth, 'Bearer k123');
    assert.deepEqual(r.traders.map(t => t.handle), ['alpha']); assert.equal(r.traders[0].wallet, good);
    assert.equal(r.creditsRemaining, 4000); assert.equal(r.belowReserve, true);
    mode = '402'; await assert.rejects(fomoLeaderboard('k123', '7d', { base }), (e: any) => e.code === 'CREDITS_EXHAUSTED');
    await assert.rejects(fomoLeaderboard('', '7d', { base }), (e: any) => e.code === 'NOT_CONFIGURED');
  } finally { srv.close(); }
});

test('live analytics: FOMO labels + smart labels flow into signals, rank and wallet detail (from our own index)', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); L.setSolUsd(db, '150', 't', now);
  const trader = newKey(); const other = newKey();
  for (let k = 0; k < 4; k++) {
    const c = new Curve(); let slot = 1000 + k * 20; feed(db, st, c.createLogs(`C${k}`, `C${k}`), slot, now - 3_000_000);
    const b = c.trade(trader, true, 500_000_000n, Math.floor((now - 2_000_000) / 1000)); feed(db, st, b.logs, ++slot, now - 2_000_000);
    feed(db, st, c.trade(other, true, 3_000_000_000n, Math.floor((now - 1_500_000) / 1000)).logs, ++slot, now - 1_500_000);
    feed(db, st, c.trade(trader, false, b.tok, Math.floor((now - 1_000_000) / 1000)).logs, ++slot, now - 1_000_000);
  }
  L.saveFomoTraders(db, '7d', [{ wallet: trader, handle: 'alpha', userId: 'u-1', rank: 1, pnlUsd: 99, volumeUsd: 1, verified: true }], now);
  const sig = L.liveSignals(db, now, 'label_trades', { label: 'fomo' });
  assert.equal(sig.length, 8); assert.equal((sig[0] as any).walletName, '@alpha');
  const rank = L.liveRank(db, now, '7d', 'fomo');
  assert.equal(rank.rows.length, 1); assert.equal(rank.rows[0].name, '@alpha'); assert.equal(rank.rows[0].winRateDenominator, 4); assert.equal(rank.rows[0].winRate, 100);
  const wd = L.liveWalletDetail(db, trader, now, '7d');
  assert.equal(wd.trades, 8); assert.equal(wd.winRateDenominator, 4); assert.ok(wd.labels.some(l => l.label === 'fomo @alpha' && /not verified/.test(l.method)));
  assert.equal(L.liveSignals(db, now, 'cluster', { label: 'fomo', minWallets: 1, windowMs: 86_400_000 }).length, 4);
  assert.throws(() => L.liveSignals(db, now, 'callouts', {}), /UNSUPPORTED_SIGNAL/);
});

test('live copy trade: copies a source buy once (redelivery safe), then follows the source selling half', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const t0 = Date.now(); L.setSolUsd(db, '150', 't', t0);
  const c = new Curve(); let slot = 10; feed(db, st, c.createLogs(), slot, t0 - 60_000);
  for (let i = 0; i < 5; i++) feed(db, st, c.trade(newKey(), true, 1_000_000_000n, Math.floor((t0 - 50_000) / 1000)).logs, ++slot, t0 - 50_000);
  setMarketSource(L.createLiveSource(db));
  try {
    const { u, w } = liveUser(db, t0); const source = newKey();
    const cp = S.createStrategy(db, u, { kind: 'copy', chain: 'solana', walletId: w, params: { sourceWallet: source, sizing: 'fixed', amount: '0.2', maxEventAgeSec: 60 } }, t0);
    const b = c.trade(source, true, 2_000_000_000n, Math.floor((t0 + 1000) / 1000)); feed(db, st, b.logs, ++slot, t0 + 1000);
    S.evaluateAll(db, 'w', t0 + 2000); S.evaluateAll(db, 'w', t0 + 3000); // second pass re-reads the overlap window
    assert.equal(q1(db, `SELECT COUNT(*) n FROM orders WHERE strategy_id = ? AND side = 'buy' AND state = 'finalized'`, cp.id).n, 1, 'one copy buy');
    const held = q1(db, `SELECT qty FROM paper_balances WHERE wallet_id = ? AND asset = ?`, w, c.mint).qty;
    feed(db, st, c.trade(source, false, b.tok / 2n, Math.floor((t0 + 4000) / 1000)).logs, ++slot, t0 + 4000);
    S.evaluateAll(db, 'w', t0 + 5000);
    const sold = q1(db, `SELECT amount_in FROM orders WHERE strategy_id = ? AND side = 'sell'`, cp.id);
    assert.ok(sold, 'followed the sell'); const ratio = Number(sold.amount_in) / Number(held);
    assert.ok(Math.abs(ratio - 0.5) < 0.001, `sold ${ratio} of position`);
  } finally { setMarketSource(null); }
});

test('live dev snipe + token snipe: fire on real create events only after arming', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const t0 = Date.now(); L.setSolUsd(db, '150', 't', t0);
  setMarketSource(L.createLiveSource(db));
  try {
    const { u, w } = liveUser(db, t0);
    const old = new Curve(); feed(db, st, old.createLogs(), 5, t0 - 10_000); // created BEFORE arming → must not trigger
    const ds = S.createStrategy(db, u, { kind: 'dev_snipe', chain: 'solana', walletId: w, params: { creatorWallet: old.creator, amount: '0.1' } }, t0);
    assert.equal(S.evaluateAll(db, 'w', t0 + 1000).find(r => r.id === ds.id)?.outcome, 'watching');
    const fresh = new Curve(); fresh.creator = old.creator; feed(db, st, fresh.createLogs('New', 'NEW'), 6, t0 + 2000);
    assert.equal(S.evaluateAll(db, 'w', t0 + 3000).find(r => r.id === ds.id)?.outcome, 'filled');
    assert.equal(qa(db, `SELECT token FROM orders WHERE strategy_id = ?`, ds.id)[0].token, fresh.mint);
    const target = new Curve();
    const ts = S.createStrategy(db, u, { kind: 'token_snipe', chain: 'solana', tokenAddress: target.mint, walletId: w, params: { amount: '0.1' } }, t0 + 3000);
    assert.equal(S.evaluateAll(db, 'w', t0 + 4000).find(r => r.id === ts.id)?.outcome, 'watching', 'coin not created yet');
    feed(db, st, target.createLogs('Tgt', 'TGT'), 7, t0 + 5000);
    assert.equal(S.evaluateAll(db, 'w', t0 + 6000).find(r => r.id === ts.id)?.outcome, 'filled');
    assert.equal(((): string => { try { S.createStrategy(db, u, { kind: 'migration_buy', chain: 'solana', tokenAddress: target.mint, walletId: w, params: { amount: '0.1' } }, t0); return 'OK'; } catch (e) { return (e as any).code; } })(), 'CAPABILITY_BLOCKED');
  } finally { setMarketSource(null); }
});
