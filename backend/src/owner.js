import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { config } from './config.js';
import { AppError, assert } from './errors.js';
import { memberAccount, postSystemTransfer, postTransfer, SYSTEM_ACCOUNTS, verifyLedger } from './ledger.js';
import { audit } from './audit.js';
import { mapRequest } from './member.js';
import { bettingSummary, listAllBets } from './betting.js';
import { requirePermission } from './auth.js';
import { createMemberNotification } from './notifications.js';
import { MONEY_CURRENCY, recordMoneyEvent } from './money.js';

function filterDate(value){if(!value)return'';const date=String(value).trim();const parsed=new Date(`${date}T00:00:00Z`);assert(/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date,400,'Format tanggal tidak valid.','DATE_FILTER_INVALID');return date;}

export async function dashboard(){const [members,pending,approved,refs,betting,approvals,ledger]=await Promise.all([query(`SELECT COUNT(*)::int count FROM users u WHERE NOT EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id)`),query(`SELECT COUNT(*)::int count FROM wallet_requests WHERE status IN('PENDING','AWAITING_SECOND_APPROVAL','PROCESSING')`),query(`SELECT COUNT(*)::int count FROM wallet_requests WHERE status='APPROVED'`),query(`SELECT COUNT(*)::int count FROM referral_relationships WHERE status IN('REGISTERED','QUALIFIED','REWARDED')`),bettingSummary(),query(`SELECT COUNT(*)::int count FROM approval_requests WHERE status='PENDING'`),tx(client=>verifyLedger(client))]);return{members:members.rows[0].count,pending:pending.rows[0].count,approved:approved.rows[0].count,referrals:refs.rows[0].count,pendingApprovals:approvals.rows[0].count,ledgerBalanced:ledger.balanced,betting};}
export async function allWalletRequests({status,type,search='',from='',to='',limit=200,offset=0}={}){
  const v=[];const w=[];
  if(status){v.push(String(status).toUpperCase());w.push(`r.status=$${v.length}`)}
  if(type){v.push(String(type).toUpperCase());w.push(`r.request_type=$${v.length}`)}
  if(search){
    const text=`%${String(search).trim().slice(0,120)}%`;v.push(text);const textIndex=v.length;
    const digits=String(search).replace(/\D/g,'');v.push(digits?`%${digits}%`:'');const digitsIndex=v.length;
    w.push(`(u.username ILIKE $${textIndex} OR r.id::text ILIKE $${textIndex} OR ($${digitsIndex}<>'' AND regexp_replace(r.amount::text,'[^0-9]','','g') ILIKE $${digitsIndex}))`);
  }
  for(const [value,operator] of [[filterDate(from),'>='],[filterDate(to),'<']]){
    if(!value)continue;
    v.push(value);
    w.push(operator==='>='?`r.created_at >= $${v.length}::date`:`r.created_at < $${v.length}::date + interval '1 day'`);
  }
  v.push(Math.min(Number(limit)||200,500));const limitIndex=v.length;
  v.push(Math.max(Number(offset)||0,0));
  const {rows}=await query(`SELECT r.*,u.username FROM wallet_requests r JOIN users u ON u.id=r.member_id ${w.length?`WHERE ${w.join(' AND ')}`:''} ORDER BY r.created_at DESC LIMIT $${limitIndex} OFFSET $${v.length}`,v);
  return rows.map(mapRequest);
}

