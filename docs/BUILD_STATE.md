# JGG — Build State (checkpoint)

_Last updated: 2026-09-26, session 8._

## Status in one line
Demo/Paper terminal works end-to-end (web + API + worker + Postgres/RLS schema verified on Supabase). Nothing is live. See `docs/REQUIREMENTS.md` for every M/C/T item.

## Done this session (with evidence — details in docs/verification.md)
- API: strategies (draft→activate, leases, TP/SL, trailing, copy, snipes, kill switch), tools/Skills runner (66), rule-based AI planner (proposals only), all v1 routes, SSE stream, alerts, worker.
- Web: all routes M01–M16 (Trenches 3-column with pause/hold + quick buy, Trending table, CopyTrade 8 tabs, Monitor + rules, Track, Portfolio + ledger/orders/strategies/export, Rewards, Up/Down, Perpetual, Cooking, AI + Skills Market + detail/run drawer, Token terminal with canvas chart + ticket + exits, Wallet page + copy setup, Watchlist, Settings (mode/presets/risk/API keys/notifications), Status). Resizable dock, utility bar, mobile bottom nav.
- Tests: 39/39 (`npm test`); browser smoke 17 routes × 7 viewports, 0 console errors, 0 overflow, 5 flows pass; secret scan clean.
- Postgres: `infra/postgres/migrations/0001–0003` applied to Supabase project `mmpjzxvqvhqeucasswqz` in schema `jgg`; RLS verified as `jgg_app`; advisors 0 findings.
- 8 bugs found by tests and fixed (list in verification.md).

## Session 3 additions
- Strict type-check (backend, tests, web) passing via offline type shims; `npm run typecheck`.
- tests/api/security.test.ts (T43, T44, T50, T52, T53/T54) — 46/46 tests pass overall.
- PWA shell caching (no API caching/replay), offline banner; per-user/device layout persistence; a11y checks (tests/e2e/pwa_a11y.py).
- Load/soak script and results (scripts/load-test.mjs).
- CLI + MCP stdio server over the scoped API (apps/cli/jgg.mjs).
- Fixes: API-key strategies now drafts only; error-vs-empty precedence, offline shown as signed-out, layout JSON truncation; automation waits while submissions are unresolved.

## Session 8 (owner: "simple, malinis, premium" + use my JGG logo everywhere)
- Recovered the codebase from the session-7 export after the build container was reclaimed; the repo 2342556/JGG is now the source of truth (push after every checkpoint).
- Brand: the owner's JGG monogram (docs/brand/jgg-mark-source.png) traced to one vector path in apps/web/src/brand.ts; in-app logo, favicon, PWA icons (192/512/maskable/apple-touch) all generated from it by scripts/brand-icons.mjs. White on #0B0B0C. Old green pixel mark + "JGG" wordmark removed. SW cache bumped to v3 so installed PWAs refresh icons.
- Simpler UI: Trenches/Trending as one clean row list (avatar + risk dot, symbol/age, holders/bonded, MC + change, quick buy); Token header (name only if different, price + 1h chip, 3 stats); Auto = 3 style presets + plain-English plan + one-tap start (starter daily limits shown before the tap), plain position stages, one headline track-record number; AI = one ask box, answer with collapsible "how it was put together", skills as simple rows with one status pill.
- price() fixed: printed a literal "{3}" and a stray zero; now $0.0₄1230 subscript notation from the rounded exponent.
- Fixture token JGGDEMO → DEMO (no brand collision).
- Evidence: 91/91 unit/API tests; typecheck clean; smoke 18 routes × 7 viewports 0 errors / 0 overflow, 6/6 flows; auto_mobile + live_ui e2e clean; pwa_a11y no violations.
- Exit system (owner spec): initial SL, one-time partial TP by tokens held, trailing from the post-activation peak (after the partial by default; at +X% or immediately optional), per-rule toggles, named presets, per-position override, exact trigger prices/quantities before enabling. Write-ahead exit orders with DB guarantees, crash recovery, reconciliation, full event log. Two independent review rounds: 8 + 6 defects found, all fixed with regression tests (incl. a pre-existing bug: failed TP/SL sells were marked done). 143/143 tests; smoke, exits_mobile, auto_mobile, live_ui, pwa_a11y clean. See docs/EXIT_SYSTEM_PLAN.md. Paper only — live NOT enabled.

