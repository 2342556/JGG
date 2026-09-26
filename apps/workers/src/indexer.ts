// JGG standalone indexer (Solana · pump.fun). Separate process: node apps/workers/src/indexer.ts
// Needs JGG_SOLANA_RPC_HTTP + JGG_SOLANA_RPC_WS (any standard Solana RPC provider). JGG_JUPITER_API_KEY for SOL/USD
// (or JGG_SOL_USD_MANUAL for a manually supplied value, flagged as manual on /status).
import { join } from 'node:path';
import { openDb, run, type DB } from '../../api/src/db.ts';
import { createRpc, subscribeLogs } from '../../../packages/providers/src/solana/rpc.ts';
import { jupiterPrices } from '../../../packages/providers/src/solana/jupiter.ts';
import { fomoLeaderboard } from '../../../packages/providers/src/fomo.ts';
import { PUMP_PROGRAM_ID, WSOL_MINT } from '../../../packages/providers/src/solana/pump.ts';
import * as L from '../../api/src/live.ts';

export function startIndexer(db: DB, env: Record<string, string | undefined>) {
  const http = env.JGG_SOLANA_RPC_HTTP, ws = env.JGG_SOLANA_RPC_WS;
  if (!http || !ws) throw new Error('Set JGG_SOLANA_RPC_HTTP and JGG_SOLANA_RPC_WS');
  const rpc = createRpc(http, { maxRps: Number(env.JGG_RPC_MAX_RPS ?? 8) });
  const st = L.newStats(); let conn = 'connecting'; let connInfo = ''; let liveSince: number | null = null; // exits distrust reserves older than the current stream
  const txQueue: string[] = []; const MAX_Q = 500; let dropped = 0; let inflight = 0; const MAX_INFLIGHT = Number(env.JGG_TX_FETCH_CONCURRENCY ?? 2);
  const sub = subscribeLogs(ws, PUMP_PROGRAM_ID, (v, slot) => {
    const now = Date.now();
    try { if (L.ingestLogs(db, v, slot, now, st)) { if (txQueue.length >= MAX_Q) { txQueue.shift(); dropped++; } txQueue.push(v.signature); } }
    catch (e) { st.decodeErrors++; console.error('ingest error', (e as Error).message); }
  }, { onState: (s, info) => { if (s === 'live' && conn !== 'live') liveSince = Date.now(); conn = s; connInfo = info ?? ''; console.log(new Date().toISOString(), 'ws', s, info ?? ''); } });
  const pump = setInterval(() => { // emit_cpi fallback: fetch full transactions (bounded)
    while (inflight < MAX_INFLIGHT && txQueue.length) {
      const sig = txQueue.shift()!; inflight++;
      rpc.getTransaction(sig).then(t => { if (t) L.ingestTransaction(db, sig, t, Date.now(), st); }).catch(() => { st.decodeErrors++; }).finally(() => { inflight--; });
    }
  }, 50);
  let enriching = false;
  const enrich = setInterval(async () => {
    if (enriching) return; enriching = true;
    try { for (const m of L.tokensNeedingEnrichment(db, Date.now(), 3)) await L.enrichToken(db, rpc, m, Date.now()); } finally { enriching = false; }
  }, 5_000);
  const price = async () => {
    try {
      if (env.JGG_JUPITER_API_KEY) { const p = await jupiterPrices([WSOL_MINT], env.JGG_JUPITER_API_KEY); if (p[WSOL_MINT]) L.setSolUsd(db, L.numToDec(p[WSOL_MINT].usdPrice), 'jupiter-price-v3', Date.now()); }
      else if (env.JGG_SOL_USD_MANUAL) L.setSolUsd(db, env.JGG_SOL_USD_MANUAL, 'manual (JGG_SOL_USD_MANUAL)', Date.now());
    } catch (e) { console.error('price error', (e as Error).message); }
  };
  price(); const priceIv = setInterval(price, 60_000);
  // Graduated coins with active exits: Jupiter Price v3 every 10 s (one request, ≤50 mints). Missing = unknown (exits wait, never assume).
  const gradIv = setInterval(async () => {
    if (!env.JGG_JUPITER_API_KEY) return;
    try { const mints = L.graduatedExitMints(db); if (!mints.length) return; const p = await jupiterPrices(mints, env.JGG_JUPITER_API_KEY); const at = Date.now();
      for (const m of mints) if (p[m]) L.setExtPrice(db, m, L.numToDec(p[m].usdPrice), 'jupiter-price-v3', at); } catch (e) { console.error('graduated price error', (e as Error).message); }
  }, 10_000);
  // Optional third-party labels (fomoapi.io). Hourly by default: a leaderboard call costs 250 credits (free key ≈ 1,000 calls/month).
  let fomoIv: any = null;
  if (env.JGG_FOMOAPI_KEY) {
    const everyMs = Math.max(30, Number(env.JGG_FOMO_POLL_MIN ?? 60)) * 60_000; let fomoStop = false;
    const pollFomo = async () => {
      if (fomoStop) return;
      try {
        const r = await fomoLeaderboard(env.JGG_FOMOAPI_KEY!, '7d', { base: env.JGG_FOMOAPI_BASE });
        L.saveFomoTraders(db, '7d', r.traders, Date.now());
        if (r.belowReserve) fomoStop = true; // keep a credit reserve; resume after restart / next month
        run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('fomo', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          JSON.stringify({ ok: true, traders: r.traders.length, capturedAt: r.capturedAt, creditsRemaining: r.creditsRemaining, paused: fomoStop }), Date.now());
      } catch (e) {
        const code = (e as any).code ?? 'ERROR'; if (code === 'AUTH' || code === 'CREDITS_EXHAUSTED') fomoStop = true;
        run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('fomo', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify({ ok: false, error: code, paused: fomoStop }), Date.now());
      }
    };
    pollFomo(); fomoIv = setInterval(pollFomo, everyMs);
  }
  const smart = setInterval(() => { try { L.recomputeSmart(db, Date.now()); } catch (e) { console.error('smart error', (e as Error).message); } }, 5 * 60_000);
  L.recomputeSmart(db, Date.now());
  const beat = setInterval(() => run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('indexer', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    JSON.stringify({ conn, connInfo, liveSince, ...st, txQueue: txQueue.length, txDropped: dropped, modelMismatchRate: st.modelChecks ? st.modelMismatches / st.modelChecks : null }), Date.now()), 2_000);
  const prune = setInterval(() => run(db, `DELETE FROM live_trades WHERE ts < ?`, Date.now() - 8 * 86_400_000), 3_600_000); // keep 8 days (smart labels use 7)
  return { stats: st, stop: () => { sub.stop(); for (const iv of [pump, enrich, priceIv, gradIv, smart, beat, prune, fomoIv]) if (iv) clearInterval(iv); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.JGG_DB ?? join(process.cwd(), 'data', 'jgg.db'));
  const ix = startIndexer(db, process.env);
  const stop = () => { ix.stop(); setTimeout(() => { db.close(); process.exit(0); }, 200); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log('JGG indexer started (pump.fun on Solana)');
}
