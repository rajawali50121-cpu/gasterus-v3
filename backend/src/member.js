import { randomUUID, createHash } from 'node:crypto';
import { query, tx } from './db.js';
import { AppError, assert } from './errors.js';
import { audit } from './audit.js';
import { enforceResponsiblePlay } from './responsible-play.js';
import { postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { fingerprintWalletRequest, MONEY_CURRENCY, recordMoneyEvent } from './money.js';
import { verifyPassword } from './security.js';
import { recordSecurityEvent } from './security-events.js';
import { config } from './config.js';

function walletOutput(r,username=null){return{id:r.id,username:username||r.username,requestType:r.request_type,amount:Number(r.amount),currency:r.currency||MONEY_CURRENCY,note:r.note,status:r.status,fundsState:r.funds_state||'NONE',rejectionReason:r.rejection_reason,paymentMethod:r.payment_snapshot||null,payoutSnapshot:r.payout_snapshot||null,referenceNumber:r.reference_number||null,proofImage:r.proof_image||null,providerCode:r.provider_code||null,providerReference:r.provider_reference||null,providerStatus:r.provider_status||null,createdAt:r.created_at,reviewedAt:r.reviewed_at,heldAt:r.held_at,settledAt:r.settled_at,releasedAt:r.released_at,reversedAt:r.reversed_at,payoutProcessedBy:r.payout_processed_by||null,payoutProcessedAt:r.payout_processed_at||null};}

export async function createWalletRequest(session,input,ip=''){
  const type=String(input.requestType||'').toUpperCase();
  const amount=Number(input.amount);
  const requestKey=String(input.idempotencyKey||'').trim().slice(0,120);
  assert(['DEPOSIT','WITHDRAW'].includes(type),400,'Jenis pengajuan tidak valid.','REQUEST_TYPE_INVALID');
  assert(Number.isSafeInteger(amount)&&amount>=10000&&amount<=200000000,400,'Jumlah pengajuan harus antara 10.000 dan 200.000.000.','REQUEST_AMOUNT_INVALID');
  assert(requestKey.length>=16,400,'Idempotency key transaksi tidak valid. Muat ulang halaman dan coba lagi.','WALLET_IDEMPOTENCY_REQUIRED');
  const note=String(input.note||'').trim().slice(0,250)||null;
  const referenceNumber=String(input.referenceNumber||'').trim().slice(0,120)||null;
  const proofImage=String(input.proofImage||'').trim();
  assert(!proofImage||proofImage.length<=2_500_000,400,'Bukti pembayaran terlalu besar. Maksimal sekitar 2 MB.','PROOF_TOO_LARGE');
  assert(!proofImage||/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(proofImage),400,'Format bukti pembayaran tidak valid.','PROOF_INVALID');

  // Real-money withdrawal requires step-up verification using the member's current password.
  // Verification is intentionally performed before taking the SERIALIZABLE row lock so a slow
  // password KDF does not unnecessarily hold a monetary database lock.
  if(type==='WITHDRAW'){
    const authorizationPassword=String(input.authorizationPassword||'');
    assert(authorizationPassword.length>0,401,'Konfirmasi password diperlukan untuk withdrawal.','TRANSACTION_AUTH_REQUIRED');
    const authUser=(await query(`SELECT id,username,password_hash,status FROM users WHERE id=$1`,[session.userId])).rows[0];
    const valid=Boolean(authUser)&&await verifyPassword(authorizationPassword,authUser.password_hash);
    if(!valid){
      await recordSecurityEvent({memberId:session.userId,channel:'MEMBER',eventType:'WITHDRAW_AUTH_FAILED',severity:'HIGH',usernameHint:authUser?.username||null,ip,details:{requestType:type}});
      assert(false,401,'Konfirmasi password transaksi tidak valid.','TRANSACTION_AUTH_FAILED');
    }
    assert(authUser.status==='ACTIVE',403,'Akun tidak aktif.','ACCOUNT_INACTIVE');
  }

  return tx(async client=>{
    const member=(await client.query(`SELECT id,username,bank_name,account_name,account_number,status FROM users WHERE id=$1 FOR UPDATE`,[session.userId])).rows[0];
    assert(member&&member.status==='ACTIVE',403,'Akun tidak aktif.','ACCOUNT_INACTIVE');
    const duplicate=(await client.query(`SELECT * FROM wallet_requests WHERE member_id=$1 AND request_type=$2 AND request_key=$3`,[session.userId,type,requestKey])).rows[0];
    if(duplicate){
      const expected=fingerprintWalletRequest({requestType:type,amount,paymentMethodId:duplicate.payment_method_id,referenceNumber:duplicate.reference_number,payoutSnapshot:duplicate.payout_snapshot});
      assert(!duplicate.request_fingerprint||duplicate.request_fingerprint===expected,409,'Idempotency key sudah digunakan untuk transaksi berbeda.','IDEMPOTENCY_KEY_REUSED');
      return{...walletOutput(duplicate,member.username),duplicate:true};
    }

    if(type==='WITHDRAW'){
      const pendingCorrection=(await client.query(`SELECT id,invoice FROM sportsbook_tickets WHERE member_id=$1 AND settlement_correction_pending=true ORDER BY updated_at DESC LIMIT 1`,[session.userId])).rows[0];
      if(pendingCorrection) throw new AppError(409,'Withdrawal ditahan sementara karena ada koreksi settlement Sportsbook yang belum terselesaikan.','SPORTSBOOK_SETTLEMENT_CORRECTION_PENDING',{ticketId:pendingCorrection.id,invoice:pendingCorrection.invoice||null});
      const policy=(await client.query(`SELECT setting_value FROM system_settings WHERE setting_key='compliance.withdraw'`)).rows[0]?.setting_value||{};
      if(policy.requireVerifiedKyc===true){const compliance=(await client.query(`SELECT kyc_status FROM member_compliance_profiles WHERE member_id=$1`,[session.userId])).rows[0];assert(compliance?.kyc_status==='VERIFIED',403,'KYC terverifikasi diperlukan sebelum withdrawal.','KYC_REQUIRED_FOR_WITHDRAW');}
    }

    let paymentMethodId=null,paymentSnapshot=null,payoutSnapshot=null;
    if(type==='DEPOSIT'){
      await enforceResponsiblePlay(session.userId,{kind:'DEPOSIT',amount,sessionCreatedAt:session.createdAt,client});
      paymentMethodId=String(input.paymentMethodId||'').trim()||null;
      assert(paymentMethodId,400,'Pilih metode pembayaran deposit.','PAYMENT_METHOD_REQUIRED');
      const method=(await client.query(`SELECT * FROM payment_methods WHERE id=$1 AND is_active=TRUE FOR SHARE`,[paymentMethodId])).rows[0];
      assert(method,400,'Metode pembayaran tidak tersedia.','PAYMENT_METHOD_UNAVAILABLE');
      assert((method.currency||MONEY_CURRENCY)===MONEY_CURRENCY,409,'Currency metode pembayaran tidak sesuai.','PAYMENT_CURRENCY_MISMATCH');
      assert(amount>=Number(method.min_amount)&&amount<=Number(method.max_amount),400,`Nominal deposit untuk ${method.name} harus antara ${Number(method.min_amount).toLocaleString('id-ID')} dan ${Number(method.max_amount).toLocaleString('id-ID')}.`,'PAYMENT_AMOUNT_OUT_OF_RANGE');
      paymentSnapshot={id:method.id,code:method.code,methodType:method.method_type,name:method.name,providerName:method.provider_name,accountName:method.account_name,accountNumber:method.account_number,feeFixed:Number(method.fee_fixed||0),feePercent:Number(method.fee_percent||0),currency:method.currency||MONEY_CURRENCY,integrationMode:method.integration_mode||'MANUAL',providerCode:method.provider_code||null};
    }else{
      assert(member.bank_name&&member.account_name&&member.account_number,409,'Lengkapi rekening withdrawal pada profil sebelum membuat pengajuan.','WITHDRAW_ACCOUNT_REQUIRED');
      payoutSnapshot={bankName:member.bank_name,accountName:member.account_name,accountNumber:member.account_number};
    }

    const fingerprint=fingerprintWalletRequest({requestType:type,amount,paymentMethodId,referenceNumber,payoutSnapshot});
    const id=randomUUID();
    await client.query(`INSERT INTO wallet_requests(id,member_id,request_type,amount,currency,note,payment_method_id,payment_snapshot,payout_snapshot,reference_number,proof_image,request_key,request_fingerprint,funds_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,'NONE')`,[id,session.userId,type,amount,MONEY_CURRENCY,note,paymentMethodId,paymentSnapshot?JSON.stringify(paymentSnapshot):null,payoutSnapshot?JSON.stringify(payoutSnapshot):null,referenceNumber,proofImage||null,requestKey,fingerprint]);

    let balanceAfter=null;
    if(type==='WITHDRAW'){
      const hold=await postTransfer(client,{memberId:session.userId,systemCode:SYSTEM_ACCOUNTS.WITHDRAW_HOLD,memberDelta:-amount,type:'WALLET_WITHDRAW_RESERVED',referenceType:'WALLET_REQUEST',referenceId:id,idempotencyKey:`wallet-reserve:${id}`,metadata:{requestType:type,payoutSnapshot},actorId:session.userId});
      balanceAfter=hold.after;
      await client.query(`UPDATE wallet_requests SET funds_state='RESERVED',held_at=now(),updated_at=now() WHERE id=$1`,[id]);
      await recordMoneyEvent(client,{walletRequestId:id,memberId:session.userId,eventType:'WITHDRAW_RESERVED',amount,actorId:session.userId,metadata:{balanceAfter,payoutSnapshot}});
    }else{
      await recordMoneyEvent(client,{walletRequestId:id,memberId:session.userId,eventType:'DEPOSIT_REQUESTED',amount,actorId:session.userId,metadata:{paymentMethodId,referenceNumber}});
    }
    await audit({actorId:session.userId,actorRole:'MEMBER',action:'WALLET_REQUEST_CREATED',targetType:'WALLET_REQUEST',targetId:id,details:{type,amount,currency:MONEY_CURRENCY,paymentMethodId,requestKey,fundsState:type==='WITHDRAW'?'RESERVED':'NONE'},ip,client});
    const row=(await client.query('SELECT * FROM wallet_requests WHERE id=$1',[id])).rows[0];
    return{...walletOutput(row,member.username),balanceAfter,duplicate:false};
  },{isolation:'SERIALIZABLE'});
}
export async function listMemberRequests(memberId){const {rows}=await query(`SELECT * FROM wallet_requests WHERE member_id=$1 ORDER BY created_at DESC LIMIT 300`,[memberId]);return rows.map(mapRequest);}
export function mapRequest(r){return walletOutput(r);}

export async function referralOverview(memberId,limit=100){const p=await query(`SELECT p.invite_code,ru.username AS referrer_username FROM member_referral_profiles p LEFT JOIN users ru ON ru.id=p.referred_by_member_id WHERE p.member_id=$1`,[memberId]);if(!p.rows[0])throw new AppError(404,'Profil referral tidak tersedia.','REFERRAL_NOT_FOUND');const {rows}=await query(`SELECT u.username,r.status,r.created_at FROM referral_relationships r JOIN users u ON u.id=r.referred_member_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT $2`,[memberId,Math.min(Number(limit)||100,500)]);const counts=await query(`SELECT COUNT(*)::int invited,COUNT(*) FILTER(WHERE status IN('REGISTERED','QUALIFIED','REWARDED'))::int registered,COUNT(*) FILTER(WHERE status IN('QUALIFIED','REWARDED'))::int qualified,COUNT(*) FILTER(WHERE status='REWARDED')::int rewarded FROM referral_relationships WHERE referrer_id=$1`,[memberId]);return{inviteCode:p.rows[0].invite_code,referredBy:p.rows[0].referrer_username?{username:p.rows[0].referrer_username}:null,totals:counts.rows[0],invited:rows.map(x=>({username:x.username,status:x.status,registeredAt:x.created_at}))};}
const MEMBER_HISTORY_TRUST_FILTER = `(source_name LIKE 'OFFICIAL:%' OR source_name LIKE 'CONSENSUS:%' OR source_name='APPROVED_RESULT')`;
const trustedLotteryResult = market => ['VERIFIED','MANUAL_RESOLUTION'].includes(String(market?.verification_status || '')) || (Boolean(config.totoPublishSingleSource) && String(market?.verification_status || '')==='SINGLE_SOURCE' && /^\d{3,6}$/.test(String(market?.result || '')));

export async function numberHistoryMarkets(){const {rows}=await query(`SELECT m.id,m.slug,m.code,m.name,m.result,m.period,m.status,m.updated_at,m.verification_status,COUNT(h.id)::int history_count FROM markets m LEFT JOIN market_result_history h ON h.market_id=m.id AND ${MEMBER_HISTORY_TRUST_FILTER} GROUP BY m.id ORDER BY m.sort_order`);return rows.map(x=>({id:x.id,slug:x.slug,code:x.code,name:x.name,result:trustedLotteryResult(x)?x.result:null,period:x.period,status:x.status==='open'?'ACTIVE':x.status.toUpperCase(),updatedAt:x.updated_at,historyCount:x.history_count}));}
export async function numberHistory(identifier,{limit=20,offset=0}={}){const market=await query(`SELECT * FROM markets WHERE slug=$1 OR code=$1 OR id::text=$1 LIMIT 1`,[String(identifier).slice(0,120)]);if(!market.rows[0])throw new AppError(404,'Pasaran tidak ditemukan.','MARKET_NOT_FOUND');const m=market.rows[0];const l=Math.min(Math.max(Number(limit)||20,1),100),o=Math.max(Number(offset)||0,0);const [items,total]=await Promise.all([query(`SELECT id,period,result,draw_date,draw_time,created_at FROM market_result_history WHERE market_id=$1 AND ${MEMBER_HISTORY_TRUST_FILTER} ORDER BY draw_date DESC NULLS LAST,draw_time DESC NULLS LAST,created_at DESC LIMIT $2 OFFSET $3`,[m.id,l,o]),query(`SELECT COUNT(*)::int count FROM market_result_history WHERE market_id=$1 AND ${MEMBER_HISTORY_TRUST_FILTER}`,[m.id])]);return{items:items.rows.map(x=>({id:x.id,period:x.period,result:x.result,drawDate:x.draw_date,drawTime:x.draw_time,updatedAt:x.created_at})),total:total.rows[0].count,market:{id:m.id,slug:m.slug,code:m.code,name:m.name,result:trustedLotteryResult(m)?m.result:null,period:m.period,status:m.status==='open'?'ACTIVE':m.status.toUpperCase(),updatedAt:m.updated_at}};}
export async function appendMarketHistory({marketId,period,result,drawDate,drawTime,sourceName='SYSTEM',sourceUpdatedAt=new Date(),client=null}){const checksum=createHash('sha256').update([marketId,period,result,drawDate,drawTime,sourceName].join('|')).digest('hex');const db=client||{query};const inserted=await db.query(`INSERT INTO market_result_history(id,market_id,period,result,draw_date,draw_time,source_name,source_updated_at,checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(checksum) DO NOTHING RETURNING id`,[randomUUID(),marketId,period,result,drawDate||null,drawTime||null,sourceName,sourceUpdatedAt,checksum]);return Boolean(inserted.rows[0]);}
