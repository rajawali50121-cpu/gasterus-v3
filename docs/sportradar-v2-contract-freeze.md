# Sportradar v2 — FASE 1 Contract Freeze

**Status:** kontrak dokumentasi dibekukan untuk ruang lingkup prematch + verifikasi hasil Soccer.  
**Parent:** FASE 0 PR #99 — https://github.com/rajawali50121-cpu/gasterus-v3/pull/99  
**Baseline:** commit FASE 0 `7b6ac655569480f7f563fa65220990c16cf0f6af`.  
**Mode riset:** dokumentasi resmi Sportradar saja; tidak ada API request, key, sandbox Try It, atau provider call.

## 1. Keputusan integrasi yang dikunci

1. Odds source: **Odds Comparison Prematch v2** saja.
2. Soccer source: **Soccer API v4**, hanya untuk mendapatkan status/hasil pertandingan setelah jadwal dikenal.
3. Event join key: exact string `sr:sport_event:...`; jangan mengubah URN ke integer dan jangan join dengan nama tim/tanggal.
4. Worker Odds dan Soccer independen; quota state/QPS/lock/cooldown independen.
5. Soccer worker default OFF; ketika OFF tidak boleh membuka koneksi provider.
6. Pipeline: provider → worker → Redis snapshot → internal read-only API → frontend.
7. Tidak ada Live Odds API, Push feed, live market, bet acceptance, wallet, ledger, betting engine, settlement implementation, atau migration dalam scope.
8. API key hanya pada header `x-api-key`, server-side. Never put key in URL, browser, logs, fixture, error text, or metrics.

## 2. Contract: Odds Comparison Prematch v2

### 2.1 Base URL, request conventions

Base:
```
https://api.sportradar.com/oddscomparison-prematch/{access_level}/v2/{language_code}/
```
- `access_level`: `trial` atau `production`.
- `language_code`: `en` adalah bahasa yang didukung penuh untuk OC Prematch.
- `format`: `json` atau `xml`; implementasi target memilih `json`.
- HTTP method: GET untuk feed yang dirancang.
- Header auth: `x-api-key: <secret>`.
- Timestamp: UTC ISO-8601. Change-log window menggunakan Unix seconds.
- Key tetap server-only.

Official: https://developer.sportradar.com/odds/docs/oc-ig-api-basics

### 2.2 Feed yang masuk desain

| Feed | GET path relatif base URL | Parameter | Response data yang didokumentasikan | Cache/update |
|---|---|---|---|---|
| Books | `books.json` | path: access_level, language_code, format | root `books`; item `id` (`sr:book:...`), `name`; contoh juga memiliki `generated_at`; Prematch dapat menampilkan `consensus` | TTL 300s; perubahan konfigurasi bookmaker |
| Sports | `sports.json` | path: access_level, language_code, format | root `sports`; item `id` (`sr:sport:...`), `name`, `type` | TTL 300s; saat coverage sport berubah |
| Sport Competitions | `sports/{sport_id}/competitions.json` | path tambahan `sport_id` | root `competitions`; item `id`, `name`, `gender`, `markets`, `futures`, `player_props`, `category` | TTL 300s; coverage kompetisi berubah |
| Daily Schedules | `sports/{sport_id}/schedules/{date}/schedules.json` | path `sport_id`, `date=YYYY-MM-DD`; query `start`, `limit`, `live` | root event list; `sport_event.id`, `start_time`, `start_time_confirmed`, `status`, competitors | TTL 1s; data dihapus dari feed 24 jam setelah akhir hari |
| Sport Event Markets | `sport_events/{sport_event_id}/sport_event_markets.json` | path `sport_event_id`; query `live=true/false` | `sport_event`, `markets`, `market.id/name/is_live`, `market.book.id/name/removed`, `outcome.id/field_id/type/odds_*/handicap/total/removed` | TTL 1s; harga bookmaker diperbarui per menit (per update-frequency docs) |
| Sport Event Markets Change Log | `sport_event_markets_changelog.json` | path access_level/language_code/format; endpoint docs tidak mendefinisikan query filter | `status.from`, `status.to` (Unix seconds); `status.change[].id` (event URN), `sport_event_markets_odds_change`, `type` | TTL 1s; tiap response mencakup jendela 5 menit |

