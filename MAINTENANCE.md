# 🗺️ MAINTENANCE GUIDE — gasterus-v3

> **Baca dokumen ini PERTAMA sebelum menyentuh CSS atau HTML apapun.**
> Tujuan: Mencegah duplikasi, konflik, dan patch berulang yang membuang token.
>
> Untuk CSS/HTML ikuti alur di bawah. Untuk env, batas memori, dan anti-OOM
> backend, lihat bagian **⚙️ ENV RUNTIME, MEMORI & ANTI-OOM** di akhir dokumen.

---

## 📐 WORKFLOW WAJIB (2-Agent System)

`
CLAUDE (Analyst)                    CLINE (Executor)
──────────────────                  ────────────────
1. Baca MAINTENANCE.md         →    Tunggu instruksi
2. Lihat screenshot target     →
3. Audit: cari selector exist  →
4. Buat laporan per-element    →    Terima laporan
5. Tentukan: MODIFY / REMOVE   →    FIND → MODIFY → VERIFY
`

**Format laporan Claude ke Cline:**
`
ELEMENT          : [nama elemen]
CSS FILE         : [nama file CSS]
EXISTING SELECTOR: [selector exact, + line number jika bisa]
CURRENT STYLE    : [property yang ada sekarang]
TARGET STYLE     : [property yang harus ada]
CSS TO CHANGE    : [property: value baru]
CSS TO REMOVE    : [property yang dihapus]
CSS TO PRESERVE  : [property yang TIDAK boleh disentuh]
CSS FILE STATUS  : LOADED / NOT LINKED (+ posisi link jika NOT LINKED)
ASSET STATUS     : NOT NEEDED / EXISTS (path) / NEEDS PLACEHOLDER
`

### ❌ DILARANG KERAS
| Larangan | Alasan |
|----------|--------|
| Append CSS class baru tanpa grep dulu | Menyebabkan duplikat |
| Append section HTML tanpa baca file dulu | Nav-drawer/footer muncul 2x |
| Membuat fix_xxx2.py, fix_xxx3.py | Sudah ada 21 script fix menumpuk |
| Overwrite seluruh file tanpa diff | Kehilangan patch sebelumnya |
| Menambah !important | Menyembunyikan konflik, sulit di-debug |

---

## 🗂️ PETA CSS — File & Tanggung Jawab

### Dua Strategy CSS yang Dipakai (JANGAN dicampur per halaman!)

#### Strategy A — "Mobile Blue Stack" (all-in-one)
File tunggal: css/mobile-blue.css
Halaman yang pakai: index, member, deposit, register, 404

#### Strategy B — "Modular Stack"
File terpisah berurutan:
1. /css/tokens.css       <- CSS variables (--bg-app, --brand-primary, dll)
2. /css/base.css         <- Reset, typography dasar
3. /css/layout.css       <- Header, footer, nav-drawer, grid
4. /css/components.css   <- .btn, .badge, .table, dll
5. /css/animations.css   <- Keyframes, transitions
6. /css/mobile.css       <- Responsive overrides
7. /css/pages/[page].css <- Hanya style spesifik halaman itu
Halaman yang pakai: withdraw, bet-history, market-play, promotion, referral, rules, terms, privacy, responsible-play, number-history

---

## 📋 STATUS CSS PER HALAMAN

| Halaman | Strategy | tokens.css | Status |
|---------|----------|-----------|--------|
| index.html | A (mobile-blue) | Built-in | OK |
| member.html | A (mobile-blue) | Built-in | OK |
| deposit.html | A (mobile-blue) | Built-in | OK |
| register.html | A (mobile-blue) | Built-in | OK |
| 404.html | A (mobile-blue) | Built-in | OK |
| withdraw.html | B (modular) | TIDAK DI-LINK | Perlu ditambah |
| bet-history.html | B (modular) | TIDAK DI-LINK | Perlu ditambah |
| market-play.html | B (modular) | TIDAK DI-LINK | Perlu ditambah |
| promotion.html | B (modular) | TIDAK DI-LINK | Perlu ditambah |
| number-history.html | B (modular) | TIDAK DI-LINK | Perlu ditambah |
| referral.html | B (modular) | Di-link | OK |
| rules.html | B (modular) | Di-link | OK |
| terms.html | B (modular) | Di-link | OK |
| privacy.html | B (modular) | Di-link | OK |
| responsible-play.html | B (modular) | Di-link | OK |
| sportsbook.html | C (hanya sportsbook.css) | TIDAK ADA | KRITIS — tampilan rusak |

