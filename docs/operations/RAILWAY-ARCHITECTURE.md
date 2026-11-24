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

## Legacy sportsbook architecture restored

The legacy GASTERUS sportsbook is restored from baseline `18f713ae0f87c199e983f89dc702de622f87d1b2` on an isolated branch. Its feed, Sportradar adapter, render worker, pagination, market lifecycle, quote/bet flow, settlement, cashout, realtime stream, member UI and owner trading desk are reconnected to the current application.

The legacy runtime uses:
- `backend/src/sportsbook-render-worker.js` for Sportradar ingestion and signed snapshot delivery.
- `backend/src/sportsbook-feed.js` and the provider/feed lifecycle modules for normalization, pagination, freshness, market availability, risk and member projection.
- `backend/src/sportsbook-betting.js`, settlement, quote, cashout and trading modules for wager lifecycle and controls.
- `backend/src/app.js` routes for member feed, event details, streaming, quotes, bets, cashout, owner operations and private worker ingestion.
- `frontend/sportsbook.html`, `frontend/js/sportsbook.js` and `frontend/css/pages/sportsbook-v3.css` for the legacy member experience.

Sportradar credentials remain server-side on the dedicated worker. The legacy worker's production startup guard requires a production Sportradar entitlement; a self-issued Trial key is not treated as commercial/live betting access. No production wager acceptance is authorized until provider entitlement, odds freshness, settlement authority and end-to-end wallet/ledger checks are verified.

The dedicated worker Dockerfile and environment template are restored. Legacy sportsbook migrations 002 and 010–014 are present again so fresh installations can create the required schema. Before running migrations against an existing database, verify the corresponding filenames in `schema_migrations`; the migrations must not be replayed blindly.

Cloudflare remains the frontend platform. Railway remains responsible for backend services, PostgreSQL, Redis and background workers. No production deployment or database migration is performed by this restoration PR.

## Safety boundaries

- The replacement must integrate with existing member identity, responsible-play checks, wallet and ledger contracts without rewriting those shared systems.
- Existing sportsbook tables and historical financial records are retained; no migration may drop or rewrite historical bets or ledger entries.
- New bet acceptance, risk checks, ticket persistence, results authority and settlement must be implemented and tested before real-money routes are exposed.
- No production deploy or Railway variable/service mutation is part of this source branch.
