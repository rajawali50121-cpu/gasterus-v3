import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { redis } from './redis.js';
import { config } from './config.js';
import { AppError, assert } from './errors.js';
import { apiKeyHash, hashPassword, hmac, randomToken, verifyPassword } from './security.js';
import { bearerToken, cookie, cookies } from './http.js';
import { audit } from './audit.js';
import { recordSecurityEvent } from './security-events.js';
import { isValidMemberEmail, isValidMemberPassword, isValidMemberUsername } from './registration-policy.js';

const cookieNames={MEMBER:'a7_member_session',OWNER:'a7_owner_session'};
const sessionKey=(channel,token)=>`session:${channel.toLowerCase()}:${hmac(token)}`;
function sanitizeUser(row,roles=[]) { return {id:row.id,username:row.username,email:row.email,phone:row.phone,status:row.status,balance:Number(row.current_balance||0),bankName:row.bank_name||null,accountName:row.account_name||null,accountNumber:row.account_number||null,rulesAccepted:Boolean(row.rules_accepted_at),roles}; }
export async function userById(id) {
  const {rows}=await query(`SELECT u.*,a.current_balance FROM users u LEFT JOIN ledger_accounts a ON a.owner_user_id=u.id WHERE u.id=$1`,[id]);
  if(!rows[0])throw new AppError(404,'Akun tidak ditemukan.','USER_NOT_FOUND');
  const roleRows=await query('SELECT role_code FROM user_roles WHERE user_id=$1 ORDER BY role_code',[id]);
  return sanitizeUser(rows[0],roleRows.rows.map(x=>x.role_code));
}
async function createSession(user,channel,roles=[]) {
  const token=randomToken(40),csrf=randomToken(24),ttl=channel==='OWNER'?config.ownerSessionTtl:config.memberSessionTtl;
  const value={userId:user.id,channel,csrf,roles,createdAt:new Date().toISOString()};
  await redis.set(sessionKey(channel,token),JSON.stringify(value),{EX:ttl});
  return {token,sessionToken:token,csrfToken:csrf,user:sanitizeUser(user,roles),ttl};
}
export async function session(request,channel) {
  // Accept the session token from the HttpOnly cookie (same-origin) OR from the
  // Authorization: Bearer header (token stored in localStorage). The header path is
  // mandatory when the member frontend is served from a different site than the API
  // and browsers block third-party cookies, so the cookie round-trip never happens.
  const token=cookies(request)[cookieNames[channel]] || bearerToken(request);
  if(!token)throw new AppError(401,'Sesi tidak tersedia.','AUTH_REQUIRED');
  const key=sessionKey(channel,token);
  const raw=await redis.get(key);
  if(!raw)throw new AppError(401,'Sesi telah berakhir.','SESSION_EXPIRED');
  // R6.94: OWNER sessions use an idle timeout — every authenticated activity slides
  // the Redis expiry forward (max 15 minutes of inactivity logs the operator out).
  if(channel==='OWNER')await redis.expire(key,config.ownerSessionTtl).catch(()=>{});
  const value=JSON.parse(raw); value.token=token;
  return value;
}
export function sessionCookie(channel,token,ttl) { return cookie(cookieNames[channel],token,ttl,config.cookieSecure); }
export function clearSessionCookie(channel) { return cookie(cookieNames[channel],'',0,config.cookieSecure); }
export function requireCsrf(request,s) { assert(request.headers['x-csrf-token']===s.csrf,403,'Token keamanan tidak valid.','CSRF_INVALID'); }
export async function logout(request,channel) { const s=await session(request,channel); await redis.del(sessionKey(channel,s.token)); if(channel==='OWNER')await audit({actorId:s.userId,actorRole:'OWNER',action:'OWNER_LOGOUT',targetType:'SESSION',targetId:hmac(s.token)}); return s; }
export function hasPermission(s,permission) {
  if(s.roles?.includes('OWNER'))return true;
  const rolePermissions={
    SUPERVISOR:['approvals:read','approvals:approve','bets:read','wallet:read','members:read','content:write','compliance:read','risk:read','support:write','reports:read','money:read'],
    FINANCE:['wallet:read','wallet:review','members:read','payments:write','reconciliation:write','reports:read','money:read','money:reverse'],
    RESULT_OPERATOR:['bets:read','markets:write','settlements:request'],
    SUPPORT:['members:read','bets:read','wallet:read','support:write','compliance:read'],
    SECURITY:['audit:read','roles:write','mfa:reset','sessions:revoke','members:credential-reset','security:read','risk:read','risk:write','compliance:read','compliance:write','responsible:write'],
    COMPLIANCE:['members:read','compliance:read','compliance:write','responsible:write','risk:read','risk:write','reports:read'],
    ANALYST:['members:read','wallet:read','bets:read','reports:read','risk:read']
  };
  return s.roles?.some(role=>rolePermissions[role]?.includes(permission));
}
export function requirePermission(s,permission){assert(hasPermission(s,permission),403,'Akses tidak diizinkan.','FORBIDDEN');}