Endpoint reference:
- Books: https://developer.sportradar.com/odds/reference/oc-prematch-books
- Sports: https://developer.sportradar.com/odds/reference/oc-prematch-sports
- Sport Competitions: https://developer.sportradar.com/odds/reference/oc-prematch-sport-competitions
- Daily Schedules: https://developer.sportradar.com/odds/reference/oc-prematch-daily-schedules
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log

### 2.3 Pagination — endpoint-specific, do not generalize

**Daily Schedules**
- `start`: string offset.
- `limit`: string, minimum 1, maximum **50** on this endpoint.
- `live`: boolean selecting live/non-live markets; for this prematch-only product use `live=false`.
- Important discrepancy: page narrative says default response 200 events, but the parameter definition explicitly caps `limit` at 50. Implementation must obey endpoint parameter cap 50, not infer page size from narrative default. Confirm with OpenAPI artifact during implementation if spec differs.

**General Odds list pagination**
- Where supported, use `start` and `limit`; page limits differ by feed.
- Read `X-Max-Results`, `X-Offset`, `X-Result`. Do not assume a 200 response means complete.
- Iterate until the returned result count is smaller than requested page size (or zero), with sanity checks against offset/header progression.
- Sport Event Markets and Change Log pages currently show no pagination parameters; do not append `start`/`limit` without endpoint contract.

### 2.4 Market and outcome identity / removal

Documented fields:
- Event: `sport_event.id` string, e.g. `sr:sport_event:47395897`; also `replaced_by`, `resume_time`, `start_time`, `start_time_confirmed`, `status`.
- Market: `market.id` is documented as GUID with example `sr:market:1`; `name`; `is_live` boolean.
- Book: `market.book.id` GUID example `sr:book:18186`; `name`; `removed` is documented as String despite its description saying true when removed. Preserve provider raw value and validate exact fixture/schema before coercion.
- Outcome: `market.book.outcome.id` GUID example `sr:outcome:1714`; `field_id` GUID/identifier with examples 1/2 for home/away and 3/4/5 for home/draw/away; `type`; `handicap`; `spread`; `total`; `odds_american`, `odds_decimal`, `odds_fraction`, `open_odds_*`; `removed` boolean.
- `external_market_id`, `external_sport_event_id`, `external_outcome_id` are bookmaker identifiers for deeplinks, not internal SR IDs.
- Odds numeric values are represented as strings in documented data points. Preserve exact decimal text; don't parse to binary float for storage.
- `market.is_live=true` is excluded from this prematch pipeline even if encountered. Also request `live=false` on the endpoint where explicitly documented.
- Treat removed book/outcome as tombstones, not as absent data. Do not silently resurrect from stale cache.

**ID caution:** docs label market/outcome IDs as GUID but give `sr:market:`/`sr:outcome:` examples. Keep exact raw string; do not assume a particular serialization beyond documented sample. Do not build a synthetic ID by concatenating market/book/outcome without collision analysis.

### 2.5 Change Log operational semantics

Official Monitoring Odds Changes guide:
https://developer.sportradar.com/odds/docs/oc-ig-monitoring-odds-changes

- Change Log tells which event changed; it does not contain the changed market payload. Re-fetch Sport Event Markets for tracked event IDs.
- Window is five minutes and does not rewind. If consumer misses more than five minutes, it must reconcile by refreshing every tracked event once before resuming cursor progression.
- Polling at least once per five minutes is documented for continuous change tracking. That cadence is **not affordable by default trial quota**: 12 calls/hour × 24 × 30 = 8,640 calls/month for the changelog alone. It excludes daily schedules and every per-event market refresh.
- Therefore, do not enable continuous Change Log loop until actual quota and event count are known. If the budget cannot support it, explicitly accept stale odds / reduced coverage; never pretend the five-minute window was fully covered.
- TTL 1s is a cache TTL, not a polling instruction.

