// Verify the standalone Solana indexer against YOUR RPC (run on a networked machine). No secrets are written.
//   JGG_SOLANA_RPC_HTTP=https://... JGG_SOLANA_RPC_WS=wss://... [JGG_JUPITER_API_KEY=...] node scripts/verify-live.mjs [seconds=120]
// Writes docs/live-verify/REPORT.json: decode counts, curve self-check mismatch rate, enrichment results, SOL/USD fetch.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
const { openDb, q1 } = await import('../apps/api/src/db.ts');
const { startIndexer } = await import('../apps/workers/src/indexer.ts');
const L = await import('../apps/api/src/live.ts');
const { createRpc } = await import('../packages/providers/src/solana/rpc.ts');
const secs = Number(process.argv[2] ?? 120);
const dir = join(tmpdir(), 'jgg-verify-' + Date.now()); mkdirSync(dir, { recursive: true });
const db = openDb(join(dir, 'v.db'));
const ix = startIndexer(db, process.env);
console.log(`Listening to pump.fun for ${secs}s…`);
await new Promise(r => setTimeout(r, secs * 1000));
ix.stop();
const rpc = createRpc(process.env.JGG_SOLANA_RPC_HTTP);
const sample = db.prepare(`SELECT mint FROM live_tokens WHERE seen_from_creation = 1 ORDER BY created_at DESC LIMIT 3`).all().map(r => r.mint);
for (const m of sample) await L.enrichToken(db, rpc, m, Date.now());
const st = ix.stats;
const report = {
  seconds: secs, rpcHost: new URL(process.env.JGG_SOLANA_RPC_HTTP).host, stats: st,
  decodeRatePerNotification: st.notifications ? +(st.events / st.notifications).toFixed(3) : null,
  curveModelMismatchRate: st.modelChecks ? +(st.modelMismatches / st.modelChecks).toFixed(4) : null,
  tokensSeen: q1(db, `SELECT COUNT(*) n FROM live_tokens`).n, createdWhileListening: q1(db, `SELECT COUNT(*) n FROM live_tokens WHERE seen_from_creation = 1`).n,
  trades: q1(db, `SELECT COUNT(*) n FROM live_trades`).n,
  enrichment: db.prepare(`SELECT mint, token_program, mint_authority IS NULL AS mintRenounced, freeze_authority IS NULL AS noFreeze, top10_bps, pool_account IS NOT NULL AS poolFound, sec_error FROM live_tokens WHERE mint IN (${sample.map(() => '?').join(',') || "''"})`).all(...sample),
  solUsd: L.solUsd(db, Date.now()),
  verdict: [],
};
if (!st.events) report.verdict.push('FAIL: no pump events decoded — check RPC WS URL / logsSubscribe support');
if (st.events && st.modelChecks && report.curveModelMismatchRate > 0.01) report.verdict.push('WARN: curve model mismatch > 1% — fee/formula assumptions need review');
if (st.txFetchQueued > st.events) report.verdict.push('NOTE: many txs needed getTransaction (events via emit_cpi); raise JGG_TX_FETCH_CONCURRENCY or use a Geyser stream');
if (!report.solUsd) report.verdict.push('WARN: no SOL/USD — set JGG_JUPITER_API_KEY (free key at portal.jup.ag) or JGG_SOL_USD_MANUAL');
if (!report.verdict.length) report.verdict.push('OK');
mkdirSync('docs/live-verify', { recursive: true });
writeFileSync('docs/live-verify/REPORT.json', JSON.stringify(report, (_k, v) => typeof v === 'bigint' ? String(v) : v, 2));
console.log(JSON.stringify(report, (_k, v) => typeof v === 'bigint' ? String(v) : v, 2));
db.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
