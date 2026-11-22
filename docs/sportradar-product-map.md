# GASTERUS Sportradar Product Map

## One credential, multiple product packages

Production stores one secret: `SPORTRADAR_API_KEY`, only on the isolated sportsbook render worker. Every Sportradar request sends it in the `x-api-key` header. Do not create duplicate key variables for each product and never expose the key to the browser.

The key is shared across the products that the Sportradar application is entitled to use. A valid key does not automatically mean every product package is enabled.

## Product routing

| Documentation / product | Base URL pattern | Responsibility | GASTERUS use |
|---|---|---|---|
| Odds Comparison Prematch v2 | `https://api.sportradar.com/oddscomparison-prematch/{trial\|production}/v2/en` | Prematch events, books, markets, odds, change log | Primary prematch odds source |
| Odds Comparison Player Props v2 | `https://api.sportradar.com/oddscomparison-player-props/{trial\|production}/v2/en` | Player-level markets and prices | Separate player-props module; enable only after entitlement and payload validation |
| Soccer API v4 | `https://api.sportradar.com/soccer/{trial\|production}/v4/en` | Soccer competitions, schedules, scores, statistics | Event/results context only; never treat it as an odds feed |
| Odds Comparison Regular v1 | Legacy product-specific URL family | Older Odds Comparison integration | Retired from the new runtime; do not mix v1 and v2 paths |

Odds Comparison v2 packages use separate base URLs while sharing the same API key and common discovery conventions. The product map in `backend/src/sportradar-products.js` is the single source of truth for those URL families.

## Access and entitlement rules

- `trial` / `production` is the access level in the URL. It is not the same thing as OC US / OC Core coverage.
- The response `X-Origin-Id` identifies the Odds Comparison coverage tier. Do not infer global coverage from the word `production`.
- Each package's `books.json` feed shows bookmakers configured for that package.
- The Prematch `sports/{sport_id}/competitions.json` response includes availability flags such as `markets`, `player_props`, and `futures`. Only request a package for competitions whose relevant flag is true.
- Player Props and Prematch share Sportradar event IDs (`sr:sport_event:...`), but their market families and endpoint paths remain separate.
- HTTP 403 is an authentication/access error; HTTP 429 is rate limiting. A 200 response with an unexpected JSON shape is not proof of valid market data.

## Required Prematch flow

1. Discover `books.json` and `sports.json`.
2. Discover `sports/{sport_id}/competitions.json`; select competitions with `markets: true`.
3. Pull the Prematch daily schedule / daily event-market feed for those sports and dates.
4. Read the exact event-market response wrapper and validate its event, market, book, and outcome arrays before normalizing.
5. Use the Prematch change log to refresh only changed event IDs; recover with a direct event-market pull after a missed five-minute window.
6. Keep removed books/outcomes for audit and closing-line history, but prevent removed, live, stale, or unverified prices from accepting bets.

## Safety boundaries

- Do not call every package repeatedly just to discover whether the key has access; entitlement probes consume the same provider quota.
- Do not enable Player Props, Live Odds, Futures, or Soccer API settlement authority until package access and the response contract are verified.
- Soccer API results must not become automatic settlement authority merely because a fixture or score endpoint responds. Settlement authority remains governed by the existing sportsbook settlement controls.
- Wallet, ledger, tickets, risk, settlement, authentication, and database records are not provider code and must not be deleted during a provider rebuild.
