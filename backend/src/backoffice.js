import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { redis } from './redis.js';
import { assert } from './errors.js';
import { audit } from './audit.js';
import { hashPassword } from './security.js';
import { requirePermission } from './auth.js';
import { walletLedger } from './betting.js';

const clean=(value,max=500)=>String(value??'').trim().slice(0,max);
const nullable=(value,max=500)=>clean(value,max)||null;
const flag=value=>value===true||String(value).toLowerCase()==='true';
const integer=(value,fallback=0)=>Number.isSafeInteger(Number(value))?Number(value):fallback;
function dataImage(value,max=2_500_000){const v=clean(value,max);if(!v)return null;assert(/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(v)||/^https?:\/\//i.test(v)||/^\//.test(v),400,'Format gambar tidak valid.','IMAGE_INVALID');return v;}
function safeUrl(value,max=2500){const v=clean(value,max);if(!v)return null;assert(/^https?:\/\//i.test(v)||/^\//.test(v)||/^#/.test(v)||/^[a-z0-9_.-]+\.html(?:[?#].*)?$/i.test(v),400,'URL tidak valid.','URL_INVALID');return v;}

export async function backofficeSummary(){
  const [{rows},series]=await Promise.all([query(`SELECT
    (SELECT COUNT(*)::int FROM users u WHERE NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id)) AS members,
    (SELECT COUNT(*)::int FROM users u WHERE u.status='SUSPENDED' AND NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id)) AS suspended,
    (SELECT COUNT(*)::int FROM wallet_requests WHERE status IN('PENDING','AWAITING_SECOND_APPROVAL','PROCESSING')) AS pending_wallet,
    (SELECT COUNT(*)::int FROM wallet_requests WHERE status='APPROVED') AS transactions_successful,
    (SELECT COUNT(*)::int FROM wallet_requests WHERE status IN('FAILED','REJECTED')) AS transactions_failed,
    (SELECT COALESCE(SUM(amount),0)::bigint FROM wallet_requests WHERE request_type='DEPOSIT' AND status='APPROVED' AND COALESCE(settled_at,reviewed_at)>=date_trunc('day',now())) AS deposits_today,
    (SELECT COALESCE(SUM(amount),0)::bigint FROM wallet_requests WHERE request_type='WITHDRAW' AND status='APPROVED' AND COALESCE(settled_at,reviewed_at)>=date_trunc('day',now())) AS withdraws_today,
    (SELECT COUNT(*)::int FROM payment_methods WHERE is_active) AS payment_methods,
    (SELECT COUNT(*)::int FROM content_banners WHERE is_active AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())) AS live_banners,
    (SELECT COUNT(*)::int FROM promotions WHERE is_active AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())) AS live_promotions`),query(`SELECT to_char(days.day,'YYYY-MM-DD') AS day,
      COALESCE(SUM(w.amount) FILTER(WHERE w.request_type='DEPOSIT' AND w.status='APPROVED'),0)::bigint AS deposits,
      COALESCE(SUM(w.amount) FILTER(WHERE w.request_type='WITHDRAW' AND w.status='APPROVED'),0)::bigint AS withdrawals
      FROM generate_series(date_trunc('day',now())-interval '13 days',date_trunc('day',now()),interval '1 day') AS days(day)
      LEFT JOIN wallet_requests w ON w.created_at>=days.day AND w.created_at<days.day+interval '1 day'
      GROUP BY days.day ORDER BY days.day`)]);
  const r=rows[0];return{members:r.members,suspended:r.suspended,pendingWallet:r.pending_wallet,transactionsSuccessful:r.transactions_successful,transactionsFailed:r.transactions_failed,depositsToday:Number(r.deposits_today||0),withdrawsToday:Number(r.withdraws_today||0),paymentMethods:r.payment_methods,liveBanners:r.live_banners,livePromotions:r.live_promotions,transactionSeries:series.rows.map(row=>({day:row.day,deposits:Number(row.deposits||0),withdrawals:Number(row.withdrawals||0)}))};
}

export async function getMemberDetail(session,id){
  requirePermission(session,'members:read');
  const {rows}=await query(`SELECT u.id,u.username,u.email,u.phone,u.status,u.bank_name,u.account_name,u.account_number,u.created_at,u.updated_at,a.current_balance,
    COALESCE(jsonb_agg(DISTINCT ur.role_code) FILTER(WHERE ur.role_code IS NOT NULL),'[]'::jsonb) roles
    FROM users u LEFT JOIN ledger_accounts a ON a.owner_user_id=u.id LEFT JOIN user_roles ur ON ur.user_id=u.id WHERE u.id=$1 GROUP BY u.id,a.current_balance`,[id]);
  const user=rows[0];assert(user,404,'Member tidak ditemukan.','MEMBER_NOT_FOUND');
  const counts=await query(`SELECT request_type,status,COUNT(*)::int count,COALESCE(SUM(amount),0)::bigint amount FROM wallet_requests WHERE member_id=$1 GROUP BY request_type,status`,[id]);
  return{id:user.id,username:user.username,email:user.email,phone:user.phone,status:user.status,bankName:user.bank_name,accountName:user.account_name,accountNumber:user.account_number,balance:Number(user.current_balance||0),roles:user.roles,createdAt:user.created_at,updatedAt:user.updated_at,walletSummary:counts.rows.map(x=>({requestType:x.request_type,status:x.status,count:x.count,amount:Number(x.amount||0)})),ledger:await walletLedger(id,30)};
}

export async function updateMember(session,id,input,ip=''){
  requirePermission(session,'members:write');
  const current=(await query('SELECT * FROM users WHERE id=$1',[id])).rows[0];assert(current,404,'Member tidak ditemukan.','MEMBER_NOT_FOUND');
  const email=nullable(input.email,160);const phone=nullable(input.phone,30);const bankName=nullable(input.bankName,60);const accountName=nullable(input.accountName,100);const accountNumber=nullable(input.accountNumber,100);
  if(email)assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'Email tidak valid.','EMAIL_INVALID');
  const {rows}=await query(`UPDATE users SET email=$1,phone=$2,bank_name=$3,account_name=$4,account_number=$5,updated_at=now() WHERE id=$6 RETURNING id,username,email,phone,status,bank_name,account_name,account_number,updated_at`,[email,phone,bankName,accountName,accountNumber,id]);
  await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'MEMBER_PROFILE_UPDATED',targetType:'USER',targetId:id,details:{fields:['email','phone','bankName','accountName','accountNumber']},ip});return rows[0];
}

export async function setMemberStatus(session,id,input,ip=''){
  requirePermission(session,'members:write');const status=clean(input.status,20).toUpperCase();assert(['ACTIVE','SUSPENDED'].includes(status),400,'Status member tidak valid.','MEMBER_STATUS_INVALID');
  const {rows}=await query(`UPDATE users SET status=$1,updated_at=now() WHERE id=$2 AND NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id) RETURNING id,username,status`,[status,id]);assert(rows[0],404,'Member tidak ditemukan atau akun pengelola tidak dapat diubah di sini.','MEMBER_NOT_FOUND');
  if(status==='SUSPENDED')await revokeMemberSessions(session,id,ip,false);
  await audit({actorId:session.userId,actorRole:session.roles.join(','),action:`MEMBER_${status}`,targetType:'USER',targetId:id,ip});return rows[0];
}

export async function resetMemberPassword(session,id,input,ip=''){
  requirePermission(session,'members:credential-reset');const password=String(input.password??'');assert(password.length>=10&&password.length<=128,400,'Password baru harus 10-128 karakter.','PASSWORD_INVALID');
  const hash=await hashPassword(password);const {rows}=await query(`UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2 AND NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id) RETURNING id,username`,[hash,id]);assert(rows[0],404,'Member tidak ditemukan.','MEMBER_NOT_FOUND');
  await revokeMemberSessions(session,id,ip,false);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'MEMBER_PASSWORD_RESET',targetType:'USER',targetId:id,ip});return{...rows[0],sessionsRevoked:true};
}

