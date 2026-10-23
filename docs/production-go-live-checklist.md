# Checklist go-live produksi

Dokumen ini adalah gerbang rilis operasional, bukan pengganti persetujuan hukum,
konfigurasi akun provider, atau pemeriksaan langsung pada environment produksi.
Jangan buka taruhan atau pembayaran uang sungguhan sampai semua butir wajib
memiliki bukti dan penanggung jawab.

## Gerbang wajib sebelum menerima pengguna atau transaksi nyata

- [ ] **Legal dan wilayah operasi:** penasihat yang berwenang telah menyetujui
  lisensi, negara/wilayah yang diizinkan, batas usia, aturan promosi, privasi,
  KYC/AML, pajak, dan kewajiban pelaporan. Geoblocking serta kontrol usia sudah
  diuji untuk wilayah yang tidak diizinkan.
- [ ] **Sumber hasil dan settlement:** daftar sumber resmi, periode/kompetisi,
  aturan konflik dan keterlambatan data, otoritas settlement, eskalasi, serta
  approval operator kedua terdokumentasi. Default konfigurasi produksi
  `TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED=false`; mengubahnya menjadi `true`
  harus menjadi keputusan risiko yang tercatat, bukan kebutuhan agar tes atau
  deploy lolos. `SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED` juga default
  `false`; mengaktifkannya memerlukan operator settlement, sumber bukti, audit,
  dan runbook yang disetujui.
- [ ] **Pembayaran dan saldo:** kredensial produksi disimpan di secret manager,
  callback menggunakan autentikasi provider dan pemeriksaan amount/reference,
  idempotensi diuji, serta rekonsiliasi bank/provider dan refund/chargeback
  memiliki pemilik operasional. Uji end-to-end dilakukan pada sandbox provider.
- [ ] **Migrasi dan deploy:** CI lulus, termasuk tes integrasi ledger sportsbook.
  Predeploy dan schema readiness lulus pada staging dari salinan skema/data uji.
  Perubahan skema kompatibel dengan versi aplikasi yang akan di-rollback.
- [ ] **Backup dan pemulihan:** backup PostgreSQL otomatis aktif, terenkripsi,
  disimpan terpisah dari database utama, aksesnya dibatasi, dan retensinya
  memenuhi RPO yang disetujui. Lakukan restore ke database kosong/terisolasi
  sebelum rilis; verifikasi jumlah record penting, `schema_migrations`, saldo,
  dan `verifyLedger`. Simpan waktu, hasil, serta operator uji restore. Jangan
  menganggap volume database sebagai backup.
- [ ] **Redis dan antrean:** tentukan data Redis mana yang dapat dibuat ulang,
  persistensi/retensinya, dan bagaimana outbox/pekerjaan tertunda dipulihkan.
  Setelah simulasi restart Redis, pastikan tidak ada pekerjaan uang yang hilang
  atau diproses ganda dan ledger tetap seimbang.
- [ ] **Monitoring dan respons insiden:** alert diuji untuk readiness gagal,
  worker heartbeat stale, feed/odds basi, 429 provider, antrean tumbuh,
  callback pembayaran gagal, ledger tidak seimbang, lonjakan error, memori, dan
  kapasitas storage. Tetapkan on-call, jalur eskalasi Finance/Engineering,
  komunikasi pengguna, serta prosedur penutupan taruhan dan pembayaran.
- [ ] **Keamanan akses:** secret produksi unik, panjang, tidak sama dengan staging,
  dan rotasi/pencabutannya diketahui. MFA admin, akun operator bernama, least
  privilege, pemisahan persetujuan transaksi, logging audit, CORS/domain,
  TLS, serta proses pemulihan akun telah diverifikasi.
- [ ] **Responsible play dan dukungan:** batas deposit/pengeluaran, jeda akun,
  self-exclusion, kanal bantuan, penanganan keluhan, serta proses KYC dan
  peninjauan risiko diuji sebagai alur pengguna dan operasional.
- [ ] **Staging dan rilis:** smoke test web/API/admin dan browser mobile lulus;
  URL/domain, email reset, payment callback, provider feed, dan cache asset
  mengarah ke environment yang tepat. Uji rollback aplikasi dan frontend,
  kemudian pastikan health/readiness pulih tanpa membuka taruhan otomatis.

## Prosedur uji restore yang minimum

1. Buat backup terenkripsi menggunakan fasilitas backup terkelola atau
   `pg_dump --format=custom`; jangan menaruh password pada command line atau
   menyimpan backup di repo/workspace.
2. Buat database restore kosong yang terisolasi dan gunakan `pg_restore` tanpa
   opsi penghapusan objek. Jangan pernah menjalankan simulasi restore terhadap
   database produksi.
3. Jalankan pemeriksaan skema dan rekonsiliasi ledger pada hasil restore.
   Catat durasi, hasil, serta selisih terhadap RPO/RTO yang disetujui.
4. Hapus database uji melalui prosedur platform setelah bukti restore disimpan
   di sistem operasional yang aksesnya dibatasi.

Perintah backup/restore harus dijalankan dari lingkungan operator yang
terotorisasi, menggunakan secret manager dan target terisolasi. Detail retensi,
enkripsi, dan restore bergantung pada fasilitas provider yang benar-benar aktif
di project; verifikasi di dashboard dan lakukan latihan, jangan mengasumsikan
default platform.

## Pemeriksaan teknis repo

Jalankan sebelum rilis:

```sh
npm ci
npm ci --prefix backend
npm test
npm run check
```

CI juga membuat database sementara `sportsbook_test`, menjalankan migrasi dan
seed, lalu menjalankan `backend/tests/sportsbook-ledger-integration.test.js`
dengan `SPORTSBOOK_INTEGRATION=1`. Tes tersebut memakai database loopback yang
namanya dibatasi untuk mencegah jalan tidak sengaja terhadap database produksi.

Jika ada butir wajib yang belum memiliki bukti, tutup taruhan baru dan jangan
aktifkan pembayaran uang sungguhan. Checklist ini tidak dapat membuktikan status
lisensi, setting provider/platform, backup aktif, atau pemulihan di akun live.
