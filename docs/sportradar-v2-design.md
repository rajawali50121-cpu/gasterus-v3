# FASE 0 — Desain Integrasi Sportradar v2 (read-only)

**Status:** rancangan, belum implementasi.  
**Basis kode:** `master` pada `bddb1301d49dce59bf48260951fa094ecc2c7e8e`.  
**Branch dokumen:** `design/sportradar-v2`.  
**Batas fase:** hanya dokumen ini; kode lama tidak diubah/dihapus.

## 1. Keputusan tetap

- Produk sportsbook **prematch saja**. Tidak memakai Odds Comparison Live Odds, feed in-play, push feed, live score UI, atau market live.
- **Odds Comparison Prematch v2** menjadi sumber jadwal, market, dan odds.
- **Soccer API v4** menjadi sumber hasil/status pertandingan untuk proses verifikasi hasil di fase terpisah.
- Penghubung event antarkedua produk adalah ID Sportradar `sr:sport_event`; simpan string URN utuh, jangan mengandalkan numeric suffix saja.
- Alur: provider → worker terpisah → Redis/DB → API internal read-only → frontend.
- Worker Odds dan Soccer terpisah; quota namespace terpisah; Soccer default **OFF**.
- Rolling quota 30 hari di Redis dan pembatas laju **1 request/detik per worker/product** sesuai keputusan proyek.
- Penerimaan taruhan tetap nonaktif. Tidak ada perubahan wallet, ledger, betting engine, settlement, atau migrasi.

## 2. Kontrak API resmi yang berhasil diverifikasi

Semua URL di bawah adalah dokumentasi resmi Sportradar. Request hanya dirancang; **tidak ada API provider yang dipanggil**. Gunakan HTTPS, GET, JSON, dan header `x-api-key` pada server saja. Jangan masukkan key ke URL/log/browser.

### 2.1 Odds Comparison Prematch v2

Base URL resmi:
```
https://api.sportradar.com/oddscomparison-prematch/{access_level}/v2/{language_code}
```
`access_level`: `trial` atau `production`; bahasa `en` paling lengkap; format JSON/XML. Autentikasi `x-api-key`.

| Feed | Bentuk endpoint resmi | Fungsi dan kontrak yang dapat dipastikan |
|---|---|---|
| Books | `GET /books.json` | Daftar bookmaker yang dikonfigurasi untuk key; ID bookmaker berbentuk `sr:book:{id}`; Prematch juga dapat memuat book `consensus`. |
| Sports | `GET /sports.json` | Daftar sport dan ID, mis. Soccer `sr:sport:1`; cache TTL 5 menit, rekomendasi refresh harian. |
| Sport Competitions | `GET /sports/{sport_id}/competitions.json` | Kompetisi dengan odds; field `markets` menyatakan ketersediaan prematch market; cache TTL 5 menit, rekomendasi harian. |
| Daily Schedules | `GET /sports/{sport_id}/schedules/{date}/schedules.json` | Jadwal event dengan odds pada sport/tanggal itu; parameter `start`, `limit` (maksimum 50 pada dokumentasi feed); query `live` tersedia untuk memilih live/non-live. Desain hanya meminta `live=false` bila parameter tersebut didukung endpoint yang dipanggil. TTL 1 detik; rekomendasi polling setiap jam atau lebih jarang pada tanggal yang dipantau. |
| Sport Event Markets | `GET /sport_events/{sport_event_id}/sport_event_markets.json` | Market untuk satu event; event ID, waktu mulai/status, market, bookmaker, outcome, odds, dan flag penghapusan. Query `live` tersedia; desain hanya menerima pasar prematch (`live=false`) dan menolak item `market.is_live=true`. TTL 1 detik; bookmaker prices diperbarui sekali per menit. |
| Sport Event Markets Change Log | `GET /sport_event_markets_changelog.json` | Perubahan odds event dalam jendela lima menit; `status.from` dan `status.to` adalah Unix timestamp; baris perubahan membawa event ID dan waktu perubahan. TTL 1 detik; rekomendasi poll 1–5 menit untuk event yang dipantau. |

