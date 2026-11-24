# Railway Architecture

## Runtime services

| Service | Responsibility |
|---|---|
| `gasterus-v3` | Public API, authentication, member/admin APIs, TOTO, wallet, ledger and casino integrations |
| PostgreSQL | Durable application, member, ticket and financial records |
| Redis | Cache, queues, coordination and worker heartbeats |
| Feed worker | TOTO result collection and scheduled polling; isolated from settlement worker |
| `gasterus-db-migration` | One-shot reviewed database migrations |

## Operational boundaries

- TOTO collection and settlement are separate runtime responsibilities. Preserve the TOTO poller, collector, scheduler, settlement worker, schemas, migrations, and tests when changing unrelated features.
- Financial ledger, member identity, responsible-play checks, and wallet contracts are shared critical systems. Changes must remain backward-compatible and covered by tests.
- Production credentials must be explicitly configured in Railway; never substitute predictable defaults.
- No production deploy or Railway variable/service mutation is part of source cleanup.

## Database history

Applied migration files are historical records. Do not rewrite or remove applied migrations as part of routine feature cleanup, and do not drop historical financial or ticket data without a separately reviewed data-retention plan.
