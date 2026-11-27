# GASTERUS Sportsbook v2 — Go-live runbook

## Architecture

The provider and financial paths are deliberately separate:

1. **Odds Comparison Prematch v2 worker** discovers Soccer schedules and prices, then refreshes only events returned by the official five-minute Change Log. It writes the last-known-good snapshot to Redis and normalized prices to PostgreSQL.
2. **Soccer API v4 result worker** independently polls daily summaries for tracked events after the configured result buffer. It stores provider time separately from local receipt time and treats only verified `closed` results with complete scores, or provider-confirmed `cancelled`, as settleable.
3. **Member API** exposes only operator-approved, verified full-time Soccer 1X2 selections. The server rechecks the exact provider event, market, bookmaker, selection, odds, status, freshness, mapping and risk limits before debiting a member.
4. **Settlement worker** settles only verified result contracts, using the existing GASTERUS double-entry ledger. Stake is held in `SYSTEM:SPORTSBOOK_HOLD`; potential profit is reserved from `SYSTEM:SPORTSBOOK_RISK_RESERVE`. Unused reserve is released atomically.
5. **Owner review queue** quarantines result changes received after settlement. No automatic wallet reversal or additional credit is attempted.

## Official provider contracts

- Odds Comparison Prematch v2 base: `https://api.sportradar.com/oddscomparison-prematch/{trial|production}/v2/{language}`.
- Soccer API v4 base: `https://api.sportradar.com/soccer/{trial|production}/v4/{language}`.
- Both products authenticate server-side using the `x-api-key` header.
- Prematch flow: Daily Schedules → per-event Sport Event Markets → Sport Event Markets Change Log. The Change Log reports changed events in a five-minute window; if a gap exceeds that window, reconcile every tracked event before restoring betting.
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
| Odds discovery + Change Log | `node src/sportsbook-next/worker.js` | `SPORTRADAR_ODDS_ENABLED=true` |
| Soccer v4 results | `deploy/Dockerfile.soccer-v4-worker` | `SPORTRADAR_SOCCER_ENABLED=true` |
| Ticket settlement | `deploy/Dockerfile.sportsbook-settlement-worker` | `SPORTSBOOK_SETTLEMENT_ENABLED=true` |

The Odds Comparison worker remains separately controlled by its own quota and Change Log flags. Keep all betting flags false during initial deployment.

## Configuration gates

Use `backend/.env.sportsbook-v2.example` as a variable-name reference only. Set real values in Railway sealed variables, never in Git or chat.

Before enabling bets, verify all of the following from the provider account dashboard and runtime:

- Odds Comparison and Soccer v4 each have **production** entitlement.
- Record the current rolling 30-day usage separately for each product and set the matching baseline-confirmed flag only after checking provider reporting.
- Change Log cadence must be 60–300 seconds. At 240 seconds it requires at least 10,800 Change Log calls per rolling 30 days before any event-market refresh calls; a trial budget of 800 or 1,000 cannot support continuous Change Log coverage. Keep bet acceptance disabled if the account quota cannot support the required cadence.
- Soccer v4 polling cadence must fit its own remaining rolling quota. The default example is 90 minutes, one request per cycle; the worker rejects a cadence whose 30-day call requirement exceeds the remaining budget.
- Configure explicit positive maximum stake and maximum payout.
- The Soccer result worker heartbeat and settlement worker heartbeat/status must be fresh and healthy.
- At least one full-time Soccer 1X2 provider mapping must be reviewed against actual live provider payloads and enabled as `VERIFIED`.
- Fund `SYSTEM:SPORTSBOOK_RISK_RESERVE` through the approved finance/ledger process. A zero or insufficient reserve rejects the ticket; the code never manufactures bankroll.
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
- [ ] Change Log full reconciliation completes; no pending refresh queue remains.
- [ ] At least one approved market/outcome mapping is verified against actual provider payloads.
- [ ] Soccer results worker and settlement worker heartbeats are healthy.
- [ ] Risk reserve is funded and reconciled against finance records.
- [ ] Owner/member session, CSRF, ticket history, responsible-play and audit flows pass staging E2E.
- [ ] Test accepted tickets through win, loss, void, parlay void-leg, insufficient reserve, duplicate request, stale odds, missing result, corrected result and owner review scenarios.
- [ ] Only after staging sign-off should the owner explicitly enable betting flags and deploy. No production deployment is performed by this PR.