## 3. Contract: Soccer API v4 — results/status only

### 3.1 Base URL and conventions

```
https://api.sportradar.com/soccer/{access_level}/v4/{language_code}/
```
- `access_level`: `trial` or `production`.
- `language_code`: choose `en` for deterministic English identifiers/labels.
- `format`: `json` or `xml`; target implementation chooses JSON.
- GET, header `x-api-key`.
- API Basics documents REST and JSON/XML; it describes 52 distinct feeds. Only feeds listed below are in scope.
- Do not use Push feeds or live tracking endpoints in this prematch/result verification design.

Official:
- https://developer.sportradar.com/soccer/docs/soccer-ig-api-basics
- https://developer.sportradar.com/soccer/docs/soccer-ig-account-maintenance

### 3.2 Allowed feeds

| Feed | GET path relative base | Parameters | Contract | Cache |
|---|---|---|---|---|
| Daily Summaries | `schedules/{date}/summaries.json` | path `date=YYYY-MM-DD`; query `start` default 0, `limit` default 200, max 200 | Per-event `sport_event`, `sport_event_context`, `sport_event_status`; event URN, start time, competitors, scores/status and optional stats | TTL 300s |
| Sport Event Summary | `sport_events/{sport_event_id}/summary.json` | path `sport_event_id` exact URN | Single event summary, score/status, stats; content depends on coverage | TTL 1s; use only for targeted reconciliation if quota allows |
| Sport Events Updated | `sport_events/updated.json` | no query parameters listed on endpoint reference | Event IDs updated in preceding 24h; item `id`, `updated_at` | TTL 60s; optional candidate for targeted refresh only |

References:
- Daily Summaries: https://developer.sportradar.com/soccer/reference/soccer-daily-summaries
- Sport Event Summary: https://developer.sportradar.com/soccer/reference/soccer-sport-event-summary
- Sport Events Updated: https://developer.sportradar.com/soccer/reference/soccer-sport-events-updated

### 3.3 Daily Summaries pagination confirmed

The Daily Summaries endpoint page explicitly documents:
- `start`: int32, default 0; offset of records to skip; `offset` is an alternative.
- `limit`: int32, default 200, maximum 200.
- A day can require multiple pages; default response is 200 sport events.
- Therefore PR #94's use of 200 is consistent with the current official endpoint page; previous FASE 0 uncertainty is resolved.
- For implementation, read response pagination headers where present and use endpoint docs. Do not infer identical caps for other Soccer feeds.

### 3.4 Result/status response model

Official Daily Summaries documents:
- `sport_event.id` exact URN; `sport_event.start_time`; `sport_event.replaced_by` when a postponed match is rescheduled; `sport_event_context` includes competition/season/round/competitors.
- `sport_event_status.status`: overall match status.
- `sport_event_status.match_status`: detailed sub-status, especially during live match phases.
- Scores: `home_score`, `away_score`, `winner_id`; period scores under `period_scores[].home_score/away_score/type/number`. Coverage controls which stats/fields are available.
- Example JSON wrapper is `sport_event` plus sibling `sport_event_status` for one event; actual Daily Summaries collection wrapper and optional/null edge cases must be fixture-validated against official schema before code.

**Status rules from official Match Status Workflow**
- Overall status values: `not_started`, `started`, `live`, `postponed`, `suspended`, `delayed`, `interrupted`, `cancelled`, `ended`, `closed`, `abandoned`.
- `ended` = match is over; `closed` = match result confirmed. Do not promote `ended` to provider-confirmed result.
- `match_status` has separate values such as `1st_half`, `2nd_half`, `halftime`, `overtime`, `awaiting_penalties`, `penalties`, `aet`, `ap`. It is not interchangeable with overall status.
- Postponed event handling: if restarted from beginning or resumed after 48 hours, new `sport_event` ID is assigned and original gets `replaced_by`; same ID is retained for interruption resumed within 48 hours.
- These status workflows are coverage-dependent; the documentation warns that workflow details apply to live-covered matches. This design uses only the overall status and does not implement live tracking.
- Soccer worker is result/status ingestion only. It must not calculate or apply settlement outcomes.