async function moneyPolicy(client){return (await client.query(`SELECT setting_value FROM system_settings WHERE setting_key='finance.moneyIntegrity'`)).rows[0]?.setting_value||{};}
async function ensureWithdrawalReserved(client,row,actorId){
  if(row.request_type!=='WITHDRAW'||row.funds_state==='RESERVED')return row;
  assert(row.funds_state==='NONE',409,'Status dana withdrawal tidak valid.','WITHDRAW_FUNDS_STATE_INVALID');
  const ledger=await postTransfer(client,{memberId:row.member_id,systemCode:SYSTEM_ACCOUNTS.WITHDRAW_HOLD,memberDelta:-Number(row.amount),type:'WALLET_WITHDRAW_RESERVED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-reserve:${row.id}`,metadata:{legacyReservation:true,payoutSnapshot:row.payout_snapshot||null},actorId});
  await client.query(`UPDATE wallet_requests SET funds_state='RESERVED',held_at=COALESCE(held_at,now()),updated_at=now() WHERE id=$1`,[row.id]);
  await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:'WITHDRAW_RESERVED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId,metadata:{legacyReservation:true,balanceAfter:ledger.after}});
  return{...row,funds_state:'RESERVED',held_at:new Date()};
}
async function releaseWithdrawal(client,row,actorId,reason){
  if(row.request_type!=='WITHDRAW'||row.funds_state!=='RESERVED')return null;
  const ledger=await postTransfer(client,{memberId:row.member_id,systemCode:SYSTEM_ACCOUNTS.WITHDRAW_HOLD,memberDelta:Number(row.amount),type:'WALLET_WITHDRAW_RELEASED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-release:${row.id}`,metadata:{reason},actorId});
  await client.query(`UPDATE wallet_requests SET funds_state='RELEASED',released_at=now(),updated_at=now() WHERE id=$1`,[row.id]);
  await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:'WITHDRAW_RELEASED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId,metadata:{reason,balanceAfter:ledger.after}});
  return ledger;
}
async function executeWallet(client,row,actorId){
  const isDeposit=row.request_type==='DEPOSIT';
  const amount=Number(row.amount);const policy=await moneyPolicy(client);let ledger;let balanceAfter;
  const integration=row.payment_snapshot?.integrationMode||'MANUAL';
  const isManualOverride=Boolean(isDeposit&&integration==='PROVIDER'&&row.provider_status!=='CONFIRMED'&&actorId);
  if(isDeposit){
    if(integration==='PROVIDER'&&policy.requireProviderConfirmation!==false&&!actorId)assert(row.provider_status==='CONFIRMED',409,'Konfirmasi payment provider belum diterima.','PROVIDER_CONFIRMATION_REQUIRED');
    ledger=await postTransfer(client,{memberId:row.member_id,systemCode:SYSTEM_ACCOUNTS.CLEARING,memberDelta:amount,type:'WALLET_DEPOSIT_SETTLED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-settle:${row.id}`,metadata:{requestType:row.request_type,providerCode:row.provider_code||null,providerReference:row.provider_reference||null,manualOverride:isManualOverride},actorId});
    balanceAfter=ledger.after;
  }else{
    row=await ensureWithdrawalReserved(client,row,actorId);
    await postSystemTransfer(client,{fromCode:SYSTEM_ACCOUNTS.WITHDRAW_HOLD,toCode:SYSTEM_ACCOUNTS.CLEARING,amount,type:'WALLET_WITHDRAW_SETTLED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-settle:${row.id}`,metadata:{requestType:row.request_type,payoutSnapshot:row.payout_snapshot||null},actorId});
    balanceAfter=Number((await memberAccount(client,row.member_id,true)).current_balance);
  }
  await client.query(`UPDATE wallet_requests SET status='APPROVED',funds_state='SETTLED',reviewed_by=COALESCE(reviewed_by,$1),reviewed_at=COALESCE(reviewed_at,now()),settled_at=now(),updated_at=now() WHERE id=$2`,[actorId,row.id]);
  await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:isDeposit?'DEPOSIT_SETTLED':'WITHDRAW_SETTLED',amount,currency:row.currency||MONEY_CURRENCY,actorId,metadata:{balanceAfter,providerCode:row.provider_code||null,providerReference:row.provider_reference||null,manualOverride:isManualOverride}});
  await createMemberNotification(client,{memberId:row.member_id,type:isDeposit?'DEPOSIT_APPROVED':'WITHDRAW_APPROVED',title:isDeposit?'Deposit Berhasil Disetujui':'Withdraw Berhasil Disetujui',message:isDeposit?`Saldo sebesar IDR ${amount.toLocaleString('id-ID')} telah masuk ke saldo Anda.`:`Withdraw sebesar IDR ${amount.toLocaleString('id-ID')} telah disetujui dan dana yang sebelumnya ditahan telah diselesaikan.`,amount,referenceType:'WALLET_REQUEST',referenceId:row.id,actionUrl:'history.html',priority:'HIGH',metadata:{requestType:row.request_type,balanceAfter}});
  return{...ledger,balanceAfter,after:balanceAfter};
}

async function assertNoSportsbookSettlementCorrection(client,memberId){
  const pending=(await client.query(`SELECT id,invoice FROM sportsbook_tickets WHERE member_id=$1 AND settlement_correction_pending=true ORDER BY updated_at DESC LIMIT 1`,[memberId])).rows[0];
  if(pending) throw new AppError(409,'Payout withdrawal ditahan karena ada koreksi settlement Sportsbook yang belum terselesaikan.','SPORTSBOOK_SETTLEMENT_CORRECTION_PENDING',{ticketId:pending.id,invoice:pending.invoice||null});
}

async function authorizeWithdrawalPayout(client,row,actorId,{secondApproval=false}={}){
  await assertNoSportsbookSettlementCorrection(client,row.member_id);
  row=await ensureWithdrawalReserved(client,row,actorId);
  assert(row.request_type==='WITHDRAW'&&row.funds_state==='RESERVED',409,'Withdrawal tidak siap untuk payout.','WITHDRAW_PAYOUT_STATE_INVALID');
  await client.query(`UPDATE wallet_requests SET status='PROCESSING',reviewed_by=COALESCE(reviewed_by,$1),reviewed_at=COALESCE(reviewed_at,now()),second_approved_by=CASE WHEN $2::boolean THEN $1 ELSE second_approved_by END,updated_at=now() WHERE id=$3`,[actorId,secondApproval,row.id]);
  await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:secondApproval?'WITHDRAW_SECOND_APPROVAL_AUTHORIZED':'WITHDRAW_AUTHORIZED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId,metadata:{payoutSnapshot:row.payout_snapshot||null}});
  await createMemberNotification(client,{memberId:row.member_id,type:'SYSTEM',title:'Withdraw Sedang Diproses',message:`Withdraw IDR ${Number(row.amount).toLocaleString('id-ID')} telah diotorisasi. Dana tetap ditahan sampai transfer payout dikonfirmasi.`,amount:Number(row.amount),referenceType:'WALLET_REQUEST',referenceId:row.id,actionUrl:'history.html',priority:'HIGH',metadata:{requestType:'WITHDRAW',fundsState:'RESERVED'}});
  return{...row,status:'PROCESSING',funds_state:'RESERVED',second_approved_by:secondApproval?actorId:row.second_approved_by};
}

export async function reviewWallet(session,id,{decision,reason},ip=''){
  requirePermission(session,'wallet:review');const d=String(decision||'').toUpperCase();assert(['APPROVED','REJECTED'].includes(d),400,'Keputusan tidak valid.','DECISION_INVALID');
  return tx(async client=>{
    const row=(await client.query('SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];assert(row,404,'Pengajuan tidak ditemukan.','REQUEST_NOT_FOUND');assert(row.status==='PENDING',409,'Pengajuan sudah diproses.','REQUEST_PROCESSED');
    if(d==='REJECTED'){
      const rejectionReason=String(reason||'').slice(0,250)||'Tidak disetujui';const released=await releaseWithdrawal(client,row,session.userId,rejectionReason);
      await client.query(`UPDATE wallet_requests SET status='REJECTED',funds_state=CASE WHEN request_type='WITHDRAW' AND funds_state='RESERVED' THEN 'RELEASED' ELSE funds_state END,reviewed_by=$1,rejection_reason=$2,reviewed_at=now(),released_at=CASE WHEN request_type='WITHDRAW' THEN COALESCE(released_at,now()) ELSE released_at END,updated_at=now() WHERE id=$3`,[session.userId,rejectionReason,id]);
      await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:'REQUEST_REJECTED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{reason:rejectionReason,balanceAfter:released?.after??null}});
      await createMemberNotification(client,{memberId:row.member_id,type:'WALLET_REJECTED',title:`Pengajuan ${row.request_type==='DEPOSIT'?'Deposit':'Withdraw'} Ditolak`,message:`Pengajuan sebesar IDR ${Number(row.amount).toLocaleString('id-ID')} belum dapat disetujui. ${rejectionReason}`,amount:Number(row.amount),referenceType:'WALLET_REQUEST',referenceId:row.id,actionUrl:'history.html',priority:'NORMAL',metadata:{requestType:row.request_type,reason:rejectionReason,balanceAfter:released?.after??null}});
      await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_REQUEST_REJECTED',targetType:'WALLET_REQUEST',targetId:id,details:{fundsReleased:Boolean(released)},ip,client});return{...mapRequest({...row,status:'REJECTED',rejection_reason:rejectionReason,funds_state:released?'RELEASED':row.funds_state}),approvalRequired:false,balanceAfter:released?.after??null};
    }
    if(Number(row.amount)>=config.highValueThreshold && !session.roles.includes('OWNER')){const approvalId=randomUUID();await client.query(`UPDATE wallet_requests SET status='AWAITING_SECOND_APPROVAL',reviewed_by=$1,reviewed_at=now(),updated_at=now() WHERE id=$2`,[session.userId,id]);await client.query(`INSERT INTO approval_requests(id,action_type,payload,requested_by,expires_at) VALUES($1,'HIGH_VALUE_WALLET',$2::jsonb,$3,now()+make_interval(secs => $4))`,[approvalId,JSON.stringify({walletRequestId:id,requestType:row.request_type,amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,payoutSnapshot:row.payout_snapshot||null,paymentSnapshot:row.payment_snapshot||null,providerCode:row.provider_code||null,providerReference:row.provider_reference||null}),session.userId,config.approvalTtl]);await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:'SECOND_APPROVAL_REQUIRED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{approvalId}});await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_APPROVAL_REQUESTED',targetType:'APPROVAL',targetId:approvalId,details:{walletRequestId:id,amount:Number(row.amount)},ip,client});return{id,status:'AWAITING_SECOND_APPROVAL',approvalRequired:true,approvalId};}
    if(row.request_type==='WITHDRAW'){await authorizeWithdrawalPayout(client,row,session.userId);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_WITHDRAW_AUTHORIZED',targetType:'WALLET_REQUEST',targetId:id,details:{amount:Number(row.amount),fundsState:'RESERVED'},ip,client});return{id,status:'PROCESSING',approvalRequired:false,fundsState:'RESERVED'};}
    const isManualOverride=Boolean(row.request_type==='DEPOSIT'&&(row.payment_snapshot?.integrationMode||'MANUAL')==='PROVIDER'&&row.provider_status!=='CONFIRMED');
    const ledger=await executeWallet(client,row,session.userId);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_REQUEST_APPROVED',targetType:'WALLET_REQUEST',targetId:id,details:{amount:Number(row.amount),balanceAfter:ledger.after,manualOverride:isManualOverride},ip,client});return{id,status:'APPROVED',approvalRequired:false,balanceAfter:ledger.after};
  },{isolation:'SERIALIZABLE'});
}

export async function confirmWithdrawalPayout(session,id,{decision,reference,reason}={},ip=''){
  requirePermission(session,'wallet:review');
  const d=String(decision||'').trim().toUpperCase();
  assert(['PAID','FAILED'].includes(d),400,'Status payout harus PAID atau FAILED.','PAYOUT_DECISION_INVALID');
  const payoutReference=String(reference||'').trim().slice(0,160);
  const why=String(reason||'').trim().slice(0,500);
  if(d==='PAID')assert(payoutReference.length>=4,400,'Reference transfer payout wajib diisi.','PAYOUT_REFERENCE_REQUIRED');
  if(d==='FAILED')assert(why.length>=4,400,'Alasan kegagalan payout wajib diisi.','PAYOUT_FAILURE_REASON_REQUIRED');
  return tx(async client=>{
    const row=(await client.query(`SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    assert(row,404,'Pengajuan tidak ditemukan.','REQUEST_NOT_FOUND');
    assert(row.request_type==='WITHDRAW'&&row.status==='PROCESSING'&&row.funds_state==='RESERVED',409,'Withdrawal tidak sedang menunggu konfirmasi payout.','PAYOUT_STATE_INVALID');
    if(d==='PAID') await assertNoSportsbookSettlementCorrection(client,row.member_id);
    if(d==='FAILED'){
      const released=await releaseWithdrawal(client,row,session.userId,why);
      await client.query(`UPDATE wallet_requests SET status='FAILED',funds_state='RELEASED',provider_status='FAILED',rejection_reason=$1,payout_processed_by=$2,payout_processed_at=now(),released_at=COALESCE(released_at,now()),updated_at=now() WHERE id=$3`,[why,session.userId,id]);
      await recordMoneyEvent(client,{walletRequestId:id,memberId:row.member_id,eventType:'WITHDRAW_PAYOUT_FAILED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{reason:why,balanceAfter:released?.after??null}});
      await createMemberNotification(client,{memberId:row.member_id,type:'WALLET_REJECTED',title:'Payout Withdraw Gagal',message:`Payout withdraw IDR ${Number(row.amount).toLocaleString('id-ID')} gagal diproses dan dana telah dikembalikan ke saldo.`,amount:Number(row.amount),referenceType:'WALLET_REQUEST',referenceId:id,actionUrl:'history.html',priority:'HIGH',metadata:{reason:why,balanceAfter:released?.after??null}});
      await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_WITHDRAW_PAYOUT_FAILED',targetType:'WALLET_REQUEST',targetId:id,details:{reason:why,balanceAfter:released?.after??null},ip,client});
      return{id,status:'FAILED',fundsState:'RELEASED',balanceAfter:released?.after??null};
    }
    const providerCode='MANUAL_PAYOUT';
    const conflict=(await client.query(`SELECT id FROM wallet_requests WHERE provider_code=$1 AND provider_reference=$2 AND id<>$3`,[providerCode,payoutReference,id])).rows[0];
    assert(!conflict,409,'Reference transfer payout sudah digunakan pada transaksi lain.','PAYOUT_REFERENCE_DUPLICATE');
    await client.query(`UPDATE wallet_requests SET provider_code=$1,provider_reference=$2,provider_status='CONFIRMED',payout_processed_by=$3,payout_processed_at=now(),updated_at=now() WHERE id=$4`,[providerCode,payoutReference,session.userId,id]);
    const ledger=await executeWallet(client,{...row,provider_code:providerCode,provider_reference:payoutReference,provider_status:'CONFIRMED'},session.userId);
    await recordMoneyEvent(client,{walletRequestId:id,memberId:row.member_id,eventType:'WITHDRAW_PAYOUT_CONFIRMED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{providerCode,payoutReference,balanceAfter:ledger.after}});
    await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_WITHDRAW_PAYOUT_CONFIRMED',targetType:'WALLET_REQUEST',targetId:id,details:{payoutReference,balanceAfter:ledger.after},ip,client});
    return{id,status:'APPROVED',fundsState:'SETTLED',payoutReference,balanceAfter:ledger.after};
  },{isolation:'SERIALIZABLE'});
}

export async function requestWalletReversal(session,id,{reason},ip=''){
  requirePermission(session,'money:reverse');const why=String(reason||'').trim().slice(0,500);assert(why.length>=8,400,'Alasan reversal wajib diisi dengan jelas.','REVERSAL_REASON_REQUIRED');
  return tx(async client=>{const row=(await client.query(`SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE`,[id])).rows[0];assert(row,404,'Pengajuan tidak ditemukan.','REQUEST_NOT_FOUND');assert(row.status==='APPROVED'&&row.funds_state==='SETTLED',409,'Hanya transaksi settled yang dapat direversal.','REVERSAL_STATE_INVALID');const existing=(await client.query(`SELECT id FROM approval_requests WHERE action_type='WALLET_REVERSAL' AND status IN('PENDING','APPROVED') AND payload->>'walletRequestId'=$1`,[id])).rows[0];assert(!existing,409,'Reversal transaksi ini sudah menunggu persetujuan.','REVERSAL_ALREADY_PENDING');const approvalId=randomUUID();await client.query(`INSERT INTO approval_requests(id,action_type,payload,requested_by,expires_at) VALUES($1,'WALLET_REVERSAL',$2::jsonb,$3,now()+make_interval(secs => $4))`,[approvalId,JSON.stringify({walletRequestId:id,reason:why,requestType:row.request_type,amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,payoutSnapshot:row.payout_snapshot||null,paymentSnapshot:row.payment_snapshot||null,providerCode:row.provider_code||null,providerReference:row.provider_reference||null}),session.userId,config.approvalTtl]);await recordMoneyEvent(client,{walletRequestId:id,memberId:row.member_id,eventType:'REVERSAL_REQUESTED',amount:Number(row.amount),currency:row.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{approvalId,reason:why}});await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_REVERSAL_REQUESTED',targetType:'APPROVAL',targetId:approvalId,details:{walletRequestId:id,reason:why},ip,client});return{id:approvalId,status:'PENDING',walletRequestId:id};},{isolation:'SERIALIZABLE'});
}

async function executeWalletReversal(client,row,actorId,reason){
  assert(row.status==='APPROVED'&&row.funds_state==='SETTLED',409,'Transaksi tidak dapat direversal.','REVERSAL_STATE_INVALID');const amount=Number(row.amount);let ledger;
  if(row.request_type==='DEPOSIT')ledger=await postTransfer(client,{memberId:row.member_id,systemCode:SYSTEM_ACCOUNTS.CLEARING,memberDelta:-amount,type:'WALLET_DEPOSIT_REVERSED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-reverse:${row.id}`,metadata:{reason},actorId});
  else ledger=await postTransfer(client,{memberId:row.member_id,systemCode:SYSTEM_ACCOUNTS.CLEARING,memberDelta:amount,type:'WALLET_WITHDRAW_REVERSED',referenceType:'WALLET_REQUEST',referenceId:row.id,idempotencyKey:`wallet-reverse:${row.id}`,metadata:{reason},actorId});
  await client.query(`UPDATE wallet_requests SET status='REVERSED',funds_state='REVERSED',reversed_at=now(),updated_at=now() WHERE id=$1`,[row.id]);
  await recordMoneyEvent(client,{walletRequestId:row.id,memberId:row.member_id,eventType:`${row.request_type}_REVERSED`,amount,currency:row.currency||MONEY_CURRENCY,actorId,metadata:{reason,balanceAfter:ledger.after}});
  await createMemberNotification(client,{memberId:row.member_id,type:'SYSTEM',title:'Penyesuaian Transaksi',message:`Transaksi ${row.request_type.toLowerCase()} sebesar IDR ${amount.toLocaleString('id-ID')} telah direversal setelah pemeriksaan operasional.`,amount,referenceType:'WALLET_REVERSAL',referenceId:row.id,actionUrl:'history.html',priority:'HIGH',metadata:{reason,balanceAfter:ledger.after}});
  return ledger;
}


async function trustedSettlementResult(db,marketId,period){
  const {rows}=await db.query(`SELECT result,source_name,draw_date,source_updated_at,created_at FROM market_result_history WHERE market_id=$1 AND period=$2 AND (source_name LIKE 'OFFICIAL:%' OR source_name LIKE 'CONSENSUS:%') ORDER BY draw_date DESC NULLS LAST,source_updated_at DESC NULLS LAST,created_at DESC LIMIT 5`,[marketId,period]);
  assert(rows.length>0,409,'Hasil authority terverifikasi untuk periode ini belum tersedia.','TRUSTED_RESULT_NOT_READY');
  const values=[...new Set(rows.map(row=>String(row.result||'')).filter(value=>/^\d{4}$/.test(value)))];
  assert(values.length===1,409,'Authority result untuk periode ini tidak konsisten. Settlement ditahan.','TRUSTED_RESULT_CONFLICT');
  return {result:values[0],sourceName:rows[0].source_name,drawDate:rows[0].draw_date||null};
}
export async function requestSettlement(session,input,mode='SETTLEMENT',ip=''){requirePermission(session,'settlements:request');const marketId=Number(input.marketId);const period=String(input.period||'').trim().slice(0,80);assert(Number.isInteger(marketId)&&period,400,'Pasaran dan periode wajib diisi.','SETTLEMENT_INPUT_INVALID');let result=null,authority=null;if(mode==='SETTLEMENT'){authority=await trustedSettlementResult({query},marketId,period);result=authority.result;if(input.result!==undefined&&String(input.result||'').trim()!=='')assert(String(input.result).trim()===result,409,'Hasil yang dimasukkan tidak sama dengan authority terverifikasi.','SETTLEMENT_RESULT_AUTHORITY_MISMATCH');}const id=randomUUID();await query(`INSERT INTO approval_requests(id,action_type,payload,requested_by,expires_at) VALUES($1,$2,$3::jsonb,$4,now()+make_interval(secs => $5))`,[id,mode==='VOID'?'VOID':'SETTLEMENT',JSON.stringify({marketId,period,result:mode==='SETTLEMENT'?result:null,authoritySource:authority?.sourceName||null,authorityDrawDate:authority?.drawDate||null}),session.userId,config.approvalTtl]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:`${mode}_APPROVAL_REQUESTED`,targetType:'APPROVAL',targetId:id,details:{marketId,period,authoritySource:authority?.sourceName||null},ip});return{id,status:'PENDING',actionType:mode==='VOID'?'VOID':'SETTLEMENT',result:mode==='SETTLEMENT'?result:null,authoritySource:authority?.sourceName||null,expiresAt:new Date(Date.now()+config.approvalTtl*1000).toISOString()};}
export async function listApprovals(session,{status='PENDING',limit=200}={}){requirePermission(session,'approvals:read');const {rows}=await query(`SELECT a.*,rq.username requested_by_username,ap.username approved_by_username FROM approval_requests a JOIN users rq ON rq.id=a.requested_by LEFT JOIN users ap ON ap.id=a.approved_by WHERE ($1='' OR a.status=$1) ORDER BY a.created_at DESC LIMIT $2`,[String(status||'').toUpperCase(),Math.min(Number(limit)||200,500)]);return rows.map(x=>({id:x.id,actionType:x.action_type,payload:x.payload,status:x.status,requestedBy:x.requested_by,requestedByUsername:x.requested_by_username,approvedBy:x.approved_by,approvedByUsername:x.approved_by_username,reason:x.reason,expiresAt:x.expires_at,createdAt:x.created_at,executedAt:x.executed_at}));}
export async function decideApproval(session,id,{decision,reason},ip=''){requirePermission(session,'approvals:approve');const d=String(decision||'').toUpperCase();assert(['APPROVED','REJECTED'].includes(d),400,'Keputusan tidak valid.','DECISION_INVALID');return tx(async client=>{const {rows}=await client.query('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE',[id]);const row=rows[0];assert(row,404,'Persetujuan tidak ditemukan.','APPROVAL_NOT_FOUND');assert(row.status==='PENDING',409,'Persetujuan sudah diproses.','APPROVAL_PROCESSED');assert(new Date(row.expires_at)>new Date(),409,'Persetujuan telah kedaluwarsa.','APPROVAL_EXPIRED');assert(row.requested_by!==session.userId || session.roles.includes('OWNER'),409,'Pembuat permintaan tidak boleh menyetujui tindakannya sendiri.','FOUR_EYES_REQUIRED');if(d==='REJECTED'){const rejectionReason=String(reason||'').slice(0,250)||'Tidak disetujui';await client.query(`UPDATE approval_requests SET status='REJECTED',rejected_by=$1,reason=$2,updated_at=now() WHERE id=$3`,[session.userId,rejectionReason,id]);if(row.action_type==='HIGH_VALUE_WALLET'){const wr=(await client.query('SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE',[row.payload.walletRequestId])).rows[0];if(wr&&wr.status==='AWAITING_SECOND_APPROVAL'){const released=await releaseWithdrawal(client,wr,session.userId,rejectionReason);await client.query(`UPDATE wallet_requests SET status='REJECTED',funds_state=CASE WHEN request_type='WITHDRAW' AND funds_state='RESERVED' THEN 'RELEASED' ELSE funds_state END,rejection_reason=$1,second_approved_by=$2,released_at=CASE WHEN request_type='WITHDRAW' THEN COALESCE(released_at,now()) ELSE released_at END,updated_at=now() WHERE id=$3`,[rejectionReason,session.userId,wr.id]);await recordMoneyEvent(client,{walletRequestId:wr.id,memberId:wr.member_id,eventType:'SECOND_APPROVAL_REJECTED',amount:Number(wr.amount),currency:wr.currency||MONEY_CURRENCY,actorId:session.userId,metadata:{reason:rejectionReason,balanceAfter:released?.after??null}});await createMemberNotification(client,{memberId:wr.member_id,type:'WALLET_REJECTED',title:`Pengajuan ${wr.request_type==='DEPOSIT'?'Deposit':'Withdraw'} Ditolak`,message:`Persetujuan kedua untuk pengajuan IDR ${Number(wr.amount).toLocaleString('id-ID')} ditolak. ${rejectionReason}`,amount:Number(wr.amount),referenceType:'WALLET_REQUEST',referenceId:wr.id,actionUrl:'history.html',priority:'NORMAL',metadata:{requestType:wr.request_type,reason:rejectionReason}});}}await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'APPROVAL_REJECTED',targetType:'APPROVAL',targetId:id,details:{actionType:row.action_type},ip,client});return{id,status:'REJECTED'};}
    await client.query(`UPDATE approval_requests SET status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now() WHERE id=$2`,[session.userId,id]);
    if(row.action_type==='HIGH_VALUE_WALLET'){const wr=(await client.query('SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE',[row.payload.walletRequestId])).rows[0];assert(wr&&wr.status==='AWAITING_SECOND_APPROVAL',409,'Pengajuan saldo tidak dapat diproses.','WALLET_STATE_INVALID');if(wr.request_type==='WITHDRAW'){await authorizeWithdrawalPayout(client,wr,session.userId,{secondApproval:true});await client.query(`UPDATE approval_requests SET status='EXECUTED',executed_at=now(),updated_at=now() WHERE id=$1`,[id]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'HIGH_VALUE_WITHDRAW_AUTHORIZED',targetType:'APPROVAL',targetId:id,details:{walletRequestId:wr.id,amount:Number(wr.amount),fundsState:'RESERVED'},ip,client});return{id,status:'EXECUTED',walletStatus:'PROCESSING',fundsState:'RESERVED'};}const ledger=await executeWallet(client,wr,session.userId);await client.query(`UPDATE wallet_requests SET second_approved_by=$1,updated_at=now() WHERE id=$2`,[session.userId,wr.id]);await client.query(`UPDATE approval_requests SET status='EXECUTED',executed_at=now(),updated_at=now() WHERE id=$1`,[id]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'HIGH_VALUE_WALLET_EXECUTED',targetType:'APPROVAL',targetId:id,details:{walletRequestId:wr.id,balanceAfter:ledger.after},ip,client});return{id,status:'EXECUTED',balanceAfter:ledger.after};}
    if(row.action_type==='WALLET_REVERSAL'){const wr=(await client.query('SELECT * FROM wallet_requests WHERE id=$1 FOR UPDATE',[row.payload.walletRequestId])).rows[0];assert(wr,404,'Transaksi untuk reversal tidak ditemukan.','REQUEST_NOT_FOUND');const ledger=await executeWalletReversal(client,wr,session.userId,String(row.payload.reason||row.reason||'Approved reversal'));await client.query(`UPDATE approval_requests SET status='EXECUTED',executed_at=now(),updated_at=now() WHERE id=$1`,[id]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'WALLET_REVERSAL_EXECUTED',targetType:'APPROVAL',targetId:id,details:{walletRequestId:wr.id,balanceAfter:ledger.after},ip,client});return{id,status:'EXECUTED',balanceAfter:ledger.after};}
    if(row.action_type==='ROLE_CHANGE'){assert(row.payload.userId&&row.payload.roleCode,409,'Payload perubahan role tidak valid.','ROLE_PAYLOAD_INVALID');await client.query(`INSERT INTO user_roles(user_id,role_code,assigned_by) VALUES($1,$2,$3) ON CONFLICT(user_id,role_code) DO NOTHING`,[row.payload.userId,row.payload.roleCode,session.userId]);await client.query(`UPDATE approval_requests SET status='EXECUTED',executed_at=now(),updated_at=now() WHERE id=$1`,[id]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'ROLE_ASSIGNED',targetType:'USER',targetId:row.payload.userId,details:{roleCode:row.payload.roleCode,approvalId:id},ip,client});return{id,status:'EXECUTED'};}
    const mode=row.action_type==='VOID'?'VOID':'SETTLE';if(mode==='SETTLE'){const authority=await trustedSettlementResult(client,Number(row.payload.marketId),String(row.payload.period||''));assert(authority.result===String(row.payload.result||''),409,'Authority result berubah sebelum approval. Settlement dibatalkan.','SETTLEMENT_AUTHORITY_CHANGED');}const runId=randomUUID();await client.query(`INSERT INTO settlement_runs(id,approval_id,market_id,period,result_value,mode,requested_by,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[runId,id,row.payload.marketId,row.payload.period,row.payload.result,mode,row.requested_by,session.userId]);await client.query(`INSERT INTO job_outbox(id,queue_name,payload) VALUES($1,$2,$3::jsonb)`,[randomUUID(),config.queueName,JSON.stringify({runId,approvalId:id,mode,marketId:row.payload.marketId,period:row.payload.period,result:row.payload.result})]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'SETTLEMENT_QUEUED',targetType:'SETTLEMENT_RUN',targetId:runId,details:{mode,marketId:row.payload.marketId,period:row.payload.period},ip,client});return{id,status:'APPROVED',runId,queueStatus:'QUEUED'};},{isolation:'SERIALIZABLE'});}
export async function listMembers(limit=200,{offset=0,search='',status='',membersOnly=false}={}){
  const values=[];const where=[];
  if(membersOnly)where.push(`NOT EXISTS(SELECT 1 FROM user_roles owner_role WHERE owner_role.user_id=u.id)`);
  if(search){values.push(`%${String(search).trim().slice(0,120)}%`);where.push(`(u.username ILIKE $${values.length} OR u.id::text ILIKE $${values.length} OR COALESCE(u.email,'') ILIKE $${values.length} OR COALESCE(u.phone,'') ILIKE $${values.length})`)}
  if(status){values.push(String(status).toUpperCase());where.push(`u.status=$${values.length}`)}
  values.push(Math.min(Number(limit)||200,500));const limitIndex=values.length;
  values.push(Math.max(Number(offset)||0,0));
  const {rows}=await query(`SELECT u.id,u.username,u.email,u.phone,u.status,u.created_at,a.current_balance,COALESCE(jsonb_agg(ur.role_code) FILTER(WHERE ur.role_code IS NOT NULL),'[]'::jsonb) roles FROM users u LEFT JOIN ledger_accounts a ON a.owner_user_id=u.id LEFT JOIN user_roles ur ON ur.user_id=u.id ${where.length?`WHERE ${where.join(' AND ')}`:''} GROUP BY u.id,a.current_balance ORDER BY u.created_at DESC LIMIT $${limitIndex} OFFSET $${values.length}`,values);
  return rows.map(x=>({id:x.id,username:x.username,email:x.email,phone:x.phone,status:x.status,balance:Number(x.current_balance||0),roles:x.roles,createdAt:x.created_at}));
}
export async function auditList(limit=200,{offset=0,search='',from='',to=''}={}){
  const values=[];const where=[];
  if(search){values.push(`%${String(search).trim().slice(0,120)}%`);where.push(`(action ILIKE $${values.length} OR COALESCE(target_type,'') ILIKE $${values.length} OR COALESCE(target_id,'') ILIKE $${values.length})`)}
  for(const [value,operator] of [[filterDate(from),'>='],[filterDate(to),'<']]){
    if(!value)continue;
    values.push(value);
    where.push(operator==='>='?`created_at >= $${values.length}::date`:`created_at < $${values.length}::date + interval '1 day'`);
  }
  values.push(Math.min(Number(limit)||200,1000));const limitIndex=values.length;
  values.push(Math.max(Number(offset)||0,0));
  const {rows}=await query(`SELECT id,actor_id,actor_role,action,target_type,target_id,details,created_at FROM audit_logs ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY created_at DESC LIMIT $${limitIndex} OFFSET $${values.length}`,values);
  return rows.map(x=>({...x,created_at:x.created_at}));
}
export async function referrals(limit=200){const {rows}=await query(`SELECT a.username referrer_username,b.username referred_username,r.invite_code,r.status,r.created_at FROM referral_relationships r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_member_id ORDER BY r.created_at DESC LIMIT $1`,[Math.min(Number(limit)||200,500)]);return rows.map(x=>({referrerUsername:x.referrer_username,referredUsername:x.referred_username,inviteCode:x.invite_code,status:x.status,createdAt:x.created_at}));}
export async function assignRole(session,{userId,roleCode},ip=''){requirePermission(session,'roles:write');assert(roleCode!=='OWNER'||session.roles.includes('OWNER'),403,'Hanya owner yang dapat memberikan role owner.','FORBIDDEN');const id=randomUUID();await query(`INSERT INTO approval_requests(id,action_type,payload,requested_by,expires_at) VALUES($1,'ROLE_CHANGE',$2::jsonb,$3,now()+make_interval(secs => $4))`,[id,JSON.stringify({userId,roleCode}),session.userId,config.approvalTtl]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'ROLE_CHANGE_REQUESTED',targetType:'APPROVAL',targetId:id,details:{userId,roleCode},ip});return{id,status:'PENDING'};}
export { listAllBets };