**Struktur market/outcome terverifikasi pada Sport Event Markets:**
- `sport_event.id` memakai URN `sr:sport_event:…`; `sport_event.start_time`, `start_time_confirmed`, dan `status` tersedia.
- `market.id` memakai `sr:market:…`; `market.name` adalah nama market; `market.is_live` boolean.
- `market.book.id` memakai `sr:book:…`; `book.removed` menandai market bookmaker yang dihapus.
- `outcome.id` memakai `sr:outcome:…`; `field_id` mengidentifikasi tipe outcome; `type` menyatakan tipe taruhan; `handicap`, `spread`, `total` tersedia sesuai market.
- Harga yang didokumentasikan termasuk `odds_decimal`, `odds_american`, `odds_fraction`, serta nilai pembukaan `open_odds_*`; nilai odds dikirim sebagai string. `outcome.removed=true` berarti outcome dihapus.
- `external_market_id` dan `external_outcome_id` adalah ID eksternal bookmaker untuk deeplink; bukan pengganti ID internal Sportradar.

**Pagination dan error Odds:**
- List feed memakai header `X-Max-Results`, `X-Offset`, `X-Result`; jangan menganggap halaman pertama lengkap. Feed menerima `start` dan `limit` sesuai batas masing-masing endpoint.
- `403`: autentikasi gagal; dokumentasi menyebut body HTML, bukan JSON error.
- `429`: rate limit; hormati `Retry-After` bila ada dan lakukan backoff.
- `404`: path atau ID tidak dikenal.
- Timestamp feed adalah UTC ISO-8601; change-log memakai Unix timestamp.
- TTL adalah cache window, **bukan** instruksi untuk polling secepat TTL.

### 2.2 Soccer API v4 — hasil/status saja

Base URL resmi:
```
https://api.sportradar.com/soccer/{access_level}/v4/{language_code}
```
Autentikasi `x-api-key`; bahasa `en` dipakai pada desain. Soccer API v4 memiliki 52 feed; desain fase ini membatasi penggunaan ke feed yang diperlukan untuk hasil/status, bukan feed live.

| Feed | Bentuk endpoint resmi | Fungsi dan kontrak yang dapat dipastikan |
|---|---|---|
| Daily Summaries | `GET /schedules/{date}/summaries.json` | Informasi pertandingan harian termasuk skor tim dan statistik pertandingan; TTL/cache 300 detik. Ini feed utama rancangan untuk mengambil hasil/status pada tanggal yang telah dilacak sistem. |
| Sport Event Summary | `GET /sport_events/{sport_event_id}/summary.json` | Ringkasan satu pertandingan, skor/status dan statistik; TTL/cache 1 detik. Feed ini tidak menjadi polling rutin pada FASE 0 dan perlu justifikasi kuota sebelum dipakai. |
| Sport Events Updated | `GET /sport_events/updated.json` | ID event yang berubah dalam 24 jam terakhir; TTL/cache 60 detik. Kandidat mekanisme refresh selektif, tetapi pemakaian harus masuk perhitungan kuota. |

**Struktur hasil/status terverifikasi:**
- Ringkasan event membawa `sport_event.id`, `sport_event.start_time`, `sport_event_context`, dan `sport_event_status`.
- `sport_event_status.status` adalah status keseluruhan; `match_status` adalah substatus fase pertandingan. Skor yang didokumentasikan meliputi `home_score`, `away_score`, `winner_id`, dan skor per periode.
- Status keseluruhan yang disebut dokumentasi: `not_started`, `started`, `live`, `postponed`, `suspended`, `delayed`, `interrupted`, `cancelled`, `ended`, `closed`, `abandoned`.
- **Pembedaan penting:** `ended` berarti pertandingan selesai; `closed` berarti hasil telah dikonfirmasi. Jangan memetakan `ended` menjadi hasil final terverifikasi.
- `postponed` dapat memiliki `replaced_by` yang menunjuk ID event baru; ID baru tidak boleh digabung ke ID lama secara destruktif.
- Status dan ketersediaan data bergantung pada coverage kompetisi/event. Status yang tidak tersedia atau payload yang tidak lengkap harus masuk status review, bukan ditebak.