---

## ⚠️ KONFLIK CSS YANG DIKETAHUI

### Duplikat DALAM satu file (belum dibersihkan)

mobile-blue.css — 19 class duplikat:
| Class | Jumlah | Prioritas |
|-------|--------|-----------|
| .qris-white-card | 8x | DARURAT |
| .deposit-row | 6x | DARURAT |
| .res-search | 4x | Tinggi |
| .deposit-note-box, .site-footer, .footer-social, .inp-wrap, .cs-info, .reg-phone-wrap, .reg-checkbox, .table | 3x | Tinggi |
| 11 class lain | 2x | Sedang |

sportsbook.css — 8 class duplikat:
| Class | Jumlah |
|-------|--------|
| .sb-nav | 4x |
| .sb-slip-stake | 3x |
| .sb-search, .sb-stale-banner, .sb-error, .sb-slip-pick, .sb-slip-row, .sb-quote-ok | 2x masing-masing |

layout.css — 4 class duplikat:
| Class | Jumlah |
|-------|--------|
| .footer-col | 4x |
| .app-header, .brand-logo, .balance-pill | 2x masing-masing |

### Konflik ANTAR file (class di 2+ file)

| Class | Ada di | Authority |
|-------|--------|-----------|
| .menu-toggle, .nav-drawer, .nav-drawer-* | mobile-blue.css vs layout.css | layout.css |
| .btn, .btn-primary, .btn-secondary, .btn-sm, .btn-block | mobile-blue.css vs components.css | components.css |
| .badge, .badge-* | mobile-blue.css vs components.css | components.css |
| .table, .table-responsive | mobile-blue.css vs components.css | components.css |
| .bank-card | mobile-blue.css vs home.css | Perlu investigasi |
| .member-market-card, .member-market-grid | mobile-blue.css vs member.css | member.css |

---

## 🔍 QUICK AUDIT COMMANDS

# Cari apakah class sudah ada SEBELUM menambah:
Select-String -Path frontend/css/mobile-blue.css -Pattern "\.nama-class" | Select LineNumber, Line

