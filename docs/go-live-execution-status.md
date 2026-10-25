# Status eksekusi go-live

Tanggal: 2026-10-25
Branch: `release/go-live-20261025`
Commit terakhir: `0138f11` (docs: add go-live execution status checkpoint)
PR: #5 (OPEN, MERGEABLE)

## Ringkasan fase

| Fase | Status | Catatan | Bukti |
|---|---|---|---|
| 0 Baseline repo | PASS | Branch clean, PR #5 CI hijau pada commit terbaru | `docs/evidence/phase0-git-status.txt`, `docs/evidence/phase0-pr-checks.txt`, `docs/evidence/phase0-pr-view.json` |
| 1 Inventaris kebutuhan | PASS | Inventaris env, health, heartbeat, migrasi, gap rollback ditulis | `docs/go-live-staging-requirements.md` |
| 2 Cek akses staging | BLOCKED | Railway CLI tidak login; DATABASE_URL/REDIS_URL/token/ID absen; psql/redis-cli absen | `docs/evidence/phase2-staging-access.txt` |
| 3 Deploy staging | NOT RUN | Dihentikan karena Fase 2 BLOCKED | `docs/evidence/phase2-staging-access.txt` |
| 4 Verifikasi runtime | NOT RUN | Tidak ada URL staging | `docs/evidence/phase2-staging-access.txt` |
| 5 Smoke test sandbox | BLOCKED | Kredensial provider sandbox/akun uji tidak tersedia | `docs/evidence/phase2-staging-access.txt` |
| 6 Drill pemulihan | BLOCKED | Tidak ada DB/Redis terisolasi dan prosedur rollback migrasi | `docs/go-live-staging-requirements.md` section 8 |
| 7 Keamanan/observability runtime | BLOCKED | Tidak ada akses staging/runtime | `docs/evidence/phase2-staging-access.txt` |
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

- Staging deploy: BLOCKED
- `/healthz`, `/ready`, worker heartbeat staging: NOT RUN
- Smoke test register/login/deposit/bet/settle/cashout/withdraw/admin RBAC: BLOCKED
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