**Pagination dan error Soccer:**
- Dokumentasi umum Soccer menyatakan pagination digunakan oleh feed yang mendukungnya; parameter/limit harus diverifikasi per endpoint sebelum implementasi. Daily Summaries: penggunaan `start`/`limit` maksimum 200 tercantum pada integrasi #94 tetapi perlu dikonfirmasi lagi pada OpenAPI/endpoint reference saat FASE 1; untuk saat ini tandai sebagai kontrak endpoint yang belum tuntas.
- `403`: autentikasi gagal; dokumentasi Soccer menyebut body HTML.
- `429`: batas laju/kuota; hentikan request loop, gunakan backoff dan `Retry-After` bila tersedia.
- `404`: ID/path tidak dikenal pada pola API umum; validasi status spesifik endpoint sebelum memetakan respons.

### 2.3 Kuota, QPS, dan implikasi jadwal

Dokumentasi resmi Account Maintenance Soccer menyatakan:
- Setiap API key/produk memiliki rolling quota 30 hari dan QPS limit; nilai aktual per produk dapat dilihat di akun Sportradar.
- Rolling 30 hari mengeluarkan request yang berumur lebih dari 30 hari.
- Default trial yang didokumentasikan: **1.000 request / rolling 30 hari dan 1 QPS**.
- Melebihi QPS/kuota menghasilkan error; dokumentasi Odds/Soccer menyebut `429 Too Many Requests`.

**Batas bukti:** angka 1.000/30 hari dan 1 QPS adalah default trial terdokumentasi, bukan bukti bahwa akun GASTERUS memiliki entitlement/limit yang sama. Nilai aktual Odds dan Soccer wajib dimasukkan dari dashboard masing-masing produk sebelum worker diaktifkan.

**Benturan jadwal yang harus dihormati:** Change Log Prematch meliputi jendela lima menit. Poll tiap lima menit berarti 8.640 request per 30 hari untuk feed itu saja, jauh di atas default trial 1.000, belum termasuk jadwal dan market. Maka tidak boleh menyalakan polling 5 menit secara otomatis pada trial. Scheduler harus menghitung budget total, memprioritaskan panggilan, dan menolak konfigurasi yang tidak mungkin. Polling lebih jarang dari jendela change-log dapat melewatkan perubahan; rekonsiliasi penuh perlu direncanakan, bukan dianggap tertangani otomatis.

### 2.4 Sumber resmi yang dipakai

**Odds Comparison Prematch v2**
- API Basics: https://developer.sportradar.com/odds/docs/oc-ig-api-basics
- Prematch Overview/feed map: https://developer.sportradar.com/odds/reference/oc-prematch-overview
- Daily Schedules: https://developer.sportradar.com/odds/reference/oc-prematch-daily-schedules
- Sport Event Markets: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets
- Sport Event Markets Change Log: https://developer.sportradar.com/odds/reference/oc-prematch-sport-event-markets-change-log
- Update Frequencies: https://developer.sportradar.com/odds/docs/oc-ig-update-frequencies
- Monitoring Odds Changes: https://developer.sportradar.com/odds/docs/oc-ig-monitoring-odds-changes

**Soccer API v4**
- API Basics: https://developer.sportradar.com/soccer/docs/soccer-ig-api-basics
- Daily Summaries: https://developer.sportradar.com/soccer/reference/soccer-daily-summaries
- Sport Event Summary: https://developer.sportradar.com/soccer/reference/soccer-sport-event-summary
- Sport Events Updated: https://developer.sportradar.com/soccer/reference/soccer-sport-events-updated
- Match Status Workflow: https://developer.sportradar.com/soccer/docs/soccer-ig-match-status-workflow
- Account Maintenance / quota: https://developer.sportradar.com/soccer/docs/soccer-ig-account-maintenance
- v3→v4 migration and ID format: https://developer.sportradar.com/soccer/reference/soccer-v3-to-v4-migration-guide

## 3. Inventaris kode lama (read-only)

### 3.1 `master` — `backend/src/sportsbook-next/`

