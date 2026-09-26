# JGG — Operations runbook (dev build)

**Start/stop:** API `node apps/api/src/server.ts`, worker `node apps/workers/src/worker.ts`. Both handle SIGINT/SIGTERM (worker finishes its current tick). Run several workers safely: strategy leases prevent double evaluation.
**Health:** `GET /api/v1/health` (public liveness), `GET /api/v1/status` (worker heartbeat age, outbox backlog, uncertain orders, provider statuses).
**Uncertain orders:** `/status` shows the count. The worker reconciles orders in `reconciliation_required` after 5 s using external truth; nothing is resubmitted. Manual: `POST /api/v1/orders/:id/reconcile`.
**Kill switch:** user-level `POST /api/v1/automation/stop` (pauses strategies, rejects queued automation intents, reports unresolved orders). Resume requires an interactive session and re-activation per strategy.
**Paper reset:** `POST /api/v1/paper/reset` (blocked while uncertain orders exist).
**Backups (dev):** stop processes, copy `data/jgg.db*`. Production: Postgres PITR; after restore, reconcile external activity before re-enabling strategies (T54, not yet automated).
**Rollback of the Postgres schema:** `DROP SCHEMA jgg CASCADE; DROP ROLE jgg_app;` (dedicated schema; nothing else touched).
**Rate limits:** auth 20/min/IP, API 600/min/IP, writes 120/min/user (in-process; production needs Redis).
