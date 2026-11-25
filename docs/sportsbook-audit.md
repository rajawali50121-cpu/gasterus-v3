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

## Verified migration audit (19 November 2026)

A read-only count audit was executed from the new Railway migration service against the old source database, the intermediate `gasterus_import` database, and the new primary target. It did not modify any database.

- Source and import each have 63 public base tables.
- Every source/import table count matches except `market_result_history`: source 1,398, import 1,389 (9-row difference). This is consistent with a point-in-time import while the old production database continues receiving writes; it still requires final synchronization.
- Source and import both report 48 `schema_migrations` records.
- New target has 63 public base tables but only 44 `schema_migrations` records. It is not a data-complete production target.
- Source/import have 10 users, 16 ledger accounts, 1 wallet request, 1 QRIS deposit order, 4,102 sportsbook lifecycle rows, 26,145 lifecycle-history rows, 742 provider incident rows, 22 quota-period rows, 949 quota-reservation rows, and 71 security-event rows.
- Target currently has 0 users, 0 wallet requests, 0 QRIS deposit orders, 0 ledger entries, 0 ledger transactions, 0 sportsbook tickets, 0 sportsbook lifecycle rows, and 0 lifecycle-history rows. It has 6 ledger accounts and 1 sportsbook provider incident row.
- The source and import both currently report 0 ledger entries and 0 ledger transactions. That is not proof of wallet integrity; account balances, legacy balance sources, and pending payment records still need an explicit financial reconciliation before restore/cutover.
- The read-only audit command was removed from the migration service afterward; the service's normal schema-check command was restored. No source or target rows were changed.

## Current blockers

- This cleanup branch is not yet merged into the deployment branch or deployed.
- Worker production ingestion was verified from the 19 November logs: 207 events fetched over 10 pages, 1,024 markets, 5,620 books, and 12,921 outcomes; backend accepted the signed snapshot and served 203 filtered events with 5,335 bettable markets.
- The running Railway backend/worker are still on the previous deployment commit. The cleanup branch must pass CI before deployment.
- Full wallet/ledger integrity, owner/admin access, pending payment reconciliation, and TOTO financial-state verification are not yet complete.
- The import is a point-in-time copy, and the source remains live. A final consistent backup and restore is still required during an approved maintenance window.
- The new target is not populated with production user and transaction data. Do not point traffic at it.
- No final cutover or traffic change has been performed.

## Audit recording format

For each release gate, record the exact branch, commit SHA, service, deployment ID, database, command/test, observed result, and remaining blocker. Distinguish configured, deployed, running, tested, and production-serving. A successful deployment alone is not evidence of correct ingestion or data parity.