Official status workflow:
https://developer.sportradar.com/soccer/docs/soccer-ig-match-status-workflow

## 4. Authentication, errors, quota and rate limits

### 4.1 Authentication

- Both products document API key authentication via `x-api-key` header.
- Odds API Basics explicitly warns to keep the key server-side.
- Soccer endpoint pages expose the same header input.
- Do not treat `403` as JSON; Odds docs explicitly show HTML Authentication Error for missing/invalid key. Soccer generic response code docs list 401/403; exact body format is not confirmed in the Soccer page used here.

### 4.2 HTTP error handling contract

Official generic Response Codes:
https://developer.sportradar.com/getting-started/docs/response-codes

| HTTP | Official meaning | Worker behavior |
|---|---|---|
| 200 | OK | Validate response schema before persist |
| 301/302 | permanent/temporary redirect | Follow only safe HTTPS redirects; do not forward secret to untrusted host |
| 304 | Not Modified | Reuse prior validated snapshot; no empty overwrite |
| 400 | Bad Request | Permanent config/parameter failure; no retry loop |
| 401 | Unauthorized | Stop product worker; credential investigation |
| 403 | Forbidden | Stop product worker; authorization/key/entitlement investigation |
| 404 | Not Found / invalid route / wrong identifier | Quarantine event/endpoint reference; no blind retry |
| 405 | Method not allowed | Code/config error; stop that feed |
| 408 | Request timeout | Bounded retry with backoff |
| 410 | Gone | Mark resource unavailable; don't retry blindly |
| 429 | Quota exceeded OR throttled | Freeze new provider calls for affected product; distinguish quota vs QPS from provider response/account report; never hot-loop |
| 499 | Client closed request | Treat as uncertain request outcome; quota reservation remains spent |
| 500/502/503/504 | server/upstream errors | Bounded exponential backoff with jitter; no retry storm |

Odds-specific API Basics states:
- 403 authentication failure returns HTML Authentication Error page.
- 429 is rate limit; slow request rate and increase wait.
- 404 is unknown path or ID.
- Other codes follow global Response Codes.

Do not assume `Retry-After` is guaranteed: current cited docs define 429 handling but do not guarantee this header for either selected product. Parse it if present; otherwise use bounded backoff.

### 4.3 Quota/QPS

Official Your Account page:
https://developer.sportradar.com/getting-started/docs/your-account

- Every API key/product has rolling 30-day quota and QPS limit.
- Each product's limits and usage are visible in the account dashboard.
- Rolling 30-day means requests from 31 days prior drop out of quota each day.
- Default trial: 30-day trial period, 1,000 requests per rolling 30 days, 1 QPS.
- These are defaults only; actual account plan/limits must be read per product from dashboard.
- Quota is product-specific. Keep Odds and Soccer counters independent.
- QPS is defined per API product. The architecture decision remains 1 QPS per worker/product; do not assume two workers share a counter.

**Budget implication**
- 1,000 calls / 30 days averages about 33.3 calls/day/product before safety reserve.
- Change Log at 5-minute cadence costs 8,640 calls/30 days, so it cannot be enabled under default trial.
- Every request counts conservatively in the local guard, including timeout/crash after reserve. A retry is a new request and reserves quota again.
- Worker must refuse to start when actual limit, usage baseline, or product entitlement is unknown.

## 5. Contract decisions for implementation

1. Odds schedule feed: `live=false`, `limit<=50`, paginate with `start`; UTC date handling mandatory.
2. Odds markets: request `live=false`; additionally reject `market.is_live=true` on ingestion. Preserve removed book/outcome tombstones.
3. Odds Change Log: only use if budget can cover at least once per five-minute window plus event-market re-fetches. Otherwise disabled, and freshness limitations visible.
4. Soccer Daily Summaries: `limit<=200`; fetch only dates/event populations relevant to Odds tracked event set.
5. Soccer Summary: targeted fallback/reconciliation only, not continuous per-event polling.
6. Sport Events Updated: optional, not mandatory for initial implementation.
7. Soccer OFF by default and independent from Odds worker.
8. Match join only on exact `sport_event.id`; replacements create explicit link to new URN and never mutate old identity.
9. `closed` is provider-confirmed status; `ended` is not. Any unknown status or missing score/status is unresolved and never inferred.
10. No settlement decision is implemented from these provider statuses in this phase.

