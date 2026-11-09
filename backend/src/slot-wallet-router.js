import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { tx } from './db.js';
import { AppError } from './errors.js';
import { memberAccount, postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { MONEY_CURRENCY } from './money.js';
import { logger } from './logger.js';

const PROVIDER_CODE = 'GITSLOTPARK';
const SIGNING_FIELDS = Object.freeze({
  GETBALANCE: ['agentID', 'userID', 'gameID'],
  WITHDRAW: ['agentID', 'userID', 'amount', 'transactionID', 'roundID', 'gameID'],
  DEPOSIT: ['agentID', 'userID', 'amount', 'refTransactionID', 'transactionID', 'roundID', 'gameID'],
  BETWIN: ['agentID', 'userID', 'betAmount', 'winAmount', 'transactionID', 'roundID', 'gameID'],
  ROLLBACKTRANSACTION: ['agentID', 'userID', 'refTransactionID', 'gameID']
});
const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);

function amountParts(value) {
  const source = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  const match = source.match(/^(\d{1,15})(?:\.(\d{1,2}))?$/);
  if (!match) throw new AppError(400, 'Nominal harus berupa angka positif dengan maksimal dua desimal.', 'SLOT_AMOUNT_INVALID');
  const fraction = (match[2] || '').padEnd(2, '0');
  const cents = Number(`${match[1]}${fraction}`);
  const wholeAmount = Number(match[1]);
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(wholeAmount)) {
    throw new AppError(400, 'Nominal transaksi tidak valid.', 'SLOT_AMOUNT_INVALID');
  }
  return {
    formatted: `${wholeAmount}.${fraction}`,
    wholeAmount: fraction === '00' ? wholeAmount : null
  };
}

function canonicalValue(field, payload) {
  if (field === 'amount' || field === 'betAmount' || field === 'winAmount') {
    return amountParts(payload[field]).formatted;
  }
  return String(payload[field] ?? '');
}

export function createSlotSignature(operation, payload, secret = config.slotCallbackSigningKey, { includeGameId = true } = {}) {
  const fields = SIGNING_FIELDS[String(operation).toUpperCase()];
  if (!fields) throw new AppError(400, 'Operasi callback tidak dikenal.', 'SLOT_OPERATION_INVALID');
  const signedFields = includeGameId ? fields : fields.filter(field => field !== 'gameID');
  const data = signedFields.map(field => canonicalValue(field, payload)).join('');
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

function signatureMatches(operation, payload) {
  if (!config.slotCallbackSigningKey) return false;
  const supplied = clean(payload?.sign, 64).toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(supplied)) return false;
  let candidates;
  try {
    candidates = [createSlotSignature(operation, payload)];
    if (SIGNING_FIELDS[operation].includes('gameID')) {
      candidates.push(createSlotSignature(operation, payload, config.slotCallbackSigningKey, { includeGameId: false }));
    }
  } catch {
    return false;
  }
  const providedBytes = Buffer.from(supplied, 'hex');
  return candidates.some(expected => timingSafeEqual(providedBytes, Buffer.from(expected, 'hex')));
}

function result(code, message = '', fields = {}) {
  return { code, message, ...fields };
}

function normalizeOperation(operation) {
  const normalized = String(operation ?? '').replace(/[^a-z]/gi, '').toUpperCase();
  const aliases = {
    BALANCE: 'GETBALANCE',
    DEBIT: 'WITHDRAW',
    CREDIT: 'DEPOSIT',
    ROLLBACK: 'ROLLBACKTRANSACTION'
  };
  return aliases[normalized] || normalized;
}

function validCommonFields(payload) {
  const userID = clean(payload?.userID, 48);
  const gameID = Number(payload?.gameID);
  return /^[A-Za-z0-9]{4,48}$/.test(userID) &&
    Number.isSafeInteger(gameID) && gameID > 0 &&
    clean(payload?.agentID, 80).length > 0;
}

function validTransactionFields(operation, payload) {
  const transactionID = clean(payload?.transactionID, 160);
  const roundID = clean(payload?.roundID, 160);
  if (operation === 'WITHDRAW') {
    return Boolean(transactionID && roundID) && amountParts(payload?.amount).wholeAmount > 0;
  }
  if (operation === 'DEPOSIT') {
    return Boolean(transactionID && roundID && clean(payload?.refTransactionID, 160)) &&
      amountParts(payload?.amount).wholeAmount > 0;
  }
  if (operation === 'BETWIN') {
    return Boolean(transactionID && roundID) &&
      amountParts(payload?.betAmount).wholeAmount !== null &&
      amountParts(payload?.winAmount).wholeAmount !== null &&
      (amountParts(payload?.betAmount).wholeAmount > 0 || amountParts(payload?.winAmount).wholeAmount > 0);
  }
  if (operation === 'ROLLBACKTRANSACTION') {
    return Boolean(clean(payload?.refTransactionID, 160));
  }
  return true;
}

