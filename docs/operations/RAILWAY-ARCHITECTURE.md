# Railway Architecture

Canonical deployment source: `railway-migration-fix-039`.

## Runtime services

| Service | Responsibility |
|---|---|
| `gasterus-v3` | Public API, authentication, member/admin APIs, TOTO, wallet, ledger and existing application logic |
| PostgreSQL | Durable application, member, ticket and financial records |
| Redis | Cache, queues, coordination and worker heartbeats |
| Dedicated Sportradar v2 worker | Isolated odds ingestion, quota enforcement and snapshot persistence; no TOTO or wallet scheduler coupling |
| `gasterus-db-migration` | One-shot reviewed database migrations |

## Sportradar sportsbook replacement

The old sportsbook feed, provider adapter, render pipeline, bet lifecycle and settlement implementation have been removed from the application runtime. The replacement lives under `backend/src/sportsbook-next/`.

The integration follows the official Odds Comparison Prematch v2 contract:
- Authentication uses the `x-api-key` request header. The key stays server-side.
- Base URL: `https://api.sportradar.com/oddscomparison-prematch/{trial|production}/v2/en`.
- Discover available coverage from `sports.json`; do not assume sports, competitions, bookmakers or markets.
- Daily schedules use `sports/{sport_id}/schedules/{date}/schedules.json`, with offset pagination (`start`, `limit` up to 50) and `X-Max-Results` handling.
- Event prices are retrieved from `sport_events/{sport_event_id}/sport_event_markets.json`; bookmaker and outcome IDs, removed flags, decimal odds and opening odds are preserved.
- Market instances are keyed by both provider market ID and market name because one market ID can represent multiple period/inning instances.
- The official odds change log covers a five-minute window and should be polled at least every five minutes. The current 150-minute discovery mode is therefore display-only; it does not authorize wager acceptance. Bet acceptance remains disabled until an approved fresh-price update path (change-log polling within quota or UOF AMQP credentials) is enabled.
- Soccer fixtures/results context uses Soccer API v4 feeds and must not be treated as odds.
- HTTP 429 stops the current cycle. No immediate retry loop or provider fallback is permitted.
- Poll interval default is 150 minutes. Odds older than the configured freshness threshold must never be accepted for a wager.

Quota limits and access level must be set from the actual Sportradar account/package. A valid API key alone does not prove entitlement to every Sportradar product. UOF/AMQP is a separate product path and must not be assumed enabled by a REST key.

## Safety boundaries

- The replacement must integrate with existing member identity, responsible-play checks, wallet and ledger contracts without rewriting those shared systems.
- Existing sportsbook tables and historical financial records are retained; no migration may drop or rewrite historical bets or ledger entries.
- New bet acceptance, risk checks, ticket persistence, results authority and settlement must be implemented and tested before real-money routes are exposed.
- No production deploy or Railway variable/service mutation is part of this source branch.
