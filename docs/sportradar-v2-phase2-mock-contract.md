# FASE 2 — Mock contract harness (official documentation subset)

**Branch:** `test/sportradar-v2-phase2`  
**Parent:** `design/sportradar-v2-phase1` at `c10f6e80f90a126462966ee1c4ca631bde2286b9`  
**Scope:** local-only mock contract tests; no production worker integration.

## Result

This phase adds `backend/tests/sportradar-v2-official-contract.test.js`, a Node built-in HTTP mock and test suite. It makes no external network calls and uses only a dummy test key.

The fixture values are **contract-minimal synthetic test data**. Their field names, primitive types, documented IDs, route patterns, and limits are transcribed from Sportradar's rendered official endpoint references. They are not captured provider responses and are not represented as the full OpenAPI/XSD schema.

## Official facts exercised

### Odds Comparison Prematch v2

- Books: `GET /books.json`; response resource `books[]`, item `id` and `name`.
- Sports: `GET /sports.json`; resource `sports[]`, item `id`, `name`, `type`.
- Sport Competitions: `GET /sports/{sport_id}/competitions.json`; resource `competitions[]`, including `markets`, `futures`, `player_props`, and category fields.
- Daily Schedules: `GET /sports/{sport_id}/schedules/{date}/schedules.json`; `start`, `limit`, `live`; documented `limit` maximum **50**.
- Sport Event Markets: `GET /sport_events/{sport_event_id}/sport_event_markets.json`; event → markets → books → outcomes; odds are strings; `market.is_live` and removal flags are represented.
- Change Log: `GET /sport_event_markets_changelog.json`; documented hierarchy is **`status.from`, `status.to`, `status.change[]`**. Each change has `id`, `sport_event_markets_odds_change`, and `type`.

**Critical correction found during FASE 2:** the existing legacy helper `backend/src/sportsbook-next/change-log.js` expects a top-level `payload.changes` array. That does not match the current official endpoint reference, which places change records at `payload.status.change`. The helper is not modified in this phase because the FASE 0 architecture explicitly calls for a new isolated implementation and prohibits silently patching/reusing the legacy worker.

### Soccer API v4

- Daily Summaries route: `GET /schedules/{date}/summaries.json`.
- Query pagination: `start` default 0 and `limit` maximum **200**.
- Documented event fields include `sport_event.id`, `sport_event.start_time`, and sibling `sport_event_status.status`, `match_status`, `home_score`, `away_score`, `winner_id`.
- Test fixture isolates this documented event/status fragment under a mock-only property. It intentionally does **not** invent the provider's Daily Summaries collection wrapper.

## Files added

- `backend/tests/sportradar-v2-official-contract.test.js`

## Tests included

- GET-only behavior and dummy `x-api-key` header.
- Documented Odds Prematch paths and response resource fragments.
- Odds Daily Schedules `limit > 50` rejection in the mock.
- Correct Change Log `status.change[]` nesting (and explicit absence of top-level `changes`).
- Soccer Daily Summaries route, pagination limit and documented event/status leaf fields.

## Explicit remaining blockers — do not mark full FASE 2 complete yet

1. The official raw OpenAPI YAML and XSD archives for Odds Prematch v2 and Soccer v4 have not been retrieved. Sportradar's docs confirm that both products publish OpenAPI/XSD links, but the raw artifacts are not currently accessible through this execution environment.
2. The exact Soccer Daily Summaries collection wrapper and nullable/required constraints are not enumerated in the rendered endpoint page's response section. The mock deliberately avoids fabricating that wrapper.
3. The exact full schema for every Odds feed, including optional/null fields and all response variants, remains unpinned.
4. The new test file has been committed through GitHub, but **has not been executed in a Codespaces terminal in this session**. No test pass is claimed.
5. Worker lifecycle, quota guard, crash/restart, shutdown and integration tests are still pending and belong to the later implementation gate.

## Official sources

- Odds API Basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Prematch Overview: https://developer.sportradar.com/odds/reference/oc-prematch-overview
- Books: https://developer.sportradar.com/odds/reference/oc-prematch-books
- Sports: https://developer.sportradar.com/odds/reference/oc-prematch-sports
- Sport Competitions: https://developer.sportradar.com/odds/reference/oc-prematch-sport-competitions
- Daily Schedules: https://developer.sportradar.com/odds/reference/oc-prematch-daily-schedules
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Sport Event Markets Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log
- Soccer Daily Summaries: https://developer.sportradar.com/soccer/reference/soccer-daily-summaries
- Soccer v4 Swagger UI: https://api.sportradar.com/soccer/trial/v4/openapi/swagger/index.html

## Safety boundary

No Sportradar API key was used. No provider endpoint was called. No production database, Redis, Railway, master branch, wallet, ledger, settlement, betting engine, migration, deployment, or bet-acceptance path was changed.
