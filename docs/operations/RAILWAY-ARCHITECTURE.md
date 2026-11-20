# Gasterus production architecture and Railway operations

Status: migration preparation; NOT cut over to the new Railway account.
Last reviewed: 2026-11-19.
Canonical repository: `rajawali50121-cpu/gasterus-v3`.
Canonical deployment source: `railway-migration-fix-039`. 

## 1. Service boundaries

| Layer | Platform/service | Sole responsibility |
|---|---|---|
| Frontend | Cloudflare Pages | Serve the Gasterus frontend. Keep the frontend out of the Railway backend image. |
| API and business logic | Railway `gasterus-v3` | Authentication, member/admin APIs, betting, wallet, settlement, sportsbook read/ingest endpoint and application rules. |
| Primary data | Railway PostgreSQL | Durable relational source of truth. |
| Cache and coordination | Railway Redis | Feed snapshots, cache, queues and distributed coordination. |
| Odds ingestion | Railway `sportsbook-render-worker` | Fetch and normalize Sportradar prematch fixtures/odds, then send a signed snapshot to the API over Railway private networking. |
| Migration verification | Railway `gasterus-db-migration` | One-shot schema-ledger inspection only. It does not perform the final source-to-target data restore. Keep it unscheduled; use a separately reviewed final dump/restore procedure during the approved migration window. |

Do not move application/business logic between these layers without a reviewed change and explicit approval. Cloudflare remains the frontend platform. Railway remains the API/data/ingestion platform.

## 2. Sportsbook provider policy

- Sportradar is the only production sportsbook fixtures-and-odds provider.
- The production render worker calls only `fetchSportradar`.
- No secondary odds provider or local backend odds adapter is part of the production sportsbook path.
- Do not copy legacy provider flags or credentials merely because they exist in the old environment.
- Provider access level must match the intended production contract. Trial access is not production access; the worker permits trial only for an explicitly opted-in one-shot cron run.
- Preserve complete pagination and provider data. API quota and physical resource limits, not arbitrary event/page caps, are the real ceilings.

## 3. Data flow

1. The Railway render worker reads Sportradar using `SPORTRADAR_API_KEY`.
2. The worker normalizes the response and builds a complete snapshot.
3. The worker signs the exact JSON request body with `SPORTSBOOK_INGEST_HMAC_SECRET` and sends it to `/api/internal/sportsbook/ingest` on the backend's Railway private hostname.
4. The backend validates timestamp, HMAC signature, schema, event and market structure.
5. The backend stores the accepted snapshot in Redis. The API read path serves the stored snapshot; the backend must not independently start another odds-provider fetch.
6. The PostgreSQL database remains the durable source of truth for application records; Redis is not a substitute for PostgreSQL.

Transport rule: HTTPS is accepted generally. HTTP is accepted only when the destination hostname ends in `.railway.internal`; public HTTP endpoints and URLs containing embedded credentials are rejected. The HMAC secret must never be sent to a public plaintext HTTP endpoint.

## 4. New Railway project layout

Project: `unique-possibility` (`12c25d56-2f12-4d26-ad30-0b822389d8b0`), environment: `production` (`18c05d2e-db87-419c-a2e5-ce43591e1d4f`).

- `gasterus-v3`: backend/API; source branch `railway-migration-fix-039`; Dockerfile `deploy/Dockerfile`.
- `Postgres`: new target database; persistent volume mounted at `/var/lib/postgresql/data`.
- `Redis`: new cache/coordination store; persistent volume mounted at `/data`.
- `sportsbook-render-worker`: scheduled Sportradar ingestion; Dockerfile `deploy/Dockerfile.sportsbook-render-worker`; cron `5 17 * * *` UTC (00:05 WIB).
- `gasterus-db-migration`: one-shot database migration service; must not be scheduled as a recurring job.

Use Railway service references for internal database/cache endpoints and backend HMAC sharing. Do not copy old Railway-generated IDs, private domains, service URLs, or database/cache URLs into the new project.

## 5. Secrets and variable ownership

