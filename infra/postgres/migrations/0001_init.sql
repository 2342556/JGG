-- JGG production schema for PostgreSQL 15+ (verified on PostgreSQL 17.6 / Supabase).
-- Everything lives in schema `jgg` so it is isolated and reversible: DROP SCHEMA jgg CASCADE.
-- Tenant isolation: the app connects as a NON-superuser role without BYPASSRLS and runs
--   SET LOCAL jgg.user_id = '<user id>'  at the start of every request transaction.
-- Money/quantities: NUMERIC (exact). Raw on-chain integers: NUMERIC(78,0) (uint256 fits).
BEGIN;
CREATE SCHEMA IF NOT EXISTS jgg;
SET search_path = jgg;

CREATE OR REPLACE FUNCTION jgg.current_user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('jgg.user_id', true), '') $$;

CREATE TABLE users (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL CHECK (kind IN ('demo','wallet')), display text, referral_code text UNIQUE NOT NULL, referred_by text);
CREATE TABLE identities (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), chain text NOT NULL, address text NOT NULL, verified_at timestamptz NOT NULL, UNIQUE (chain, address));
CREATE TABLE sessions (id_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), csrf text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE TABLE auth_challenges (nonce text PRIMARY KEY, chain text NOT NULL, address text NOT NULL, domain text NOT NULL, message text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE settings (user_id text PRIMARY KEY REFERENCES users(id), mode text NOT NULL CHECK (mode IN ('demo','live_readonly','paper','live')), mode_version int NOT NULL DEFAULT 1, chain text NOT NULL DEFAULT 'solana', layout jsonb NOT NULL DEFAULT '{}', display jsonb NOT NULL DEFAULT '{}', version int NOT NULL DEFAULT 1);
CREATE TABLE wallets (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), chain text NOT NULL, address text NOT NULL, custody text NOT NULL CHECK (custody IN ('paper','watch','external','hosted')), label text, verified_control boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, chain, address));
CREATE TABLE presets (user_id text NOT NULL REFERENCES users(id), slot text NOT NULL, chain text NOT NULL, config jsonb NOT NULL, schema_version int NOT NULL DEFAULT 1, version int NOT NULL DEFAULT 1, PRIMARY KEY (user_id, slot, chain));
CREATE TABLE risk_policies (user_id text PRIMARY KEY REFERENCES users(id), policy jsonb NOT NULL, version int NOT NULL DEFAULT 1);
CREATE TABLE watchlists (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), name text NOT NULL, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, name));
CREATE TABLE watchlist_items (watchlist_id text NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), chain text NOT NULL, address text NOT NULL, note text, added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (watchlist_id, chain, address));
CREATE TABLE tracked_wallets (user_id text NOT NULL REFERENCES users(id), chain text NOT NULL, address text NOT NULL, nickname text, grp text, muted boolean NOT NULL DEFAULT false, added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, chain, address));
CREATE TABLE idempotency_keys (user_id text NOT NULL REFERENCES users(id), key text NOT NULL, scope text NOT NULL, payload_hash text NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, scope, key));
CREATE TABLE quotes (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, mode_version int NOT NULL, wallet_id text NOT NULL REFERENCES wallets(id), chain text NOT NULL, token text NOT NULL, side text NOT NULL CHECK (side IN ('buy','sell')), body jsonb NOT NULL, context_hash text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE trade_intents (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, mode_version int NOT NULL, quote_id text NOT NULL REFERENCES quotes(id), wallet_id text NOT NULL REFERENCES wallets(id), chain text NOT NULL, token text NOT NULL, side text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0), state text NOT NULL, version int NOT NULL DEFAULT 0, source text NOT NULL, strategy_id text, context_hash text NOT NULL, approval jsonb, reservation_id text, order_id text, reason text, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE INDEX ix_intents_user ON trade_intents (user_id, created_at DESC);
CREATE TABLE orders (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, intent_id text UNIQUE REFERENCES trade_intents(id), strategy_id text, chain text NOT NULL, token text NOT NULL, side text NOT NULL, amount_in numeric NOT NULL, min_out numeric, state text NOT NULL, version int NOT NULL DEFAULT 0,
  provider text NOT NULL, provider_state text, tx_ref text, filled_out numeric, fee_native numeric, error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE INDEX ix_orders_user ON orders (user_id, created_at DESC, id DESC);
CREATE INDEX ix_orders_reconcile ON orders (state) WHERE state = 'reconciliation_required';
CREATE TABLE order_events (id bigserial PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), user_id text NOT NULL REFERENCES users(id), from_state text, to_state text NOT NULL, version int NOT NULL, detail jsonb, at timestamptz NOT NULL, UNIQUE (order_id, version));
CREATE TABLE order_attempts (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), user_id text NOT NULL REFERENCES users(id), attempt int NOT NULL, tx_ref text, dispatched_at timestamptz, outcome text, UNIQUE (order_id, attempt));
CREATE TABLE fills (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), user_id text NOT NULL REFERENCES users(id), chain_fill_id text NOT NULL, qty_in numeric NOT NULL, qty_out numeric NOT NULL, fee_native numeric NOT NULL, at timestamptz NOT NULL, UNIQUE (order_id, chain_fill_id));
CREATE TABLE paper_balances (user_id text NOT NULL REFERENCES users(id), wallet_id text NOT NULL REFERENCES wallets(id), asset text NOT NULL, qty numeric NOT NULL CHECK (qty >= 0), reserved numeric NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= qty), version int NOT NULL DEFAULT 0, PRIMARY KEY (wallet_id, asset));
CREATE TABLE balance_reservations (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), wallet_id text NOT NULL REFERENCES wallets(id), asset text NOT NULL, qty numeric NOT NULL CHECK (qty > 0), state text NOT NULL CHECK (state IN ('held','consumed','released')), purpose text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE position_lots (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), wallet_id text NOT NULL REFERENCES wallets(id), chain text NOT NULL, token text NOT NULL, bucket text NOT NULL, known_qty numeric NOT NULL CHECK (known_qty >= 0), known_basis numeric NOT NULL, unknown_qty numeric NOT NULL DEFAULT 0, realized numeric NOT NULL DEFAULT 0, version int NOT NULL DEFAULT 0, opened_at timestamptz NOT NULL, UNIQUE (wallet_id, chain, token, bucket));
CREATE TABLE journal_entries (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, ref text NOT NULL UNIQUE, kind text NOT NULL, at timestamptz NOT NULL);
CREATE TABLE journal_lines (entry_id text NOT NULL REFERENCES journal_entries(id), user_id text NOT NULL REFERENCES users(id), account text NOT NULL, asset text NOT NULL, amount numeric NOT NULL);
-- Double-entry invariant enforced by the database at commit: every entry sums to zero per asset.
CREATE OR REPLACE FUNCTION jgg.check_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM jgg.journal_lines WHERE entry_id = NEW.entry_id GROUP BY asset HAVING SUM(amount) <> 0) THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL entry %', NEW.entry_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jgg.check_journal_balanced();
CREATE TABLE strategies (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, kind text NOT NULL, chain text NOT NULL, token text, wallet_id text NOT NULL REFERENCES wallets(id), params jsonb NOT NULL, state jsonb NOT NULL, lifecycle text NOT NULL, version int NOT NULL DEFAULT 0,
  parent_id text REFERENCES strategies(id), grant_json jsonb, bucket text, reason text, lease_owner text, lease_until timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE INDEX ix_strat_active ON strategies (lifecycle) WHERE lifecycle = 'active';
CREATE TABLE strategy_events (id bigserial PRIMARY KEY, strategy_id text NOT NULL REFERENCES strategies(id), user_id text NOT NULL REFERENCES users(id), kind text NOT NULL, detail jsonb, dedupe text UNIQUE, at timestamptz NOT NULL);
CREATE TABLE alerts (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, last_eval timestamptz, last_fired timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE alert_events (id text PRIMARY KEY, alert_id text NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), dedupe text NOT NULL UNIQUE, detail jsonb NOT NULL, at timestamptz NOT NULL);
CREATE TABLE notifications (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), kind text NOT NULL, title text NOT NULL, body text NOT NULL, dedupe text UNIQUE, destination text NOT NULL, delivery text NOT NULL, read_at timestamptz, at timestamptz NOT NULL);
CREATE TABLE ai_runs (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), prompt text NOT NULL, planner text NOT NULL, status text NOT NULL, output jsonb, cost numeric NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, finished_at timestamptz);
CREATE TABLE ai_tool_calls (id text PRIMARY KEY, run_id text NOT NULL REFERENCES ai_runs(id), user_id text NOT NULL REFERENCES users(id), tool text NOT NULL, scope text NOT NULL, args jsonb NOT NULL, status text NOT NULL, result_summary jsonb, at timestamptz NOT NULL);
CREATE TABLE skill_runs (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), skill_id text NOT NULL, mode text NOT NULL, inputs jsonb NOT NULL, status text NOT NULL, output jsonb, at timestamptz NOT NULL);
CREATE TABLE api_keys (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), name text NOT NULL, prefix text NOT NULL, secret_hash text NOT NULL UNIQUE, scopes jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz, request_budget int NOT NULL DEFAULT 10000, used int NOT NULL DEFAULT 0);
CREATE TABLE launch_intents (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), mode text NOT NULL, launchpad text NOT NULL, config jsonb NOT NULL, state text NOT NULL, version int NOT NULL DEFAULT 0, review jsonb, created_at timestamptz NOT NULL);
CREATE TABLE commission_entries (id text PRIMARY KEY, beneficiary text NOT NULL REFERENCES users(id), fee_ref text NOT NULL, program text NOT NULL, amount numeric NOT NULL CHECK (amount >= 0), state text NOT NULL CHECK (state IN ('pending','available','paid','reversed')), at timestamptz NOT NULL, UNIQUE (fee_ref, program, beneficiary));
CREATE TABLE audit_events (id bigserial PRIMARY KEY, user_id text, actor text NOT NULL, action text NOT NULL, detail jsonb, correlation_id text, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox_events (id bigserial PRIMARY KEY, user_id text, topic text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE inbox_events (source text NOT NULL, event_id text NOT NULL, consumer text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (source, event_id, consumer));
CREATE TABLE worker_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- ---------------- Row-level security: owner-only on every tenant table ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identities','settings','wallets','presets','risk_policies','watchlists','watchlist_items','tracked_wallets','idempotency_keys','quotes','trade_intents','orders','order_events','order_attempts','fills',
    'paper_balances','balance_reservations','position_lots','journal_entries','journal_lines','strategies','strategy_events','alerts','alert_events','notifications','ai_runs','ai_tool_calls','skill_runs','api_keys','launch_intents'] LOOP
    EXECUTE format('ALTER TABLE jgg.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE jgg.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_only ON jgg.%I USING (user_id = jgg.current_user_id()) WITH CHECK (user_id = jgg.current_user_id())', t);
  END LOOP;
END $$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY self_only ON users USING (id = jgg.current_user_id()) WITH CHECK (id = jgg.current_user_id());
ALTER TABLE commission_entries ENABLE ROW LEVEL SECURITY; ALTER TABLE commission_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY beneficiary_read ON commission_entries FOR SELECT USING (beneficiary = jgg.current_user_id());
-- sessions/auth_challenges/audit/outbox/inbox/worker_state: service-role only (no grants to the app tenant role).

-- Application role: no BYPASSRLS, no superuser. Password/login are provisioned outside migrations.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jgg_app') THEN CREATE ROLE jgg_app NOLOGIN NOBYPASSRLS; END IF; END $$;
GRANT USAGE ON SCHEMA jgg TO jgg_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA jgg TO jgg_app;
REVOKE ALL ON sessions, auth_challenges, audit_events, outbox_events, inbox_events, worker_state FROM jgg_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA jgg TO jgg_app;
COMMIT;
