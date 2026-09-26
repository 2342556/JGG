# Deploying JGG (PWA on Netlify + backend on your server)

Netlify serves static files only. JGG's API, worker and indexer are long-running processes with a database, so they run on a
server you control (e.g. your Hostinger VPS) and Netlify proxies `/api/*` to it. The browser sees one origin (the Netlify URL).

## 1. Backend on the VPS (Docker)
1. Point a DNS name at the VPS, e.g. `jgg-api.yourdomain.com`.
2. On the VPS: `git clone <your repo> jgg && cd jgg && cp .env.example .env` and fill in:
   - `JGG_ORIGIN=https://<your-site>.netlify.app` (the PUBLIC origin: cookies, CSRF and wallet sign-in are bound to it)
   - `JGG_API_DOMAIN=jgg-api.yourdomain.com`, `JGG_TRUST_PROXY=1`
   - `JGG_DATA_SOURCE=solana_live`, `JGG_SOLANA_RPC_HTTP`, `JGG_SOLANA_RPC_WS` (Helius/QuickNode/…), `JGG_JUPITER_API_KEY` (portal.jup.ag)
   - optional `JGG_FOMOAPI_KEY`
3. `docker compose -f infra/docker-compose.prod.yml --env-file .env up -d --build`
4. Check `https://jgg-api.yourdomain.com/api/v1/status` → api/worker up, `live.indexer.conn = live`.
5. Run the 2-minute verifier once: `docker compose -f infra/docker-compose.prod.yml exec indexer node scripts/verify-live.mjs 120`.

Other processes already use ports 80/443 on the VPS (e.g. n8n behind its own proxy)? Then drop the `caddy` service and add a
`reverse_proxy 127.0.0.1:8787` site (with `flush_interval -1` for streaming) to your existing proxy, publishing the api port locally only.

## 2. PWA on Netlify
1. New site from your Git repo (or `netlify deploy`). Build settings come from `netlify.toml`.
2. Site configuration → Environment variables: `JGG_API_ORIGIN=https://jgg-api.yourdomain.com` → redeploy.
3. Open the Netlify URL on your phone → Chrome menu "Install app" (Android) or Safari Share → "Add to Home Screen" (iOS).
Note: Netlify's proxy may close long-lived streams; the app reconnects automatically and also polls.

## 3. Live trading (real funds) — only after paper results you trust
1. Generate `JGG_CUSTODY_MASTER_KEY` (see `.env.example`) and store a copy OFFLINE. Losing it = losing access to the trading-wallet keys.
2. `JGG_LIVE_ALLOWED_WALLETS=<your Phantom address>`, keep `JGG_LIVE_MAX_TRADE_SOL` / `JGG_LIVE_MAX_DAILY_SOL` small, then `JGG_LIVE_TRADING=enabled` and restart.
3. On the phone, open the site inside Phantom's browser → Log in → "Sign in with Solana wallet". (Demo accounts can never hold funds.)
4. Settings → Trading wallet → Create → deposit a SMALL amount of SOL → Settings → Mode → Live.
5. First live test: one manual 0.01 SOL buy and sell on a coin you choose; confirm both on Solscan; then withdraw to confirm the exit path.
Withdrawals always go to the wallet you signed in with. The server refuses to sign anything its simulation shows overspending.

## What is NOT verified from the build environment
No network there: the mainnet stream, Jupiter live routes, real RPC responses, Netlify proxy behaviour and Docker build were not run.
Every one of those paths is tested against local fakes; the first real run is step 1.5 and step 3.5 above.