| File | Keputusan FASE 1 | Alasan singkat |
|---|---|---|
| `sportradar-client.js` | **Ambil pola, tulis ulang** | Header key, timeout, metadata/error logging berguna; client mencampur endpoint Odds dan Soccer sehingga batas produk harus dipisah. |
| `config.js` | **Jangan reuse langsung** | Satu config memuat dua base URL/konfigurasi Odds; kontrak baru butuh config dan credential/quota per produk. |
| `quota.js` | **Ambil pola Lua, desain ulang keyspace** | Atomic rolling ZSET/baseline dan QPS pacing berguna; namespace sekarang khusus `sportsbook:next` dan limiter 1.1s/shared tidak memenuhi isolasi worker. |
| `worker.js` | **Jangan reuse loop** | Loop discovery/change-log dan status saling terkait; `shutdownController` dideklarasikan di blok entrypoint tetapi dipakai fungsi `main`, sehingga scope lifecycle harus dirancang ulang. |
| `normalize.js` | **Audit fungsi per fungsi** | Normalisasi market/outcome berpotensi berguna, tetapi semua pemetaan ID/status/removed harus dicocokkan dengan kontrak resmi dan fixture. |
| `pagination.js` | **Ambil pola setelah verifikasi** | Pagination generik dapat dipakai bila menghormati header `X-*` dan batas tiap feed. |
| `change-log.js` | **Ambil ide, tulis ulang** | Konsep perubahan event berguna; window 5 menit dan gap recovery wajib mengikuti kontrak feed. |
| `market-catalog.js` | **Port selektif** | Katalog domain berguna; jangan bawa asumsi ID/market tanpa contract fixtures. |
| `repository.js` | **Jangan reuse write path** | Menulis tabel sportsbook saat ini; fase baru perlu repository/Redis writer terisolasi dan tidak boleh mengubah skema. |
| `public-feed.js` | **Reuse konsep read-only** | Pemisahan data publik dari provider cocok; endpoint baru harus hanya membaca snapshot/cache dan tidak memanggil provider. |
| `prematch-freshness-guard.js` | **Audit/port terpisah** | Guard freshness relevan bagi UI prematch; tidak boleh memblokir data berdasarkan asumsi TTL. |
| `redis.js`, `db.js` | **Reuse adapter setelah kontrak koneksi** | Koneksi infrastruktur dapat digunakan tanpa mengubah schema; lifecycle close harus dimiliki proses worker. |
| `results.js`, `results-repository.js`, `settlement-rules.js` | **Tidak dipakai oleh Odds worker** | Domain hasil/settlement dipisah dari ingest odds; jangan menyentuh settlement atau tabel hasil pada fase ini. |
| `halt.js`, `index.js` | **Audit integrasi saat fase implementasi** | Titik entrypoint/halt lama tidak boleh diam-diam mengaktifkan worker baru. |

### 3.2 Worker Soccer pada PR #94 (belum menjadi bagian master)

PR #94 `feat/soccer-v4-isolated-worker`, HEAD `87adf9e04477d2545d639341ba81877f2a8f3c17`, masih Draft dan bertumpuk di atas branch foundation #91; bukan kode master. Inventarisnya berdasarkan diff PR dan file branch #94:

| Area PR #94 | Keputusan FASE 1 | Alasan singkat |
|---|---|---|
| `soccer-v4-client.js` | **Ambil struktur request, validasi ulang** | Memakai `x-api-key`, timeout, 429 dan Daily Summaries; pagination/metadata perlu dikonfirmasi terhadap OpenAPI endpoint. |
| `soccer-v4-config.js` | **Ambil default OFF dan validasi quota** | Fail-closed dan satu request per cycle baik; fallback ke key Odds harus dihilangkan agar entitlement/kuota produk eksplisit. |
| `soccer-v4-quota.js` | **Ambil ide rolling guard, pisahkan limiter** | Namespace kuota Soccer independen sudah ada; helper QPS/cooldown diimpor dari Odds sehingga perlu dipisah sesuai keputusan dua worker. |
| `soccer-v4-worker.js` | **Ambil pola modul-scope signal, tulis ulang scheduler** | Controller signal di level modul sudah benar; jadwal tanggal/candidate dan persistence hasil harus ditinjau ulang di luar settlement scope. |
| `results.js`, `results-repository.js` | **Tidak dipindahkan ke FASE 0** | Berhubungan dengan result revision/projection dan tabel lama; tidak boleh menyentuh settlement/migrasi pada desain ini. |
| `soccer-v4-worker.test.js` | **Ambil ide kasus uji** | Kontrak, quota, pagination dan status tests berguna; tambah mock server nyata serta proses worker start/crash/restart/shutdown. |
| workflow dan Dockerfile | **Bukan bagian desain runtime baru** | CI/deploy artifact baru diputuskan hanya setelah modul baru lulus gerbang kualitas. |

