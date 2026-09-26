// Dev/test persistence on Node's built-in SQLite (WAL; shared by API + worker processes).
// Production contract is PostgreSQL with RLS: infra/postgres/migrations/*.sql.
// Every repository query in this app is owner-scoped (user_id) — tested in tests/api (T14).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const MIGRATIONS: { id: string; sql: string }[] = [{ id: '0001_init', sql: `
CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('demo','wallet')), display TEXT, referral_code TEXT UNIQUE NOT NULL, referred_by TEXT);
CREATE TABLE identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, verified_at INTEGER NOT NULL, UNIQUE (chain, address));
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE auth_challenges (nonce TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, domain TEXT NOT NULL, message TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE settings (user_id TEXT PRIMARY KEY REFERENCES users(id), mode TEXT NOT NULL CHECK (mode IN ('demo','live_readonly','paper','live')), mode_version INTEGER NOT NULL DEFAULT 1, chain TEXT NOT NULL DEFAULT 'solana', layout TEXT NOT NULL DEFAULT '{}', display TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE wallets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, custody TEXT NOT NULL CHECK (custody IN ('paper','watch','external','hosted')), label TEXT, verified_control INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (user_id, chain, address));
CREATE TABLE presets (user_id TEXT NOT NULL REFERENCES users(id), slot TEXT NOT NULL, chain TEXT NOT NULL, config TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, slot, chain));
CREATE TABLE risk_policies (user_id TEXT PRIMARY KEY REFERENCES users(id), policy TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE watchlists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE (user_id, name));
CREATE TABLE watchlist_items (watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE, user_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL, note TEXT, added_at INTEGER NOT NULL, PRIMARY KEY (watchlist_id, chain, address));
CREATE TABLE tracked_wallets (user_id TEXT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, nickname TEXT, grp TEXT, muted INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, chain, address));
CREATE TABLE idempotency_keys (user_id TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, scope, key));
CREATE TABLE quotes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, mode_version INTEGER NOT NULL, wallet_id TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL, body TEXT NOT NULL, context_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE trade_intents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, mode_version INTEGER NOT NULL, quote_id TEXT NOT NULL REFERENCES quotes(id), wallet_id TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL,
  amount TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, strategy_id TEXT, context_hash TEXT NOT NULL, approval TEXT, reservation_id TEXT, order_id TEXT, reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ix_intents_user ON trade_intents(user_id, created_at);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, intent_id TEXT UNIQUE, strategy_id TEXT, chain TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL, amount_in TEXT NOT NULL, min_out TEXT, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL, provider_state TEXT, tx_ref TEXT, filled_out TEXT, fee_native TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ix_orders_user ON orders(user_id, created_at);
CREATE INDEX ix_orders_state ON orders(state);
CREATE TABLE order_events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), from_state TEXT, to_state TEXT NOT NULL, version INTEGER NOT NULL, detail TEXT, at INTEGER NOT NULL, UNIQUE (order_id, version));
CREATE TABLE order_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), attempt INTEGER NOT NULL, tx_ref TEXT, dispatched_at INTEGER, outcome TEXT, UNIQUE (order_id, attempt));
CREATE TABLE fills (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), chain_fill_id TEXT NOT NULL, qty_in TEXT NOT NULL, qty_out TEXT NOT NULL, fee_native TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (order_id, chain_fill_id));
CREATE TABLE paper_balances (user_id TEXT NOT NULL, wallet_id TEXT NOT NULL REFERENCES wallets(id), asset TEXT NOT NULL, qty TEXT NOT NULL, reserved TEXT NOT NULL DEFAULT '0', version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (wallet_id, asset));
CREATE TABLE balance_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL, asset TEXT NOT NULL, qty TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('held','consumed','released')), purpose TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE position_lots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, bucket TEXT NOT NULL, known_qty TEXT NOT NULL, known_basis TEXT NOT NULL, unknown_qty TEXT NOT NULL DEFAULT '0', realized TEXT NOT NULL DEFAULT '0', version INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, UNIQUE (wallet_id, chain, token, bucket));
CREATE TABLE journal_entries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE journal_lines (entry_id TEXT NOT NULL REFERENCES journal_entries(id), account TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL);
CREATE TABLE strategies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, kind TEXT NOT NULL, chain TEXT NOT NULL, token TEXT, wallet_id TEXT NOT NULL, params TEXT NOT NULL, state TEXT NOT NULL, lifecycle TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT, grant_json TEXT, reason TEXT, lease_owner TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ix_strat_active ON strategies(lifecycle);
CREATE TABLE strategy_events (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, dedupe TEXT UNIQUE, at INTEGER NOT NULL);
CREATE TABLE alerts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_eval INTEGER, last_fired INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE alert_events (id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, user_id TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, detail TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, dedupe TEXT UNIQUE, destination TEXT NOT NULL, delivery TEXT NOT NULL, read_at INTEGER, at INTEGER NOT NULL);
CREATE TABLE ai_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, prompt TEXT NOT NULL, planner TEXT NOT NULL, status TEXT NOT NULL, output TEXT, cost TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE ai_tool_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id), tool TEXT NOT NULL, scope TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, result_summary TEXT, at INTEGER NOT NULL);
CREATE TABLE skill_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, skill_id TEXT NOT NULL, mode TEXT NOT NULL, inputs TEXT NOT NULL, status TEXT NOT NULL, output TEXT, at INTEGER NOT NULL);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER, request_budget INTEGER NOT NULL DEFAULT 10000, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE launch_intents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, launchpad TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, review TEXT, created_at INTEGER NOT NULL);
CREATE TABLE commission_entries (id TEXT PRIMARY KEY, beneficiary TEXT NOT NULL, fee_ref TEXT NOT NULL, program TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (fee_ref, program, beneficiary));
CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, correlation_id TEXT, at INTEGER NOT NULL);
CREATE TABLE outbox_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, topic TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER);
CREATE TABLE inbox_events (source TEXT NOT NULL, event_id TEXT NOT NULL, consumer TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (source, event_id, consumer));
CREATE TABLE paper_chain (tx_ref TEXT PRIMARY KEY, order_id TEXT NOT NULL, landed INTEGER NOT NULL, filled_out TEXT, fee TEXT, at INTEGER NOT NULL);
CREATE TABLE worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
` },
{ id: '0002_strategy_bucket', sql: `ALTER TABLE strategies ADD COLUMN bucket TEXT; CREATE INDEX ix_strat_user ON strategies(user_id, created_at);` },
{ id: '0003_live_solana', sql: `
CREATE TABLE live_tokens (mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, uri TEXT, creator TEXT, bonding_curve TEXT, created_at INTEGER NOT NULL, created_sig TEXT,
  v_sol TEXT, v_tok TEXT, r_sol TEXT, r_tok TEXT, state_slot INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, fee_bps INTEGER,
  last_trade_at INTEGER, first_seen_at INTEGER NOT NULL, seen_from_creation INTEGER NOT NULL DEFAULT 0,
  sec_checked_at INTEGER, token_program TEXT, mint_authority TEXT, freeze_authority TEXT, risky_ext TEXT, top10_bps INTEGER, pool_account TEXT, sec_error TEXT);
