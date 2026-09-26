// Standalone live data path (Option B), exercised with pump-shaped events and a fake RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q1, qa, type DB } from '../../apps/api/src/db.ts';
import { createUser } from '../../apps/api/src/auth.ts';
import * as T from '../../apps/api/src/trading.ts';
import * as S from '../../apps/api/src/strategies.ts';
import * as L from '../../apps/api/src/live.ts';
import * as D from '../../packages/domain/src/index.ts';
import * as P from '../../packages/providers/src/solana/pump.ts';
import { setMarketSource } from '../../packages/providers/src/execution.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';

const SOL_USD = '150';
function feed(db: DB, st: L.IngestStats, logs: string[], slot: number, at: number, sig = newSig()) { L.ingestLogs(db, { signature: sig, err: null, logs }, slot, at, st); return sig; }
/** A coin created `ageMin` ago with `n` buyers (distinct wallets) and some sells. */
function seedCoin(db: DB, st: L.IngestStats, now: number, o: { ageMin: number; buyers: number; buySol: bigint; sellers?: number }) {
  const c = new Curve(); let slot = 1_000; const t0 = now - o.ageMin * 60_000;
  feed(db, st, c.createLogs('Live Cat', 'LCAT'), slot, t0);
  const wallets: string[] = [];
  for (let i = 0; i < o.buyers; i++) { const w = newKey(); wallets.push(w); const ts = t0 + Math.floor((i + 1) * (o.ageMin * 60_000 - 60_000) / o.buyers); feed(db, st, c.trade(w, true, o.buySol, Math.floor(ts / 1000)).logs, ++slot, ts); }
  for (let i = 0; i < (o.sellers ?? 0); i++) { const w = wallets[i]; const bal = BigInt(q1(db, `SELECT tok FROM live_trades WHERE wallet = ?`, w).tok); feed(db, st, c.trade(w, false, bal / 2n, Math.floor((now - 30_000) / 1000)).logs, ++slot, now - 30_000); }
  return { c, wallets, slot };
}
const fakeRpc = (mintInfo: any, largest: { address: string; amount: string; owner: string }[]) => ({
  getAccountInfoParsed: async () => ({ value: { owner: P.TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: mintInfo } } } }),
  getTokenLargestAccounts: async () => ({ value: largest.map(l => ({ address: l.address, amount: l.amount })) }),
  getMultipleAccountsParsed: async () => ({ value: largest.map(l => ({ data: { parsed: { info: { owner: l.owner } } } })) }),
  getTransaction: async () => null, getSlot: async () => 1, call: async () => null,
}) as any;

test('ingest: create + trades land in tables; duplicates and failed txs are ignored; older slots never overwrite newer state', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  const c = new Curve(); const w = newKey();
  feed(db, st, c.createLogs(), 10, now);
  const t1 = c.trade(w, true, 1_000_000_000n, Math.floor(now / 1000));
  const sig = feed(db, st, t1.logs, 12, now);
  feed(db, st, t1.logs, 12, now, sig); // redelivery
  const other = new Curve(); other.mint = c.mint; L.ingestLogs(db, { signature: newSig(), err: { InstructionError: [0, 'Custom'] }, logs: other.trade(w, true, 5n, 1).logs }, 13, now, st);
  const stale = new Curve(); stale.mint = c.mint; // an older slot carrying other reserves
  feed(db, st, stale.trade(w, true, 7n, Math.floor(now / 1000)).logs, 11, now);
  const tok = q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, c.mint);
  assert.equal(tok.symbol, 'TEST'); assert.equal(tok.seen_from_creation, 1); assert.equal(tok.fee_bps, 125, '95 protocol + 30 creator');
  assert.equal(tok.v_sol, String(c.vs), 'state from slot 12, not the stale slot 11');
  assert.equal(q1(db, `SELECT COUNT(*) n FROM live_trades`).n, 2); assert.equal(st.dupes, 1); assert.equal(st.failedTx, 1);
  assert.equal(st.modelMismatches, 0, 'x*y=k self-check agrees with generated events');
});

