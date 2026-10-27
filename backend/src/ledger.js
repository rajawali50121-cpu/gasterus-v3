import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { logger } from './logger.js';

// ============================================================================
// DEADLOCK RETRY CONFIGURATION
// PostgreSQL error code 40P01 = deadlock_detected
// ============================================================================
const DEADLOCK_ERROR_CODE = '40P01';
const MAX_DEADLOCK_RETRIES = 3;
const DEADLOCK_RETRY_BASE_MS = 50;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withDeadlockRetry(operationName, operation) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_DEADLOCK_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isDeadlock = error.code === DEADLOCK_ERROR_CODE 
        || error.message?.includes('deadlock detected');
      
      if (!isDeadlock || attempt === MAX_DEADLOCK_RETRIES) {
        throw error;
      }
      
      lastError = error;
      const delay = DEADLOCK_RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(`[LEDGER] Deadlock detected in ${operationName}, retrying (attempt ${attempt + 1}/${MAX_DEADLOCK_RETRIES})`, {
        operation: operationName,
        attempt: attempt + 1,
        delay,
        error: error.message
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

export const SYSTEM_ACCOUNTS={
  CLEARING:'SYSTEM:CLEARING',
  BET_HOLD:'SYSTEM:BET_HOLD',
  CASINO_HOLD:'SYSTEM:CASINO_HOLD',
  SPORTSBOOK_HOLD:'SYSTEM:SPORTSBOOK_HOLD',
  WITHDRAW_HOLD:'SYSTEM:WITHDRAW_HOLD',
  PRIZE_POOL:'SYSTEM:PRIZE_POOL'
};
export async function ensureSystemAccounts(client) {
  for(const code of Object.values(SYSTEM_ACCOUNTS)){
    await client.query(`INSERT INTO ledger_accounts(id,account_code,account_type,current_balance) VALUES($1,$2,'SYSTEM',0) ON CONFLICT(account_code) DO NOTHING`,[randomUUID(),code]);
  }
}
export async function memberAccount(client,memberId,lock=false) {
  const {rows}=await client.query(`SELECT * FROM ledger_accounts WHERE owner_user_id=$1 ${lock?'FOR UPDATE':''}`,[memberId]);
  if(!rows[0])throw new AppError(409,'Akun saldo tidak tersedia.','LEDGER_ACCOUNT_MISSING');
  return rows[0];
}
async function accountByCode(client,code,lock=true){const {rows}=await client.query(`SELECT * FROM ledger_accounts WHERE account_code=$1 ${lock?'FOR UPDATE':''}`,[code]);if(!rows[0])throw new AppError(500,'Akun sistem tidak tersedia.','SYSTEM_ACCOUNT_MISSING');return rows[0];}
export async function postTransfer(client,{memberId,systemCode,memberDelta,type,referenceType,referenceId,idempotencyKey=null,metadata={},actorId=null}) {
  return withDeadlockRetry('postTransfer', async () => {
    assert(Number.isSafeInteger(memberDelta)&&memberDelta!==0,500,'Nilai ledger tidak valid.','LEDGER_AMOUNT_INVALID');
    await ensureSystemAccounts(client);
    // Member account is always locked before the system account to keep lock order deterministic.
    const member=await memberAccount(client,memberId,true); const system=await accountByCode(client,systemCode,true);
    const memberAfter=Number(member.current_balance)+memberDelta; const systemDelta=-memberDelta; const systemAfter=Number(system.current_balance)+systemDelta;
    assert(memberAfter>=0,409,'Saldo tidak mencukupi.','INSUFFICIENT_BALANCE');
    const transactionId=randomUUID();
    const inserted=await client.query(`INSERT INTO ledger_transactions(id,transaction_type,reference_type,reference_id,idempotency_key,metadata,created_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING id`,[transactionId,type,referenceType,String(referenceId),idempotencyKey,JSON.stringify(metadata),actorId]);
    if(!inserted.rows[0]){const existing=await client.query(`SELECT id FROM ledger_transactions WHERE ($1::text IS NOT NULL AND idempotency_key=$1) OR (transaction_type=$2 AND reference_type=$3 AND reference_id=$4) LIMIT 1`,[idempotencyKey,type,referenceType,String(referenceId)]);return {duplicate:true,transactionId:existing.rows[0]?.id,before:Number(member.current_balance),after:Number(member.current_balance)};}
    await client.query('UPDATE ledger_accounts SET current_balance=$1,updated_at=now() WHERE id=$2',[memberAfter,member.id]);
    await client.query('UPDATE ledger_accounts SET current_balance=$1,updated_at=now() WHERE id=$2',[systemAfter,system.id]);
    await client.query(`INSERT INTO ledger_entries(id,transaction_id,account_id,amount_signed,balance_before,balance_after) VALUES
      ($1,$2,$3,$4,$5,$6),($7,$2,$8,$9,$10,$11)`,[randomUUID(),transactionId,member.id,memberDelta,Number(member.current_balance),memberAfter,randomUUID(),system.id,systemDelta,Number(system.current_balance),systemAfter]);
    return {transactionId,before:Number(member.current_balance),after:memberAfter};
  });
}
export async function verifyLedger(client) {
  const imbalance=await client.query(`SELECT t.id transaction_id,COUNT(e.id)::int entry_count,COALESCE(SUM(e.amount_signed),0)::bigint AS total FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.id GROUP BY t.id HAVING COUNT(e.id)<2 OR COALESCE(SUM(e.amount_signed),0)<>0 LIMIT 20`);
  const arithmetic=await client.query(`SELECT id,transaction_id,balance_before,amount_signed,balance_after FROM ledger_entries WHERE balance_after<>balance_before+amount_signed LIMIT 20`);
  const drift=await client.query(`SELECT a.id,a.account_code,a.current_balance,COALESCE(SUM(e.amount_signed),0)::bigint AS calculated
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.current_balance<>COALESCE(SUM(e.amount_signed),0) LIMIT 20`);
  return {balanced:imbalance.rowCount===0&&arithmetic.rowCount===0&&drift.rowCount===0,imbalancedTransactions:imbalance.rows,arithmeticErrors:arithmetic.rows,accountDrift:drift.rows};
}
export async function postSystemTransfer(client,{fromCode,toCode,amount,type,referenceType,referenceId,idempotencyKey=null,metadata={},actorId=null}) {
  return withDeadlockRetry('postSystemTransfer', async () => {
    assert(Number.isSafeInteger(amount)&&amount>0,500,'Nilai ledger tidak valid.','LEDGER_AMOUNT_INVALID');
    await ensureSystemAccounts(client);
    const codes=[fromCode,toCode].sort();const locked={};for(const code of codes)locked[code]=await accountByCode(client,code,true);
    const from=locked[fromCode],to=locked[toCode];const fromAfter=Number(from.current_balance)-amount,toAfter=Number(to.current_balance)+amount;
    if(fromCode===SYSTEM_ACCOUNTS.WITHDRAW_HOLD)assert(fromAfter>=0,409,'Dana withdrawal yang ditahan tidak mencukupi.','WITHDRAW_HOLD_INSUFFICIENT');
    const transactionId=randomUUID();
    const inserted=await client.query(`INSERT INTO ledger_transactions(id,transaction_type,reference_type,reference_id,idempotency_key,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING id`,[transactionId,type,referenceType,String(referenceId),idempotencyKey,JSON.stringify(metadata),actorId]);
    if(!inserted.rows[0]){const existing=await client.query(`SELECT id FROM ledger_transactions WHERE ($1::text IS NOT NULL AND idempotency_key=$1) OR (transaction_type=$2 AND reference_type=$3 AND reference_id=$4) LIMIT 1`,[idempotencyKey,type,referenceType,String(referenceId)]);return{duplicate:true,transactionId:existing.rows[0]?.id};}
    await client.query('UPDATE ledger_accounts SET current_balance=$1,updated_at=now() WHERE id=$2',[fromAfter,from.id]);await client.query('UPDATE ledger_accounts SET current_balance=$1,updated_at=now() WHERE id=$2',[toAfter,to.id]);
    await client.query(`INSERT INTO ledger_entries(id,transaction_id,account_id,amount_signed,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6),($7,$2,$8,$9,$10,$11)`,[randomUUID(),transactionId,from.id,-amount,Number(from.current_balance),fromAfter,randomUUID(),to.id,amount,Number(to.current_balance),toAfter]);return{transactionId};
  });
}