- Backend owns the new `SPORTSBOOK_INGEST_HMAC_SECRET`; the worker references that exact new-project value. Never replace it with the old account's HMAC secret.
- Worker owns `SPORTRADAR_API_KEY`; it must be set as a secret on the worker service. Never commit it or paste it into source control.
- Worker `DATABASE_URL` and `REDIS_URL` must reference the new project's Postgres and Redis services.
- Worker `SPORTSBOOK_INGEST_URL` must target the new backend's private Railway hostname and the internal ingest route.
- Migration service `SOURCE_DATABASE_URL` points only to the old Postgres public connection string; `TARGET_DATABASE_URL` points only to the new Postgres private reference.
- Never copy Railway-generated `RAILWAY_*` metadata variables. Railway supplies those per service/environment.
- Never print, commit, or share secret values in tickets, logs, chat, or this document.

## 6. Migration safety gates

The old Railway project remains the live production system until all gates below pass. Do not change its services, variables, database, Redis, worker, domains, or schedules during preparation.

1. Verify the new backend, Postgres and Redis are healthy.
2. Verify the new backend's migration/seed/schema readiness and security variables.
3. Verify the worker source, Docker build, required Sportradar production credential, private ingest URL and shared HMAC reference.
4. Run worker tests and a controlled ingestion smoke test against the new backend; verify accepted event/market counts and Redis snapshot freshness.
5. Schedule a maintenance window. Stop writes to the old application before taking the final consistent PostgreSQL dump.
6. Restore into the new PostgreSQL database only after confirming the target is disposable/empty or a separately approved replacement target. Do not use `pg_restore --clean` against a database receiving live application writes.
7. Compare schema migration versions, table row counts, owner/admin identity, wallet ledger integrity and critical business records between source and target.
8. Start/verify the new backend against the restored database; run read-only health, readiness and business smoke tests.
9. Verify Cloudflare routing and required secrets before changing any production origin.
10. Cut over only after explicit owner approval. Keep the old environment intact and available for rollback until the new environment is proven stable.

If any gate fails, stop. Do not improvise a fallback provider, partially cut over, or delete old resources.

## 7. Audit and maintenance runbook

For each audit, inspect in this order:

1. Project/environment inventory and staged changes.
2. Backend deployment status, build/runtime logs, `/healthz`, `/ready`, and internal sportsbook readiness.
3. PostgreSQL and Redis health, volumes, connectivity, storage and backups.
4. Worker cron configuration, last run, Sportradar access level, API quota/rate-limit diagnostics, snapshot acceptance and ingest freshness.
5. HMAC reference alignment (verify presence/reference; never reveal value).
6. Git source branch, exact commit SHA, Dockerfile, tests and CI status.
7. Cloudflare Pages build/deploy status and API origin routing.

Always record the project, environment, service, commit SHA, deployment ID, observed status, evidence, and any remaining blocker. Distinguish clearly between configured, deployed, running, tested, and production-serving. A successful backend deployment alone does not prove the worker, data migration, frontend routing, or cutover is complete.

## 8. Current migration checkpoint (verified 2026-11-19)

### Old Railway — source production (must remain untouched until cutover)
- Project: `amiable-sparkle` (`72b7f370-4029-4860-9f0c-cb1bc7b870ea`), environment: `production` (`ddab77fd-fd61-4f44-95de-675953659381`).
- Backend, PostgreSQL, Redis and `sportsbook-render-worker` are LIVE/healthy. The backend is on `master`; the old worker and backend still contain legacy provider variable names.
- Old backend service domain remains `gasterus-v3-production.up.railway.app`.
- No old service, variable, volume, domain, database, Redis or cron configuration was changed during this audit.