# Cek class muncul di CSS mana saja:
Select-String -Path frontend/css/*.css,frontend/css/pages/*.css -Pattern "^\.nama-class[\s{]"

# Cek duplikat dalam satu file:
Select-String -Path frontend/css/mobile-blue.css -Pattern "^\.[a-z]" | Group-Object { (.Line -split "\s")[0] } | Where-Object Count -gt 1 | Sort-Object Count -Descending

# Lihat perubahan vs git HEAD:
git diff --stat HEAD

---

## 🛠️ ISSUE TRACKER

### BELUM DIKERJAKAN — Darurat (lakukan segera)
- [x] Fix sportsbook.html: Tambah tokens.css sebelum sportsbook.css
- [x] Bersihkan duplikat mobile-blue.css: .qris-white-card, .deposit-tab-item, .preset-pill-btn, .btn-qris-submit (Consolidated cleanly)

### BELUM DIKERJAKAN — Tinggi
- [ ] Bersihkan semua duplikat sportsbook.css (8 class)
- [ ] Bersihkan duplikat layout.css (4 class)
- [ ] Resolve konflik nav-drawer: layout.css sebagai authority, hapus dari mobile-blue.css

### BELUM DIKERJAKAN — Sedang
- [ ] Tambah tokens.css ke: withdraw, bet-history, market-play, promotion, number-history
- [ ] Resolve konflik .btn, .badge, .table: components.css sebagai authority
- [ ] Hapus file null di root project
- [ ] Arsipkan scripts/fix_*.py ke scripts/archive/

### SUDAH DIKERJAKAN
- [x] Audit awal — identifikasi semua masalah (09 Sep 2026)
- [x] Buat MAINTENANCE.md ini (09 Sep 2026)

---

## 📁 STRUKTUR FILE CSS

frontend/css/
|-- tokens.css          <- CSS Variables global (--brand-*, --bg-*, --text-*)
|-- base.css            <- Reset, body, typography dasar
|-- layout.css          <- app-header, nav-drawer, site-footer, grid
|-- components.css      <- btn, badge, table, card, form elements
|-- animations.css      <- @keyframes, transition utilities
|-- mobile.css          <- Responsive breakpoints
|-- mobile-blue.css     <- ALL-IN-ONE untuk halaman Strategy A
|-- home.css            <- Hanya untuk index.html (jika terpisah)
|-- member.css          <- Hanya untuk member.html (jika terpisah)
|-- pages/
    |-- sportsbook.css  <- Hanya untuk sportsbook.html
    |-- transaction.css <- Hanya untuk withdraw.html
    |-- market-play.css <- Hanya untuk market-play.html

---

## ⚙️ ENV RUNTIME, MEMORI & ANTI-OOM

Dokumen ini juga menjadi panduan operasi backend, bukan hanya CSS.

### Batas memori per proses (`deploy/launcher.js`)
Setiap service punya ceiling heap sendiri supaya OOM killer tidak menjatuhkan
seluruh container sekaligus:

| Env | Default | Service |
|-----|---------|---------|
| `GATEWAY_HEAP_MB` | 48 | gateway |
| `CORE_HEAP_MB` | 256 | core |
| `WORKER_HEAP_MB` | 384 | worker (settlement) |
| `FEED_WORKER_HEAP_MB` | 256 | feed-worker (collector TOTO + feed) |
| `MEMBER_HEAP_MB` | 128 | member |
| `ADMIN_HEAP_MB` | 64 | admin |
| `SCRIPT_HEAP_MB` | 128 | script lain |

### Batas tree RSS (otomatis — tidak perlu set env)
`backend/src/memory-guard.js` me-recycle sebuah service bila **heap V8** ATAU
**RSS total proses** (diri sendiri + proses anak terdaftar, mis. Chromium)
melewati batas, 3x berturut-turut, lalu `exit(0)` halus supaya launcher
me-restart hanya service itu — bukan seluruh container.

Batas RSS **diturunkan otomatis** dari limit memori container yang dibaca dari
cgroup (`memory.max` v2 / `memory.limit_in_bytes` v1), yaitu **75%** dari limit
tersebut dengan lantai 256MB. Jadi guard otomatis benar pada semua ukuran plan
Railway **tanpa konfigurasi env**. Yang terjadi saat start, terbaca di log:

```
memory-guard[feed-worker] heap 256MB | tree RSS 1536MB (sumber: cgroup:2048MB) | jendela 3x60s
```

- Tidak terdeteksi (mis. bukan container/cgroup) → jatuh ke default **900MB**.
- `TREE_RSS_LIMIT_MB` **hanya sebagai override** bila Anda memang ingin
  memaksa angka tertentu. Kosongkan saja kalau tidak perlu.
- Cara memantau: `/internal/monitoring` → `memory.rssBytes`,
  `memory.childRssBytes`, `memory.childCount`, plus log
  `memory-guard[<label>] heap … | tree … | child …`.

### `SPORTS_SOURCE_BROWSER_EXECUTABLE`
Override path binary browser untuk `backend/src/sportsbook-browser-renderer.js`
(DevTools/CDP). Urutan pencarian:
1. argumen eksplisit → 2. `SPORTS_SOURCE_BROWSER_EXECUTABLE` → 3. Windows
   (`CHROME_PATH`/path default) → 4. `/usr/bin/chromium`,
   `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`,
   `/usr/bin/google-chrome-stable`.

⚠️ **Jebakan Ubuntu 24.04:** paket `chromium` dari apt hanya *stub snap*
("System doesn't have a working snapd") dan tidak bisa dipakai di container.
Karena `/usr/bin/chromium-browser` diperiksa **sebelum** `google-chrome`, stub
rusak itu akan dipilih lebih dulu sehingga rendering gagal. Buang stub-nya
(`apt-get remove chromium-browser`) lalu pasang Google Chrome stable, atau set
`SPORTS_SOURCE_BROWSER_EXECUTABLE` ke binary yang benar. (Image produksi
`deploy/Dockerfile` sudah memasang Chromium, jadi ini hanya relevan untuk mesin
dev/CI.)

### Kontrol jumlah spawn Chromium
- `TOTO_BROWSER_FALLBACK_MAX_SOURCES` — default **0** (fallback browser TOTO mati).
- `TOTO_OFFICIAL_BROWSER_FALLBACK_MAX_SOURCES` — default **2**.

Naikkan hanya kalau result sering `SINGLE_SOURCE`; tiap kenaikan berarti lebih
banyak spawn Chromium sehingga RSS naik. Sportsbook feed sendiri API-only dan
tidak memakai Chromium. Membuka banyak halaman TOTO sekaligus akan menumpuk
memori — browser fallback hanya jalur cadangan.

### State TOTO persisten di Redis
Kalibrasi jam result dan status libur per pasar disimpan di key
`toto:runtime:state:v1` (TTL 7 hari), dimuat ulang saat start
(`loadTotoRuntimeState`) dan ditulis tiap siklus poll (`persistTotoRuntimeState`).
Kalau key hilang, pasar kembali memakai jadwal operator konservatif sampai
terkalibrasi lagi — itu aman (pasar selalu menutup lebih awal), bukan rusak.

### Mematikan service tertentu
`WORKER_ENABLED=false` atau `FEED_WORKER_ENABLED=false` untuk mematikan service
tertentu, berguna saat menelusuri masalah memori.

---

## ⚽ SCRAPER SPORTSBOOK DI RAILWAY (Odds Real, Anti-OOM)

Scrape odds dijalankan sebagai **service Railway terpisah**
(`.railway/railway.ts` → `sportsbook-render-worker`, image
`deploy/Dockerfile.sportsbook-render-worker`) — beban scrape tidak pernah
menyentuh memori service backend `gasterus-v3`. Pengaman memori worker:

- **Heap V8 dikunci 224MB** (`NODE_OPTIONS=--max-old-space-size=224`) di bawah
  ukuran container (~512MB); V8 GC agresif jauh sebelum OOM.
- **Cakupan odds berlisensi** diproses berurutan: Sportmonks, SharpAPI, lalu
  The Odds API. Sportmonks dan SharpAPI hanya aktif bila key dan flag enable dari
  service backend tersedia; keduanya dapat menambah fixture dan market asli.
- **EPL dan La Liga** mengambil market `h2h,spreads,totals` (1X2,
  handicap, over/under) di region `eu` setiap 840 detik.
- **Market per-event dimatikan** (`THE_ODDS_API_EVENT_MARKETS_ENABLED=false`,
  alokasi 0) — tanpa fetch tambahan.
- Event detail tetap menampilkan semua market provider yang masuk snapshot,
  maksimum 24 market dan 40 selection per market. Market utama FT diprioritaskan;
  market terlalu besar dibuang utuh, tidak dipotong menjadi odds yang menyesatkan.
- Cache detail odds per-event dibatasi 100 entri / 2MB total, tiap respons
  maksimum 512KB; cache feed dibatasi 500 event / 8MB, TTL Redis minimal 180 dtk.
  Snapshot ingestion worker tetap dibatasi 500 event / 6MB per push.
- Cache detail UI dibatasi 60 event per tab dan dibuang saat feed revision atau
  halaman berubah. Browser mengambil REST satu kali sebagai bootstrap/fallback;
  pembaruan reguler menggunakan SSE, bukan polling REST berulang.
- Secret & URL diwariskan dari service backend `gasterus-v3`
  (`${{gasterus-v3.*}}`) — tidak diduplikasi. Atur `SPORTMONKS_API_KEY`,
  `THE_ODDS_API_KEY`, `THE_ODDS_API_KEY_2`, dan `THE_ODDS_API_KEYS` hanya pada
  service backend; worker memakai nilai service tersebut agar tidak tertahan
  pada secret worker lama.
- **Railway** (`gasterus-v3`) hanya menerima snapshot di
  `/api/internal/sportsbook/ingest` (HMAC + jendela timestamp + cap payload),
  menyimpannya ke Redis. Bila sumber gagal, cache yang masih layak hanya
  disajikan read-only; tanpa cache feed mengembalikan error eksplisit dan tidak
  membuat fixture atau harga odds sintetis. Feed cache namespace juga dinaikkan
  agar cache lawas yang mungkin berisi fixture buatan tidak dimuat ulang.

- **Worker** (`backend/src/sportsbook-render-worker.js`) mengambil fixture dan
  odds asli dari provider yang aktif (bukan data dummy), membangun snapshot
  ≤500 event lalu mengirim HMAC-signed ke `gasterus-v3` setiap 90 detik
  (`SPORTSBOOK_INGEST_MAX_AGE_SECONDS=180`).
- **Anggaran kuota** (biaya = jumlah sport × ceil(86400/refresh) × markets ×
  regions kredit/hari): 2 liga × 840 detik × 3 market × `eu` = **618
  kredit/hari**, di bawah batas Professional (667/hari). Menambah
  sport/market atau menyalakan endpoint event-market dapat melebihi kuota —
  event-market tidak diaktifkan tanpa persetujuan batas kuota. Batas ini dijaga test
  `backend/tests/sportsbook-render-deployment.test.js`.
- Sportmonks/SharpAPI memakai paket dan kuota masing-masing; penambahan source
  tidak menambah permintaan/kredit The Odds API. Pastikan key dan flag provider
  memang tersedia/diizinkan sebelum mengaktifkan, dan pantau kuota provider
  masing-masing. Worker hanya menerima source yang dikenal oleh validator ingest.
- **Kesegaran harga**: cadence refresh (840 s) harus di bawah
  `SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS` (900 s) supaya taruhan prematch
  tidak pernah ditolak `SPORTS_PRICE_STALE`. Market live yang harganya lebih
  tua dari `SPORTSBOOK_MAX_LIVE_PRICE_AGE_SECONDS` (90 s) otomatis di-suspend
  fail-closed oleh feed.
- **Guard kuota harian (429)**: saat The Odds API membalas 429, worker
  menyajikan payload terakhir per sport (stale) dan menahan retry 30 menit
  (`ODDS_API_QUOTA_BACKOFF_SECONDS`) — feed ke Railway tetap hidup tanpa
  membanjiri provider. Harga menua tetap ditutup jendela freshness di atas;
  ini murni ketersediaan feed. Dijaga test `sportsbook-odds-api-quota.test.js`.

---

## 📝 LOG PERUBAHAN

| Tanggal | File | Perubahan | Oleh |
|---------|------|-----------|------|
| 09 Sep 2026 | Semua 21 file | +3113/-525 baris belum di-commit | Cline |
| 09 Sep 2026 | MAINTENANCE.md | Dibuat pertama kali | Claude/Antigravity |
| 10 Okt 2026 | MAINTENANCE.md | Tambah bagian "ENV RUNTIME, MEMORI & ANTI-OOM" (`TREE_RSS_LIMIT_MB`, `SPORTS_SOURCE_BROWSER_EXECUTABLE`, kontrol spawn Chromium, state Redis TOTO) | Cline |
| 10 Okt 2026 | memory-guard.js | Batas tree RSS otomatis dari cgroup (75% limit container) — env jadi opsional | Cline |
| 16 Okt 2026 | .railway/railway.ts + sportsbook-render-worker* + MAINTENANCE.md | Scraper odds The Odds API sebagai service Railway terpisah (heap 224MB, 5 liga); Redis `--maxmemory` 128MB dipulihkan; guard kuota 429 + test topologi deploy | Cline |
| 18 Okt 2026 | sportsbook-providers.js + sportsbook-render-worker* + .railway/railway.ts | Pagination Sportmonks round-robin per tanggal (maks 120 halaman/refresh, berhenti awal saat 600 kandidat) — snapshot ingest tidak lagi terpotong ~17 match; `maxPages` kini diteruskan dari `SPORTSBOOK_RENDER_MAX_PAGES`; batas OOM 4MB/12MB tidak berubah | Cline |
| 18 Okt 2026 | sportsbook-providers.js + sportsbook-render-worker-core.js + sportsbook-ingestion.js + sportsbook-feed.js + verify-sportsbook-e2e.mjs | Filter penyembunyian fixture aktif dibuang (`has_odds === false` / `markets kosong` tidak lagi membuang match) — semua pertandingan pre-match & live ikut snapshot (display-only bila tanpa odds); skema ingest menerima `markets: []`; prioritas dedupe memilih salinan berharga; worker memangkas payload deterministik ke anggaran ingest (6MB) alih-alih gagal 413 diam-diam; halaman default `/api/member/sportsbook/events` naik 30→500 agar curl server melihat katalog penuh; E2E guard 300+ match | Cline |
| 19 Okt 2026 | sportsbook-feed.js + sportsbook-providers.js + sportsbook.js | Feed katalog diselaraskan ke 500 event / 8MB, detail event mempertahankan variasi market yang sudah diterima dengan batas 24×40, cache detail provider/UI dibatasi byte/jumlah/TTL, dan sizing cache feed dibuat linear agar pembatasan tidak membuat lonjakan serialisasi berulang | Copilot |

---
Update dokumen ini setiap kali ada perubahan signifikan pada CSS/HTML structure.
