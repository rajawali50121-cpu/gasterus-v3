# GASTERUS Sportsbook Rebuild — Sportradar Odds Comparison v2

## Objective
Replace the legacy sportsbook feed/market integration with a clean implementation built against the official Sportradar Odds Comparison v2 contract. This branch is isolated from production. Do not delete or replace production files until the new implementation passes contract fixtures, integration tests, and a controlled cutover.

## Source of truth
- API Basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Odds Comparison Fundamentals: https://developer.sportradar.com/odds/docs/oc-ig-fundamentals
- Prematch workflow: https://developer.sportradar.com/odds/docs/oc-ig-pulling-prematch-odds
- Update Frequencies: https://developer.sportradar.com/odds/docs/oc-ig-update-frequencies
- Prematch endpoint reference: https://developer.sportradar.com/odds/reference/oc-prematch-overview

## Contract rules
1. Use the Odds Comparison Prematch v2 base URL and the configured access level (trial or production) exactly as provisioned for the API key.
2. Send the API key only in the server-side x-api-key header. Never expose it to frontend code, logs, or API responses.
3. Discover coverage using Books, Sports, and Sport Competitions. Respect each competition's markets availability flag; do not hardcode coverage as if all sports/leagues are available.
4. Build the prematch slate from Daily Schedules (or Competition Schedules when explicitly selected). Follow pagination using response result headers; never silently assume the first page is complete.
5. Fetch each event board from Sport Event Markets. Preserve Sportradar event, market, book, and outcome identifiers and source fields.
6. Identify a market instance using provider market ID plus instance/name/context; the same market ID can repeat for different periods/innings.
7. Preserve bookmaker identity and consensus as distinct books. Preserve each outcome's decimal/American/fractional current and opening odds, plus handicap/total line values where supplied.
8. Process lifecycle fields such as removed and suspension/status exactly as specified by the v2 payload. Missing, removed, suspended, malformed, or stale prices are not bettable.
9. Use Sport Event Markets Change Log to refresh only changed events. Its window covers the previous five minutes; after a missed polling window, reconcile rather than assuming the log is complete.
10. Read cache-control max-age from each response. Follow documented feed cadence and bookmaker refresh cadence; TTL is a cache floor, not permission to poll every second.
11. Handle 429 with backoff and quota-aware scheduling. Do not retry provider limit responses in a tight loop. Track rolling 30-day quota and QPS separately.
12. Keep raw provider payloads (redacted of credentials) available for diagnostics and contract-fixture tests. Normalization must be deterministic and versioned.

## New module boundaries
- backend/src/providers/sportradar-odds-v2/client.js: authenticated HTTP transport, timeout, pagination, retry/backoff, response metadata.
- backend/src/providers/sportradar-odds-v2/discovery.js: books, sports, competitions and coverage cache.
- backend/src/providers/sportradar-odds-v2/schedules.js: daily/competition schedules and pagination.
- backend/src/providers/sportradar-odds-v2/markets.js: event market retrieval and change-log refresh.
- backend/src/providers/sportradar-odds-v2/normalize.js: lossless provider-to-domain normalization; no guessed market IDs.
- backend/src/providers/sportradar-odds-v2/eligibility.js: stale/suspended/removed/invalid-price bet eligibility.
- backend/src/providers/sportradar-odds-v2/index.js: orchestration only.
- Frontend consumes GASTERUS domain DTOs, never raw provider payloads or credentials.

## Safety and cutover
- Do not change wallet, member balance, bet ledger, settlement history, or unrelated lottery/casino code as part of provider replacement.
- Do not drop or rewrite production tables. Additive migrations only, with explicit rollback.
- Keep old sportsbook route available behind a feature flag while the new feed is verified in shadow mode.
- Shadow mode compares event/market counts and normalized payloads without accepting bets.
- Bet placement must reject stale, suspended, removed, unsupported, or unpriced selections server-side.
- No stale snapshot may be promoted to bettable after provider failure.
- Cut over only after CI is green, documented Sportradar coverage is confirmed for the account, and E2E checks pass.
- Production deployment is a separate explicit step; this branch does not deploy.

## Delivery phases
1. Contract inventory: inspect all sportsbook imports/routes/jobs/tests/migrations and mark provider code versus business-critical wallet/ledger/settlement code.
2. Implement the new provider client and discovery/schedule/market workflows against official v2 examples.
3. Add payload fixtures and contract tests for pagination, duplicate market IDs, book/outcome identity, line values, removed/suspended states, change-log gaps, 429 and quota controls.
4. Integrate normalized domain DTOs with the existing GASTERUS betting/ledger boundary without changing financial semantics.
5. Run shadow mode and compare real account responses.
6. Replace legacy sportsbook provider/UI paths, remove obsolete code only after import graph and tests prove it is unused.
7. Deploy behind a feature flag, verify, then enable traffic.

## Account-dependent blockers
The account's enabled access tier, subscribed packages (Prematch vs Live Odds/Player Props), sport/competition coverage, bookmaker configuration, and quota values must be read from the Sportradar console. Do not infer them from a key name or documentation examples.