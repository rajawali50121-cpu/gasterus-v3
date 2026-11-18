# Gasterus production architecture and Railway operations

Status: migration preparation; NOT cut over to the new Railway account.
Last reviewed: 2026-11-18.
Canonical repository: `rajawali50121-cpu/gasterus-v3`.

## 1. Service boundaries

| Layer | Platform/service | Sole responsibility |
|---|---|---|
| Frontend | Cloudflare Pages | Serve the Gasterus frontend. Keep the frontend out of the Railway backend image. |
| API and business logic | Railway `gasterus-v3` | Authentication, member/admin APIs, betting, wallet, settlement, sportsbook read/ingest endpoint and application rules. |
| Primary data | Railway PostgreSQL | Durable relational source of truth. |
| Cache and coordination | Railway Redis | Feed snapshots, cache, queues and distributed coordination. |
| Odds ingestion | Railway `sportsbook-render-worker` | Fetch and normalize Sportradar prematch fixtures/odds, then send a signed snapshot to the API over Railway private networking. |
| One-time migration | Railway `gasterus-db-migration` | Dump the old PostgreSQL database and restore it to the new PostgreSQL database. Run only during the approved migration window. |

Do not move application/business logic between these layers without a reviewed change and explicit approval. Cloudflare remains the frontend platform. Railway remains the API/data/ingestion platform.

## 2. Sportsbook provider policy

- Sportradar is the only production sportsbook fixtures-and-odds provider.
- The production render worker calls only `fetchSportradar`.
- Do not activate, configure, or route production odds through SharpAPI, SportMonks, OddsPapi, The Rundown, or another fallback provider.
- Do not copy old Railway provider flags or credentials merely because they exist in the old environment.
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

Project: `unique-possibility`, environment: `production`.

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

## 8. Current migration checkpoint (2026-11-18)

- New backend deployment is successful and the service is online.
- New PostgreSQL and Redis are online with persistent volumes.
- Worker source is staged (not committed/deployed) at commit `e8906f2432c99ca58c4b36d9a0e2eb7c30bbf674`; its cron configuration remains in place.
- Migration service has no source/deployment yet.
- `SPORTRADAR_API_KEY` is not present in the new worker's variable-name inventory; worker must not be deployed until it is securely configured.
- `SOURCE_DATABASE_URL` is not currently staged on the migration service. Re-stage it from the secured old-account CLI export only after verifying the source endpoint; do not paste the secret into chat.
- Three earlier backend deployments failed; the latest backend deployment succeeded. Preserve the failed deployment history for audit.
- No production cutover has occurred.
- No CI checks were returned for the current code commits; do not describe the code change as test-passing until tests actually run.
- The worker source attachment is staged in Railway and must not be committed/deployed until `SPORTRADAR_API_KEY` is securely configured and the ingest transport tests are run.