### New Railway — migration target (not yet production-serving)
- Project: `unique-possibility` (`12c25d56-2f12-4d26-ad30-0b822389d8b0`), environment: `production` (`18c05d2e-db87-419c-a2e5-ce43591e1d4f`).
- Live services: `gasterus-v3`, `Postgres`, `Redis`, `sportsbook-render-worker`, and one-shot `gasterus-db-migration`. All latest deployments report `SUCCESS`; backend, Postgres and Redis are online, worker is cron-ready.
- Both services are configured for branch `railway-migration-fix-039`. Their service source configuration reports commit pin `e8906f2432c99ca58c4b36d9a0e2eb7c30bbf674`, while the latest successful backend and worker deployments report build commit `9187c42d52a57dbfc5c4bb37e8ef9d3d2c9aca01`. This source/deployment SHA discrepancy must be reconciled before final release.
- New backend variable inventory is clean of legacy provider flags. New worker variable inventory includes Sportradar settings and the ingestion credentials/URL names. The connected Railway account redacts variable values, so presence is verified but exact reference targets and secret validity are not independently verified here.
- Worker cron is `5 17 * * *` UTC (00:05 WIB). The 19 November scheduled run used Sportradar production access and fetched 207 events over 10 pages, 1,024 markets, 5,620 books, and 12,921 outcomes. Backend logs confirm the signed snapshot was accepted; after feed filtering, 203 events and 5,335 bettable markets were served. This verifies the worker-to-backend ingestion path for that run, not ongoing uptime or final deployment parity.
- No Railway-generated service domain or custom domain is attached to the new backend. Keep routing unchanged until the final cutover gate.

### Database migration — incomplete; do not cut over
- The old PostgreSQL remains the live write source.
- A point-in-time copy of the old database exists separately as `gasterus_import` on the new PostgreSQL. The 19 November read-only audit found 63 public base tables in source and import. All table counts match except `market_result_history` (source 1,398; import 1,389), a 9-row difference while the source remains live.
- The new PostgreSQL's primary `railway` database has its own application schema/migration ledger. The one-shot `gasterus-db-migration` service remains a read-only schema-check service; it does not copy `gasterus_import` into `railway`.
- Latest ledger counts: SOURCE = 48, IMPORT = 48, TARGET (`railway`) = 44. The target ledger corresponds to the current 44 migration files; source/import retain four historical entries. Do not treat these counts alone as proof of business-data parity.
- The target has 63 public base tables but is not populated with production data: users 0, wallet requests 0, QRIS orders 0, ledger entries 0, ledger transactions 0, sportsbook tickets 0, sportsbook lifecycle rows 0, and lifecycle-history rows 0. Source/import each have 10 users, 16 ledger accounts, 1 wallet request, 1 QRIS order, 4,102 sportsbook lifecycle rows, 26,145 lifecycle-history rows, 742 provider incidents, 22 quota periods, 949 quota reservations, and 71 security events.
- Source/import currently report 0 ledger entries and 0 ledger transactions. This is not proof of wallet integrity; source account balances and pending-payment state still require explicit financial reconciliation. Final consistent dump/restore, critical-record verification, owner/admin checks, and application smoke tests remain outstanding.
- Three historical backend deployments failed while migration `039_canonicalize_market_slugs.sql` rejected five expected pool slugs. The current latest backend deployment is successful; preserve those failed deployments as audit history and do not erase them.
- No production cutover has occurred. Old Railway remains the active production system.

### Required next sequence
1. Keep old Railway production untouched.
2. Reconcile the source/deployment commit SHA discrepancy. Verify the cleanup branch in CI, then deploy the same reviewed commit to backend and worker and confirm the signed private ingest remains accepted.
3. Schedule a maintenance window and stop old-application writes.
4. Take a final consistent source PostgreSQL dump, validate it, and restore it into the new primary `railway` database. Do not overwrite the live target or use destructive restore flags without a verified backup and explicit migration plan.
5. Compare source and target table counts plus critical user, wallet, transaction, bet, settlement and audit records. Resolve any schema/migration mismatch before startup.
6. Verify new backend readiness and read-only business smoke tests against the restored target database.
7. Verify Cloudflare frontend/API origin configuration without changing it prematurely.
8. Obtain explicit cutover approval, then switch traffic. Keep old Railway intact for rollback until the new system is proven stable.

A deployment marked `SUCCESS` proves only that deployment completed. It does not prove final database migration, provider ingestion, Cloudflare routing, or production cutover.
