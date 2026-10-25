# Kebutuhan go-live staging (inventaris dari kode)

Dokumen ini dibuat dari pembacaan kode repo, bukan asumsi. Tidak berisi nilai secret.

## 1. Akses staging yang dibutuhkan

- Railway CLI terpasang (`railway 5.71.0`), tetapi `railway whoami` mengembalikan `Unauthorized. Please login with railway login`.
- Environment shell saat ini tidak memiliki `DATABASE_URL`, `REDIS_URL`, token Railway, atau ID project/environment/service.
- `psql` dan `redis-cli` tidak terpasang.
- Karena itu, Fase 3-7 yang membutuhkan staging nyata ditandai `BLOCKED` sampai akses terotorisasi tersedia.

Bukti: `docs/evidence/phase2-staging-access.txt`.

## 2. Variabel environment wajib (backend `requiredSecret`)

Nama variabel wajib (tanpa nilai), dengan panjang minimum seperti di `backend/src/config.js`:

- `DATABASE_URL` (min 12)
- `REDIS_URL` (min 12)
- `MEMBER_PROXY_SECRET` (min 32)
- `ADMIN_PROXY_SECRET` (min 32)
- `OPS_INTERNAL_SECRET` (min 32)
- `SESSION_HMAC_KEY` (min 32)
- `API_KEY_PEPPER` (min 32)
- `MFA_ENCRYPTION_KEY_BASE64` (min 40, decode base64 ke 32 byte)

Alias yang dinormalisasi oleh `deploy/predeploy.js` sebelum validasi:

- `DATABASE_URL` <- `POSTGRES_URL` / `DATABASE_PRIVATE_URL` / `DATABASE_PUBLIC_URL`
- `REDIS_URL` <- `REDIS_PRIVATE_URL` / `REDIS_PUBLIC_URL`

## 3. Variabel inti runtime (default tersedia, tetapi perlu penyesuaian staging)

