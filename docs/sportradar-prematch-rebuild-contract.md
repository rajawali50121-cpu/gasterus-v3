# Sportradar Odds Comparison Prematch v2 — Rebuild Contract

Status: implementation specification; not deployed.

## Non-negotiable scope

Rebuild the Sportradar adapter and ingestion path as a clean, isolated integration. Do not delete or rewrite GASTERUS-owned systems: betslip, tickets, wallet/ledger, risk controls, market lifecycle, operator controls, TOTO, authentication, or applied database migrations. Preserve existing application contracts through an explicit adapter boundary. Do not deploy until the release gates below pass.

## Official source of truth

Use the current Sportradar Odds Comparison Prematch v2 documentation, not guessed endpoint paths, hard-coded market IDs, or inferred payload fields:

- API basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Prematch overview: https://developer.sportradar.com/odds/reference/oc-prematch-overview
- Sports: https://developer.sportradar.com/odds/reference/oc-prematch-sports
- Daily Schedules: https://developer.sportradar.com/odds/reference/oc-prematch-daily-schedules
- Daily Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-daily-sport-event-markets
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Sport Event Markets Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log

## API contract that must be implemented

1. Base URL shape is `https://api.sportradar.com/oddscomparison-prematch/{trial|production}/v2/en`.
2. Authenticate server-side using the `x-api-key` header. Never expose the key to frontend, logs, snapshots, or errors.
3. Discover available books and sports from `books.json` and `sports.json`. Do not assume every sport or bookmaker is available to the account.
4. For competition-structured sports, discover competitions from `sports/{sport_id}/competitions.json`; respect each competition's `markets` availability flag.
5. The fixture-only Daily Schedules endpoint is `sports/{sport_id}/schedules/{YYYY-MM-DD}/schedules.json`. It returns schedule metadata and supports `start`/`limit` pagination.
6. For date-wide odds ingestion, use the separately documented Daily Sport Event Markets endpoint: `sports/{sport_id}/schedules/{YYYY-MM-DD}/sport_event_markets.json`. This returns the markets for all events on that sport/date in one feed. It supports `start` and `limit`; reconcile completion with documented response headers (`X-Max-Results` and `X-Result`) and reject incomplete retrieval. Do not confuse this endpoint with the fixture-only Daily Schedules feed.
7. For targeted refresh of one event, use `sport_events/{sport_event_id}/sport_event_markets.json`. The response is event → market → book → outcome. Preserve bookmaker identity and source IDs; do not collapse multiple books into one market without an explicit GASTERUS pricing policy.
8. Treat the change-log endpoint as the incremental update mechanism only after implementing its documented five-minute window, cursor/watermark overlap, gap detection, and full reconciliation fallback. Do not repeatedly fetch all schedules and every event market as the default refresh strategy.
8. Treat HTTP 429 as a hard provider limit signal: honor `Retry-After` when present, back off, stop the current cycle, and never publish a partial snapshot. Do not assume a 429 body proves whether account quota or QPS was exceeded.
9. Respect documented update cadence: prematch bookmaker prices refresh about once per minute. Do not poll faster without a documented/contractual reason.

## Normalization rules

- Parse only documented fields and preserve original provider IDs: `sr:sport`, `sr:competition`, `sr:sport_event`, `sr:market`, `sr:book`, and `sr:outcome`.
- Keep `market.id/name/is_live`, `book.id/name/removed`, and outcome IDs, `field_id`, `type`, `handicap`, `spread`, `total`, `removed`, and decimal/American/fractional prices distinct.
- Preserve each bookmaker's price separately. Consensus is a provider-supplied book, not a replacement for all bookmaker prices.
- Do not classify markets or periods from guessed numeric IDs. Use the current documented market catalogue and explicit metadata; unknown markets remain `UNMAPPED` and non-bettable until mapped and tested.
- Do not infer a missing handicap line, period, outcome identity, or price. Missing/ambiguous data is quarantined or display-only.
- Do not alter provider odds during normalization. Any GASTERUS risk repricing is a later, separately audited application layer.
- Preserve removed/suspended states. Removed books/outcomes must not remain bettable.
- Sportradar Odds Comparison is an odds feed, not a settlement/results authority. Do not enable automatic settlement from odds-feed data.

## Runtime architecture

1. Isolated Railway worker owns the Sportradar key and is the only component allowed to call the provider.
2. Worker performs bounded discovery/schedule sync and incremental odds updates, validates complete response coverage, then emits one versioned normalized snapshot.
3. Worker signs the exact serialized snapshot using the existing HMAC transport contract.
4. Backend verifies signature, schema, provider identity, timestamps, completeness, and freshness before storing/serving it.
5. Frontend consumes only the backend's safe public projection. No provider key or direct provider calls in browser code.
6. Redis coordination must be global across worker instances: one active sync lease, shared QPS spacing, hourly/rolling quota budgets, and cache TTLs. Fail closed when required production quota settings are absent.
7. If any required page/event update fails, mark the cycle incomplete and do not replace a healthy snapshot with partial or stale data. Stale prices remain suspended/read-only.

## Rebuild sequence

1. Inventory the current Sportradar adapter, worker, snapshot schema, backend ingestion, frontend market projection, and tests. Keep all non-provider business systems untouched.
2. Build a contract test suite from official endpoint paths, response examples, headers, and schema. Include pagination, duplicate IDs, removed books/outcomes, empty valid schedules, missing prices, unknown markets, 429, timeout, and partial-cycle failure.
3. Implement a new provider client and normalized internal schema in a new module. Do not overwrite the current production path yet.
4. Add an explicit compatibility adapter from the new schema to the existing sportsbook feed/betslip contract. Prove stable event/market/selection IDs and quote validation.
5. Run old and new normalizers side-by-side against sanitized fixtures; compare event, market, book, outcome, and price counts. No production key is needed for fixture tests.
6. Shadow-run against the provider only after the exact contracted request quota and current rolling usage are confirmed. Use a conservative call budget and no member-facing activation.
7. Cut over only after all CI, integration, quote, lifecycle, and safety tests pass. Keep the previous implementation and database state available for rollback.

## Mandatory acceptance gates

- Every request path and query parameter matches current official v2 docs.
- Pagination completion is proven from response headers; no arbitrary page/event truncation.
- Per-book outcomes and prices survive round-trip normalization.
- Market mappings have fixture-backed tests; unknown mappings cannot become bettable.
- 429/5xx/timeout/partial pagination never publishes a partial healthy snapshot.
- Multi-instance worker test proves shared request budgets and no overlapping cycles.
- Snapshot signature, schema validation, freshness, and backend rejection tests pass.
- Existing betslip, quote, ticket, wallet, settlement, risk, and TOTO tests remain green.
- Production shadow run records exact calls, quota budget, events, books, markets, outcomes, snapshot age, and rejected records without exposing secrets.
- No merge, deploy, traffic switch, destructive deletion, or automatic settlement until explicit release gates are satisfied.


## Implementation status (2026-11-22)

A first isolated adapter implementation is available on branch `rebuild/sportradar-docs-first` and draft PR #59. It performs server-side key authentication, discovery of `sports.json` and `books.json`, competition coverage checks, and paginated Daily Sport Event Markets ingestion. The worker is routed to this adapter on the draft branch. This is a staged rebuild, not a production cutover.

Still required before release: implement the five-minute change-log loop with durable watermark/gap recovery, shared Redis quota and worker lease across replicas, complete fixture/contract tests against documented payload examples, and full regression tests for all existing sportsbook transaction systems. Do not merge or deploy until these gates are met and CI is green.
