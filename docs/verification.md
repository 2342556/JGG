# JGG — Verification record

_Environment: Node v22.22.2 (Linux), no npm registry access, Chromium via Python Playwright 1.56. Date: 2026-09-25._

| Check | Command | Result |
|---|---|---|
| Domain + API tests | `npm test` (`node --test 'tests/domain/*.test.ts' 'tests/api/*.test.ts'`) | **91 pass, 0 fail** (adds Finder outcome tracking: pass recording, horizon sampling, rug/graduation/timeout classification, stats) |
| Type check | `npm run typecheck` (strict tsc for backend+tests and web) | **0 errors** — uses offline shims `types/node-shim.d.ts`, `apps/web/react-shim.d.ts` (node/react APIs loosely typed; all JGG code checked) |
| Web build | `node scripts/build-web.mjs` | OK, ~130 ms, JS ≈339 KiB minified |
| Browser smoke | `python3 tests/e2e/smoke.py http://localhost:8790 docs/screenshots` (API `JGG_ENV=test` + worker running) | 17 routes × 7 viewports: **0 console errors, 0 horizontal body overflow**; flows: quick buy → approve → finalized (stays on page) ✔, portfolio shows position ✔, AI run grounded answer ✔, skill C05 run ✔, strategy activation denied without risk policy ✔ |
| Secret scan (T42) | `node scripts/secret-scan.mjs` | 69 files + bundle clean |
| A11y / PWA / layout | `python3 tests/e2e/pwa_a11y.py http://localhost:8790` | 14 routes: 0 unnamed controls, h1 + main on every page; focus visible; `/` focuses search; dock layout persists per user after clearing localStorage; offline reload shows cached shell + offline banner + error states |
| CLI + MCP (T50) | `node apps/cli/jgg.mjs run C05 …`; JSON-RPC over stdio to `jgg.mjs mcp` | CLI skill run OK; MCP initialize, tools/list = 66, C13 → proposal (requiresApproval), C52 without scope → FORBIDDEN, unknown method → -32601 |
| Auto trader (mobile) | `python3 tests/e2e/auto_mobile.py http://localhost:8790` (390×844) | Finder renders signed-out; starter limits → start → worker bought the top pick within 6 s and attached exits (TP1/TP2/trailing/SL); 0 console errors, no overflow |
| Exit plan (service) | `tests/api/auto.test.ts` with controlled prices | +50% → sells 50% and arms trailing; peak 1.8 → stop 1.53; 1.52 → sells the rest; +100% path → TP2; −31% path → stop-loss; never oversells |
| GMGN adapter | `tests/domain/gmgn.test.ts` | documented CLI args built exactly; condition orders match the auto-exit plan; execution commands refused; missing key/CLI handled; tolerant mapping keeps unknowns null. **Not run against live GMGN (no network here).** |
| Standalone live pipeline (Option B) | `tests/domain/pump.test.ts`, `tests/api/live.test.ts`, `tests/api/rpc.test.ts` | Anchor discriminator matches the official Anchor docs sample; EVENT_IX_TAG_LE bytes; TradeEvent/CreateEvent/CompleteEvent decode incl. appended fields; logs attributed via invoke stack (other programs ignored); emit_cpi requires program id + tag; failed txs ignored; dedupe; older slots never overwrite; curve math (documented initial state → mcap 27,958,993,476 lamports); quotes = curve math, refuse stale/no SOL/USD/graduated; enrichment excludes the curve's token account from top-10 and flags freeze/risky extensions; Finder only on coins seen from creation; smart-money labels; paper buy + TP1/trailing on live price moves; real WebSocket client subscribes with `mentions` + `confirmed`, reconnects and resubscribes; getTransaction fallback for emit_cpi-only events; all against a local fake RPC |
| Live-mode UI | seeded DB + `python3 tests/e2e/live_ui.py` (1440 and 390 wide) | 8 routes, 0 console errors, 0 overflow; live tag shown; unsupported views say "not available in standalone v1"; Finder shows the seeded coin; auto trader bought it and attached exits |
| **Not yet verified** | `node scripts/verify-live.mjs 120` on a networked machine | Real mainnet stream, real decode rate, real curve-model mismatch rate, real RPC security responses, Jupiter key |
| Custody + live execution (real-funds path) | `tests/api/custody.test.ts` against local fake Solana RPC + fake Jupiter | demo/non-allow-listed accounts refused; key stored only as ciphertext; buy: route minOut check → simulation → custody signature verified by the fake Jupiter → fill from chain balances; overspending simulation / weak route / per-trade cap / daily cap stop before signing; execute timeout → reconciliation re-sends identical signed bytes → fill; unseen after window → expired + reservation released; withdraw only to the verified wallet with exact System transfer |
| Live UI incl. Trading wallet | `tests/e2e/live_ui.py`, `tests/e2e/auto_mobile.py` | 0 console errors / 0 overflow; live rank renders; wallet tab lists exactly which server settings are missing |
| Finder outcome tracking | `tests/api/finderOutcomes.test.ts` | a synthetic pump yields the exact bps at the 5-min horizon; a synthetic dump (price -97%, real SOL drained to 0) is classified `rugged` and stops sampling further; `CompleteEvent` freezes as `graduated`; a quiet coin times out at 24h; stats aggregate correctly with a small-sample caveat below n=30. Live-mode smoke confirms `/api/v1/finder/stats` populates within seconds of a seeded pass; fixture mode correctly reports "unavailable, needs live data" instead of fabricating numbers. |
| Load / soak (T57) | `node scripts/load-test.mjs http://localhost:8790 50 20` ×3 | 18,450 requests, ~500 rps, execute p95 ≈120 ms, 0 errors; 3,200 orders all `finalized`; 0 balances with leftover reservations; API RSS 157→168 MB (plateau) |
| PostgreSQL schema + RLS | Supabase MCP on project `mmpjzxvqvhqeucasswqz` (PG 17.6), migrations `jgg_0001_init`, `jgg_0002_app_role_membership`, `jgg_0003_function_search_path` | 38 tables in schema `jgg`, 32 with forced RLS. Verification block ran as role `jgg_app` (NOBYPASSRLS): user A sees only A's orders, cannot insert/update B's rows, sees nothing without a bound tenant, cannot read `sessions`; unbalanced journal entry rejected by trigger; `reserved > qty` rejected. Block ended with a deliberate exception → rolled back (0 rows persisted, confirmed). Supabase security advisors: **0 findings** (after pinning function search_path). |

