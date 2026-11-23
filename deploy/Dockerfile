FROM node:22.23.2-trixie-slim

# Verify exact Node version
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); if(a!==22||b!==23||c<2){throw new Error('Node runtime must be >=22.23.2')}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-client-17 tini chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Install dependencies
COPY backend/package*.json ./backend/
RUN cd backend \
 && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund --package-lock=false; fi \
 && npm cache clean --force

# Copy application source.
# NOTE (Instruction #1): the frontend is deployed to Cloudflare Pages only and is
# intentionally NOT shipped in the Railway backend container. Do not re-add
# `COPY frontend ./frontend` — Railway runs backend/API logic only.
COPY backend ./backend
COPY deploy ./deploy
COPY admin ./admin

# Syntax check critical files
RUN node --check deploy/launcher.js \
 && node --check deploy/gateway.js \
 && node --check deploy/predeploy.js \
 && node --check backend/migrations/migrate.js \
 && node --check backend/migrations/schema-ready.js \
 && node --check backend/src/app.js \
 && node --check backend/src/sportsbook-next/index.js \
 && node --check backend/src/auth.js \
 && node --check backend/src/betting.js \
 && node --check backend/src/toto-collector-core.js \
 && node --check backend/src/toto-draw-scheduler.js \
 && node --check backend/src/toto-draw-calibrator.js \
 && node --check backend/src/toto-collector.js \
 && node --check backend/src/feed-worker.js \
 && node --check backend/src/memory-guard.js \
 && node --check backend/src/toto-market-identity.js \
 && node --check backend/src/toto-auto-settlement.js \
 && node --check backend/src/toto-schedule-registry.js \
 && node --check backend/src/health-check.js

RUN mkdir -p /data/backups && chown -R node:node /app /data/backups

ENV NODE_ENV=production
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "deploy/launcher.js"]
