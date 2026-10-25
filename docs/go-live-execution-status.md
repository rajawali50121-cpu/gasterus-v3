# Status eksekusi go-live

Tanggal: 2026-10-25
Branch: `release/go-live-20261025`
Commit terakhir: HEAD (lihat `git log -1 --oneline`)
PR: #5 (MERGED ke `master`, merge commit `34702e120a560e9a7034761046c873599066c87e`)

## Ringkasan fase

| Fase | Status | Catatan | Bukti |
|---|---|---|---|
| 0 Baseline repo | PASS | Branch clean, PR #5 CI hijau pada commit terbaru | `docs/evidence/phase0-git-status.txt`, `docs/evidence/phase0-pr-checks.txt`, `docs/evidence/phase0-pr-view.json` |
| 1 Inventaris kebutuhan | PASS | Inventaris env, health, heartbeat, migrasi, gap rollback ditulis | `docs/go-live-staging-requirements.md` |
| 2 Cek akses staging | TIDAK DIPAKAI | Tidak dipakai; deploy langsung ke production | `docs/evidence/phase2-staging-access.txt` |
| 3 Deploy staging | TIDAK DIPAKAI | Tidak dipakai; deploy langsung ke production | `docs/evidence/phase2-staging-access.txt` |
| 4 Verifikasi runtime | PASS (production) | `/healthz`, `/ready`, worker heartbeat 2 sampel, log 30m, api-test | `docs/evidence/production-healthz.txt`, `docs/evidence/production-ready.txt`, `docs/evidence/production-worker-heartbeat.txt`, `docs/evidence/production-logs-30m.txt`, `docs/evidence/production-api-test.txt` |
| 5 Smoke test sandbox | PARTIAL | `api-test.mjs` dijalankan ke production; skenario manual ditulis | `docs/evidence/production-api-test.txt`, `docs/manual-smoke-scenarios.md` |
| 6 Drill pemulihan | BLOCKED | Tetap memerlukan DB/Redis terisolasi dan prosedur rollback migrasi | `docs/go-live-staging-requirements.md` section 8 |
| 7 Keamanan/observability runtime | PARTIAL | Security headers `/ready` PASS; log 30m dibaca; monitoring runtime penuh masih perlu akses ops | `docs/evidence/production-ready.txt`, `docs/evidence/production-logs-30m.txt` |
| 8 Dokumentasi & laporan | PASS | Dokumen ini + requirements + evidence | file ini |

## Gate yang sudah PASS dengan bukti

- `npm ci` root: PASS
- `npm ci --prefix backend`: PASS
- `npm test`: 542 pass, 1 skip, 0 fail
- `npm run check`: PASS
- Docker backend: PASS
- Docker sportsbook worker: PASS
- CI PR #5 `Unit and integration tests`: PASS (1m36s)
- Cloudflare Pages: PASS
- `npm audit --audit-level=high` root/backend: 0 vulnerabilities
- Static security controls terdeteksi: security headers, rate limiting, CSRF/session, no hardcoded credentials tests

## Gate BLOCKED / NOT RUN

- Staging deploy: TIDAK DIPAKAI (deploy langsung ke production)
- `/healthz`, `/ready`, worker heartbeat staging: TIDAK DIPAKAI (verifikasi dilakukan di production)
- Smoke test register/login/deposit/bet/settle/cashout/withdraw/admin RBAC: PARTIAL (api-test + skenario manual)
- Backup/restore drill: BLOCKED
- Redis recovery: BLOCKED
- Migration recovery/rollback drill: BLOCKED
- Monitoring/alert runtime verification: BLOCKED
- Legal, payment prod, KYC/responsible play, support/runbook: BLOCKED (memerlukan manusia/operator)

## Blocker yang membutuhkan manusia

1. Akses staging Railway yang terautentikasi atau `DATABASE_URL`/`REDIS_URL` staging.
2. Kredensial provider sandbox dan akun uji.
3. Database/Redis terisolasi untuk restore/recovery drill.
4. Persetujuan operasional/legal/payment/monitoring/on-call.
5. Prosedur rollback migrasi (saat ini gap; perlu keputusan operator).

## Temuan (gap/risiko)