export async function revokeMemberSessions(session,id,ip='',writeAudit=true){
  requirePermission(session,'sessions:revoke');let revoked=0;
  for await (const batch of redis.scanIterator({MATCH:'session:member:*',COUNT:100})) {for(const key of (Array.isArray(batch)?batch:[batch])){const raw=await redis.get(key);if(!raw)continue;try{if(JSON.parse(raw).userId===id){await redis.del(key);revoked++;}}catch{}}}
  if(writeAudit)await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'MEMBER_SESSIONS_REVOKED',targetType:'USER',targetId:id,details:{revoked},ip});return{userId:id,revoked};
}

function mapPayment(x){return{id:x.id,code:x.code,methodType:x.method_type,name:x.name,providerName:x.provider_name,accountName:x.account_name,accountNumber:x.account_number,qrImage:x.qr_image,instructions:x.instructions,minAmount:Number(x.min_amount),maxAmount:Number(x.max_amount),feeFixed:Number(x.fee_fixed),feePercent:Number(x.fee_percent),currency:x.currency||'IDR',integrationMode:x.integration_mode||'MANUAL',providerCode:x.provider_code||null,isActive:x.is_active,sortOrder:x.sort_order,updatedAt:x.updated_at};}
export async function listPaymentMethods(includeInactive=false){const {rows}=await query(`SELECT * FROM payment_methods ${includeInactive?'':'WHERE is_active=TRUE'} ORDER BY sort_order,name`);return rows.map(mapPayment);}
export async function upsertPaymentMethod(session,input,ip=''){
  requirePermission(session,'payments:write');const id=nullable(input.id,60)||randomUUID();const type=clean(input.methodType,20).toUpperCase();assert(['BANK','QRIS','EWALLET'].includes(type),400,'Jenis metode pembayaran tidak valid.','PAYMENT_TYPE_INVALID');const name=clean(input.name,100);assert(name,400,'Nama metode pembayaran wajib diisi.','PAYMENT_NAME_REQUIRED');
  const code=(clean(input.code,60)||`${type}-${name}`).toUpperCase().replace(/[^A-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);assert(code,400,'Kode metode pembayaran tidak valid.','PAYMENT_CODE_INVALID');
  const min=Math.max(0,integer(input.minAmount,10000));const max=Math.max(min,integer(input.maxAmount,200000000));const feeFixed=Math.max(0,integer(input.feeFixed,0));const feePercent=Math.max(0,Math.min(100,Number(input.feePercent)||0));const qr=dataImage(input.qrImage);const currency=clean(input.currency||'IDR',3).toUpperCase();assert(currency==='IDR',400,'Versi ini hanya mengizinkan currency IDR untuk transaksi uang nyata.','PAYMENT_CURRENCY_INVALID');const integrationMode=clean(input.integrationMode||'MANUAL',20).toUpperCase();assert(['MANUAL','PROVIDER'].includes(integrationMode),400,'Integration mode tidak valid.','PAYMENT_INTEGRATION_INVALID');const providerCode=nullable(input.providerCode,60)?.toUpperCase()||null;if(integrationMode==='PROVIDER')assert(providerCode,400,'Provider code wajib untuk mode PROVIDER.','PAYMENT_PROVIDER_CODE_REQUIRED');
  const {rows}=await query(`INSERT INTO payment_methods(id,code,method_type,name,provider_name,account_name,account_number,qr_image,instructions,min_amount,max_amount,fee_fixed,fee_percent,currency,integration_mode,provider_code,is_active,sort_order,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,method_type=excluded.method_type,name=excluded.name,provider_name=excluded.provider_name,account_name=excluded.account_name,account_number=excluded.account_number,qr_image=excluded.qr_image,instructions=excluded.instructions,min_amount=excluded.min_amount,max_amount=excluded.max_amount,fee_fixed=excluded.fee_fixed,fee_percent=excluded.fee_percent,currency=excluded.currency,integration_mode=excluded.integration_mode,provider_code=excluded.provider_code,is_active=excluded.is_active,sort_order=excluded.sort_order,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,[id,code,type,name,nullable(input.providerName,100),nullable(input.accountName,100),nullable(input.accountNumber,120),qr,nullable(input.instructions,1500),min,max,feeFixed,feePercent,currency,integrationMode,providerCode,input.isActive===undefined?true:flag(input.isActive),integer(input.sortOrder,100),session.userId]);
  await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'PAYMENT_METHOD_UPSERTED',targetType:'PAYMENT_METHOD',targetId:id,details:{code,type,name},ip});return mapPayment(rows[0]);
}
export async function setPaymentMethodActive(session,id,input,ip=''){requirePermission(session,'payments:write');const {rows}=await query('UPDATE payment_methods SET is_active=$1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *',[flag(input.isActive),session.userId,id]);assert(rows[0],404,'Metode pembayaran tidak ditemukan.','PAYMENT_METHOD_NOT_FOUND');await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'PAYMENT_METHOD_STATUS_CHANGED',targetType:'PAYMENT_METHOD',targetId:id,details:{isActive:rows[0].is_active},ip});return mapPayment(rows[0]);}

function mapBanner(x){return{id:x.id,placement:x.placement,title:x.title,subtitle:x.subtitle,imageUrl:x.image_url,targetUrl:x.target_url,buttonLabel:x.button_label,isActive:x.is_active,sortOrder:x.sort_order,startsAt:x.starts_at,endsAt:x.ends_at,updatedAt:x.updated_at};}
export async function listBanners(includeInactive=false,placement=''){const vals=[];const where=[];if(!includeInactive)where.push(`is_active=TRUE AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`);if(placement){vals.push(clean(placement,30).toUpperCase());where.push(`placement=$${vals.length}`)}const {rows}=await query(`SELECT * FROM content_banners ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY sort_order,created_at`,vals);return rows.map(mapBanner);}
export async function upsertBanner(session,input,ip=''){requirePermission(session,'content:write');const id=nullable(input.id,60)||randomUUID();const placement=clean(input.placement,30).toUpperCase()||'HERO';assert(['HERO','MEMBER_HOME','DEPOSIT','MOBILE'].includes(placement),400,'Placement banner tidak valid.','BANNER_PLACEMENT_INVALID');const title=clean(input.title,160);assert(title,400,'Judul banner wajib diisi.','BANNER_TITLE_REQUIRED');const image=dataImage(input.imageUrl);assert(image,400,'Gambar banner wajib diisi.','BANNER_IMAGE_REQUIRED');const {rows}=await query(`INSERT INTO content_banners(id,placement,title,subtitle,image_url,target_url,button_label,is_active,sort_order,starts_at,ends_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
 ON CONFLICT(id) DO UPDATE SET placement=excluded.placement,title=excluded.title,subtitle=excluded.subtitle,image_url=excluded.image_url,target_url=excluded.target_url,button_label=excluded.button_label,is_active=excluded.is_active,sort_order=excluded.sort_order,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,[id,placement,title,nullable(input.subtitle,500),image,safeUrl(input.targetUrl),nullable(input.buttonLabel,60),input.isActive===undefined?true:flag(input.isActive),integer(input.sortOrder,100),input.startsAt||null,input.endsAt||null,session.userId]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'BANNER_UPSERTED',targetType:'BANNER',targetId:id,details:{placement,title},ip});return mapBanner(rows[0]);}
export async function deleteBanner(session,id,ip=''){requirePermission(session,'content:write');const {rows}=await query('DELETE FROM content_banners WHERE id=$1 RETURNING id,title',[id]);assert(rows[0],404,'Banner tidak ditemukan.','BANNER_NOT_FOUND');await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'BANNER_DELETED',targetType:'BANNER',targetId:id,details:{title:rows[0].title},ip});return{deleted:true,id};}