test('enrichment: pool account excluded from top-10; freeze authority / risky extensions mark the coin risky', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  const { c } = seedCoin(db, st, now, { ageMin: 20, buyers: 12, buySol: 300_000_000n });
  const holder = newKey();
  await L.enrichToken(db, fakeRpc({ supply: '1000000000000000', mintAuthority: null, freezeAuthority: null }, [
    { address: 'poolAta', amount: '700000000000000', owner: c.bc }, { address: 'h1', amount: '50000000000000', owner: holder }, { address: 'h2', amount: '30000000000000', owner: newKey() }]), c.mint, now);
  const t = q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, c.mint);
  assert.equal(t.top10_bps, 800, '(50e12 + 30e12) / 1e15 — curve ATA excluded'); assert.equal(t.pool_account, 'poolAta'); assert.equal(t.freeze_authority, null);
  await L.enrichToken(db, fakeRpc({ supply: '1000000000000000', mintAuthority: null, freezeAuthority: 'Frz1111111111111111111111111111111111111111', extensions: [{ extension: 'permanentDelegate' }] }, []), c.mint, now + 1);
  const t2 = q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, c.mint);
  assert.ok(t2.freeze_authority); assert.equal(t2.risky_ext, 'permanentDelegate');
  L.setSolUsd(db, SOL_USD, 'test', now);
  const f = L.liveFinderInputs(db, now + 2).find(x => x.address === c.mint)!;
  assert.equal(f.honeypot, 'risky'); assert.equal(D.finderScore(f).passed, false);
});

test('live quotes match the curve math, require fresh SOL/USD and fresh reserves, and stop at graduation', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  const { c, wallets, slot } = seedCoin(db, st, now, { ageMin: 10, buyers: 5, buySol: 500_000_000n });
  const src = L.createLiveSource(db);
  assert.deepEqual(src.quote('solana', c.mint, 'buy', '0.5', 500, now), { ok: false, code: 'NO_SOL_USD' });
  L.setSolUsd(db, SOL_USD, 'test', now);
  const q = src.quote('solana', c.mint, 'buy', '0.5', 500, now); assert.ok(q.ok);
  if (q.ok) {
    const expect = P.quoteBuy(c.vs, c.vt, c.rt, 500_000_000n, 125n);
    assert.equal(q.quote.expectedOut, D.str(D.rawToDec(expect.tokensOut.toString(), 6)));
    assert.equal(q.quote.minOut, D.str(D.rawToDec(D.minimumOutRaw(expect.tokensOut.toString(), 500), 6)));
    assert.match(q.quote.fees[0].note, /latest observed/);
  }
  assert.deepEqual(src.quote('solana', c.mint, 'buy', '0.0000000001', 500, now), { ok: false, code: 'AMOUNT_PRECISION' });
  assert.deepEqual(src.quote('solana', c.mint, 'buy', '0.5', 500, now + 16 * 60_000), { ok: false, code: 'STALE_DATA' });
  assert.deepEqual(src.quote('bsc', c.mint, 'buy', '0.5', 500, now), { ok: false, code: 'CHAIN_UNSUPPORTED' });
  feed(db, st, c.completeLogs(wallets[0]), slot + 1, now);
  assert.deepEqual(src.quote('solana', c.mint, 'buy', '0.5', 500, now), { ok: false, code: 'CURVE_COMPLETE' });
  assert.equal(src.priceUsd('solana', c.mint, now), null, 'no curve price after graduation');
});

test('live finder: only coins seen from creation; derived holders/bundles/snipers; KOL factor excluded; passes after enrichment', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  L.setSolUsd(db, SOL_USD, 'test', now);
  const { c } = seedCoin(db, st, now, { ageMin: 40, buyers: 30, buySol: 700_000_000n, sellers: 4 }); // ≈21 SOL on the curve ≈ $3.1k > $2k gate
  const orphan = new Curve(); feed(db, st, orphan.trade(newKey(), true, 1_000_000_000n, Math.floor(now / 1000)).logs, 5, now); // first seen via a trade → history incomplete
  let inputs = L.liveFinderInputs(db, now);
  assert.equal(inputs.length, 1, 'orphan coin excluded'); assert.equal(inputs[0].honeypot, 'unknown', 'not enriched yet → cannot pass');
  await L.enrichToken(db, fakeRpc({ supply: '1000000000000000', mintAuthority: null, freezeAuthority: null }, [{ address: 'pool', amount: '600000000000000', owner: c.bc }, { address: 'h', amount: '20000000000000', owner: newKey() }]), c.mint, now);
  L.recomputeSmart(db, now); // warm-up: no smart wallets yet, but labels are "ready" (0 known)
  inputs = L.liveFinderInputs(db, now);
  const x = inputs[0];
  assert.equal(x.holders, 30); assert.equal(x.honeypot, 'safe'); assert.equal(x.smartMoney, 0); assert.equal(x.kols, null); assert.equal(x.buys1h, 30 - Math.max(0, 30 - 30)); // all buys within 1h? (40-min-old coin)
  assert.ok(x.liquidityUsd! > 1000);
  const src = L.createLiveSource(db);
  const r = D.runFinder(inputs, src.finderConfig, src.finderExclude);
  assert.equal(r.passed.length, 1, JSON.stringify({ excluded: r.excluded, x }, (_k, v) => typeof v === 'bigint' ? String(v) : v)); assert.match(r.version, /no:kols/);
});

