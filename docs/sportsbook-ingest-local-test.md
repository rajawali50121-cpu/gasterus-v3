# Verifikasi lokal Sportsbook ingest

Endpoint ingest worker adalah `POST /api/internal/sportsbook/ingest`. Endpoint ini
memverifikasi HMAC-SHA256 atas `timestamp + "." + rawBody`, menolak timestamp kedaluwarsa,
memeriksa ukuran dan skema snapshot, lalu menyimpan snapshot tervalidasi ke Redis staging.
Feed backend membaca snapshot staging dan memproyeksikan status pertandingan ke PostgreSQL.

## Prasyarat

1. Siapkan `backend/.env` dengan kredensial development untuk PostgreSQL dan Redis, serta
   `SPORTSBOOK_INGEST_HMAC_SECRET` yang sama dengan worker (minimal 32 karakter).
2. Jalankan migrasi database dan pastikan Redis tersedia:

   ```sh
   npm run migrate
   ```

3. Jalankan backend di terminal pertama:

   ```sh
   npm run start
   ```

## Kirim snapshot uji

Di terminal kedua, script memakai HMAC helper yang sama dengan worker, mengirim satu
request valid ke loopback, dan memastikan request dengan body yang diubah ditolak:

```sh
npm run test:sportsbook:ingest
```

Secara default target adalah `http://127.0.0.1:8080/api/internal/sportsbook/ingest`.
Jika backend mendengarkan pada URL loopback lain, atur `SPORTSBOOK_INGEST_URL`; script
menolak host non-loopback dan path selain endpoint internal ingest. `SPORTSBOOK_INGEST_URL`
dan `SPORTSBOOK_INGEST_HMAC_SECRET` dapat dibaca dari `backend/.env`.

## Verifikasi batch PostgreSQL

Untuk memeriksa penulisan batch nyata ke tabel `sportsbook_event_states`, jalankan:

```sh
npm run test:sportsbook:ingest -- --verify-db
```

Mode ini memakai `DATABASE_URL` yang harus menunjuk ke host loopback, menjalankan writer
batch aktual untuk fixture terjadwal dan live, memeriksa baris yang ditulis, lalu menghapus
baris uji. Pastikan migrasi `044_sportsbook_event_states.sql` sudah diterapkan. Endpoint
HTTP sendiri hanya menyimpan snapshot staging di Redis; penulisan PostgreSQL normal terjadi
saat refresh feed berikutnya.

Tes validasi tanpa menjalankan server tersedia melalui:

```sh
node --test backend/tests/sportsbook-ingestion.test.js backend/tests/sportsbook-event-state.test.js
```
