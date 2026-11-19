# Sportsbook architecture and audit baseline

Status: migration preparation; not production cutover.
Canonical deployment source: `railway-migration-fix-039`.
Active cleanup branch: `chore/sportradar-only-final`.

## Source ownership

- Sportradar Odds Comparison is the sole external sportsbook fixtures-and-odds source.
- The isolated Railway `sportsbook-render-worker` owns the Sportradar credential, fetches all required pages, normalizes the response, and sends a signed snapshot over Railway private networking.
- The Railway backend has no odds-provider adapter and performs no external odds fetch. It validates and consumes only a fresh, signed Sportradar snapshot.
- TheSportsDB integration is limited to team artwork metadata. It does not provide fixtures, odds, scores, or settlement authority.
- Sportradar is not treated as a match-results authority. FT settlement requires explicit operator authority; HT settlement remains unavailable until a separately approved results authority is implemented. Automatic sportsbook settlement remains disabled by default.
- Internal market lifecycle, risk repricing, trading controls, quote validation, wallet ledger, and TOTO logic remain application-owned and must not be removed as part of provider cleanup.

## Required runtime flow

1. Worker requests Sportradar prematch data using its own secret.
2. Worker completes pagination and validates the full response. A partial/failed fetch is not published as a healthy snapshot.
3. Worker signs the exact serialized JSON body and posts to the backend's private ingest route.
4. Backend verifies HMAC, timestamp, provider allowlist, schema, event, market, and selection fields.
5. Backend stores the accepted snapshot in Redis and serves the member feed from that snapshot.
6. If the snapshot is missing, stale, invalid, or Redis is unavailable, the feed becomes unavailable/read-only. It must not fabricate fixtures, use a local adapter, or silently switch sources.

## Data and deployment boundaries

- Cloudflare Pages remains the frontend.
- Railway owns the backend API, PostgreSQL, Redis, and the isolated Sportradar worker.
- The old Railway project remains live until final data sync and explicit cutover approval.
- The new Railway project must use one documented source branch and commit for backend and worker.
- Historical database migrations are immutable. Retiring provider code does not authorize deleting applied migration files or dropping tables before backup, dependency audit, and row-count verification.

## Release gates

1. Reconcile the Sportradar-only code onto the agreed Railway deployment branch without overwriting TOTO, wallet, settlement, or unrelated work.
2. Verify worker pagination, normalization, signing, private-network delivery, and backend rejection of non-Sportradar snapshots.
3. Verify read-only/unavailable behavior when the snapshot is absent, stale, malformed, or unsigned.
4. Run the complete backend test suite and frontend tests under the repository's supported Node version.
5. Verify the worker produces an accepted production-access snapshot and record event/market counts, timestamps, and payload bytes.
6. Take a consistent source database backup during the approved maintenance window. Restore to the new target only after target safety is established.
7. Compare all tables and actual row counts, then validate wallet balances against ledger entries, pending transactions, owner/admin access, and critical business records.
8. Run application smoke tests against the restored target, including TOTO, sportsbook read/quote, operator settlement, deposits, withdrawals, and authentication.
9. Keep the old Railway environment untouched until the new environment passes every gate.
10. Cut over only after explicit approval. Preserve the old environment for rollback.

## Current blockers

- This cleanup branch is not yet merged into the deployment branch or deployed.
- GitHub connector access can edit/read repository files but cannot run the Codespaces terminal; test and build evidence must come from CI or the connected Codespaces session.
- Railway connector can inspect deployments and service configuration but does not provide direct SQL execution in the connected account. Database row-count and financial-integrity verification is therefore not complete.
- The previously created `gasterus_import` database is a point-in-time copy and is not a substitute for the final consistent restore while the old production database continues receiving writes.
- No final cutover or traffic change has been performed.

## Audit recording format

For each release gate, record the exact branch, commit SHA, service, deployment ID, database, command/test, observed result, and remaining blocker. Distinguish configured, deployed, running, tested, and production-serving. A successful deployment alone is not evidence of correct ingestion or data parity.
