import { randomBytes } from 'node:crypto';
import pg from '../backend/node_modules/pg/lib/index.js';
import { hashPassword } from '../backend/src/security.js';

const { Pool } = pg;
// Password tidak lagi punya nilai default di dalam repo: default yang tertanam
// berarti password admin bisa ditebak dari sumber. Without NEW_PASSWORD, skrip
// membuat password acak yang kuat dan mencetaknya sekali.
const generated = !process.env.NEW_PASSWORD;
const newPassword = process.env.NEW_PASSWORD || `Gas#${randomBytes(9).toString('base64url')}!${randomBytes(2).toString('base64url')}`;
const username = process.env.TARGET_USERNAME || 'owner';

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

  const res = await pool.query(
    `UPDATE users 
     SET password_hash = $1, 
         mfa_enabled = false,
         mfa_secret_encrypted = NULL,
         status = 'ACTIVE', 
         updated_at = now() 
     WHERE username = $3 
     RETURNING id, username`,
    [hash, username]
  );

  if (res.rowCount === 0) {
    console.error(`User ${username} not found!`);
    process.exit(1);
  } else {
    console.log('=== ADMIN CREDENTIALS RESET SUCCESS ===');
    console.log(JSON.stringify({
      success: true,
      username,
      password: newPassword,
      passwordGenerated: generated
    }, null, 2));
    console.log('\nCara pakai:');
    console.log('1. Simpan password & TOTP secret di password manager sekarang.');
    console.log(`2. Buka https://gasterus.fun/cc-x7k9/ lalu login dengan username "${username}".`);
    console.log('3. Login menggunakan password baru. MFA/OTP dinonaktifkan untuk akun ini.');
  }
} catch (err) {
  console.error('Error resetting credentials:', err);
  process.exit(1);
} finally {
  await pool.end();
}