async function findMember(client, providerUserId) {
  const compactId = providerUserId.startsWith('g') ? providerUserId.slice(1) : providerUserId;
  const { rows } = await client.query(
    `SELECT id,status FROM users
      WHERE username=$1 OR replace(lower(id::text),'-','')=$2
      LIMIT 1 FOR UPDATE`,
    [providerUserId, compactId.toLowerCase()]
  );
  const member = rows[0];
  if (!member || member.status !== 'ACTIVE') return null;
  return member;
}

function currentBalance(account) {
  return Number(account.current_balance);
}

async function lockMemberAccount(client, member) {
  const account = await memberAccount(client, member.id, true);
  if (account.status !== 'ACTIVE') throw new AppError(409, 'Akun saldo tidak aktif.', 'SLOT_ACCOUNT_INACTIVE');
  return account;
}

function parseGameId(payload) {
  const gameID = Number(payload?.gameID);
  if (!Number.isSafeInteger(gameID) || gameID < 1) {
    throw new AppError(400, 'Kode game tidak valid.', 'SLOT_GAME_INVALID');
  }
  return gameID;
}

async function readBalance(operation, payload, transaction) {
  return transaction(async client => {
    const member = await findMember(client, clean(payload.userID, 48));
    if (!member) return result(5, 'User ID not found.');
    const account = await memberAccount(client, member.id);
    if (account.status !== 'ACTIVE') return result(1, 'Wallet account is inactive.');
    return result(0, '', { balance: currentBalance(account) });
  });
}

async function applyWalletTransaction(operation, payload, transaction, transfer) {
  const transactionID = clean(payload.transactionID, 160);
  const gameID = parseGameId(payload);
  const roundID = clean(payload.roundID, 160);

  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${PROVIDER_CODE}:${transactionID}`]);
    const member = await findMember(client, clean(payload.userID, 48));
    if (!member) return result(5, 'User ID not found.');
    const account = await lockMemberAccount(client, member);
    const duplicate = await client.query(
      'SELECT id FROM slot_wallet_transactions WHERE provider_code=$1 AND transaction_id=$2',
      [PROVIDER_CODE, transactionID]
    );
    if (duplicate.rows[0]) {
      return result(11, 'Duplicate transaction.');
    }
    if (operation === 'DEPOSIT') {
      const reference = await client.query(
        `SELECT member_id,event_type,game_id FROM slot_wallet_transactions
          WHERE provider_code=$1 AND transaction_id=$2
          FOR UPDATE`,
        [PROVIDER_CODE, clean(payload.refTransactionID, 160)]
      );
      if (!reference.rows[0] || reference.rows[0].member_id !== member.id ||
          reference.rows[0].event_type !== 'WITHDRAW' || Number(reference.rows[0].game_id) !== gameID) {
        return result(8, 'Could not find reference transaction id.');
      }
      const rolledBack = await client.query(
        `SELECT id FROM slot_wallet_transactions
          WHERE provider_code=$1 AND event_type='ROLLBACK' AND reference_transaction_id=$2`,
        [PROVIDER_CODE, clean(payload.refTransactionID, 160)]
      );
      if (rolledBack.rows[0]) return result(8, 'Could not find reference transaction id.');
    }

    let debitAmount = 0;
    let creditAmount = 0;
    if (operation === 'WITHDRAW') debitAmount = amountParts(payload.amount).wholeAmount;
    if (operation === 'DEPOSIT') creditAmount = amountParts(payload.amount).wholeAmount;
    if (operation === 'BETWIN') {
      debitAmount = amountParts(payload.betAmount).wholeAmount;
      creditAmount = amountParts(payload.winAmount).wholeAmount;
    }

    const platformTransactionID = randomUUID();
    const metadata = {
      providerCode: PROVIDER_CODE,
      gameID,
      roundID,
      transactionID,
      refTransactionID: clean(payload.refTransactionID, 160) || null,
      currency: MONEY_CURRENCY
    };
    if (debitAmount > 0) {
      await transfer(client, {
        memberId: member.id,
        systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD,
        memberDelta: -debitAmount,
        type: 'CASINO_BET',
        referenceType: 'SLOT_CALLBACK',
        referenceId: `${transactionID}:DEBIT`,
        idempotencyKey: `slot:${transactionID}:debit`,
        metadata
      });
    }
    if (creditAmount > 0) {
      await transfer(client, {
        memberId: member.id,
        systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD,
        memberDelta: creditAmount,
        type: 'CASINO_WIN',
        referenceType: 'SLOT_CALLBACK',
        referenceId: `${transactionID}:CREDIT`,
        idempotencyKey: `slot:${transactionID}:credit`,
        metadata
      });
    }

    const updatedAccount = await memberAccount(client, member.id);
    await client.query(
      `INSERT INTO slot_wallet_transactions
        (id,provider_code,transaction_id,reference_transaction_id,member_id,event_type,game_id,round_id,
         debit_amount,credit_amount,member_delta,currency_code,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [
        platformTransactionID, PROVIDER_CODE, transactionID,
        clean(payload.refTransactionID, 160) || null, member.id, operation, gameID, roundID,
        debitAmount, creditAmount, creditAmount - debitAmount, MONEY_CURRENCY,
        JSON.stringify({ ...metadata, userID: clean(payload.userID, 48) })
      ]
    );
    return result(0, '', {
      platformTransactionID,
      balance: currentBalance(updatedAccount)
    });
  });
}

