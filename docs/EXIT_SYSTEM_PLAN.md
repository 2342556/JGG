# Position exit system — inspection findings and plan

_Status: plan, awaiting owner decisions. Paper only. Live trading stays off; no real order is submitted until the owner approves the verified setup._

## What exists today (inspected)

| File | What it does now |
|---|---|
| `packages/domain/src/strategies.ts` | Trailing TP/SL math (peak only rises, fires once), fixed TP/SL prices, staged quantities (% of **original** qty), exit coordinator (`claimExit`, `applyExternalReduction`). |
| `packages/domain/src/finder.ts` → `autoExitParams` | Auto-trader exit plan: partial at +50% **and** trailing armed at the same moment, remainder TP at +100%, SL −30%. |
| `apps/api/src/strategies.ts` | `tp_sl` / `trailing_*` evaluation every worker tick (2 s), leases, `submit()` → quote → intent → approve → execute, `reconcilePending`, auto trader, `afterLiveFill`. |
| `apps/api/src/trading.ts` | Quotes, intents, reservations, `idempotent()` (key + payload hash), orders state machine, `applyFill` (weighted-average lots, journal), paper reconciliation. |
| `apps/api/src/custody.ts` | Live: Jupiter Swap v2 `/order` + `/execute`, simulation guard, fills read from chain balance deltas, reconciliation (re-send same signed tx ≤ 110 s, else expire), `syncBalances`. |
| `apps/api/src/live.ts` | Live price = pump.fun curve reserves × SOL/USD. Returns **null once a coin graduates**. |
| `apps/api/src/db.ts`, `infra/postgres/migrations/*` | `strategies` (state JSON), `strategy_events` (dedupe), `orders`, `order_events`, `fills`, `idempotency_keys`. |
| `apps/web/src/pages/Auto.tsx`, `Token.tsx` (`ExitDrawer`) | Exit inputs; no per-rule enable/disable, no named presets, no exact trigger/qty preview. |

## Bugs found (verified by running code, not just reading)

1. **Failed exit sell is recorded as done.** A reverted stop-loss sell returns `exit_sl`, sets `remaining = 0` and completes the strategy while every token is still held. Same path for TP stages. Position silently unprotected.
2. **Exit retries can never succeed.** Retry reuses idempotency key `stg:<id>:<exitId>` with a new quote → `IDEMPOTENCY_KEY_REUSED`. A crash between order creation and state save hits the same wall.
3. **Graduated coins lose their price** → exits sit at `no_price` forever (live data).
4. Partial TP is % of **original** qty, not of tokens currently held; trailing arms at the same time as the partial, not after it is confirmed filled.
5. Triggers are USD (token/SOL × SOL/USD): a SOL/USD move can fire a stop with no move in the coin.

## Verified platform limits (official Jupiter docs, 2026-09-26)

- Swap API v2 `/order`: `inputMint`, `outputMint`, `amount` (smallest unit of the input token), `taker`; optional `slippageBps` (default: Jupiter's real-time slippage estimator). A sell is "sell exactly N tokens". There is **no stop/trailing order type** in the Swap API: JGG must watch the price and send a market sell. The fill price can be worse than the trigger (gaps, slippage), and nothing protects the position while the JGG worker is down.
- Jupiter Trigger API V2 does have native stop-loss, OCO and trailing (`trailingBps` 50–9000) orders, but: **$10 minimum**, **partial fills**, tokens are deposited into a **Privy-managed custodial vault**, USD triggers only, trailing starts when the order is created, price source not documented, pump.fun bonding-curve support not documented. Not used in v1; possible later as a server-side backup.
- pump.fun tokens have 6 decimals → quantities are floored to 0.000001 (never rounds up into an oversell).
- Every sell pays a Solana network + priority fee in SOL; with no SOL left for fees the sell cannot be sent.
- No testnet path: pump.fun and Jupiter are mainnet. "Test" = paper trading on live curve reserves plus fault-injected unit/service tests.

## Plan

**State machine** (`packages/domain/src/exitPlan.ts`, pure, persisted as JSON):
`holding → partial_pending → partial_done → trailing_active → closing_pending → closed` (+ `stopped`, `dust`, `needs_attention`). Rules, each individually enabled:
- Initial SL: `entry × (1 − sl%)`; entry = actual average fill price of the position.
- Partial TP: trigger `entry × (1 + tp%)`; sells `floor(held × sell%)` of tokens **held at trigger time**; exactly once (DB-enforced).
- Trailing: `trigger = peak × (1 − trail%)`, peak = highest valid price **after activation**, trigger only moves up. Activation: after partial TP is **confirmed filled** (default), or at +X% gain, or immediately — explicit setting.
- Conflicts: one exit order in flight per position; while pending nothing else is sent; after it settles, re-evaluate from reconciled holdings. SL and trailing both mean "sell all remaining" — the higher stop wins.

**Orders**: new `exit_orders` table (write-ahead): client order id `<position>:<rule>:a<attempt>` stored **before** quoting; attempt increments only after a definitive failure (reverted / not landed); uncertain → reconciliation, never resubmitted blindly; restart resumes the same attempt. Qty is always `min(planned, reconciled held)`.

**Reconciliation**: paper balances / on-chain token accounts (live) checked before every exit and every tick; external reductions shrink the managed qty; never sell more than held.

**Logging**: every state transition and order decision (fire / skip + reason / retry / reconcile) to `strategy_events` with prices, trigger levels, qty and client order id.

**Presets & overrides**: `exit_presets` table (named, versioned); strategy-level config; per-position override (can't re-arm a partial TP already done).

**UI**: one Exit plan editor (toggles, validated %, trailing activation choice, named presets) on Auto, the Token page and each open position, with a live preview of exact trigger prices and token quantities. For the auto trader the exact numbers exist only after the buy fills; before that the preview uses the current quote and is labeled as an estimate, and each position shows its exact numbers once filled.

**Tests**: the owner's worked example (100 tokens @ 100 → SL 80; +100% sells 50 once; trail 20% from peak 250 → 200; new peak recalculates) plus: reverted sell → retry, crash mid-order → resume without double-sell, uncertain → no resubmit, duplicate/stale prices, external reduction, SL vs partial-TP conflict while pending, dust remainder, rounding, kill switch.