CREATE INDEX ix_live_tokens_created ON live_tokens(created_at DESC);
CREATE INDEX ix_live_tokens_last ON live_tokens(last_trade_at DESC);
CREATE TABLE live_trades (sig TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, wallet TEXT NOT NULL, is_buy INTEGER NOT NULL, sol TEXT NOT NULL, tok TEXT NOT NULL,
  v_sol TEXT NOT NULL, v_tok TEXT NOT NULL, ts INTEGER NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (sig, idx));
CREATE INDEX ix_live_trades_mint ON live_trades(mint, ts);
CREATE INDEX ix_live_trades_wallet ON live_trades(wallet, ts);
CREATE INDEX ix_live_trades_ts ON live_trades(ts);
CREATE TABLE live_smart (wallet TEXT PRIMARY KEY, closed INTEGER NOT NULL, wins INTEGER NOT NULL, pnl_lamports TEXT NOT NULL, updated_at INTEGER NOT NULL);
` },
{ id: '0004_fomo_custody', sql: `
CREATE TABLE fomo_traders (wallet TEXT PRIMARY KEY, handle TEXT NOT NULL, user_id TEXT, rank INTEGER, window TEXT NOT NULL, pnl_usd REAL, volume_usd REAL, verified INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE custody_wallets (user_id TEXT PRIMARY KEY REFERENCES users(id), address TEXT NOT NULL UNIQUE, enc_secret TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE live_exec (order_id TEXT PRIMARY KEY REFERENCES orders(id), user_id TEXT NOT NULL, request_id TEXT, signed_tx TEXT, signature TEXT, submitted_at INTEGER, status TEXT NOT NULL, detail TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE custody_withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_address TEXT NOT NULL, lamports TEXT NOT NULL, signature TEXT, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE custody_locks (user_id TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
` },
{ id: '0005_finder_outcomes', sql: `
CREATE TABLE finder_outcomes (token TEXT PRIMARY KEY, scanned_at INTEGER NOT NULL, score INTEGER NOT NULL, coverage_bps INTEGER NOT NULL,
  entry_v_sol TEXT NOT NULL, entry_v_tok TEXT NOT NULL, entry_liq_lamports TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'tracking',
  outcome TEXT, outcome_at INTEGER, last_checked_at INTEGER NOT NULL);
CREATE INDEX ix_finder_outcomes_status ON finder_outcomes(status);
CREATE INDEX ix_finder_outcomes_scanned ON finder_outcomes(scanned_at);
CREATE TABLE finder_outcome_samples (token TEXT NOT NULL, minutes_since INTEGER NOT NULL, at INTEGER NOT NULL, price_bps_change INTEGER, liq_lamports TEXT NOT NULL, PRIMARY KEY (token, minutes_since));
CREATE INDEX ix_finder_samples_horizon ON finder_outcome_samples(minutes_since);
` }];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000;'); // first, so concurrent API+worker startup waits instead of failing
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(m.id);
    if (done) continue;
    tx(db, () => { if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(m.id)) return; db.exec(m.sql); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.id, Date.now()); }); // re-check under the write lock
  }
  return db;
}

/** Short IMMEDIATE transaction (write lock acquired up front). Never await inside. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const q1 = <T = any>(db: DB, sql: string, ...args: any[]): T | undefined => db.prepare(sql).get(...args) as T | undefined;
export const qa = <T = any>(db: DB, sql: string, ...args: any[]): T[] => db.prepare(sql).all(...args) as T[];
export const run = (db: DB, sql: string, ...args: any[]) => db.prepare(sql).run(...args);
