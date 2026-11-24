# Sportradar Feed v1 (isolated)

This package is independent of the legacy sportsbook. It does not import or modify betting, wallet, settlement, ledger, or migration code.

## Services
- API: `npm --prefix sportradar-feed-v1 run start:api`
- Worker: `npm --prefix sportradar-feed-v1 run start:worker`
- Tests: `npm --prefix sportradar-feed-v1 test`

Install its dependencies with `npm install --prefix sportradar-feed-v1`. Both services require the same Redis instance and environment variables. Configure separate Railway services with root directory `/` and the commands above, or run from the repository root. Do not point either service at the legacy worker.

## Safety defaults
- Poll every 5 hours (config accepts 4–6), up to 2 UTC dates.
- Rolling 30-day request ceiling defaults to 900; each HTTP page consumes one request.
- At least 1150ms between provider requests.
- HTTP 403/429 opens a Redis circuit breaker for 30 minutes.
- Redis distributed lock prevents overlapping pollers.
- Cached results remain readable while refresh is blocked or quota is near its ceiling.
- API never triggers provider requests.

## Provider access
Set `SPORTRADAR_API_KEY`, `SPORTRADAR_ACCESS_LEVEL`, `SPORTRADAR_LANGUAGE`, `SPORTRADAR_SPORT_IDS`, and `REDIS_URL`. The key is sent only in the `x-api-key` header and is never logged.

The worker uses the Odds Comparison Prematch Daily Sport Event Markets endpoint. Pagination is driven by response headers and the documented `start`/`limit` parameters. Provider response fields are preserved only after removing large raw payload fields; market/outcome removal flags are interpreted only when actually present. A real provider fixture is still required to validate the exact response shape before production use.

## Cache/API
- `GET /health`: process and Redis health.
- `GET /api/sportsbook/events`: latest cached feed snapshot.
- `GET /api/sportsbook/events?sport_id=sr:sport:1`: filter by sport.

No wallet/top-up endpoint exists.
