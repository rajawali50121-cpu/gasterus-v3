# Sportradar Feed v1 (isolated)

This package is independent of the legacy sportsbook. It does not import or modify betting, wallet, settlement, ledger, or migration code.

## Services
Install dependencies with `npm install` from this directory.
- API: `npm run start:api`
- Worker: `npm run start:worker`
- Tests: `npm test`

For Railway, create two separate services from the same repository and set each service's **Root Directory** to `/sportradar-feed-v1`. Set the start command to `npm run start:api` for the API service and `npm run start:worker` for the worker service. Both services need the same Redis URL. Do not point either service at the legacy worker.

## Safety defaults
- Poll every 5 hours (config accepts 4–6), up to 2 UTC dates.
- Rolling 30-day quota ceiling defaults to 900 requests; each HTTP page consumes one request.
- Stop refreshing at 90% of the configured ceiling, preserving headroom and serving the last cached snapshot.
- At least 1150ms between provider requests, shared across worker replicas.
- HTTP 403/429 opens a Redis circuit breaker for 30 minutes.
- Redis distributed per-sport/date lock prevents overlapping pollers.
- API only reads cached snapshots; it never triggers provider requests.

## Provider access
Set `SPORTRADAR_API_KEY`, `SPORTRADAR_ACCESS_LEVEL`, `SPORTRADAR_LANGUAGE`, `SPORTRADAR_SPORT_IDS`, and `REDIS_URL`. The key is sent only in the `x-api-key` header and is never logged.

The worker uses the Odds Comparison Prematch Daily Sport Event Markets endpoint. Pagination continues only when the response provides usable numeric pagination headers and the documented `start`/`limit` parameters. Provider response fields are preserved after removing known bulky raw fields; a normalized removal flag is added only when the provider explicitly supplies `removed`. A real provider fixture is still required to validate the exact response shape and pagination behavior before production use.

## Cache/API
- `GET /health`: process and Redis health plus rolling quota/breaker status.
- `GET /api/sportsbook/events`: latest cached feed snapshots.
- `GET /api/sportsbook/events?sport_id=sr:sport:1`: filter by sport.

No wallet/top-up endpoint exists.