## 6. Remaining TIDAK TERVERIFIKASI

1. **GASTERUS account entitlement, actual quota and QPS** for both products — dashboard values unavailable from docs-only access.
2. **Configured bookmakers and Indonesian/SEA competition coverage** for the key — varies by key configuration and coverage matrix.
3. **OpenAPI downloadable artifact contents and all schema optional/nullability details** — official pages link the OpenAPI/XSD resources, but this phase froze only the rendered endpoint docs; do not fabricate complete JSON Schema.
4. **Exact response wrapper for every feed and all empty/null edge cases** — endpoint data-point tables and selected examples do not enumerate every runtime shape.
5. **Retry-After presence/value semantics** — not guaranteed by cited docs.
6. **Whether a particular event's result data is covered/available for this account** — must be checked via coverage matrix/dashboard, not assumed.
7. **Business settlement policy for cancelled, abandoned, postponed, decided_by_fed, or corrections** — not defined by provider API; outside scope.
8. **Actual poll schedule that fits account quotas** — depends on dashboard limits, number of sports/dates/events and per-event market re-fetch counts.
9. **The market/book/outcome ID type normalization** beyond the docs' GUID labels and sample URN strings — preserve exact provider strings until XSD/OpenAPI artifact confirms types.
10. **Any undocumented market lifecycle state** beyond explicit `removed` and `is_live` fields — treat unknown state as unresolved.

## 7. Next gate: FASE 2

Do not write provider workers until:
- OpenAPI and XSD downloads linked from the official Prematch Overview and Soccer API Basics are obtained and checked into the test-fixture preparation process (no provider calls).
- Fixture schemas are pinned/versioned and every required field, nullable field, and collection wrapper is asserted.
- A local mock HTTP server is built from official docs/schema/sample payloads only.
- Contract tests verify paths, methods, path/query parameters, header presence (dummy key only), response shapes, pagination, tombstones, status transitions, errors and coverage gaps.
- No live Sportradar API is used in tests.
- Quota guard and worker lifecycle tests are still mandatory before any runtime integration.

## 8. Official documentation index

- Odds API Basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Prematch Overview / OpenAPI + XSD links: https://developer.sportradar.com/odds/reference/oc-prematch-overview
- Books: https://developer.sportradar.com/odds/reference/oc-prematch-books
- Sports: https://developer.sportradar.com/odds/reference/oc-prematch-sports
- Sport Competitions: https://developer.sportradar.com/odds/reference/oc-prematch-sport-competitions
- Daily Schedules: https://developer.sportradar.com/odds/reference/oc-prematch-daily-schedules
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log
- Monitoring Odds Changes: https://developer.sportradar.com/odds/docs/oc-ig-monitoring-odds-changes
- Soccer API Basics / OpenAPI + XSD links: https://developer.sportradar.com/soccer/docs/soccer-ig-api-basics
- Daily Summaries: https://developer.sportradar.com/soccer/reference/soccer-daily-summaries
- Sport Event Summary: https://developer.sportradar.com/soccer/reference/soccer-sport-event-summary
- Sport Events Updated: https://developer.sportradar.com/soccer/reference/soccer-sport-events-updated
- Match Status Workflow: https://developer.sportradar.com/soccer/docs/soccer-ig-match-status-workflow
- Account quotas/rate limits: https://developer.sportradar.com/getting-started/docs/your-account
- HTTP response codes: https://developer.sportradar.com/getting-started/docs/response-codes

---
**FASE 1 deliverable:** this contract freeze document only. No source code, production data, credentials, Railway, provider calls, deployment, merge, or bet acceptance changes.
