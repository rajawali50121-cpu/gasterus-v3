# Sportradar Soccer API v4 results worker

## Endpoint and timestamps
- Uses only Soccer v4 `GET /schedules/{date}/summaries.json` for tracked-event results.
- Sends the API key in the `x-api-key` header; never in the URL.
- Provider result timestamps come only from the response `generated_at` or provider `Last-Modified` metadata. Missing/invalid provider timestamps are never replaced with server time and cannot verify a final result.
- Uses `start` and `limit` (maximum 200) with a Redis page cursor. Captures `Cache-Control`, `ETag`, and `Last-Modified`; provider `max-age` can extend the next worker delay.

## Candidate selection and polling
- Candidate events are tracked sportsbook events whose UTC kickoff is at least `SOCCER_V4_RESULT_BUFFER_MINUTES` minutes in the past (default 150), and which do not have a verified final result.
- A final result means status exactly `closed`, `verified=true`, and a valid provider timestamp. Status `ended` is not final.
- `cancelled` results are persisted as a status only; they are not treated as a final settlement result.
- Candidates are grouped by UTC kickoff date. Only dates with one or more candidates are eligible; dates with no candidates cause zero provider requests.
- The worker chooses the oldest due candidate date. After a successful poll, that date is skipped until the next configured worker interval, allowing other pending dates to rotate ahead of it.
- `SOCCER_V4_MAX_LOOKBACK_DAYS` bounds polling to the most recent N days (default 7). Older unresolved events are excluded from provider requests and surfaced as requiring manual review.
- One request maximum per worker cycle. The default worker interval remains 60 minutes; this is not a live-score feed. Pagination advances one page per eligible cycle.

## Quota and isolation
- The worker is disabled unless `SPORTRADAR_SOCCER_ENABLED=true`; disabled mode sends no provider requests.
- Uses dedicated Soccer v4 rolling 30-day quota keys, a separate lock/status/heartbeat, and per-date page cursor/last-success keys under `sportsbook:soccer-v4:`.
- Retains the shared provider-wide QPS pacer and 429 cooldown. It does not share the Odds Comparison monthly quota keys.
- Does not request Odds Comparison feeds or Live Odds. Odds Comparison discovery, parser, schedule, change-log and snapshots remain isolated.
- Result persistence is limited to the existing Soccer result projection and revision tables. No wallet, ledger, ticket, TOTO, member-bet or settlement writes are performed.

## Configuration
Do not enable until Soccer API v4 entitlement, product-specific rolling 30-day quota and current usage are verified. Configure:
- `SPORTRADAR_SOCCER_API_KEY` (or the existing server-side `SPORTRADAR_API_KEY`)
- `SPORTRADAR_ACCESS_LEVEL` (`trial` or `production`)
- `SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS` (verified Soccer product quota; trial internal cap is 800)
- `SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE` (actual current usage, not a guessed zero)
- Optional: `SPORTRADAR_SOCCER_POLL_MINUTES` (minimum 60), `SPORTRADAR_SOCCER_LANGUAGE`
- Optional: `SOCCER_V4_RESULT_BUFFER_MINUTES` (default 150)
- Optional: `SOCCER_V4_MAX_LOOKBACK_DAYS` (default 7)

No production environment variables, Railway services, deployments, migrations or provider calls are changed by this source branch.
