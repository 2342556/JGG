// JGG durable worker: strategy triggers, reconciliation, alerts, expiry, outbox housekeeping.
// Separate process from the API; shares the database. Leases make multiple workers safe (T30).
import { join } from 'node:path';
import { hostname } from 'node:os';
import { openDb, qa, run, tx, type DB } from '../../api/src/db.ts';
import { evaluateAll } from '../../api/src/strategies.ts';
import { reconcileOrder, releaseReservation, expireInterruptedPaperOrders } from '../../api/src/trading.ts';
import { evaluateAlerts } from '../../api/src/alerts.ts';
import { ensureDemoAnchor } from '../../api/src/server.ts';
import { demoNow } from '../../../packages/test-fixtures/src/index.ts';
import { getMarketSource, setMarketSource } from '../../../packages/providers/src/execution.ts';
import * as L from '../../api/src/live.ts';
import { createLiveSource } from '../../api/src/live.ts';
import * as K from '../../api/src/custody.ts';
import { setLiveGate, setLiveLimits } from '../../api/src/trading.ts';
import { afterLiveFill } from '../../api/src/strategies.ts';
import { createRpc } from '../../../packages/providers/src/solana/rpc.ts';
import { qa as qall } from '../../api/src/db.ts';

/** Live (real funds) loop: dispatch queued live orders, reconcile uncertain ones, refresh on-chain balances. */
export async function liveTickOnce(db: DB, deps: Parameters<typeof K.dispatchLive>[1], now = Date.now()) {
  const out = { dispatched: 0, reconciled: 0, synced: 0 };
  for (const o of qall(db, `SELECT o.id FROM orders o LEFT JOIN live_exec l ON l.order_id = o.id WHERE o.mode = 'live' AND o.state = 'submitting' AND l.order_id IS NULL LIMIT 10`)) { await K.dispatchLive(db, deps, o.id, now); out.dispatched++; }
  for (const o of qall(db, `SELECT id FROM orders WHERE mode = 'live' AND state = 'reconciliation_required' LIMIT 10`)) { await K.reconcileLive(db, deps, o.id, now); out.reconciled++; }
  for (const u of qall(db, `SELECT user_id FROM custody_wallets`)) { await K.syncBalances(db, deps.rpc, u.user_id).catch(() => null); out.synced++; }
  return out;
}

export const RECONCILE_AFTER_MS = 5_000;

export function tickOnce(db: DB, owner: string, now = getMarketSource()?.now() ?? demoNow()) {
  if (getMarketSource()?.kind === 'solana_live') { L.recordFinderPasses(db, now); L.updateFinderOutcomes(db, now); }
  const interrupted = expireInterruptedPaperOrders(db, now); // paper orders orphaned by a crash mid-dispatch
  const strategies = evaluateAll(db, owner, now);
  // Reconcile uncertain submissions: consult external truth; never resubmit (T20).
  const uncertain = qa(db, `SELECT id, user_id FROM orders WHERE state = 'reconciliation_required' AND updated_at < ? LIMIT 100`, now - RECONCILE_AFTER_MS);
  const reconciled = uncertain.map(o => { try { return reconcileOrder(db, o.user_id, o.id, now); } catch (e) { return { orderId: o.id, error: (e as Error).message }; } });
  // Expire stale intents and release their reservations.
  const stale = qa(db, `SELECT id, reservation_id FROM trade_intents WHERE state IN ('awaiting_approval','authorized','validating','draft') AND expires_at < ?`, now);
  for (const s of stale) tx(db, () => { run(db, `UPDATE trade_intents SET state = 'expired', reason = 'EXPIRED', version = version + 1, updated_at = ? WHERE id = ?`, now, s.id); if (s.reservation_id) releaseReservation(db, s.reservation_id); });
  const alerts = evaluateAlerts(db, now);
  run(db, `UPDATE outbox_events SET published_at = ? WHERE published_at IS NULL AND created_at < ?`, Date.now(), Date.now() - 60_000);
  run(db, `DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ?`, Date.now() - 86_400_000);
  const summary = { strategies: strategies.length, triggered: strategies.filter(s => !['waiting', 'watching', 'lease_held', 'no_price'].includes(s.outcome)).length, reconciled: reconciled.length, interrupted, expired: stale.length, alertsFired: alerts.fired };
  run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('heartbeat', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify({ owner, ...summary, demoClock: new Date(now).toISOString() }), Date.now());
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.JGG_DB ?? join(process.cwd(), 'data', 'jgg.db'));
  ensureDemoAnchor(db);
  if (process.env.JGG_DATA_SOURCE === 'solana_live') setMarketSource(createLiveSource(db));
  setLiveGate(K.liveGateFor(db, process.env)); { const lc = K.liveConfig(process.env); setLiveLimits({ maxTradeSol: lc.maxTradeSol, maxDailySol: lc.maxDailySol }); }
  const liveDeps = process.env.JGG_SOLANA_RPC_HTTP && process.env.JGG_LIVE_TRADING === 'enabled' ? (() => { const rpc = createRpc(process.env.JGG_SOLANA_RPC_HTTP!); return { rpc, env: process.env, onFill: afterLiveFill }; })() : null;
  let liveBusy = false;
  if (liveDeps) setInterval(async () => { if (liveBusy) return; liveBusy = true; try { await liveTickOnce(db, liveDeps); } catch (e) { console.error('live tick failed:', (e as Error).message); } finally { liveBusy = false; } }, 3000);
  const owner = `${hostname()}:${process.pid}`;
  let stopping = false; let busy = false;
  const iv = setInterval(() => {
    if (stopping || busy) return; busy = true;
    try { const s = tickOnce(db, owner); if (s.triggered || s.reconciled || s.alertsFired) console.log(new Date().toISOString(), JSON.stringify(s)); }
    catch (e) { console.error('tick failed:', (e as Error).message); }
    finally { busy = false; }
  }, Number(process.env.JGG_WORKER_INTERVAL_MS ?? 2000));
  const stop = () => { stopping = true; clearInterval(iv); const wait = setInterval(() => { if (!busy) { clearInterval(wait); db.close(); console.log('worker stopped cleanly'); process.exit(0); } }, 50); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`JGG worker ${owner} started`);
}
