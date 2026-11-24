# Daily Sport Event Markets fixture

A real licensed response is intentionally not committed to Git. Capture one page locally after configuring the Sportradar key and Redis URL:

```bash
npm install
npm run fetch:fixture
```

Optional:
- `SPORTRADAR_FIXTURE_SPORT_ID=sr:sport:1`
- `SPORTRADAR_FIXTURE_DATE=YYYY-MM-DD`

The capture makes exactly one request, uses the same Redis rolling quota, global request pacing, and circuit breaker as the worker, and writes `fixtures/daily_markets.sample.json` only if the file does not already exist. Do not repeatedly retry a 403/429 response. Keep the key server-side and never commit the captured response without checking Sportradar's data licence.

Official docs:
- https://developer.sportradar.com/odds/reference/oc-prematch-overview
- https://developer.sportradar.com/odds/docs/oc-ig-api-basics
