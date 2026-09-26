-- Position exit system (owner spec 2026-09-26): named exit presets, write-ahead exit orders, external prices for graduated coins.
BEGIN;
SET search_path = jgg;
CREATE TABLE exit_presets (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40), config jsonb NOT NULL,
  version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE (user_id, name));
CREATE TABLE exit_orders (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), strategy_id text NOT NULL REFERENCES strategies(id),
  rule text NOT NULL CHECK (rule IN ('stop_loss','partial_tp','trailing')), qty numeric NOT NULL CHECK (qty > 0), trigger_price numeric NOT NULL, observed_price numeric NOT NULL,
  state text NOT NULL CHECK (state IN ('planned','submitted','filled','failed')), intent_id text, order_id text REFERENCES orders(id), sold_qty numeric, reason text,
  planned_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
-- The partial take-profit can be FILLED at most once per position; at most one exit order in flight per position.
CREATE UNIQUE INDEX ux_exit_partial_once ON exit_orders (strategy_id) WHERE rule = 'partial_tp' AND state = 'filled';
CREATE UNIQUE INDEX ux_exit_one_open ON exit_orders (strategy_id) WHERE state IN ('planned','submitted');
-- One exit plan per coin per wallet: two plans would both sell the same tokens.
CREATE UNIQUE INDEX ux_one_exit_plan ON strategies (user_id, wallet_id, chain, token) WHERE kind = 'position_exit' AND lifecycle IN ('active','paused','draft');
CREATE INDEX ix_exit_orders_strategy ON exit_orders (strategy_id, planned_at);
-- Per-fill USD unit price, so exits use the actual average FILL price (cost basis also includes network fees).
ALTER TABLE fills ADD COLUMN unit_usd numeric;
CREATE TABLE ext_prices (chain text NOT NULL, mint text NOT NULL, usd numeric NOT NULL CHECK (usd > 0), source text NOT NULL, at timestamptz NOT NULL, PRIMARY KEY (chain, mint));
ALTER TABLE exit_presets ENABLE ROW LEVEL SECURITY; ALTER TABLE exit_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON exit_presets USING (user_id = jgg.current_user_id()) WITH CHECK (user_id = jgg.current_user_id());
ALTER TABLE exit_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE exit_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON exit_orders USING (user_id = jgg.current_user_id()) WITH CHECK (user_id = jgg.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON exit_presets, exit_orders TO jgg_app;
GRANT SELECT ON ext_prices TO jgg_app; -- market data, written by the service role (worker) only
COMMIT;
