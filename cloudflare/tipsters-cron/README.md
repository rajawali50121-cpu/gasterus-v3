# tipsters-cron — Cloudflare Workers Cache untuk RapidAPI Tipsters

## Tujuan
Worker ini adalah **satu-satunya tempat yang memanggil RapidAPI** (odds-feed.p.rapidapi.com).
Backend Railway **TIDAK PERNAH** memanggil RapidAPI langsung; backend membaca event,
market, dan hasil melalui endpoint `fetch()` worker ini yang dibekalkan dari KV.

## File
- `worker.js` — logika cron A/B + endpoint fetch()
- `wrangler.toml` — konfigurasi Worker, binding KV `TIPSTERS_CACHE`, dan trigger cron

## Setup (melalui dashboard Cloudflare, tidak deploy dari CLI ini)
1. Buat KV namespace bernama `TIPSTERS_CACHE` di dashboard Workers & Pages → KV.
2. Salin `Namespace ID` ke `wrangler.toml` (ganti placeholder `[[kv_namespaces]].id`).
3. Upload worker (`worker.js` + `wrangler.toml`) melalui dashboard atau `wrangler deploy`.
4. Set secret worker (jangan pernah menulis nilai dalam kode/repo):
   - `RAPIDAPI_ODDS_KEY` — kunci RapidAPI tipsters
   - `TIPSTERS_CACHE_TOKEN` — token otentikasi endpoint `fetch()` worker ini
   Contoh CLI: `wrangler secret put RAPIDAPI_ODDS_KEY` dan `wrangler secret put TIPSTERS_CACHE_TOKEN`.
5. Pastikan trigger cron aktif:
   - Cron A `0 0,12 * * *` (07.00 dan 19.00 WIB): daftar event + market lengkap.
   - Cron B `0 21 * * *` (04.00 WIB): hasil pertandingan FINISHED 2 hari terakhir.

## Variabel lingkungan (nama saja, nilainya diisi Railway/Cloudflare)
- Worker secret: `RAPIDAPI_ODDS_KEY`, `TIPSTERS_CACHE_TOKEN`
- wrangler vars: `RAPIDAPI_ODDS_MARKET_EVENTS` (default 3)
- Railway backend env: `RAPIDAPI_ODDS_CACHE_URL`, `RAPIDAPI_ODDS_CACHE_TOKEN`,
  `RAPIDAPI_ODDS_DAYS_AHEAD` (default 3)

## Endpoint fetch() (diakses Backend Railway)
Semua butuh header `Authorization: Bearer <TIPSTERS_CACHE_TOKEN>`, tanpa itu `401`:
- `GET /events` — daftar event mentah dari RapidAPI (disimpan teks mentah ke KV)
- `GET /markets?event_id=<id>` — semua market satu event (1 request per event)
- `GET /results` — hasil pertandingan FINISHED (untuk settlement)

## Pagar kuota RapidAPI
- Cron A berhenti jika `x-ratelimit-requests-remaining < 60` atau request hari ini (UTC) >= 12.
- Cron B berjalan selama `remaining > 0`.
- Respons bukan 2xx **tidak menimpa cache lama**.
- Tersimpan: `fetchedAt` dan `remaining` tiap siklus.

## Estimasi request per hari
Cron A (x2): 1 events + MARKET_EVENTS market = 1 + 3 = 4 per kali → 8/hari
Cron B: 1 results → 1/hari
Total = 9 request/hari (<= 10). Default MARKET_EVENTS = 3.