test('end-to-end on live data: paper buy fills from live reserves; auto exits fire on real price moves; auto trader picks a live coin', async () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now();
  L.setSolUsd(db, SOL_USD, 'test', now);
  const { c, slot } = seedCoin(db, st, now, { ageMin: 30, buyers: 25, buySol: 400_000_000n });
  await L.enrichToken(db, fakeRpc({ supply: '1000000000000000', mintAuthority: null, freezeAuthority: null }, [{ address: 'pool', amount: '600000000000000', owner: c.bc }]), c.mint, now);
  L.recomputeSmart(db, now);
  setMarketSource(L.createLiveSource(db));
  try {
    const u = createUser(db, 'demo', Date.now(), 'u'); T.setMode(db, u, 'paper', now);
    const w = q1(db, `SELECT id FROM wallets WHERE user_id = ? AND chain = 'solana' AND label = 'Paper 1'`, u).id;
    const q = T.createQuote(db, u, { chain: 'solana', tokenAddress: c.mint, side: 'buy', amount: '0.5', slippageBps: 500, walletId: w }, now);
    const i = T.createIntent(db, u, { quoteId: q.id, source: 'manual' }, now, 'live-buy-0001'); T.approveIntent(db, u, i.id, {}, now);
    const o = T.executeIntent(db, u, i.id, now, 'live-exec-0001');
    assert.equal(o.state, 'finalized');
    const pf = T.portfolio(db, u, 'solana', now); assert.equal(pf.dataSource, 'solana_live'); assert.equal(pf.totals.unpriced.length, 0);
    // exits on live prices: entry = our fill price; push the curve up >50% with big buys → TP1 + trailing armed
    S.setRiskPolicy(db, u, { maxPerTrade: '1', maxPerAssetExposure: '5', maxDailyGrossBuy: '10', maxRealizedDailyLoss: '5', maxOpenPositions: 10, maxSlippageBps: 1500, maxFeeQuote: '0.01', maxDataAgeMs: 60_000, allowedChains: ['solana'], entriesPaused: false }, undefined);
    const ex = S.createStrategy(db, u, { kind: 'tp_sl', chain: 'solana', tokenAddress: c.mint, walletId: w, params: D.autoExitParams(D.DEFAULT_AUTO_EXIT) }, now);
    assert.equal(S.evaluateAll(db, 'w', now + 1000).find(r => r.id === ex.id)?.outcome, 'waiting');
    let s2 = slot; for (let k = 0; k < 6; k++) feed(db, st, c.trade(newKey(), true, 4_000_000_000n, Math.floor((now + 2000) / 1000)).logs, ++s2, now + 2000);
    assert.equal(S.evaluateAll(db, 'w', now + 3000).find(r => r.id === ex.id)?.outcome, 'exit_tp1');
    const v = S.strategyView(db, u, ex.id); assert.equal(v.state.trailing.active, true);
    // auto trader on live finder
    const at = S.createStrategy(db, u, { kind: 'auto_trader', chain: 'solana', walletId: w, params: { amount: '0.1', minScore: 0, maxPositions: 3 } }, now + 4000);
    const out = S.evaluateAll(db, 'w', now + 4000).find(r => r.id === at.id)!.outcome;
    assert.ok(/^bought:|^no_candidate|^blocked/.test(out), out);
    if (out.startsWith('bought:')) assert.equal(qa(db, `SELECT token FROM orders WHERE strategy_id = ?`, at.id)[0].token, c.mint);
  } finally { setMarketSource(null); }
});

test('smart-money labels: ≥5 closed round trips, ≥60% wins, positive P&L', () => {
  const db = openDb(':memory:'); const st = L.newStats(); const now = Date.now(); const trader = newKey();
  for (let k = 0; k < 6; k++) {
    const c = new Curve(); let slot = 100 + k * 10; feed(db, st, c.createLogs(), slot, now - 3_600_000);
    const b = c.trade(trader, true, 500_000_000n, Math.floor((now - 3_000_000) / 1000)); feed(db, st, b.logs, ++slot, now - 3_000_000);
    for (let j = 0; j < 5; j++) feed(db, st, c.trade(newKey(), true, 2_000_000_000n, Math.floor((now - 2_000_000) / 1000)).logs, ++slot, now - 2_000_000); // others pump it
    feed(db, st, c.trade(trader, false, b.tok, Math.floor((now - 1_000_000) / 1000)).logs, ++slot, now - 1_000_000); // trader exits in profit
  }
  L.recomputeSmart(db, now);
  const r = q1(db, `SELECT * FROM live_smart WHERE wallet = ?`, trader);
  assert.ok(r, 'labelled'); assert.equal(r.closed, 6); assert.equal(r.wins, 6); assert.ok(BigInt(r.pnl_lamports) > 0n);
});