export async function registerMember(input,ip='') {
  const username=String(input.username||'').trim(); const email=String(input.email||'').trim().toLowerCase()||null;
  const password=String(input.password??'');
  assert(isValidMemberUsername(username),400,'Username harus 3-12 karakter dan hanya berisi huruf, angka, atau garis bawah.','USERNAME_INVALID');
  assert(email&&isValidMemberEmail(email),400,'Email wajib diisi dengan format valid seperti nama@gmail.com.','EMAIL_INVALID');
  assert(isValidMemberPassword(password),400,'Password harus 8-72 karakter serta mengandung huruf dan angka.','PASSWORD_INVALID');
  const existing=await query('SELECT 1 FROM users WHERE username=$1 LIMIT 1',[username]);
  assert(!existing.rows[0],409,'Username sudah digunakan. Gunakan username lain.','USERNAME_TAKEN');
  if(email){
    const emailExists=await query('SELECT 1 FROM users WHERE email=$1 LIMIT 1',[email]);
    assert(!emailExists.rows[0],409,'Email sudah terdaftar. Gunakan email lain.','EMAIL_TAKEN');
  }
  const accountNumber=String(input.accountNumber||'').trim();
  if(accountNumber){
    const accExists=await query(`SELECT 1 FROM users u WHERE u.account_number=$1 AND btrim(u.account_number)<>'' AND NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id) LIMIT 1`,[accountNumber]);
    assert(!accExists.rows[0],409,'Nomor rekening sudah digunakan. Gunakan nomor rekening lain.','ACCOUNT_NUMBER_TAKEN');
  }
  const passwordHash=await hashPassword(password);
  const id=randomUUID(),accountId=randomUUID(),code=`A7${randomToken(7).replace(/[-_]/g,'').slice(0,9).toUpperCase()}`;
  let referrer=null;
  try {
    await tx(async client=>{
      if(input.referralCode){const r=await client.query(`SELECT member_id FROM member_referral_profiles WHERE invite_code=$1`,[String(input.referralCode).trim()]);referrer=r.rows[0]?.member_id||null;assert(referrer,400,'Kode referral tidak valid.','REFERRAL_INVALID');}
      await client.query(`INSERT INTO users(id,username,email,phone,password_hash,bank_name,account_name,account_number,referral_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,username,email,String(input.phone||'').slice(0,30)||null,passwordHash,String(input.bankName||'').slice(0,40)||null,String(input.accountName||'').slice(0,80)||null,String(input.accountNumber||'').slice(0,80)||null,code]);
      await client.query(`INSERT INTO ledger_accounts(id,owner_user_id,account_code,account_type,current_balance) VALUES($1,$2,$3,'MEMBER',0)`,[accountId,id,`MEMBER:${id}`]);
      await client.query(`INSERT INTO member_referral_profiles(member_id,invite_code,referred_by_member_id) VALUES($1,$2,$3)`,[id,code,referrer]);
      if(referrer)await client.query(`INSERT INTO referral_relationships(id,referrer_id,referred_member_id,invite_code) VALUES($1,$2,$3,$4)`,[randomUUID(),referrer,id,String(input.referralCode).trim()]);
    },{isolation:'SERIALIZABLE'});
  } catch (error) {
    if (error?.code === '23505' && String(error?.constraint || '').toLowerCase().includes('username')) throw new AppError(409,'Username sudah digunakan. Gunakan username lain.','USERNAME_TAKEN');
    if (error?.code === '23505' && String(error?.constraint || '').toLowerCase().includes('email')) throw new AppError(409,'Email sudah terdaftar. Gunakan email lain.','EMAIL_TAKEN');
    throw error;
  }
  await audit({actorId:id,actorRole:'MEMBER',action:'MEMBER_REGISTERED',targetType:'USER',targetId:id,ip});
  return userById(id);
}
export async function loginMember(input,ip='',userAgent='') {
  const username=String(input.username||'').trim();
  let {rows}=await query(`SELECT u.*,a.current_balance FROM users u JOIN ledger_accounts a ON a.owner_user_id=u.id WHERE u.username=$1`,[username]);
  if(!rows.length&&username)rows=(await query(`SELECT u.*,a.current_balance FROM users u JOIN ledger_accounts a ON a.owner_user_id=u.id WHERE lower(u.username)=lower($1)`,[username])).rows;
  const user=rows[0]; const valid=Boolean(user&&await verifyPassword(input.password,user.password_hash));
  if(!valid){await recordSecurityEvent({memberId:user?.id||null,channel:'MEMBER',eventType:'MEMBER_LOGIN_FAILED',severity:'MEDIUM',usernameHint:username,ip,userAgent});assert(false,401,'Username atau password salah.','LOGIN_FAILED');}
  if(user.status!=='ACTIVE'){await recordSecurityEvent({memberId:user.id,channel:'MEMBER',eventType:'MEMBER_LOGIN_BLOCKED',severity:'HIGH',usernameHint:username,ip,userAgent,details:{status:user.status}});assert(false,403,'Akun tidak aktif.','ACCOUNT_INACTIVE');}
  const roleRows=await query('SELECT role_code FROM user_roles WHERE user_id=$1',[user.id]); const roles=roleRows.rows.map(x=>x.role_code);
  assert(!roles.length,403,'Gunakan portal pengelola untuk akun ini.','CHANNEL_INVALID');
  const result=await createSession(user,'MEMBER',[]); await recordSecurityEvent({memberId:user.id,channel:'MEMBER',eventType:'MEMBER_LOGIN_SUCCESS',severity:'INFO',usernameHint:username,ip,userAgent});await audit({actorId:user.id,actorRole:'MEMBER',action:'MEMBER_LOGIN',targetType:'SESSION',targetId:hmac(result.token),ip}); return result;
}
export async function loginOwner(input,ip='',userAgent='') {
  const username=String(input.username||'').trim();
  assert(username==='gasterus',401,'Username atau password salah.','LOGIN_FAILED');
  const {rows}=await query(`SELECT u.*,a.current_balance FROM users u LEFT JOIN ledger_accounts a ON a.owner_user_id=u.id WHERE u.username=$1`,[username]);
  const user=rows[0]; const valid=Boolean(user&&await verifyPassword(input.password,user.password_hash));
  if(!valid){await recordSecurityEvent({memberId:user?.id||null,channel:'ADMIN',eventType:'ADMIN_LOGIN_FAILED',severity:'HIGH',usernameHint:username,ip,userAgent});assert(false,401,'Username atau password salah.','LOGIN_FAILED');}
  assert(user.status==='ACTIVE',403,'Akun tidak aktif.','ACCOUNT_INACTIVE');
  const roleRows=await query('SELECT role_code FROM user_roles WHERE user_id=$1',[user.id]); const roles=roleRows.rows.map(x=>x.role_code); assert(roles.includes('OWNER'),403,'Akun tidak memiliki akses OWNER.','CHANNEL_INVALID');
  // OWNER login uses username and password only. MFA is intentionally not required.
  const result=await createSession(user,'OWNER',['OWNER']); await recordSecurityEvent({memberId:user.id,channel:'ADMIN',eventType:'ADMIN_LOGIN_SUCCESS',severity:'INFO',usernameHint:username,ip,userAgent});await audit({actorId:user.id,actorRole:'OWNER',action:'OWNER_LOGIN',targetType:'SESSION',targetId:hmac(result.token),ip}); return result;
}
export async function changeOwnerPassword(ownerSession,input,ip=''){
  assert(ownerSession.channel==='OWNER'&&ownerSession.roles?.includes('OWNER'),403,'Akses tidak diizinkan.','FORBIDDEN');
  const currentPassword=String(input.currentPassword||'');
  const newPassword=String(input.newPassword||'');
  assert(newPassword.length>=10&&newPassword.length<=128,400,'Password baru harus 10-128 karakter.','PASSWORD_INVALID');
  assert(newPassword!==currentPassword,400,'Password baru harus berbeda dari password saat ini.','PASSWORD_UNCHANGED');
  const current=(await query(`SELECT password_hash FROM users WHERE id=$1 AND username='gasterus' AND status='ACTIVE' AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role_code='OWNER')`,[ownerSession.userId])).rows[0];
  assert(current&&await verifyPassword(currentPassword,current.password_hash),401,'Password saat ini tidak sesuai.','CURRENT_PASSWORD_INVALID');
  const passwordHash=await hashPassword(newPassword);
  const updated=await query(`UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2 AND username='gasterus' AND status='ACTIVE' AND password_hash=$3 AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=$2 AND role_code='OWNER') RETURNING id`,[passwordHash,ownerSession.userId,current.password_hash]);
  assert(updated.rows[0],409,'Password berubah bersamaan. Silakan coba kembali.','PASSWORD_CHANGE_CONFLICT');
  let revokedSessions=0;
  const currentKey=sessionKey('OWNER',ownerSession.token);
  for await (const batch of redis.scanIterator({MATCH:'session:owner:*',COUNT:100})) {
    for (const key of (Array.isArray(batch)?batch:[batch])) {
      if(key===currentKey)continue;
      const raw=await redis.get(key);
      if(!raw)continue;
      try{
        if(JSON.parse(raw).userId===ownerSession.userId){await redis.del(key);revokedSessions++;}
      }catch{}
    }
  }
  await audit({actorId:ownerSession.userId,actorRole:'OWNER',action:'OWNER_PASSWORD_CHANGED',targetType:'USER',targetId:ownerSession.userId,details:{revokedSessions},ip});
  return{changed:true,revokedSessions};
}
export async function acceptRules(userId){const {rows}=await query('UPDATE users SET rules_accepted_at=now(),updated_at=now() WHERE id=$1 RETURNING rules_accepted_at',[userId]);return rows[0].rules_accepted_at;}
export async function authenticateApiKey(request,scope) {
  const raw=String(request.headers['x-api-key']||String(request.headers.authorization||'').replace(/^Bearer\s+/i,'')).trim();
  assert(raw,401,'API key wajib disertakan.','API_KEY_REQUIRED'); const prefix=raw.slice(0,18); const hash=apiKeyHash(raw);
  const {rows}=await query(`SELECT * FROM api_keys WHERE key_prefix=$1 AND key_hash=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,[prefix,hash]);
  const key=rows[0]; assert(key,401,'API key tidak valid.','API_KEY_INVALID'); assert((key.scopes||[]).includes(scope),403,'Scope API key tidak mencukupi.','API_SCOPE_FORBIDDEN');
  await query('UPDATE api_keys SET last_used_at=now() WHERE id=$1',[key.id]); return key;
}
