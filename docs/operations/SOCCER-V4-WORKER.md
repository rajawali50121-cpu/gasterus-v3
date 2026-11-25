# Sportradar Soccer API v4 results worker

## Documented endpoint and authentication
- Uses Soccer v4 `GET /schedules/{date}/summaries.json` for match results and match-level summaries.
- API key is sent in the `x-api-key` request header, never in the URL.
- Reads `generated_at`, `summaries[]`, and `sport_event_status` from the documented response structure. Uses `start` and `limit` (maximum 200) and persists a Redis page cursor so later pages are fetched in subsequent quota-safe cycles.
- Captures `Cache-Control`, `ETag`, and `Last-Modified` response metadata. The worker never schedules a pull faster than the configured interval or provider `max-age`.

## Polling and quota
- Current UTC date: one Daily Summaries request per hour.
- Previous UTC date: one catch-up request per 24 hours, to catch late final-result corrections.
- One request maximum per worker cycle; default cycle interval is 60 minutes. If a date has more than 200 events, its pages are processed one request at a time before that date returns to its normal polling cadence.
- This bounds normal use to at most 750 requests per rolling 30 days (720 current-date pulls plus up to 30 previous-date catch-ups), below the internal 800-call trial safety cap. Actual Soccer product quota and existing usage must still be verified before enabling.
- This is a quota-conscious compromise: Sportradar recommends Daily Summaries every hour or less for non-live use and approximately 5 minutes after a match closes for the quickest final stats. The one-request-per-hour budget means this worker is not a real-time live-score feed.
- For live match state/statistics, Sportradar documents Sport Event Summary (1-second TTL) and live feeds. They are deliberately not enabled here because they can consume the trial budget rapidly.
- The worker polls only dates with tracked sportsbook events in the database; it does not discover or import the full global fixture catalogue.

## Isolation
- Runs as a separate process/image: `deploy/Dockerfile.soccer-v4-worker`.
- Does not request Odds Comparison feeds or share the Odds Comparison monthly quota keys.
- Uses dedicated Redis quota, lock, status, heartbeat and per-date last-success keys under `sportsbook:soccer-v4:`.
- Shares only the global Sportradar QPS gate and 429 cooldown, preventing simultaneous workers from exceeding a provider-wide rate limit.
- Result persistence is limited to the existing Soccer result projection tables. No wallet, ledger, ticket, TOTO, member-bet or settlement writes are performed.
- Odds Comparison discovery, parser, schedule, change-log and snapshots remain isolated.

## Safe defaults
The worker is disabled unless `SPORTRADAR_SOCCER_ENABLED=true`. Disabled mode sends no provider requests. Default polling is 60 minutes and one request per cycle.

Do not enable until Soccer API v4 entitlement, product-specific rolling 30-day quota and current usage are verified. Configure:
- `SPORTRADAR_SOCCER_API_KEY` (or the existing server-side `SPORTRADAR_API_KEY`)
- `SPORTRADAR_ACCESS_LEVEL` (`trial` or `production`)
- `SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS` (verified Soccer product quota; trial internal cap is 800)
- `SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE` (actual current usage, not a guessed zero)
- Optional: `SPORTRADAR_SOCCER_POLL_MINUTES` (minimum 60), `SPORTRADAR_SOCCER_LANGUAGE`

No production environment variables, Railway services, deployments, migrations or provider calls are changed by this source branch.
