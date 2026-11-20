# GASTERUS Sportsbook — Sportradar Integration Contract

## Scope and source of truth

The currently configured production adapter is **Sportradar Odds Comparison Prematch API v2**:

`https://api.sportradar.com/oddscomparison-prematch/production/v2/en`

It is the only source used by the current render worker for prematch fixtures, bookmaker markets, outcomes and prices. Do not silently mix in generated odds, Football-Data CSVs, or another provider.

This product is distinct from **Unified Odds Feed (UOF)**. UOF uses AMQP/XML for dynamic messages plus REST API lookups. Its access token, broker access, product entitlements and recovery subscription must be verified separately; an Odds Comparison `x-api-key` is not proof of UOF access.

## Documented Odds Comparison Prematch endpoints

All requests use `x-api-key` and JSON:

1. Discovery: `GET /sports.json`.
2. Full daily board: `GET /sports/{sport_id}/schedules/{date}/sport_event_markets.json?start={offset}&limit=50&live=false`.
3. Changed event list: `GET /sport_event_markets_changelog.json`.
4. Changed event board: `GET /sport_events/{sport_event_id}/sport_event_markets.json?live=false`.

The daily board returns event + market + bookmaker + outcome data. Pagination must continue until the provider's `x-max-results` is satisfied; an empty page before that total makes the cycle incomplete and must not be published.

The change log reports event IDs whose odds changed during a rolling five-minute window. Poll it within that window, re-fetch only the changed event boards, and treat the event-board response—not the change log—as the authoritative current prices. If the worker misses the five-minute window, reconcile every tracked event before resuming incremental processing. A 404 for an event that has aged out of provider retention must not erase its last stored closing prices.

Use each response's `generated_at` and `cache-control` metadata for ordering and cache behavior. Do not interpret a one-second cache TTL as an instruction to poll every second; the package's bookmaker price refresh cycle and change-log guidance determine cadence.

## Market and event semantics

- `sport_event.status` describes event state.
- `market.is_live` indicates that the event/market is live; it is **not** a provider suspension/removal flag.
- `book.removed=true` means the bookmaker's market was removed.
- `outcome.removed=true` means that outcome was removed.
- Preserve the raw market ID, bookmaker ID, external IDs, outcome ID, line/handicap/total and all original price formats.
- A removed book/outcome must not be offered for betting. A live market must not be presented as prematch. The current adapter is prematch-only and fails closed for live offers until a separately entitled live feed is connected.
- FT/HT is derived only from explicit provider market identity/name/specifier. Never manufacture an HT market or copy FT odds into HT.

## Results and HT settlement boundary

The Odds Comparison Prematch Sport Event Markets schema documents event status, market, book, outcome and price data; it does not contractually guarantee first-half result scores.

UOF documents `sport_event_status` and `period_scores.period_score` (including period number, home score and away score). The availability of period scores depends on match coverage. UOF also documents AMQP messages such as `odds_change`, `bet_stop`, `bet_settlement`, `bet_cancel`, `fixture_change`, `alive`, and rollback/recovery handling.

Therefore:
- HT settlement remains disabled unless both `HT_BETTING_ENABLED=true` and `SPORTRADAR_HT_RESULTS_ENABLED=true` are explicitly set after the actual Sportradar results feed/UOF entitlement and payloads are verified.
- An Odds Comparison API key alone must never be treated as proof of UOF result authority.
- Do not derive halftime scores from full-time scores.
- Do not change FT settlement, wallet, cashout, payout, ingestion security, or TOTO behavior as part of HT integration.

## Worker lifecycle

The render worker must be long-running, not a once-daily cron process, for change-log-driven odds updates. It performs a full prematch bootstrap, polls the documented change log within the five-minute window, refreshes changed event boards, and reconciles tracked events after an outage. API 429 responses and configured quotas must be handled without publishing partial snapshots.

## Explicitly not complete until verified

1. The account's live-odds/UOF entitlements and credentials are confirmed.
2. A real provider payload demonstrates the exact FT and HT market identifiers and odds.
3. A real UOF/Sports results payload demonstrates HT period scores and settlement messages.
4. Recovery after disconnect, duplicate delivery, rollback, cancellation, postponed/abandoned matches, and stale prices pass integration tests.
5. CI passes and the Railway worker remains healthy after a separately approved deployment.

No production deployment or merge is implied by this document.
