# Operasional sportsbook-render-worker di Koyeb

Panduan ini untuk service `sportsbook-render-worker` yang didefinisikan di
[`koyeb.yaml`](../koyeb.yaml). Worker berjalan sebagai proses background dan
mengirim snapshot ke endpoint ingest backend; worker tidak menyediakan HTTP
health endpoint sendiri.

## Health check dan log

1. **Dashboard:** buka aplikasi `gasterus-sportsbook` di Koyeb, pilih service
   `sportsbook-render-worker`, lalu periksa status deployment/instance dan
   tab **Logs**. Gunakan log langsung (live/tail) saat investigasi.
2. **CLI:** autentikasi Koyeb CLI dan pilih konteks yang benar. Lihat sintaks
   yang didukung versi CLI terpasang, lalu ikuti log service:

   ```sh
   koyeb service logs --help
   koyeb service logs gasterus-sportsbook/sportsbook-render-worker --follow
   ```

   Jika CLI meminta nama service dalam format lain, gunakan format yang
   ditampilkan oleh `--help` atau daftar service di dashboard.
3. Worker menulis JSON log. `snapshot-accepted` menandakan ingest berhasil;
   `snapshot-failed` menyertakan pesan error. Untuk health aplikasi, cocokkan
   keberhasilan ini dengan health/heartbeat worker dan status ingest backend.
   Status instance **Running** saja tidak membuktikan bahwa snapshot berhasil
   diterima.

## Metrik yang dipantau

- **Memori:** konfigurasi `NODE_OPTIONS=--max-old-space-size=224` membatasi
  heap JavaScript V8 sekitar **224 MiB**. Ini bukan batas total RAM container:
  pantau juga RSS/Memory usage di Koyeb, yang mencakup buffer, native memory,
  dan runtime Node. Periksa peringatan mendekati limit instance dan pola naik
  terus-menerus, bukan hanya satu sampel.
- **CPU:** pantau pemakaian rata-rata dan lonjakan selama pengambilan halaman
  provider serta render snapshot. Lonjakan berulang atau CPU tinggi bersamaan
  dengan cycle yang lambat dapat menandakan beban terlalu besar.
- **Restart count / restart events:** periksa perubahan jumlah restart dan
  alasan terminasi. Restart berulang dapat menunjukkan OOM, crash, konfigurasi
  invalid, atau kegagalan saat startup.
- **Keberhasilan ingest:** amati rasio `snapshot-accepted` terhadap
  `snapshot-failed`, jeda antar-snapshot, serta status endpoint backend.

## Tindakan saat peringatan memori atau OOM

1. Buka live logs dan events sekitar waktu peringatan/restart. Catat waktu,
   deployment, restart reason, dan apakah ada `snapshot-failed`; jangan
   menyalin nilai secret ke tiket atau log.
2. Jika proses masih sehat, pantau apakah pemakaian kembali turun setelah satu
   cycle. Jika penggunaan terus naik, cycle tertahan, atau terjadi restart,
   lakukan redeploy/restart dari dashboard hanya setelah memastikan dampaknya
   pada pembaruan snapshot.
3. Kurangi volume kerja melalui konfigurasi workload di `koyeb.yaml`:
   `SPORTSBOOK_RENDER_MAX_EVENTS`, `SPORTSBOOK_RENDER_MAX_PAGES`, dan batas
   halaman provider. Terapkan perubahan melalui deployment baru; jangan
   menaikkan heap melampaui memori instance yang dialokasikan.
4. Setelah deployment, pastikan penggunaan memori stabil, restart count tidak
   bertambah, dan log kembali menunjukkan `snapshot-accepted`. Jika tetap
   OOM, evaluasi kapasitas instance Koyeb dan ukuran batch bersama-sama,
   kemudian uji perubahan sebelum menaikkan beban.

## Kegagalan HMAC atau koneksi ke endpoint ingest

1. Bedakan error transport dari penolakan backend. Timeout/DNS/TLS atau HTTP
   `5xx`, `408`, `425`, dan `429` dapat dicoba ulang worker (maksimal tiga
   attempt). Error HTTP lainnya, termasuk signature tidak valid, tidak
   di-retry otomatis.
2. Untuk HTTP `401`/`403` atau signature mismatch, pastikan:
   - `SPORTSBOOK_INGEST_URL` menunjuk ke endpoint backend HTTPS yang benar:
     `/api/internal/sportsbook/ingest`.
   - `SPORTSBOOK_INGEST_HMAC_SECRET` di Koyeb dan backend sama, tidak kosong,
     dan minimal 32 karakter. Verifikasi melalui secret manager, jangan
     mencetak nilainya.
   - Jam sistem provider/worker/backend tersinkron. Backend memvalidasi
     timestamp request, sehingga timestamp yang terlalu lama atau di masa
     depan dapat ditolak.
   - Secret tidak memiliki newline/spasi ekstra dan tidak sedang berbeda
     akibat rotasi yang hanya diterapkan pada salah satu service.
3. Untuk timeout, DNS, atau TLS, periksa ejaan hostname, sertifikat HTTPS,
   status backend dan jaringan, lalu korelasikan timestamp error dengan log
   backend. Pastikan backend siap menerima request sebelum worker
   di-redeploy.
4. Jika secret perlu dirotasi, lakukan perubahan terkoordinasi pada worker dan
   backend: siapkan nilai baru yang sama di secret manager, terapkan pada
   kedua sisi dalam jendela terencana, lalu verifikasi `snapshot-accepted`.
   Jangan mengirim secret lewat chat, tiket, atau command yang tersimpan di
   shell history.
5. Jika payload ditolak karena batas ukuran (misalnya HTTP `413`), itu bukan
   kegagalan HMAC. Kurangi ukuran batch/event atau selaraskan batas payload
   worker dan backend sebelum deploy ulang.
