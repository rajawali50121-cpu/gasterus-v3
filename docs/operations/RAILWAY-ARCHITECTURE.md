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
- Discover entitled coverage in order from `sports.json`, `books.json`, and `sports/{sport_id}/competitions.json`; do not assume sports, competitions, bookmakers or markets. Coverage is cached for 24 hours.
- The worker uses the documented Prematch Daily Sport Event Markets feed `sports/{sport_id}/schedules/{date}/sport_event_markets.json` (current UTC date only), paginates with `start`/ `limit` (50 rows per page; maximum two pages per cycle), and reads `X-Max-Results`, `X-Offset`, and `X-Result`.
- The event-level source of truth is `sport_events/{sport_event_id}/sport_event_markets.json`; bookmaker/outcome IDs, `removed` flags, decimal odds, opening odds, handicaps, totals, and external bookmaker IDs are preserved.
- Market instances are keyed by both provider market ID and market name because one market ID can represent multiple period/inning instances.
- Free Trial mapping: Odds Comparison Prematch v2 only. Sportradar states Live Odds is unavailable through a self-issued trial; no Live Odds, Player Props, Futures, UOF/AMQP, or OC Core entitlement is assumed. The provider trial allowance previously verified for this account is 1,000 calls per rolling 30 days and 1 request/second. GASTERUS caps internal usage at 800 calls/30 days, tracks one entitled sport, the current UTC date, and at most two 50-event pages per cycle. Discovery feeds are cached for 24 hours. Polling is every 150 minutes. The official odds change log covers only a five-minute window and must be polled every 1–5 minutes; that cadence would exceed the trial budget, so this integration is read-only and cannot accept wagers. Bet acceptance remains disabled until an approved fresh-price update path (change-log polling within quota or UOF AMQP credentials) is enabled.
- Soccer fixtures/results context uses Soccer API v4 feeds and must not be treated as odds.
- A Redis-backed rolling 30-day budget and global 1.1-second request pacer reserve every outbound request before it is sent; no hidden retry loop is allowed. The initial provider-usage baseline expires from the budget after 30 days.
- HTTP 429 stops the current cycle and honors Retry-After. Failed cycles wait at least the configured 150-minute cadence; there is no five-minute retry loop and no provider fallback.
- Poll interval default is 150 minutes. Odds older than the configured freshness threshold must never be accepted for a wager.

Quota limits and access level must be set from the actual Sportradar account/package. A valid API key alone does not prove entitlement to every Sportradar product. UOF/AMQP is a separate product path and must not be assumed enabled by a REST key.

## Safety boundaries

- The replacement must integrate with existing member identity, responsible-play checks, wallet and ledger contracts without rewriting those shared systems.
- Existing sportsbook tables and historical financial records are retained; no migration may drop or rewrite historical bets or ledger entries.
- New bet acceptance, risk checks, ticket persistence, results authority and settlement must be implemented and tested before real-money routes are exposed.
- No production deploy or Railway variable/service mutation is part of this source branch.
