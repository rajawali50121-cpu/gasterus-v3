# Runbook settlement manual sportsbook

## Batas dan prasyarat

Runbook ini berlaku untuk tiket sportsbook yang sudah diterima. Settlement manual tidak
mengubah sumber hasil, authority settlement, suspension, status lifecycle, atau odds dan
tidak boleh dipakai untuk membuka pasar yang ditangguhkan.

Sebelum settlement:

1. Pastikan pasar dan periode pada tiket mempunyai settlement authority yang tercatat.
   Pasar yang ditangguhkan, tidak ber-authority, atau belum memiliki hasil yang final tetap
   menunggu; jangan menginput skor untuk mengatasi gate tersebut.
2. Cocokkan fixture, kompetisi, periode (FT/1H), status pertandingan, dan hasil akhir
   dengan sumber resmi yang disetujui organisasi. Simpan identitas sumber, URL/dokumen
   rujukan, waktu verifikasi, dan nama petugas di catatan operasional di luar payload rahasia.
   Jangan memakai harga odds atau data dari tiket sebagai bukti hasil.
3. Petugas settlement harus memiliki izin `settlements:request`. Perubahan kill switch
   penerimaan tiket memerlukan `markets:write`; kedua tindakan tetap memerlukan sesi owner
   yang sah dan pemeriksaan CSRF. Operator settlement tidak otomatis berwenang mengubah
   konfigurasi global.

## Memeriksa antrean dan memasukkan hasil

1. Buka `GET /api/owner/sportsbook/manual-settlement-queue` dan
   `GET /api/owner/sportsbook/bets?status=OPEN`. Cocokkan tiket dengan bukti hasil sebelum
   bertindak.
2. Untuk tiap tiket, kirim `POST /api/owner/sportsbook/bets/{ticketId}/settle` dengan
   `results` yang berisi tepat satu entri per `legNo`, status hasil yang didukung
   (`WON`, `LOST`, `VOID`, `PUSH`, `HALF_WON`, atau `HALF_LOST`), dan `resultValue`
   berupa catatan skor/periode. Sertakan `sourceName`, `feedRevision` bila tersedia,
   `reason` yang menjelaskan bukti, dan `idempotencyKey` unik untuk tindakan tersebut.
3. Periksa tiket, hasil tiap leg, nilai payout, revisi, dan baris audit setelah permintaan.
   Settlement dan transfer ledger diterapkan atomik: kemenangan membayar sesuai kalkulasi
   tiket; kekalahan menghasilkan payout nol; void/push mengembalikan stake leg sesuai
   kalkulasi tiket; half-win/half-loss dihitung oleh settlement calculator. Jangan
   menghitung atau membayar manual di luar alur ini.
4. Untuk fixture yang ditunda atau hasilnya belum final, jangan settle. Tunggu keputusan
   resmi; jika otoritas resmi menyatakan pertandingan batal, gunakan hasil `VOID` yang
   didukung bukti. Endpoint pembatalan tiket hanya digunakan bila seluruh tiket memang
   harus dibatalkan: `POST /api/owner/sportsbook/bets/{ticketId}/cancel`.

## Koreksi, rollback, dan audit

- Setiap tindakan membuat revisi settlement dan audit append-only dengan aktor, role,
  tindakan, sumber, alasan, payout sebelum/sesudah, serta referensi feed bila ada.
- Jika hasil sudah diterapkan tetapi salah, verifikasi ulang bukti dengan petugas kedua,
  catat alasan koreksi, lalu gunakan revisi settlement yang sesuai. `POST
  /api/owner/sportsbook/bets/{ticketId}/rollback` membalik payout dan membuka kembali
  tiket; setelah hasil benar terverifikasi, kirim settlement baru. Hindari rollback
  sekadar untuk mengulang request yang sudah berhasil.
- Bila koreksi perlu mendebit saldo anggota yang tidak lagi cukup, sistem mencatat revisi
  `PENDING_FUNDS` dan tidak menerapkan koreksi ledger. Jangan menghapus atau mengubah
  ledger; eskalasi ke Finance melalui proses saldo yang terotorisasi, lalu ulangi revisi
  yang sama memakai `idempotencyKey` dan tindakan yang sama. Jangan membuat revisi kedua
  sebelum status pending terselesaikan.
- Setelah setiap batch, tinjau `GET /api/owner/sportsbook/health`, riwayat revisi,
  audit log, dan hasil `verifyLedger` melalui prosedur rekonsiliasi internal. Selisih
  ledger, revisi pending yang tidak terjelaskan, atau bukti hasil yang tidak cocok adalah
  alasan untuk menghentikan settlement berikutnya dan mengeskalasi ke Finance/Engineering.

## Kill switch taruhan baru

Owner/Result Operator dengan izin `markets:write` dapat membaca
`GET /api/owner/sportsbook/betting-switch` dan mengubah penerimaan dengan
`POST /api/owner/sportsbook/betting-switch` berisi `{"closed":true}` atau `false`.
Perubahan disimpan dan diaudit di `system_settings`; transaksi taruhan memakai lock
PostgreSQL yang sama sehingga setelah permintaan penutupan berhasil tidak ada transaksi
taruhan baru yang dapat melewati switch. Settlement dan cashout tiket lama tetap berjalan.
`SPORTSBOOK_BETTING_KILL_SWITCH_ENABLED=true` adalah override tertutup yang dibaca saat
boot; mematikannya memerlukan restart proses. Jangan mengandalkan override boot untuk
operasi yang membutuhkan penutupan runtime segera.

## Rekomendasi uji terbatas (bukan konfigurasi produksi)

Untuk pengujian lokal terisolasi saja, nilai awal yang disarankan:

- `SPORTSBOOK_LIMITED_TEST_MODE_ENABLED=true`
- `SPORTSBOOK_LIMITED_TEST_MEMBER_IDS` hanya berisi UUID akun uji yang disetujui; kosong
  berarti tidak ada akun yang diizinkan
- `SPORTSBOOK_LIMITED_TEST_MAX_STAKE=1000` per tiket (unit saldo aplikasi)
- `SPORTSBOOK_MAX_MEMBER_LIABILITY=100000` per anggota (potensi payout tiket OPEN)

Mode uji default mati, allowlist default kosong, cap liability anggota default `0`
(nonaktif), dan batas ini tidak diterapkan di produksi oleh runbook ini. Allowlist bukan
pengganti syarat bettable: feed/quote server harus segar, odds dan versi harga harus lolos
validasi, pilihan harus tidak suspended, lifecycle/provider harus mengizinkan betting,
authority settlement yang sesuai untuk FT/HT harus tersedia, saldo cukup, serta batas
stake/payout dan risiko pasar harus lolos.
