# JGG backend image (API, worker, indexer share it; ROLE selects the process). Node 22 runs the TypeScript sources directly.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund --omit=optional
COPY . .
RUN node scripts/build-web.mjs && useradd -r -u 10001 jgg && mkdir -p /data && chown jgg /data
USER jgg
ENV NODE_ENV=production JGG_DB=/data/jgg.db PORT=8787
EXPOSE 8787
CMD ["sh", "-c", "case \"$ROLE\" in api) exec node apps/api/src/server.ts;; worker) exec node apps/workers/src/worker.ts;; indexer) exec node apps/workers/src/indexer.ts;; *) echo 'set ROLE=api|worker|indexer'; exit 1;; esac"]
