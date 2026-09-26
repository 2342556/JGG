# JGG — AI Trading Terminal

Multi-chain (Solana, BSC, Base, Ethereum) memecoin trading terminal with an AI workspace and 66-skill catalog. **This build runs in Demo and Paper modes**: deterministic fixture market data and a disclosed paper execution model. Live data/trading are blocked until providers, a signer and owner authorization exist (see `docs/PROVIDERS.md`).

## Run (Node ≥ 22.6, no npm install needed in this repo's offline setup)
```bash
node scripts/build-web.mjs                     # builds apps/web/dist (needs esbuild: `npm i -D esbuild react react-dom` when online)
node apps/api/src/server.ts                    # http://localhost:8787  (API + web + SSE)
node apps/workers/src/worker.ts                # strategies, reconciliation, alerts (separate process, same DB)
```
Open http://localhost:8787 → Log In → *Continue with a Demo account* (10 SOL / 5 BNB / 1 ETH virtual per chain).

## Test
```bash
npm test                                        # 91 tests (domain, API, security, live pipeline, custody, finder outcomes)
npm run typecheck                               # strict tsc (offline shims)
JGG_ENV=test PORT=8790 node apps/api/src/server.ts & node apps/workers/src/worker.ts &
python3 tests/e2e/smoke.py http://localhost:8790 docs/screenshots
node scripts/secret-scan.mjs
```

## Live mode (standalone, Solana pump.fun) — no GMGN required
```bash
export JGG_DATA_SOURCE=solana_live JGG_SOLANA_RPC_HTTP=https://… JGG_SOLANA_RPC_WS=wss://… JGG_JUPITER_API_KEY=…
node apps/workers/src/indexer.ts &   # our own pump.fun indexer (events → DB, security checks, smart-money labels)
node apps/api/src/server.ts &        # API + web
node apps/workers/src/worker.ts &    # strategies / auto trader / exits
node scripts/verify-live.mjs 120     # 2-minute check against your RPC → docs/live-verify/REPORT.json
```
Market data is live; **executions stay paper** (virtual fills priced on live curve reserves). Views not yet on live data say so instead of showing fixtures.

## Deploy
See `docs/DEPLOY.md`: backend on your server (Docker + Caddy), PWA on Netlify with `/api` proxied, then install on your phone.

## CLI and MCP (same scoped API as the UI)
```bash
export JGG_URL=http://localhost:8787 JGG_API_KEY=jgg_...   # create in Settings → API keys
node apps/cli/jgg.mjs skills
node apps/cli/jgg.mjs run C05 chain=solana address=<mint>
node apps/cli/jgg.mjs mcp          # MCP server over stdio: the 66 skills as tools
```
Trade tools return proposals awaiting approval; strategies created by keys are drafts.

## Layout
`apps/api` (HTTP, auth, trading, strategies, tools/AI, alerts) · `apps/workers` · `apps/web` (React) · `packages/domain` (exact decimal math, accounting, state machines, strategies, risk, analytics) · `packages/contracts` · `packages/catalog` (C01–C66) · `packages/providers` · `packages/test-fixtures` · `infra/postgres` (production schema with RLS).

## Key docs
`docs/BUILD_STATE.md` (checkpoint) · `docs/REQUIREMENTS.md` (M/C/T register) · `docs/verification.md` · `docs/DECISIONS.md` · `docs/PROVIDERS.md` · `docs/OPERATIONS.md`

## Safety defaults
Deny-by-default automation, per-trade approval, idempotent execution with reconciliation (timeouts never resubmitted), kill switch, CSRF + HttpOnly SameSite=Strict sessions, scoped API keys (no `trade:execute`), strict CSP. No secrets in the repo (`.env.example` only).