## Bugs found by testing and fixed (SISID)
1. **Double dispatch on replay** — replaying `execute` with the same idempotency key returned the cached "prepared" result and re-entered dispatch (state machine blocked it, but only by accident). Fix: atomic dispatch claim on `order_attempts`.
2. **Rollback of terminal outcomes** — expiring an intent then throwing inside the same transaction rolled the expiry and reservation release back. Fix: commit terminal outcomes, report after the transaction (execute + approve paths).
3. **SIWS nonce not burned on bad signature** — same rollback pattern. Fix: consume nonce in its own transaction first.
4. **Startup lock race** — API and worker opening a fresh DB together hit `database is locked` (busy_timeout set after the WAL pragma). Fix: busy_timeout first, migrations re-checked under the write lock. Verified 3× clean concurrent starts.
5. **Quote countdown clock skew** — UI compared a demo-clock expiry with wall time. Fix: API returns `ttlMs`, UI counts down from receipt.
6. **Dialog clicks bubbling into row links** — approve dialog opened from a Trenches card could navigate the card. Fix: portal + stop propagation; e2e asserts the page does not navigate.
7. **Fixture price explosion** (MCs in quadrillions) — replaced with a bounded mean-reverting walk.
8. **Empty list frozen under the pointer** on first load — freezing now only applies to a non-empty list.
9. **Errors shown as "No skills match."** — `State` preferred the empty message over an error. Fix: an error always wins over empty.
10. **Offline looked like "signed out"** — a network failure left the user shown as logged out. Fix: explicit offline state + banner; periodic recheck.
13. **Idempotency keys over 128 chars** for live copy trades (88-char Solana signatures inside the key) → every live copy SELL failed validation. Fix: long keys are hashed deterministically.
12. **API keys could activate strategies unattended** through strategy skills (the HTTP route required an interactive session, the skill path did not). Fix: key/CLI/MCP-created strategies are drafts.
11. **Settings layout JSON truncation** — oversize layout was sliced (would corrupt the row). Fix: reject oversize; reject secret-like keys.

## Reference comparison (T03) — intentional differences
- JGG wordmark/monogram and generated avatars instead of GMGN branding and token images.
- Dock "Renames" and the X/TG tracker show provider-blocked states rather than content.
- Trending tabs Binance / NextBC / Pump Live show PROVIDER_UNAVAILABLE instead of relabeled lists.
- Skills Market shows no engagement counts (no real JGG analytics).
- Rewards shows 0 bps fee and zero balances; no earnings promise (S15 income copy intentionally not reproduced).
- System font stack (Inter is not bundled offline), so text metrics differ slightly from the references.

## Not verified
Live data, live execution, any funded transaction (T59 not authorized), social/news, launches, perps, Up/Down, EVM sign-in, Postgres repository in the Node app, type-check against real @types packages, axe-core audit, multi-node load, real DB restore drill.
