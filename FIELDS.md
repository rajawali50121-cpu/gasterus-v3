# Sportradar Odds Comparison Prematch v2 field notes

## Evidence captured

One real response was fetched on 2026-11-25 from `daily-sport-event-markets` for `sr:sport:1`, access level `trial`, language `en`, with `start=0` and `limit=50`. The request returned HTTP 200 and JSON with root keys `generated_at` and `sport_schedule_sport_event_markets`; the latter contained 15 events. The local raw fixture is deliberately gitignored and must not be committed because it may contain account/provider data.

The fixture was inspected locally. Its 15 events contained 77 markets with `is_live` present as boolean `false` on every market. The inspection found no `live`, `replaced_by`, or `resume_time` keys anywhere in that captured response. These absences apply only to this fixture; they do not prove the fields can never occur.

## Field contract and implementation implications

| Field | Observation | Handling / limitation |
| --- | --- | --- |
| `generated_at` | Present at response root in the captured response. | Provider generation time; do not substitute local ingestion time if absent. |
| `sport_schedule_sport_event_markets` | Root event array; 15 elements captured. | Expected event collection for this real response. |
| `markets[].is_live` | Present in all 77 captured market objects, boolean `false`. | Prematch market signal. Keep markets non-live only when the explicit value is not `true`; do not infer `live` from a missing field. |
| `live` | Not found in the captured response. | Not established as an endpoint field by this fixture. |
| `replaced_by` | Not found in the captured response. | No replacement semantics verified from this fixture. |
| `resume_time` | Not found in the captured response. | No resume-time semantics verified from this fixture. |
| Pagination | Request used `start=0`, `limit=50`; 15 events returned. | The fixture-capture script did not retain response headers. Therefore pagination headers, total result count, and whether this response was complete cannot be proven from the captured artifact. Do not treat 15 results as proof there are no more. No follow-up request was made. |

## Truncation and snapshot protection

The provider fixture is one page and does not establish pagination completeness. The client must use available pagination metadata and page limits conservatively. If the page ceiling is reached while additional results are indicated, mark the cycle truncated/incomplete. Incomplete or truncated data must not replace the last-known-good Redis snapshot or be persisted to PostgreSQL. The contract test suite includes regressions for this fail-closed behavior; the real-fixture contract test runs when the ignored fixture exists locally and is skipped in CI where that private fixture is absent.

## Documentation boundary

The public Odds Comparison API basics describe the product/API conventions, but the captured fixture is the evidence for the exact response keys above. No assertion is made here that undocumented fields are globally impossible. Pagination completeness remains unverified for the real response because its headers were not saved.

References:
- [Sportradar Odds Comparison API Basics](https://developer.sportradar.com/odds/docs/oc-ig-api-basics)
- [Sportradar Odds Comparison APIs: Sport Event Status](https://developer.sportradar.com/sportradar-updates/changelog/odds-comparison-apis-sport-event-status)
