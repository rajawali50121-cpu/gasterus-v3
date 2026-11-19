import { randomBytes } from 'node:crypto';
import pg from '../backend/node_modules/pg/lib/index.js';
import { hashPassword, encryptSecret, generateTotpSecret, totp } from '../backend/src/security.js';

const { Pool } = pg;
// Password tidak lagi punya nilai default di dalam repo: default yang tertanam
// berarti password admin bisa ditebak dari sumber. Without NEW_PASSWORD, skrip
// membuat password acak yang kuat dan mencetaknya sekali.
const generated = !process.env.NEW_PASSWORD;
const newPassword = process.env.NEW_PASSWORD || `Gas#${randomBytes(9).toString('base64url')}!${randomBytes(2).toString('base64url')}`;
const username = process.env.TARGET_USERNAME || 'owner';
const secret = generateTotpSecret();

// Kredensial WAJIB lewat environment. Tidak ada lagi URL database yang tertanam
// di dalam kode: skrip ini menyentuh database produksi, jadi string koneksi
// yang menempel di skrip berarti siapa pun yang punya repo bisa menulis ke
// database(member, saldo, hasil). Password database pun wajib dari Railway.
//
//   DATABASE_URL_OVERRIDE='postgresql://...' node scripts/reset-admin-password.mjs
const dbUrl = process.env.DATABASE_URL_OVERRIDE || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL_OVERRIDE wajib diisi (ambil dari Railway > Postgres > Credentials).');
  process.exit(1);
}
const pool = new Pool({ connectionString: dbUrl });

try {
  const hash = await hashPassword(newPassword);
  const encryptedSecret = encryptSecret(secret);

  const res = await pool.query(
    `UPDATE users 
     SET password_hash = $1, 
         mfa_enabled = true, 
         mfa_secret_encrypted = $2, 
         status = 'ACTIVE', 
         updated_at = now() 
     WHERE username = $3 
     RETURNING id, username`,
    [hash, encryptedSecret, username]
  );

  if (res.rowCount === 0) {
    console.error(`User ${username} not found!`);
    process.exit(1);
  } else {
    const issuer = encodeURIComponent('SBOTOTO Enterprise');
    const label = encodeURIComponent(`SBOTOTO:${username}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    console.log('=== ADMIN CREDENTIALS RESET SUCCESS ===');
    console.log(JSON.stringify({
      success: true,
      username,
      password: newPassword,
      passwordGenerated: generated,
      totpSecret: secret,
      otpauthUri: otpauth,
      currentOtp: totp(secret)
    }, null, 2));
    console.log('\nCara pakai:');
    console.log('1. Simpan password & TOTP secret di password manager sekarang.');
    console.log(`2. Buka https://gasterus.fun/cc-x7k9/ lalu login dengan username "${username}".`);
    console.log('3. Masukkan kode 6 digit dari Google Authenticator / Aegis.');
    console.log('   ("currentOtp" di atas hanya berlaku 30 detik, jangan dipakai manual.)');
    console.log('4. Kalau kode ditolak, cek jam perangkat Anda (wajib sinkron, selisih < 30 detik).');
    console.log('\nSimpan secret di someplace aman. Secretariat ini bisa dirotasi kapan saja.');
  }
} catch (err) {
  console.error('Error resetting credentials:', err);
  process.exit(1);
} finally {
  await pool.end();
}
