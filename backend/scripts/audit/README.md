# Provider Benchmark Scripts

## Scripts Created (in `backend/scripts/audit/`)

| Script | Provider | Hard Max Requests | Env Vars Read |
|--------|----------|-------------------|---------------|
| `bench-sportmonks.mjs` | Sportmonks | **50** | `SPORTMONKS_API_KEY`, `SPORTMONKS_BASE_URL` |
| `bench-sharpapi.mjs` | SharpAPI | **50** | `SHARP_API_KEY`, `SHARP_API_BASE_URL`, `SHARP_API_SPORT`, `SHARP_API_MARKETS`, `SHARP_API_SPORTSBOOK`, `SHARP_API_PAGE_SIZE`, `SHARP_API_MAX_PAGES` |
| `bench-api-sports.mjs` | API-Sports | **30** | `API_SPORTS_KEY` (or `API_FOOTBALL_KEY`), `API_SPORTS_BASE_URL` |
| `bench-oddspapi.mjs` | OddsPapi | **3** | `ODDSPAPI_API_KEY`, `ODDSPAPI_BASE_URL`, `ODDSPAPI_TOURNAMENT_IDS`, `ODDSPAPI_BOOKMAKER` |
| `bench-rapidapi-tipsters.mjs` | RapidAPI Tipsters | **6** | `RAPIDAPI_ODDS_CACHE_URL`, `RAPIDAPI_ODDS_CACHE_TOKEN` |

## Run Commands (via Railway)

```bash
# Sportmonks
railway run node backend/scripts/audit/bench-sportmonks.mjs

# SharpAPI
railway run node backend/scripts/audit/bench-sharpapi.mjs

# API-Sports
railway run node backend/scripts/audit/bench-api-sports.mjs

# OddsPapi
railway run node backend/scripts/audit/bench-oddspapi.mjs

# RapidAPI Tipsters
railway run node backend/scripts/audit/bench-rapidapi-tipsters.mjs
```

## Import Lists (for verification)

### All scripts (identical)
```javascript
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
```

No other imports — all standalone, no DB/ingest/worker modules.

## Key Features

### 1. Hard Request Limits (not overridable by env vars)
| Provider | Limit | Behavior |
|----------|-------|----------|
| Sportmonks | 50 | Fetches nearest dates first, stops at limit |
| SharpAPI | 50 | Stops paging at limit |
| API-Sports | 30 | Per-day iteration, nearest dates first, free plan date limit (7 days) respected |
| OddsPapi | 3 | Only tournaments + markets + fixtures; odds-by-tournaments skipped |
| RapidAPI | 6 | 1 events + max 5 markets |

### 2. Pre-flight Estimates
Each script prints **before first API call**:
```
PROVIDER_PREFILIGHT estimated_requests=X max_requests=Y dates_to_fetch=N skipped=...
```
If estimate exceeds limit, scope is reduced (nearest dates/events first), skipped items logged.

### 3. Error Detection (Fixed)
- **SharpAPI**: Empty `errors: []` or `errors: {}` no longer counted as error (checks `Array.isArray && length > 0`)
- All providers: Check response body for `errors[]`, `message`, `error` fields, not just HTTP status
- Error text truncated to 300 chars, no keys printed

### 4. API-Sports Free Plan Date Limit
- Free plan typically allows ~7 days ahead
- Script enforces `FREE_PLAN_MAX_DAYS_AHEAD = 7`
- Logs skipped days if benchmark window exceeds this

### 5. Per-Request Logging
```
PROVIDER_RESP_BYTES <bytes> url=...
PROVIDER_RESULT endpoint=... count=... / date=... page=... fixtures=...
```

### 6. Output
- Raw funnel JSON → `/tmp/<provider>-benchmark-<timestamp>.json`
- Summary JSON to stdout with: `requests`, `input`, `output`, `errors`, `errorDetails`, `datesFetched`, `datesSkipped`, `endpointsSkipped`

### 7. Security
- ✅ No env vars printed
- ✅ No DB/ingest/worker imports
- ✅ Standalone HTTP only