**Catatan status Soccer:** PR #94 memakai `closed` sebagai status konfirmasi dan tidak menganggap `ended` final; ini sejalan dengan dokumentasi status resmi. Jangan menganggap `cancelled` sebagai hasil skor atau keputusan settlement otomatis.

## 4. Struktur target terpisah

Tidak dibuat pada FASE 0; ini kontrak struktur untuk fase implementasi berikutnya.

```
backend/src/sportradar-v2/
  shared/
    errors.js
    lifecycle.js
    redis-keys.js
    redis-lock.js
    provider-clock.js
  odds/
    config.js
    client.js
    contract.js
    normalize.js
    quota-guard.js
    redis-writer.js
    worker.js
  soccer/
    config.js
    client.js
    contract.js
    normalize.js
    quota-guard.js
    redis-writer.js
    worker.js
  api/
    read-service.js
    routes.js
```

- `odds/client.js` hanya host/path allowlist Odds Comparison Prematch v2; `soccer/client.js` hanya Soccer v4. Keduanya tidak boleh memiliki method lintas produk.
- Client mengirim GET dengan `x-api-key`, abort timeout, response body limit, parse JSON, dan metadata allowlist; key tidak pernah masuk log/error.
- `contract.js` memvalidasi fixture/response schema dan field wajib; unknown status/market tidak diubah menjadi nilai default yang seolah valid.
- Normalizer menyimpan raw provider payload terbatas untuk audit serta bentuk normalized versioned. Market/outcome IDs tetap URN penuh.
- Writer hanya menulis namespace Redis milik worker; DB persistence yang memerlukan schema/migration ditunda dan harus mendapat persetujuan fase terpisah.
- API internal hanya membaca Redis snapshot/DB read model; tidak boleh instantiate provider client, menjalankan quota reservation, atau memanggil provider.
- Frontend hanya menerima prematch feed; semua market `is_live=true` ditolak dari response yang disajikan.

## 5. Skema Redis yang diusulkan

Semua key memakai prefix versi baru `sr:v2:`; TTL harus eksplisit dan dapat dikonfigurasi. Ini rancangan key, bukan key yang sudah dibuat.

| Key pattern | Isi | Catatan |
|---|---|---|
| `sr:v2:odds:quota:calls` | ZSET request timestamp → UUID | Rolling 30 hari; satu produk Odds. |
| `sr:v2:odds:quota:baseline` | HASH `count`, `captured_at` | Baseline pemakaian provider saat worker mulai; wajib diverifikasi dashboard. |
| `sr:v2:soccer:quota:calls` | ZSET request timestamp → UUID | Rolling 30 hari; terpisah dari Odds. |
| `sr:v2:soccer:quota:baseline` | HASH `count`, `captured_at` | Baseline Soccer tersendiri. |
| `sr:v2:odds:qps:next` / `sr:v2:soccer:qps:next` | timestamp slot berikutnya | Limiter terpisah, maksimum 1 request/detik per worker/product. |
| `sr:v2:odds:qps:cooldown` / `sr:v2:soccer:qps:cooldown` | TTL cooldown | 429/Retry-After hanya mempengaruhi produk yang menerima 429. |
| `sr:v2:odds:lock` / `sr:v2:soccer:lock` | token UUID | `SET NX PX`; release compare-token Lua. |
| `sr:v2:odds:heartbeat` / `sr:v2:soccer:heartbeat` | timestamp + worker version | TTL pendek untuk mendeteksi worker mati. |
| `sr:v2:odds:status` / `sr:v2:soccer:status` | status siklus dan error code | Jangan menyimpan key/provider body sensitif. |
| `sr:v2:odds:events:{date}` | event schedule snapshot | Versioned JSON; `sr:sport_event` sebagai key identitas. |
| `sr:v2:odds:markets:{sport_event_id}` | normalized prematch market board | Tolak market live; simpan fetchedAt/provider timestamp. |
| `sr:v2:odds:changelog:cursor` | `from`/`to` sukses | Hanya majukan cursor setelah refresh dan persist selesai. |
| `sr:v2:soccer:results:{date}` | normalized daily summary | Hanya data event yang sudah dikenal/tracked; tidak impor katalog global. |
| `sr:v2:soccer:cursor:{date}` | offset halaman | Persist setelah batch berhasil; retry idempotent. |
| `sr:v2:read:prematch` | API read-model snapshot | Satu sumber baca frontend, tanpa akses provider. |

