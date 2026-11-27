# Sportradar Soccer API v4 results worker

## Endpoint, timestamps and IDs
- Uses only Soccer v4 `GET /schedules/{date}/summaries.json` for tracked-event results; maximum page size is 200 and the Soccer summaries TTL is 300 seconds.
- Sends the API key in the `x-api-key` header; never in the URL.
- Provider timestamps come only from response `generated_at` or provider `Last-Modified`. Missing/invalid provider timestamps are never replaced with server time and cannot verify a closed result.
- `normalizeSportEventId` maps both `sr:match:N` and `sr:sport_event:N` to `sr:sport_event:N`; other formats are rejected. Duplicate aliases are collapsed before persistence.
- Provider `sport_event.replaced_by` and `sport_event_status.status` are retained in the per-event result payload/projection. The original tracked database ID is preserved when writing the canonicalized result.

## Pagination (one request per cycle)
- The worker stores a Redis page cursor per UTC date. The next request for an incomplete date uses `start=<cursor>` and `limit=200`.
- `X-Result` and `X-Max-Results` determine whether more pages remain. If `X-Result < X-Max-Results`, advance the cursor by the raw page result count and continue that date in the next worker cycle. The date is complete when `start >= X-Max-Results` or the reported result count reaches the maximum.
- A date with a non-zero cursor remains due and is selected ahead of dates waiting for their next poll interval. `LAST_SUCCESS` is written only after the date's final page. Thus a 381-result date is fetched as 200 + 181 across two cycles, without exceeding one provider request in either cycle.
- If result-count headers are absent, the worker falls back to page length and the advertised maximum when available; a short page ends pagination. A zero-length page before the advertised end fails closed as a pagination stall.
- Completed dates are not re-polled until the configured interval; candidate dates with no outstanding work and no due interval cause zero requests.

## Event lifecycle and candidate selection
- Candidates are tracked sportsbook events whose UTC kickoff is at least `SOCCER_V4_RESULT_BUFFER_MINUTES` minutes in the past (default 150), with no provider-confirmed final state.
- `closed` is final only when verified and accompanied by a valid provider timestamp. `ended` is not final; events without live coverage may remain `not_started` until a result is entered and remain candidates after kickoff.
- `cancelled` is final and persisted with null scores and `verified=false`; it is not a settlement result.
- `suspended` remains a candidate.
- `postponed` with `replaced_by` stops polling the old event and records the replacement ID plus a manual-review reason. The replacement event is tracked independently under its own event ID.
- `abandoned` is not treated as final; it is excluded from automatic polling and flagged for manual review.
- A delay over 48 hours is treated by Sportradar as postponed. A continuation within 48 hours retains the event ID; a restart or continuation after more than 48 hours uses a new event ID and the old event may expose `replaced_by`.
- Candidate dates are grouped by UTC kickoff date. Only dates with candidates are eligible. The oldest due date is selected; a date with an incomplete pagination cursor takes priority and continues next cycle.
- `SOCCER_V4_MAX_LOOKBACK_DAYS` bounds automatic polling (default 7). Older unresolved events are excluded from provider requests and surfaced with IDs/reasons for manual review.

## Quota and isolation
- The worker is disabled unless `SPORTRADAR_SOCCER_ENABLED=true`; disabled mode sends no provider requests.
- Maximum one request per worker cycle. The default worker interval remains 60 minutes; this is not a live-score feed.
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
