import { randomUUID } from 'node:crypto';
import { tx, closeDatabase } from '../src/db.js';
import { encryptSecret, hashPassword } from '../src/security.js';
import { ensureSystemAccounts } from '../src/ledger.js';

const username=String(process.env.OWNER_USERNAME||'owner').trim();
const password=String(process.env.OWNER_PASSWORD||'');
const secret=String(process.env.OWNER_TOTP_SECRET||'').toUpperCase().replace(/[^A-Z2-7]/g,'');

try {
  const result=await tx(async client=>{
    await ensureSystemAccounts(client);
    const existing=await client.query(`
      SELECT u.id,u.username
      FROM users u JOIN user_roles ur ON ur.user_id=u.id
      WHERE ur.role_code='OWNER'
      ORDER BY ur.assigned_at ASC
      LIMIT 1
    `);
    if(existing.rowCount) return {created:false,username:existing.rows[0].username};
    // Jika owner belum ada DAN kredensial bootstrap tidak diset (mis. deploy
    // ulang dengan preDeploy aktif), skip dengan aman alih-alih menggagalkan
    // seluruh deployment. Owner bisa dibuat manual via bootstrap-owner.js.
    if(!password || !secret) {
      console.log('Owner bootstrap skipped: OWNER_PASSWORD/OWNER_TOTP_SECRET not set and no OWNER exists yet');
      return {created:false,username:'(pending manual bootstrap)'};
    }
    if(!username) throw new Error('OWNER_USERNAME is required for first deploy');
    if(password.length<14||password.length>128) throw new Error('OWNER_PASSWORD must contain 14-128 characters for first deploy');
    if(secret.length<16) throw new Error('OWNER_TOTP_SECRET must be a valid Base32 secret for first deploy');
    const hash=await hashPassword(password);
    const userId=randomUUID();
    await client.query(`INSERT INTO users(id,username,password_hash,status,mfa_enabled,mfa_secret_encrypted,rules_accepted_at) VALUES($1,$2,$3,'ACTIVE',true,$4,now())`,[userId,username,hash,encryptSecret(secret)]);
    await client.query(`INSERT INTO user_roles(user_id,role_code,assigned_by) VALUES($1,'OWNER',$1),($1,'SUPERVISOR',$1) ON CONFLICT DO NOTHING`,[userId]);
    return {created:true,username};
  });
  console.log(result.created?`Initial owner created: ${result.username}`:`Owner already exists; bootstrap skipped: ${result.username}`);
} finally {
  await closeDatabase();
}
