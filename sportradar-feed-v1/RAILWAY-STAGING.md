# Railway staging deployment runbook

This runbook targets only the existing `gasterus-sportsbook-staging` project and its `staging` environment. Do not select production and do not connect the legacy sportsbook services.

## Required three Railway services

Create these three services in the staging environment after the workspace has capacity:
1. `SportradarRedis`: deploy the official Railway Redis template.
2. `SportradarAPI`: connect GitHub repo `rajawali50121-cpu/gasterus-v3`, branch `sportradar-feed-v1/build`.
3. `SportradarWorker`: connect the same repo and branch.

For both app services:
- Root Directory: `/sportradar-feed-v1`
- Build Command: `npm install --omit=dev`
- API Start Command: `npm run start:api`
- Worker Start Command: `npm run start:worker`
- Node runtime: 22
- Watch paths: `/sportradar-feed-v1/**`

Set these variables on BOTH app services:
- `REDIS_URL=${{SportradarRedis.REDIS_URL}}`
- `SPORTRADAR_POLL_HOURS=5`
- `SPORTRADAR_DAYS_AHEAD=2`
- `SPORTRADAR_30D_QUOTA_LIMIT=900`
- `SPORTRADAR_MIN_REQUEST_GAP_MS=1150`
- `SPORTRADAR_BREAKER_MINUTES=30`
- `SPORTRADAR_ACCESS_LEVEL=trial`
- `SPORTRADAR_LANGUAGE=en`

Set `SPORTRADAR_API_KEY` only on `SportradarWorker` as a sealed/secret variable. Do not paste it into GitHub, source files, logs, or chat. Set `SPORTRADAR_SPORT_IDS` to the sport IDs actually entitled on the key.

## Networking and verification
- Keep Redis private; do not enable public TCP access.
- Keep the API private initially; only connect the GASTERUS staging backend after a separate integration review.
- API listens on Railway's `PORT` and exposes `GET /health`.
- Verify both app deployments reach SUCCESS; verify API `/health` reports Redis ready.
- Verify worker logs show a completed cache cycle and quota use, without printing credentials.
- Do not deploy to production or merge this branch as part of staging validation.

## Current blocker
The Railway staging project was confirmed to exist, but currently has zero services. Previous Redis provisioning attempts returned a Free-plan resource-limit error and a separate project-not-found error. Do not retry provisioning until Railway resource capacity/access is resolved. No service was created by those attempts.
