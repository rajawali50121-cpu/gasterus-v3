# GASTERUS Sportsbook v2 — Go-live runbook

## Architecture

The provider and financial paths are deliberately separate:

1. **Odds Comparison Prematch v2 worker** imports event metadata and prices from every page of the official Daily Sport Event Markets feed, joined only by exact `sr:sport_event` URN. The worker completes pagination before publishing a snapshot. Change Log polling and separate Daily Schedules polling are disabled in this release.
2. **Soccer API v4 result worker** independently polls daily summaries for tracked events after the configured result buffer. It stores provider time separately from local receipt time and treats only verified `closed` results with complete scores, or provider-confirmed `cancelled`, as settleable.
3. **Member API** exposes only operator-approved, verified full-time Soccer 1X2 selections. The server rechecks the exact provider event, market, bookmaker, selection, odds, status, freshness, mapping and risk limits before debiting a member.
4. **Settlement worker** settles only verified result contracts, using the existing GASTERUS double-entry ledger. Stake is held in `SYSTEM:SPORTSBOOK_HOLD`; potential profit is reserved from `SYSTEM:SPORTSBOOK_RISK_RESERVE`. Unused reserve is released atomically.
5. **Owner review queue** quarantines result changes received after settlement. No automatic wallet reversal or additional credit is attempted.

## Official provider contracts

- Odds Comparison Prematch v2 base: `https://api.sportradar.com/oddscomparison-prematch/{trial|production}/v2/{language}`.
- Soccer API v4 base: `https://api.sportradar.com/soccer/{trial|production}/v4/{language}`.
- Both products authenticate server-side using the `x-api-key` header.
- Prematch flow: Daily Sport Event Markets provides event metadata and market prices in the same paginated feed. The Change Log endpoint is not called by this release.
- Soccer results use Soccer v4 Daily Summaries and preserve the exact `sr:sport_event:` URN. Do not join by team names, kickoff time, or legacy `sr:match:` IDs.

Official references:
- Odds Comparison API Basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Sport Event Markets Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log
- Monitoring Odds Changes: https://developer.sportradar.com/odds/docs/oc-ig-monitoring-odds-changes
- Soccer API Basics: https://developer.sportradar.com/soccer/docs/soccer-ig-api-basics
- Soccer Daily Summaries: https://developer.sportradar.com/soccer/reference/soccer-daily-summaries

## Required independent services

Deploy these as separate Railway services from the same repository and shared PostgreSQL/Redis references. Do not run more than one replica of each polling worker unless its distributed lock and quota model is explicitly reviewed.

| Service | Entrypoint / image | Required flag |
|---|---|---|
| API | existing GASTERUS backend | existing production API |
| Odds discovery (bulk markets) | `node src/sportsbook-next/worker.js` | `SPORTRADAR_ODDS_ENABLED=true` |
| Soccer v4 results | `deploy/Dockerfile.soccer-v4-worker` | `SPORTRADAR_SOCCER_ENABLED=true` |
| Ticket settlement | `deploy/Dockerfile.sportsbook-settlement-worker` | `SPORTSBOOK_SETTLEMENT_ENABLED=true` |

The Odds Comparison worker remains separately controlled by its own quota flag. Change Log is hard-disabled in code; keep all betting flags false during initial deployment.

## Configuration gates

Use `backend/.env.sportsbook-v2.example` as a variable-name reference only. Set real values in Railway sealed variables, never in Git or chat.

Before enabling bets, verify all of the following from the provider account dashboard and runtime:

- Odds Comparison and Soccer v4 each have **production** entitlement.
- Record the current rolling 30-day usage separately for each product and set the matching baseline-confirmed flag only after checking provider reporting.
- Change Log is disabled. Do not set `SPORTRADAR_CHANGELOG_ENABLED=true`; code intentionally ignores that flag. This removes Change Log polling and per-event refresh calls from this worker.
- Soccer v4 Daily Summaries polling is fixed at 60 minutes. The quota projection includes 720 current-date hourly requests plus one daily request for each configured historical lookback date (default seven days, 930 calls/30 days before pagination). Pagination can require additional calls; Redis quota reservation remains authoritative.
- Daily Schedules are not polled separately and their timestamp is not a bet-acceptance gate. Daily Sport Event Markets is polled every 150 minutes, with every page fetched until the provider reports completion (page size 50; runtime rolling quota reservation counts each page). The minimum quota projection assumes one page per cycle plus 90 daily discovery calls; extra pages increase actual usage and can exhaust the provider quota. The calculator does not assume two pages or a fixed event count.
- Configure explicit positive maximum stake and maximum payout.
- The Soccer result worker heartbeat and settlement worker heartbeat/status must be fresh and healthy.
- At least one full-time Soccer 1X2 provider mapping must be reviewed against actual live provider payloads and enabled as `VERIFIED`.
- A ticket is not rejected because a separate Daily Schedules poll or Change Log poll is late. It is still rejected for an event that has started, a suspended/closed market or price, a changed submitted price, an unverified settlement mapping, stake/payout limits, insufficient balance, or other financial/session safeguards.
- Fund `SYSTEM:SPORTSBOOK_RISK_RESERVE` through the approved finance/ledger process. Readiness requires its available balance to be at least the configured maximum single-ticket payout; insufficient reserve keeps bet acceptance disabled, and ticket-time atomic reservation remains the final safeguard.
- Apply migrations 045, 046 and 047 through the normal migration runner in staging first. Do not manually skip earlier migrations.

The following flags must remain false until every gate above is proven:

- `SPORTSBOOK_BET_ACCEPTANCE_ENABLED`
- `SPORTSBOOK_SETTLEMENT_ENABLED`

## Market mapping policy

Only full-time Soccer 1X2 is enabled by this phase. Mapping rows must be based on the exact provider market ID, provider market name, sport ID, full-time period, and outcome types observed from the entitled account's actual Odds Comparison payloads. Do not seed guessed market IDs or names.

The server rejects:
- missing, disabled, pending, ambiguous, or non-verified mappings;
- unknown provider outcome types;
- non-full-time markets;
- stale, changed, removed, suspended, live, started, or near-kickoff prices;
- unsupported settlement rules.

Asian Handicap, totals, Draw No Bet, half-time, player props and other sports remain display-only until their grading, void, push, correction and regression tests are implemented.

## Financial and settlement controls

- Ticket acceptance, stake debit, risk-profit reservation, ticket legs, and audit record share one PostgreSQL transaction.
- Decimal odds and payout use fixed-point integer arithmetic, not JavaScript floating-point multiplication.
- Each ticket is idempotent by member + idempotency key.
- Settlement uses row locks, `SKIP LOCKED`, unique ledger idempotency keys and one transaction.
- Losing stakes move from the sportsbook hold to clearing; winning/void payouts move from hold to the member; unused reserve returns to the risk-reserve account.
- A changed provider result after settlement is flagged for owner review. The worker blocks new bets until the owner records that financial reconciliation was completed. No automatic reversal is made.

Owner review endpoints (owner session required):
- `GET /api/owner/sportsbook/v2/result-reviews?limit=50`
- `POST /api/owner/sportsbook/v2/result-reviews/{ticketId}/acknowledge` with `{ "financiallyReconciled": true, "note": "..." }`

The acknowledgement is an audited owner attestation. Use it only after checking the provider revision and completing any required manual ledger adjustment.

Member endpoints:
- `GET /api/member/sportsbook/v2/eligibility`
- `POST /api/member/sportsbook/v2/tickets`
- `GET /api/member/sportsbook/v2/tickets?limit=20`
- `GET /api/public/sportsbook/v2/events`

## Release checklist

- [ ] All three GitHub Actions workflows pass on the exact release commit.
- [ ] Migrations 045–047 apply cleanly to a staging copy and schema readiness passes.
- [ ] Both Sportradar product entitlements and rolling usage baselines are confirmed.
- [ ] Real, non-mock provider requests succeed for the configured account and expected coverage.
- [ ] Confirm Change Log remains disabled in this release and no Change Log endpoint is called.
- [ ] At least one approved market/outcome mapping is verified against actual provider payloads.
- [ ] Soccer results worker and settlement worker heartbeats are healthy.
- [ ] Risk reserve is funded and reconciled against finance records.
- [ ] Owner/member session, CSRF, ticket history, responsible-play and audit flows pass staging E2E.
- [ ] Test accepted tickets through win, loss, void, parlay void-leg, insufficient reserve, duplicate request, stale odds, missing result, corrected result and owner review scenarios.
- [ ] Only after staging sign-off should the owner explicitly enable betting flags and deploy. No production deployment is performed by this PR.
