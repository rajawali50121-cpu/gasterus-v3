# Verifikasi otomatis go-live

Tanggal: 2026-10-25
Branch: `release/go-live-20261025`
Commit: `7181a47` (chore: go-live readiness fixes)

## Hasil pemeriksaan teknis

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Install root | `npm ci` | lulus, 0 vulnerability |
| Install backend | `npm ci --prefix backend` | lulus, 0 vulnerability |
| Unit test | `npm test` | 542 pass, 1 skip, 0 fail |
| Syntax/CSS/asset | `npm run check` | lulus (94 file, 14 CSS, cache-busting OK) |
| Build backend image | `docker build -f deploy/Dockerfile` | lulus |
| Build worker image | `docker build -f deploy/Dockerfile.sportsbook-render-worker` | lulus |

## Catatan
- Migrasi path sekarang berbasis lokasi file, bukan `process.cwd()`, agar berjalan dari direktori mana pun.
- `SPORTMONKS_ENABLED` worker mengikuti secret backend (`${{gasterus-v3.SPORTMONKS_ENABLED}}`), backend tetap default `true`.
- Cache-busting `register.html` diperbarui ke `20261019-r2`.
- Default berisiko tinggi tetap tidak diubah:
  - `TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED=false`
  - `SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED=false`

## Butir yang masih memerlukan bukti operasional
Lihat `docs/production-go-live-checklist.md`. Pemeriksaan otomatis ini tidak membuktikan
legal, payment prod, backup/restore, monitoring, on-call, incident response, KYC,
support, smoke test prod, maupun rollback test.