function mapPromo(x){return{id:x.id,title:x.title,summary:x.summary,body:x.body,imageUrl:x.image_url,targetUrl:x.target_url,promoCode:x.promo_code,isActive:x.is_active,sortOrder:x.sort_order,startsAt:x.starts_at,endsAt:x.ends_at,updatedAt:x.updated_at};}
export async function listPromotions(includeInactive=false){const {rows}=await query(`SELECT * FROM promotions ${includeInactive?'':'WHERE is_active=TRUE AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())'} ORDER BY sort_order,created_at`);return rows.map(mapPromo);}
export async function upsertPromotion(session,input,ip=''){requirePermission(session,'content:write');const id=nullable(input.id,60)||randomUUID();const title=clean(input.title,160);assert(title,400,'Judul promo wajib diisi.','PROMO_TITLE_REQUIRED');const {rows}=await query(`INSERT INTO promotions(id,title,summary,body,image_url,target_url,promo_code,is_active,sort_order,starts_at,ends_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
 ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,body=excluded.body,image_url=excluded.image_url,target_url=excluded.target_url,promo_code=excluded.promo_code,is_active=excluded.is_active,sort_order=excluded.sort_order,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,[id,title,nullable(input.summary,500),nullable(input.body,5000),dataImage(input.imageUrl),safeUrl(input.targetUrl),nullable(input.promoCode,80),input.isActive===undefined?true:flag(input.isActive),integer(input.sortOrder,100),input.startsAt||null,input.endsAt||null,session.userId]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'PROMOTION_UPSERTED',targetType:'PROMOTION',targetId:id,details:{title},ip});return mapPromo(rows[0]);}
export async function deletePromotion(session,id,ip=''){requirePermission(session,'content:write');const {rows}=await query('DELETE FROM promotions WHERE id=$1 RETURNING id,title',[id]);assert(rows[0],404,'Promo tidak ditemukan.','PROMO_NOT_FOUND');await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'PROMOTION_DELETED',targetType:'PROMOTION',targetId:id,details:{title:rows[0].title},ip});return{deleted:true,id};}

export async function listSettings(session){requirePermission(session,'settings:write');const {rows}=await query('SELECT setting_key,setting_value,description,is_public,updated_at FROM system_settings ORDER BY setting_key');return rows.map(x=>({key:x.setting_key,value:x.setting_value,description:x.description,isPublic:x.is_public,updatedAt:x.updated_at}));}
export async function saveSetting(session,key,input,ip=''){requirePermission(session,'settings:write');const k=clean(key,120);assert(/^[a-z0-9._-]{3,120}$/i.test(k),400,'Kunci setting tidak valid.','SETTING_KEY_INVALID');const value=input.value??{};assert(value!==undefined,400,'Value setting wajib diisi.','SETTING_VALUE_REQUIRED');const {rows}=await query(`INSERT INTO system_settings(setting_key,setting_value,description,is_public,updated_by) VALUES($1,$2::jsonb,$3,$4,$5) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,description=COALESCE(excluded.description,system_settings.description),is_public=excluded.is_public,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,[k,JSON.stringify(value),nullable(input.description,500),flag(input.isPublic),session.userId]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'SYSTEM_SETTING_UPDATED',targetType:'SETTING',targetId:k,ip});return{key:rows[0].setting_key,value:rows[0].setting_value,description:rows[0].description,isPublic:rows[0].is_public,updatedAt:rows[0].updated_at};}

export async function publicSiteConfig(){const [banners,promotions,settings]=await Promise.all([listBanners(false),listPromotions(false),query(`SELECT setting_key,setting_value FROM system_settings WHERE is_public=TRUE`)]);return{banners,promotions,settings:Object.fromEntries(settings.rows.map(x=>[x.setting_key,x.setting_value]))};}
export async function publicDepositConfig(){const [paymentMethods,setting]=await Promise.all([listPaymentMethods(false),query(`SELECT setting_value FROM system_settings WHERE setting_key='finance.deposit' AND is_public=TRUE`)]);return{paymentMethods,settings:{'finance.deposit':setting.rows[0]?.setting_value||{enabled:true,notice:'Pilih metode pembayaran aktif dan kirim bukti pembayaran.'}}};}