- `NODE_ENV=production`
- `PORT` (default 8080)
- `HOST` (default 0.0.0.0)
- `QUEUE_NAME` (default `gasterus:settlement:queue`)
- `LOCK_TTL_MS` (default 120000)
- `WORKER_HEARTBEAT_KEY` (default `gasterus:worker:heartbeat`)
- `WORKER_HEARTBEAT_MAX_AGE_SECONDS` (default 90, batas 20-600)
- `MEMBER_SESSION_TTL_SECONDS` (default 43200)
- `OWNER_SESSION_TTL_SECONDS` (default 900)
- `HIGH_VALUE_APPROVAL_THRESHOLD` (default 1000000)
- `APPROVAL_TTL_SECONDS` (default 1800)
- `TRUST_PROXY` (default true)
- `COOKIE_SECURE` (default mengikuti production)
- `COOKIE_DOMAIN`, `COOKIE_SAMESITE`
- `BALANCE_UNIT_NAME` (default `Saldo`)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_RESET_URL`
- `ALLOWED_MEMBER_ORIGIN`, `ALLOWED_ADMIN_ORIGIN`

## 4. Guardrail keamanan yang harus tetap false

- `TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED=false`
- `SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED=false`

## 5. Endpoint health dan readiness (dari kode)

### `GET /healthz` (`backend/src/app.js`)

- Membaca Redis key heartbeat worker: `config.workerHeartbeatKey` (default `gasterus:worker:heartbeat`).
- Memanggil `isWorkerHeartbeatFresh(raw, { staleAfterSeconds: max(workerHeartbeatMaxAgeSeconds * 2, 120) })`.
- Mengembalikan `200 { status: "ok" }` jika heartbeat fresh; `503 { status: "degraded" }` jika tidak.
- Tidak memeriksa PostgreSQL.

### `GET /ready` (`backend/src/app.js`)

- Menjalankan `checkDatabase()` dan `checkRedis()` secara paralel.
- `ready = database.ok && cache.ok`.
- Mengembalikan `200 { status: "ready", database, cache }` jika keduanya ok; `503 { status: "degraded", ... }` jika tidak.
- Endpoint ini benar-benar memeriksa DB dan Redis.

### `GET /internal/monitoring` (ops, memerlukan secret ops)

- Memeriksa DB, Redis, ledger balance, heartbeat worker, queue depth, memori, sportsbook status, dan build commit.
- Heartbeat worker dianggap sehat jika age <= `workerHeartbeatMaxAgeSeconds` (default 90 detik).

## 6. Mekanisme heartbeat worker

- Penulis heartbeat: `backend/src/worker.js`, fungsi `heartbeat()`:
  - Redis `SET config.workerHeartbeatKey <ISO timestamp> EX ttl`
  - `ttl = max(workerHeartbeatMaxAgeSeconds * 2, 60)` detik (default 180 detik).
- Interval loop: `max(5000, min(30000, floor(workerHeartbeatMaxAgeSeconds * 1000 / 3)))` ms (default 30000 ms).
- Heartbeat juga ditulis pada siklus utama worker (`main()`), sebelum dispatch outbox dan settlement.
- Pembaca heartbeat untuk `/healthz`: stale threshold `max(workerHeartbeatMaxAgeSeconds * 2, 120)` detik (default 180 detik).
- `backend/migrations/worker-health.js` adalah checker CLI: membaca Redis key, memverifikasi age <= `workerHeartbeatMaxAgeSeconds` (default 90 detik), mencetak JSON `{ status, heartbeatAt, ageSeconds }`.
- `backend/src/worker-entry.js` menyediakan endpoint `/healthz` terpisah untuk service worker; status `starting` selama grace period `WORKER_HEALTH_GRACE_MS` (default 120000 ms), lalu healthy jika heartbeat age <= `max(workerHeartbeatMaxAgeSeconds * 2, 120)` detik.

## 7. Prosedur migrasi resmi

- Railway predeploy (`deploy/predeploy.js`) menjalankan:
  1. `migrations/wait-dependencies.js`
  2. `migrations/migrate.js` (3 percobaan)
  3. `migrations/seed.js` (3 percobaan)
  4. `migrations/ensure-owner.js` (2 percobaan)
  5. `migrations/schema-ready.js` (5 percobaan)
- `migrations/migrate.js`:
  - Mengambil advisory lock `gasterus-schema-migrations-v2`.
  - Membaca semua file `backend/migrations/*.sql` yang cocok `^\d+_.*\.sql$`, diurutkan.
  - Mencatat versi di tabel `schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`.
  - Menjalankan setiap migrasi dalam transaksi; jika gagal, rollback dan berhenti.
- `migrations/schema-ready.js`:
  - Memastikan tabel `schema_migrations` ada.
  - Memastikan semua 44 file migrasi SQL tercatat.
  - Memastikan tabel wajib ada: `users, markets, ledger_accounts, ledger_transactions, ledger_entries, wallet_requests, payment_methods, money_transaction_events, payment_provider_events`.
  - Memastikan Redis `PING` = `PONG`.
- Versi migrasi yang diharapkan saat ini: 44 file (`001_platform.sql` s/d `043_restore_approved_result_authority.sql`), tergantung repo commit.

## 8. Prosedur rollback migrasi (GAP)

- Tidak ditemukan file/prosedur rollback migrasi di repo (`migrations/rollback*` tidak ada; pencarian `rollback` hanya menemukan rollback settlement tiket, bukan skema DB).
- `migrate.js` hanya maju (forward-only); tidak ada down migration.
- Ini adalah temuan gap: rollback skema harus dilakukan via restore backup database terisolasi atau redeploy commit sebelumnya dengan skema yang kompatibel, bukan via perintah migrasi.
- Status: `GAP / TEMUAN`, bukan prosedur terverifikasi.

## 9. Daftar nama variabel dari `.railway/railway.ts` (tanpa nilai)

Daftar lengkap nama variabel IaC Railway yang terdeteksi (hanya nama):

ADMIN_PASSWORD
ADMIN_PROXY_SECRET
API_KEY_PEPPER
API_SPORTS_BASE_URL
API_SPORTS_DAILY_QUOTA
API_SPORTS_DAYS_AHEAD
API_SPORTS_ENABLED
API_SPORTS_KEY
API_SPORTS_LIVE_REFRESH_SECONDS
API_SPORTS_ODDS_PAGES
API_SPORTS_PREMATCH_REFRESH_SECONDS
APP_URL
CORE_HEAP_MB
CORS_ORIGIN
DATABASE_URL
FEED_WORKER_ENABLED
FEED_WORKER_HEAP_MB
FOOTBALLDATA_IO_BASE_URL
FOOTBALLDATA_IO_ENABLED
FOOTBALLDATA_IO_KEY
FOOTBALLDATA_IO_REFRESH_SECONDS
FOOTBALLDATA_IO_UPCOMING_LIMIT
FRONTEND_RESET_URL
GATEWAY_HEAP_MB
JWT_SECRET
MEMBER_HEAP_MB
MEMBER_PROXY_SECRET
MFA_ENCRYPTION_KEY_BASE64
MY_API_TOKEN
NODE_ENV
NODE_OPTIONS
OPS_INTERNAL_SECRET
OWNER_PASSWORD
OWNER_TOTP_SECRET
OWNER_USERNAME
PUBLIC_MARKET_DERIVED_MARKETS_ENABLED
PUBLIC_MARKET_OPENFOOTBALL_ENABLED
RAPIDAPI_CASINO_ENABLED
RAPIDAPI_CASINO_KEY
REDIS_URL
RESEND_API_KEY
RESEND_FROM_EMAIL
RUN_STARTUP_MIGRATIONS
SESSION_HMAC_KEY
SHARP_API_BASE_URL
SHARP_API_ENABLED
SHARP_API_KEY
SHARP_API_MARKETS
SHARP_API_MAX_PAGES
SHARP_API_PAGE_SIZE
SHARP_API_REFRESH_SECONDS
SHARP_API_SPORT
SPORTMONKS_API_KEY
SPORTMONKS_BASE_URL
SPORTMONKS_DAYS_AHEAD
SPORTMONKS_ENABLED
SPORTMONKS_MARKET_IDS
SPORTMONKS_MAX_PAGES_PER_REFRESH
SPORTMONKS_MAX_RESPONSE_BYTES
SPORTMONKS_MAX_RETRIES
SPORTMONKS_MAX_TOTAL_EVENTS
SPORTMONKS_ODDS_REFRESH_SECONDS
SPORTMONKS_PAGE_SIZE
SPORTMONKS_REFRESH_SECONDS
SPORTMONKS_REQUEST_DELAY_MS
SPORTSBOOK_INGEST_HMAC_SECRET
SPORTSBOOK_INGEST_URL
SPORTSBOOK_RENDER_MAX_EVENTS
SPORTSBOOK_RENDER_MAX_PAGES
SPORTS_FEED_MAX_CACHE_BYTES
SPORTS_FEED_MAX_EVENTS
SPORTS_SOURCE_BACKGROUND_POLL_ENABLED
THE_ODDS_API_BASE_URL
THE_ODDS_API_ENABLED
THE_ODDS_API_EVENT_MARKETS
THE_ODDS_API_EVENT_MARKETS_ENABLED
THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT
THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS
THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD
THE_ODDS_API_KEY
THE_ODDS_API_KEYS
THE_ODDS_API_KEY_2
THE_ODDS_API_MARKETS
THE_ODDS_API_MAX_TOTAL_EVENTS
THE_ODDS_API_REFRESH_SECONDS
THE_ODDS_API_REGIONS
THE_ODDS_API_SPORT_KEYS
WORKER_HEAP_MB

## 10. Variabel opsional provider/fitur (dari `backend/src/config.js` dan `.env.example`)

- Sports data providers: `API_SPORTS_*`, `FOOTBALLDATA_IO_*`, `SPORTMONKS_*`, `THE_ODDS_API_*`, `SHARP_API_*`, `SPORTSBOOK_*`, `RAPIDAPI_*`, `BETNEX_*`.
- TOTO collector: `TOTO_COLLECTOR_*`, `TOTO_*_URL`, `TOTO_BROWSER_FALLBACK_*`, `TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED`, `TOTO_AUTO_SETTLEMENT_*`.
- QRIS/DANA: `QRIS_*`, `DANA_*`.
- Admin bootstrap: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `OWNER_USERNAME`, `OWNER_PASSWORD`, `OWNER_TOTP_SECRET`, `ADMIN_ROLES`.
- Sportsbook ingest: `SPORTSBOOK_INGEST_URL`, `SPORTSBOOK_INGEST_HMAC_SECRET`, `SPORTSBOOK_INGEST_MAX_PAYLOAD_BYTES`, `SPORTSBOOK_INGEST_MAX_AGE_SECONDS`.
- Lainnya: `SPORTS_FEED_MAX_EVENTS`, `SPORTS_FEED_MAX_CACHE_BYTES`, `SPORTS_PROVIDER_CACHE_MAX_*`, `TREE_RSS_LIMIT_MB`, `CORE_HEAP_MB`, `GATEWAY_HEAP_MB`, `MEMBER_HEAP_MB`, `FEED_WORKER_HEAP_MB`, `WORKER_HEAP_MB`, `RUN_STARTUP_MIGRATIONS`, `CHROME_PATH`, `SPORTS_SOURCE_BROWSER_EXECUTABLE`.

## 11. Smoke test yang tersedia

- `api-test.mjs`: hanya memeriksa `/health`, `/ready`, `/api/public/markets`, captcha register, register tanpa captcha (400), login salah (401), `/api/member/me` tanpa auth (401) dan token invalid (401).
- Tidak mencakup register/login sukses, CSRF, rate limiting, sportsbook sandbox sampai settlement, admin RBAC.
- `e2e-test.mjs` memeriksa health/ready gateway dan flow lain, tetapi membutuhkan environment lokal/staging.

Status akhir Fase 1: inventaris selesai. Akses staging tetap `BLOCKED`.