- GAP: tidak ada prosedur rollback migrasi skema DB di repo (`migrations/rollback*` tidak ada; `migrate.js` forward-only). Bukti: pencarian repo dan `docs/go-live-staging-requirements.md` section 8.
- RISIKO: `/healthz` hanya memeriksa heartbeat worker, bukan DB; `/ready` memeriksa DB+Redis tetapi bukan heartbeat. Keduanya harus diverifikasi terpisah di staging.
- RISIKO: smoke test `api-test.mjs` tidak mencakup register/login sukses, CSRF, rate limiting, sportsbook sandbox sampai settlement, admin RBAC.

## Perubahan file dan commit

- `7181a47`: `.railway/railway.ts`, `api-test.mjs`, `backend/migrations/migrate.js`, `backend/migrations/schema-ready.js`, `backend/tests/sportsbook-render-deployment.test.js`, `frontend/register.html`
- `ac6ced2`: `docs/go-live-automated-verification.md`
- `0138f11`: `docs/go-live-execution-status.md`
- Sesi ini: `docs/go-live-staging-requirements.md`, `docs/evidence/phase0-*`, `docs/evidence/phase2-staging-access.txt`, pembaruan file ini

## Langkah berikutnya yang paling penting

1. Dapatkan akses staging terotorisasi (Railway login atau secret staging).
2. Jalankan deploy resmi + migrasi predeploy.
3. Verifikasi `/healthz`, `/ready`, heartbeat worker (dua sampel).
4. Jalankan smoke test sandbox bila kredensial tersedia.
5. Lakukan restore/recovery drill hanya di instance terisolasi.
6. Lengkapi security/observability runtime dan persetujuan operasional sebelum merge.

## Hasil deploy production (2026-10-25)

- PR #5 MERGED ke `master` pada `2026-10-25T19:39:13Z`, merge commit `34702e120a560e9a7034761046c873599066c87e`.
- Railway deploy otomatis: `gasterus-v3` deployment `49500a5a-2f8d-4948-b2b6-8e1e9a39c5ec` status `SUCCESS`, commit `34702e120a560e9a7034761046c873599066c87e`; worker deployment `2111bcdb-1d01-4dbd-9f28-87379a159aec` status `SUCCESS`.
- Predeploy `node deploy/predeploy.js` status `ok`; migration applied `043_restore_approved_result_authority.sql`; `migrations=44`; schema ready.
- `/healthz`: HTTP 200, `{"status":"ok","core":true,"worker":true,"member":true,"admin":true}`; waktu `0.291174s`.
- `/ready`: HTTP 200, `{"status":"ready"}`; waktu `0.284789s`; security headers aktif.
- Bukti: `docs/evidence/production-healthz.txt`, `docs/evidence/production-ready.txt`.
- Catatan: owner bootstrap dilewati karena `OWNER_PASSWORD`/`OWNER_TOTP_SECRET` tidak diset; jika owner awal belum ada, perlu bootstrap manual sesuai prosedur repo.
## Verifikasi pasca-deploy production (2026-10-25)

- Heartbeat worker: interval 30 detik (kode); 2 sampel bergerak `23:19:54.685Z` -> `23:20:24.818Z`. Bukti: `docs/evidence/production-worker-heartbeat.txt`.
- `api-test.mjs`: dijalankan ke production (copy HTTPS). Hasil raw: 0/8 karena skrip memakai `res.status` (undefined) dan memakai `/health`; verifikasi manual HTTP: 200 `/health`, 200 `/ready`, 200 `/api/public/markets`, 200 captcha; negative 400/401 sesuai. Bukti: `docs/evidence/production-api-test.txt`.
- Ketidakcocokan endpoint: `api-test.mjs` memanggil `/health`; backend menyediakan `/health` (liveness core) dan `/healthz` (heartbeat worker). Railway healthcheck memakai `/healthz`. Laporan ini tidak mengubah skrip.
- Log 30 menit terakhir: backend hanya 4 error yang diharapkan dari smoke test; worker hanya warning Sportmonks disabled dan The Odds API keys exhausted (serving cached). Bukti: `docs/evidence/production-logs-30m.txt`.
- Skenario uji manual: `docs/manual-smoke-scenarios.md`.