### Aturan quota guard

1. Validasi konfigurasi: limit aktual per produk, pemakaian aktual saat baseline diambil, reserve operasional, dan mode trial/production. Nilai kosong/tidak terkonfirmasi = worker gagal start tanpa request.
2. Sebelum setiap HTTP request, satu Lua script atomik: prune timestamp lebih tua dari 30 hari, hitung baseline + ZSET, periksa hard cap, periksa slot QPS/cooldown, lalu reserve UUID. Tidak ada jalur request yang melewati guard.
3. Request yang sudah di-reserve dihitung konservatif walaupun proses crash sebelum mendapat response; ini mencegah overspend saat status request tidak diketahui.
4. Baseline tidak boleh otomatis disetel ulang saat restart. Baseline baru hanya lewat prosedur operasional dengan nilai dashboard dan waktu capture yang terdokumentasi.
5. Pisahkan quota key, baseline, QPS, cooldown, metrics, dan konfigurasi Odds vs Soccer. Tidak ada shared counter.
6. Kuota adalah hard ceiling, bukan target pemakaian. Budget polling dihitung sebelum scheduler memilih feed; jika estimasi melebihi sisa budget, skip/freeze dengan alasan terukur.

## 6. Worker, lock, jadwal, dan shutdown

### Lifecycle wajib untuk masing-masing worker

- `stopping`, `shutdownController`, dan promise shutdown dideklarasikan pada **module scope**, bukan di dalam `if`/callback yang tidak terlihat oleh `main()`.
- Pasang handler `SIGTERM` dan `SIGINT` satu kali di level modul. Handler hanya menandai stopping dan abort signal; jangan memanggil process exit langsung.
- Startup berurutan: parse config → cek enabled (OFF berarti exit sukses tanpa Redis/provider) → connect Redis → acquire lock → load cursors/state → jalankan siklus → sleep abortable.
- Saat shutdown: hentikan scheduling, abort request/sleep yang sedang berjalan, tunggu siklus aktif selesai/timeout, simpan status yang aman, release lock compare-token, lalu close Redis/DB satu kali di `finally`.
- `main().catch(...).finally(...)` wajib menutup resource; kegagalan close tidak menutupi error awal. Tidak boleh ada loop/timer yang tetap hidup setelah shutdown.
- Lock `SET key token NX PX lease`; renewal hanya oleh pemegang token; release memakai Lua GET==token lalu DEL. Jika crash, lease kedaluwarsa; worker baru tidak boleh menganggap siklus sebelumnya sukses tanpa cursor/status persist.

### Scheduler Odds (prematch)

1. Books, Sports, dan Sport Competitions: refresh harian/cache-aware.
2. Daily Schedules: tanggal UTC yang dikonfigurasi; rekomendasi docs hourly atau lebih jarang pada tanggal yang dipantau; paginasi sampai lengkap.
3. Market board: hanya untuk event yang sudah tracked dan terpilih oleh budget. Gunakan Prematch Sport Event Markets, jangan panggil Live Odds.
4. Change Log: feed mengembalikan jendela 5 menit; docs menyarankan poll 1–5 menit untuk event yang dipantau. Jadwal ini hanya boleh aktif bila hitungan 30 hari + kebutuhan market/discovery muat di quota aktual. Pada trial default 1.000/30 hari, poll 5 menit tidak layak. Jangan diam-diam memperlambat lalu mengklaim tidak ada gap.
5. Jika ada gap lebih panjang dari jendela changelog, jalankan reconciliation terukur dari daftar event tracked; jangan menyatakan cursor lengkap bila belum direkonsiliasi.