async function rollbackTransaction(payload, transaction, transfer) {
  const referenceID = clean(payload.refTransactionID, 160);
  const gameID = parseGameId(payload);
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${PROVIDER_CODE}:rollback:${referenceID}`]);
    const member = await findMember(client, clean(payload.userID, 48));
    if (!member) return result(5, 'User ID not found.');
    const account = await lockMemberAccount(client, member);
    const source = await client.query(
      `SELECT * FROM slot_wallet_transactions
        WHERE provider_code=$1 AND transaction_id=$2 AND member_id=$3
        FOR UPDATE`,
      [PROVIDER_CODE, referenceID, member.id]
    );
    if (!source.rows[0] || source.rows[0].event_type === 'ROLLBACK' || Number(source.rows[0].game_id) !== gameID) {
      return result(8, 'Could not find reference transaction id.');
    }
    const priorRollback = await client.query(
      `SELECT id FROM slot_wallet_transactions
        WHERE provider_code=$1 AND event_type='ROLLBACK' AND reference_transaction_id=$2`,
      [PROVIDER_CODE, referenceID]
    );
    if (priorRollback.rows[0]) return result(9, 'Transaction is already rolled back.');

    const memberDelta = -Number(source.rows[0].member_delta);
    const rollbackID = randomUUID();
    if (memberDelta !== 0) {
      await transfer(client, {
        memberId: member.id,
        systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD,
        memberDelta,
        type: 'CASINO_ROLLBACK',
        referenceType: 'SLOT_CALLBACK',
        referenceId: `${referenceID}:ROLLBACK`,
        idempotencyKey: `slot:${referenceID}:rollback`,
        metadata: { providerCode: PROVIDER_CODE, gameID, refTransactionID: referenceID }
      });
    }
    await client.query(
      `INSERT INTO slot_wallet_transactions
        (id,provider_code,transaction_id,reference_transaction_id,member_id,event_type,game_id,round_id,
         debit_amount,credit_amount,member_delta,currency_code,payload)
       VALUES($1,$2,$3,$4,$5,'ROLLBACK',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        rollbackID, PROVIDER_CODE, `rollback:${referenceID}`, referenceID, member.id, gameID,
        source.rows[0].round_id, Math.max(memberDelta, 0), Math.max(-memberDelta, 0), memberDelta,
        MONEY_CURRENCY, JSON.stringify({ providerCode: PROVIDER_CODE, refTransactionID: referenceID, gameID })
      ]
    );
    return result(0, '');
  });
}

function errorResponse(error) {
  if (error?.code === 'INSUFFICIENT_BALANCE') return result(6, 'Insufficient funds.');
  if (error?.code === 'SLOT_AMOUNT_INVALID') return result(2, error.message);
  logger.error('Slot wallet callback failed', { code: error?.code || 'SLOT_CALLBACK_FAILED', message: error?.message || 'unknown' });
  return result(1, 'General error.');
}

export async function processSlotWalletCallback(operation, payload, {
  transaction = tx,
  transfer = postTransfer
} = {}) {
  const normalizedOperation = normalizeOperation(operation);
  if (!SIGNING_FIELDS[normalizedOperation]) return result(2, 'Wrong input parameters.');
  if (!config.slotWalletEnabled || !config.slotCallbackSigningKey) return result(1, 'Slot wallet integration is disabled.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !validCommonFields(payload)) {
    return result(2, 'Wrong input parameters.');
  }
  if (clean(payload.agentID, 80) !== config.slotProviderAgentId) return result(4, 'Invalid Agent.');
  try {
    parseGameId(payload);
    if (!validTransactionFields(normalizedOperation, payload)) return result(2, 'Wrong input parameters.');
  } catch (error) {
    return result(2, error.message);
  }
  if (!signatureMatches(normalizedOperation, payload)) return result(3, 'Invalid Sign.');

  try {
    if (normalizedOperation === 'GETBALANCE') return await readBalance(normalizedOperation, payload, transaction);
    if (normalizedOperation === 'ROLLBACKTRANSACTION') return await rollbackTransaction(payload, transaction, transfer);
    return await applyWalletTransaction(normalizedOperation, payload, transaction, transfer);
  } catch (error) {
    return errorResponse(error);
  }
}

export const __slotWallet = { amountParts, normalizeOperation };
