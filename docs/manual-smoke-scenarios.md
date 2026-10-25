# Skenario uji manual produksi (tanpa pembuatan data oleh agen)

Dokumen ini hanya berisi langkah uji yang dapat dijalankan operator secara manual.
Tidak ada akun, saldo, taruhan, atau data produksi yang dibuat oleh agen.
Gunakan akun uji yang sudah disiapkan secara terpisah dan nominal kecil.

## 0. Prasyarat

- URL produksi: https://gasterus-v3-production.up.railway.app
- Browser bersih / mode privat.
- Akun uji (username/email/password) yang memang disiapkan operator.
- Saldo kecil yang cukup untuk satu taruhan kecil.
- Catat invoice/ticket ID dan saldo sebelum/sesudah.

## 1. Register (akun baru)

1. Buka halaman register.
2. Ambil captcha: `GET /api/member/register/captcha`.
3. Isi username, email, password, captcha.
4. Submit `POST /api/member/register`.
5. Expected: HTTP 200/201, akun aktif atau status sesuai flow verifikasi.
6. Verifikasi `GET /api/member/me` dengan session/token baru.
7. Negative: submit tanpa captcha -> expected 400 `CAPTCHA_INVALID`.
8. Negative: username/email duplikat -> expected 409/400 dengan kode error yang jelas.

## 2. Login

1. Buka halaman login.
2. Submit `POST /api/member/login` dengan kredensial valid.
3. Expected: HTTP 200, session/token diterbitkan.
4. Verifikasi cookie/session tersimpan sesuai mekanisme frontend.
5. Negative: password salah -> expected 401 `LOGIN_FAILED`.
6. Negative: user tidak ada -> expected 401 `LOGIN_FAILED` (tanpa membocorkan existence).

## 3. Sesi dan autorisasi

1. Setelah login, buka `GET /api/member/me`.
2. Expected: HTTP 200, data user sesuai akun.
3. Buka endpoint member lain (mis. riwayat taruhan) dan pastikan hanya data akun sendiri.
4. Logout / hapus session.
5. Ulangi `GET /api/member/me` -> expected 401 `AUTH_REQUIRED`.
6. Coba token invalid -> expected 401 `AUTH_REQUIRED`.
7. Cek CSRF: POST state-changing tanpa CSRF token -> expected 403/400, bukan sukses.

## 4. Taruhan kecil

1. Login dengan akun uji.
2. Ambil daftar market: `GET /api/public/markets`.
3. Pilih satu market sederhana dengan odds valid dan batas taruhan kecil.
4. Catat saldo sebelum.
5. Submit taruhan kecil lewat endpoint bet yang dipakai frontend.
6. Expected: HTTP 200/201, ticket/invoice terbentuk, saldo berkurang sesuai stake.
7. Verifikasi tiket muncul di riwayat/open bets.
8. Negative: stake 0 / di bawah minimum -> expected 400.
9. Negative: stake melebihi saldo -> expected 400/409.
10. Negative: market suspended/closed -> expected 400/409.

## 5. Settlement

1. Gunakan tiket kecil dari skenario 4.
2. Tunggu settlement otomatis atau verifikasi status tiket menjadi SETTLED/WON/LOST.
3. Catat saldo setelah settlement.
4. Verifikasi saldo berubah sesuai hasil (payout atau 0).
5. Verifikasi ledger tetap seimbang melalui prosedur internal/monitoring jika akses ops tersedia.
6. Jika ada cashout, uji cashout kecil sebelum settlement:
   - buat offer cashout;
   - accept;
   - expected saldo bertambah sesuai offer;
   - tiket status CASHED_OUT.

## 6. Pembersihan

- Jangan tinggalkan taruhan terbuka yang tidak perlu.
- Jika akun uji dibuat khusus, nonaktifkan/reset sesuai prosedur owner.
- Catat hasil (PASS/FAIL), waktu, dan bukti screenshot/response.

## Catatan keamanan

- Jangan cetak atau simpan secret/token di bukti.
- Gunakan nominal kecil dan akun uji, bukan akun pelanggan.
- Jangan jalankan drill recovery/rollback di production.