## Session 7 (owner: "OA ba tayo? dapat bot na maganda ang winrate" → chose to strengthen accuracy over scope)
- Finder outcome tracking (apps/api/src/live.ts + worker wiring + /api/v1/finder/stats + Auto page panel): every Finder pass is followed forward on curve price alone (no extra RPC calls), classified rugged/graduated/timeout_24h, reported as hit-rate-by-horizon with explicit small-sample caveats. This is the evidence for "malaking winrate" — independent of any single user's trades, and visible before any real money is risked.
- 91/91 tests; typecheck clean; fixture/mobile/live e2e clean; live-seeded smoke shows the panel populating in real time.
- Deliberately did NOT expand terminal scope this session (owner chose to keep the full UI as-is and invest here instead).

## Session 6 (owner: do 1, 2 and 3 + deploy)
- (1) Optional FOMO labels via fomoapi.io (hourly, credit guard), joined with our own on-chain index.
- (2) Live copy trade, dev/token snipes, dev-sell exit, wallet rank, wallet pages and signals on live data.
- (3) Trading wallet (custody) + live execution through Jupiter Swap v2 with simulation guard, caps, reconciliation, withdrawals to the verified wallet. OFF by default.
- Deploy kit: netlify.toml (+ generated _redirects), Dockerfile, infra/docker-compose.prod.yml, Caddyfile, docs/DEPLOY.md; PWA PNG icons + manifest.
- 86/86 tests; typecheck clean; fixture/mobile/live e2e clean. Nothing run against mainnet or with real funds.

## Session 5 (owner: Option B — standalone, no GMGN)
- Own Solana pump.fun indexer: decoders (`packages/providers/src/solana/pump.ts`), RPC/WS client (`rpc.ts`), Jupiter Price v3 (`jupiter.ts`), ingestion/enrichment/smart labels/live source (`apps/api/src/live.ts`), indexer process (`apps/workers/src/indexer.ts`).
- Pluggable market source: `JGG_DATA_SOURCE=solana_live` switches quotes, fills, portfolio marks, exits, Finder, auto trader, trenches/trending/token/candles/trades to live data; fixture-driven features are disabled in live mode.
- 74/74 tests; typecheck clean; fixture smoke + live UI e2e clean.
- NOT verified against mainnet yet → owner runs `scripts/verify-live.mjs`.

## Session 4 (owner: GMGN tier + mobile auto finder/auto trader)
- GMGN adapter via official gmgn-cli (`packages/providers/src/gmgn.ts`), read-only, rate-limited; `scripts/verify-gmgn.mjs` for live verification. Execution builders tested, execution disabled.
- `jgg-finder-v1` + `/api/v1/finder` (fixtures in Demo/Paper, GMGN in Live read-only when configured).
- `auto_trader` strategy + exit plan (50% at +50% with trailing on the rest, TP +100%, SL −30%), performance endpoint with honest sample notes.
- `/auto` page, mobile tab; e2e on 390×844.
- 56/56 tests; typecheck clean; smoke 18 routes × 7 viewports clean.

## Changed files
apps/api/src/{strategies,tools,routes,server,alerts}.ts, apps/api/src/{trading,auth,db}.ts (fixes), apps/workers/src/worker.ts, apps/web/**, packages/test-fixtures (price walk, spawning, demo anchor), packages/catalog (social blocked status), tests/api/api.test.ts, tests/e2e/smoke.py, infra/**, scripts/{build-web,requirements,secret-scan}.mjs, docs/**.

## Blockers (external / authorization)
No npm registry (no lockfile, no tsc types, no pg driver). No live market/execution providers, signer, X/6551/news, launchpad adapters, derivatives venue, Up/Down contract. EVM SIWE. Funded test T59 not authorized.

## Next exact steps
1. Owner: follow docs/DEPLOY.md §1–2 (VPS backend + Netlify PWA), run verify-live, install the PWA — then let the indexer run continuously so /api/v1/finder/stats accumulates a real sample (check back after a few days: totalTracked should be well above 30).
1b. Only later, docs/DEPLOY.md §3 for real funds, starting with a 0.01 SOL manual test.
2. Then run live mode (indexer + API + worker) for ≥24h so smart-money labels warm up; measure the auto trader's paper win rate on real data.
3. In a networked env: `npm install`, lockfile, real @types.
2. Implement the Postgres repository (pg driver, per-request `SET LOCAL jgg.user_id`) and run the API tests against the Supabase `jgg` schema.
3. Wire a live read-only market provider (owner picks GMGN tier / indexer) behind MarketDataProvider; keep fixtures for Demo.
4. Remaining: axe-core audit when installable (T09), multi-node load against Postgres, real restore drill.
