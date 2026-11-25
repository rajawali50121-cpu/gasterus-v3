# Sportradar Soccer API v4 worker

## Isolation
- Runs as a separate process/image: `deploy/Dockerfile.soccer-v4-worker`.
- Uses Soccer API v4 `schedules/{date}/summaries.json` only; it never requests Odds Comparison feeds.
- Odds Comparison discovery, change-log cadence, 150-minute scheduler, parser, quota keys and snapshots are not used by this worker.
- Soccer result persistence is limited to the existing `sportsbook_v2_event_result_revisions` and `sportsbook_v2_event_results` projection via the result repository. No wallet, ledger, ticket, TOTO or settlement writes are performed.
- Soccer monthly quota keys, lock, heartbeat and status use the `sportsbook:soccer-v4:` Redis namespace.
- The cross-product 1.1-second QPS gate and 429 cooldown remain shared because the API key may have a provider-wide request-rate limit. This serializes simultaneous Sportradar calls without sharing monthly product budgets.

## Safe defaults
The worker is disabled unless `SPORTRADAR_SOCCER_ENABLED=true`. Disabled mode sends no provider requests. Poll interval defaults to 150 minutes. A cycle defaults to at most two date requests.

Do not enable it until the Soccer API v4 entitlement, product-specific rolling 30-day quota and current usage are verified in the Sportradar account. When enabled, configure:
- `SPORTRADAR_SOCCER_API_KEY` (or the existing server-side `SPORTRADAR_API_KEY`)
- `SPORTRADAR_ACCESS_LEVEL` (`trial` or `production`)
- `SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS` (verified Soccer product quota; internal trial cap is 800)
- `SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE` (actual current usage, not a guessed zero)
- Optional: `SPORTRADAR_SOCCER_POLL_MINUTES`, `SPORTRADAR_SOCCER_MAX_CALLS_PER_CYCLE`, `SPORTRADAR_SOCCER_LANGUAGE`

No production environment variables, Railway services, deployments or provider calls are changed by this source branch.