### Scheduler Soccer

- Default OFF, tanpa Redis atau provider call saat OFF.
- Hanya event/tanggal yang telah dikenal oleh read-model Odds; jangan tarik katalog global.
- Daily Summaries sebagai feed utama; jadwal awal konservatif 60 menit pada PR #94 adalah keputusan implementasi lama, bukan aturan provider. Fase berikutnya harus menyesuaikan frekuensi dengan TTL 300 detik, kebutuhan verifikasi, dan kuota aktual.
- Soccer tidak mengonsumsi kuota Odds; satu worker gagal tidak boleh menghentikan worker lain.
- Jangan gunakan live summaries, timeline, push, atau polling in-play.

## 7. Gerbang kualitas sebelum FASE 1 dianggap siap

### A. Mock server resmi-kontrak (tanpa akses internet)

Bangun local HTTP mock server dari fixture yang diturunkan dari contoh/field dokumentasi resmi, bukan hasil API live. Mock harus memeriksa:
- Path, HTTP method, query parameter, header `x-api-key` (nilai dummy), format JSON, dan endpoint allowlist.
- Odds: books, sports, competitions, daily schedules, sport event markets, change log; pagination headers; removed book/outcome; prematch vs `is_live`.
- Soccer: Daily Summaries dengan `sport_event`, `sport_event_status`, skor/status; `ended`, `closed`, `cancelled`, `postponed` + `replaced_by`; coverage/payload tidak lengkap.
- Error fixtures: 403 HTML, 404, 429 + Retry-After, 5xx, timeout, invalid JSON, malformed/unknown field.
- Tidak ada fallback diam-diam untuk status/market/ID yang tidak dikenal.

### B. Tes proses nyata start → run → shutdown

Jalankan worker sebagai child process terpisah dengan endpoint mock dan Redis test terisolasi:
- Disabled: exit normal; nol koneksi Redis dan nol HTTP.
- Enabled: start, acquire lock, jalankan minimal satu cycle ke mock, tulis Redis snapshot, lalu kirim SIGTERM; proses exit dalam batas waktu dan menutup Redis.
- SIGINT diuji terpisah.
- Dua instance bersamaan: hanya satu pemegang lock; instance kedua tidak memanggil provider.
- Lock hanya bisa dilepas oleh token pemilik; lock crash pulih setelah lease TTL.

### C. Tes quota dan QPS

- Uji 30-day boundary: tepat 30 hari, lewat satu ms, baseline, ZSET, concurrent reserve, quota exhausted.
- Uji Odds dan Soccer saling independen; pemakaian satu produk tidak mengurangi counter produk lain.
- Uji QPS 1 request/detik, cooldown 429/Retry-After, retry tidak membanjiri mock.
- Pastikan request reserve hanya sekali per request; retry adalah request baru dan memakan quota baru.
- Pastikan konfigurasi limit nol/kosong/lebih tinggi dari entitlement tidak dapat menyalakan worker.

### D. Tes crash/restart tidak boros call

- Simulasikan crash sebelum request, setelah reserve, setelah provider response, setelah persist, dan sebelum cursor update.
- Reserve tanpa hasil dianggap terpakai (fail-closed); jangan mengulang request provider hanya karena proses restart.
- Persist snapshot secara idempotent dengan provider event ID + source timestamp/version; cursor hanya maju setelah persist sukses.
- Restart memulihkan cursor, last-success, status, lock lease dan quota ZSET; tidak mengulang halaman yang telah dipersist.
- Mock server menghitung total calls; assert batas maksimum calls untuk skenario crash/restart dan tidak ada double-call yang tidak perlu.

### E. Static/security checks

