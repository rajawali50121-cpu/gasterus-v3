# Staging deployment checklist

Use this guide to configure and smoke-test a staging deployment. The current
[`koyeb.yaml`](../koyeb.yaml) defines the sportsbook render **worker only**;
the backend API and Cloudflare Pages frontend are configured as separate
services. Never put backend credentials in Cloudflare Pages frontend variables.

## Environment and secrets

### Backend API

Configure these on the backend service's secret/environment settings:

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | `production` in staging when validating production behavior |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | Must be `true` in production |
| `DATABASE_SSL_CA` | Optional PEM CA when the database uses a private/non-system CA; do not disable certificate verification |
| `REDIS_URL` | Redis connection string |
| `MEMBER_PROXY_SECRET`, `ADMIN_PROXY_SECRET`, `OPS_INTERNAL_SECRET`, `SESSION_HMAC_KEY`, `API_KEY_PEPPER` | Independent random secrets, each at least 32 characters |
| `MFA_ENCRYPTION_KEY_BASE64` | Canonical Base64 encoding of exactly 32 random bytes |
| `SPORTSBOOK_INGEST_HMAC_SECRET` | At least 32 characters; must equal the Koyeb worker secret |
| `TRUSTED_PROXY_IPS` | Comma-separated IPs of trusted immediate proxies; default is loopback for the colocated gateway |

Provider credentials are needed on the service that calls each provider.
For the current deployment, Sportmonks and The Odds API credentials belong on
the Koyeb worker. Keep deployment-specific values out of source control. The
local-development placeholders and optional settings are listed in
[`backend/.env.example`](../backend/.env.example).

### Koyeb sportsbook worker

The manifest references these Koyeb Secrets; create them in Koyeb and ensure
they point to the staging backend/provider credentials:

- `GASTERUS_SPORTSBOOK_INGEST_URL`: HTTPS backend origin plus
  `/api/internal/sportsbook/ingest`.
- `GASTERUS_SPORTSBOOK_INGEST_HMAC_SECRET`: same value as backend
  `SPORTSBOOK_INGEST_HMAC_SECRET`.
- `GASTERUS_SPORTMONKS_API_KEY`.
- `GASTERUS_THE_ODDS_API_KEY`.

The manifest supplies non-secret runtime settings, including production mode,
224 MiB V8 heap, payload/event/page limits, provider switches, and refresh
cadence. Do not copy production provider keys or HMAC material into staging.

### Cloudflare Pages

For the Pages deployment, configure:

- `BACKEND_URL`: staging backend's HTTPS origin, without a trailing slash.
- `ADMIN_PATH_PREFIX`: only if staging uses a custom admin path; it must match
  the backend/gateway configuration.

These are runtime bindings used by `frontend/_worker.js`. No database, Redis,
provider API key, or HMAC secret should be configured in the frontend.

## First-deploy health verification

Set shell variables to the staging URLs (do not include credentials):

```sh
BACKEND_ORIGIN="https://<staging-backend-host>"
STAGING_SITE="https://<staging-pages-host>"
```

1. Check backend process liveness:

   ```sh
   curl --fail-with-body --show-error "$BACKEND_ORIGIN/health"
   ```

   Expect HTTP 200 and `data.status: "ok"`.

2. Check PostgreSQL and Redis readiness:

   ```sh
   curl --fail-with-body --show-error "$BACKEND_ORIGIN/ready"
   ```

   Expect HTTP 200 and both `database.ok` and `cache.ok` to be `true`.

3. Check the public gateway and worker-dependent readiness:

   ```sh
   curl --fail-with-body --show-error "$BACKEND_ORIGIN/readyz"
   curl --fail-with-body --show-error "$BACKEND_ORIGIN/healthz"
   ```

   `/readyz` requires the backend services and sportsbook readiness. `/healthz`
   depends on a fresh worker heartbeat. If either returns HTTP 503, inspect the
   response and backend/gateway logs before declaring the deployment healthy.

4. Verify Cloudflare Pages forwards API requests to the staging backend:

   ```sh
   curl --fail-with-body --show-error "$STAGING_SITE/api/health/simple"
   ```

   Expect HTTP 200. A 503 `BACKEND_NOT_CONFIGURED` means the Pages
   `BACKEND_URL` binding is missing or empty.

5. In Koyeb, confirm the worker instance is running, has no increasing restart
   count or memory warnings, and live logs show `snapshot-accepted`. The worker
   is a background process and does not expose its own HTTP health endpoint.
   Verify both secret values are configured without printing or sharing them.

After deployment changes, run `npm run check` and `npm test` from the repository
before promoting staging to production.