- Node syntax check seluruh modul baru; unit test contract/normalizer/quota.
- Tidak ada import dari worker lama yang menjalankan side effect saat import.
- Secret scan/log redaction; tidak ada API key di URL, error, metrics, fixture, atau client frontend.
- API read-only tidak punya route mutasi; tidak menyentuh wallet, ledger, betting, settlement, migration, atau database write lama.
- CI membuktikan semua gerbang di atas sebelum branch implementasi dapat dipertimbangkan.

## 8. TIDAK TERVERIFIKASI — jangan jadikan dasar desain

1. **Limit aktual akun GASTERUS** untuk Odds Comparison Prematch dan Soccer v4, termasuk quota dan QPS per produk — hanya dapat dipastikan dari dashboard/konfirmasi Sportradar.
2. **Entitlement/coverage akun** untuk kompetisi, bookmaker, event, dan apakah Soccer v4 sudah aktif pada key yang akan digunakan.
3. **Daily Summaries pagination maksimum 200**: tertulis pada implementasi/tes PR #94, tetapi belum dikonfirmasi ulang pada endpoint reference/OpenAPI yang dapat diakses saat riset ini.
4. **Header `Last-Modified` sebagai pengganti `generated_at`**: bukan bukti waktu generasi payload yang ekuivalen; jangan gunakan sebagai provider-generated timestamp tanpa kontrak eksplisit.
5. **Root JSON wrapper dan semua optional/nullability edge cases** pada tiap feed: field/parent paths didokumentasikan, tetapi tidak seluruh contoh payload lengkap berhasil diambil. Kontrak final fixture wajib dicocokkan ke OpenAPI/XSD resmi.
6. **Mapping settlement untuk `cancelled`, `abandoned`, `postponed`, `suspended`, atau `decided_by_fed`**: status provider terverifikasi, tetapi aturan settlement bisnis GASTERUS tidak ditentukan oleh dokumentasi API dan di luar FASE 0.
7. **Kesamaan numeric suffix antarproduk untuk seluruh kasus event replacement**: gunakan URN `sr:sport_event` apa adanya; jangan menyimpulkan relasi selain field `replaced_by`/mapping resmi.
8. **Polling optimal yang muat di kuota**: belum dapat diputuskan sebelum limit aktual, jumlah sport/event tracked, dan call budget harian tersedia.
9. **Status `live=false` pada setiap feed selain endpoint yang parameternya terdokumentasi eksplisit**: jangan menambahkan query param berdasarkan asumsi. Filter hasil berdasarkan `market.is_live` juga.
10. **Kode HTTP/error tambahan per endpoint** di luar 403/404/429 dan status HTTP umum: perlu dicocokkan dengan Response Codes/OpenAPI saat implementasi.

## 9. Urutan fase berikutnya

1. **FASE 1 — contract freeze:** ambil OpenAPI/XSD resmi Odds Prematch v2 dan Soccer v4; lengkapi payload JSON fixture, query/pagination/error per endpoint; tandai semua ketidakpastian di atas.
2. **FASE 2 — mock + domain core:** buat mock server, client terpisah, schema validators, normalizer, quota guard Redis dan tes tanpa provider live.
3. **FASE 3 — worker isolated:** implementasi worker Odds dan Soccer terpisah dengan lifecycle/lock/shutdown, writer Redis, crash/restart tests; Soccer tetap OFF.
4. **FASE 4 — read-only API:** expose snapshot Redis ke API internal; validasi frontend hanya menampilkan prematch dan tidak ada jalur penerimaan taruhan.
5. **FASE 5 — entitlement & quota gate:** verifikasi dashboard key/coverage/kuota aktual dan susun budget polling sebelum ada konfigurasi enablement.
6. Setiap fase implementasi memakai branch/PR terpisah dan review; tidak ada merge, deployment, Railway, migrasi, provider live call, atau aktivasi taruhan tanpa instruksi eksplisit berikutnya.

---
**FASE 0 deliverable:** dokumen desain ini saja. Tidak ada source code lama yang diubah, tidak ada provider API yang dipanggil, dan tidak ada perubahan produksi.
