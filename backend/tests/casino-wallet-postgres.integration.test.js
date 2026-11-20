import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.CASINO_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
let safeLocalDatabase = false;
try {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  safeLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) && /test|verify/i.test(databaseName);
} catch {}
const integrationEnabled = Boolean(databaseUrl) && safeLocalDatabase;

Object.assign(process.env, {
  NODE_ENV: 'test',
  ...(integrationEnabled ? { DATABASE_URL: databaseUrl } : {}),
  REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),

  BETNEX_API_KEY: 'local-integration-only',
  BETNEX_CALLBACK_KEY: 'local-integration-callback-only',
  BETNEX_SEAMLESS_WALLET_PROTOCOL_VERIFIED: 'true',
  BETNEX_REAL_MONEY_ENABLED: 'true'
});

const [{ processBetnexCallback }, { pool, tx }, { ensureSystemAccounts }] = await Promise.all([
  import('../src/casino-wallet.js'),
  import('../src/db.js'),
  import('../src/ledger.js')
]);

async function eventually(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for asynchronous callback audit insert');
}

test('PostgreSQL transactions serialize duplicate and distinct casino callbacks and enforce lock timeout', {
  skip: !integrationEnabled && 'Set DATABASE_URL to a localhost database whose name contains test/verify'
}, async t => {
  await t.after(async () => pool.end());
  const memberId = randomUUID();
  const memberAccount = memberId.replace(/-/g, '');
  const username = `casino_test_${memberAccount.slice(0, 20)}`;
  const accountCode = `MEMBER:${memberId}`;

  await tx(async client => {
    await ensureSystemAccounts(client);
    await client.query(
      `INSERT INTO users(id,username,password_hash,status) VALUES($1,$2,'integration-test-hash','ACTIVE')`,
      [memberId, username]
    );
    await client.query(
      `INSERT INTO ledger_accounts(id,owner_user_id,account_code,account_type,current_balance,currency,status)
       VALUES($1,$2,$3,'MEMBER',2000,'IDR','ACTIVE')`,
      [randomUUID(), memberId, accountCode]
    );
  });
  const baseCallback = (serialNumber, betAmount) => ({
    member_account: memberAccount,
    game_uid: 'pg-integration-game',
    game_round: 'integration-round',
    serial_number: serialNumber,
    bet_amount: betAmount,
    win_amount: 0,
    currency_code: 'IDR',
    api_key: 'local-integration-callback-only'
  });

  const [sameOne, sameTwo] = await Promise.all([
    processBetnexCallback(baseCallback('same-serial', 600)),
    processBetnexCallback(baseCallback('same-serial', 600))
  ]);
  assert.equal(sameOne.status, 200);
  assert.equal(sameTwo.status, 200);
  assert.equal(sameOne.body.handle, true);
  assert.equal(sameTwo.body.handle, true);
  assert.equal(sameOne.body.money, 1400);
  assert.equal(sameTwo.body.money, 1400);
  assert.equal((await pool.query('SELECT current_balance FROM ledger_accounts WHERE owner_user_id=$1', [memberId])).rows[0].current_balance, 1400);

  const [differentOne, differentTwo] = await Promise.all([
    processBetnexCallback(baseCallback('different-serial-1', 100)),
    processBetnexCallback(baseCallback('different-serial-2', 200))
  ]);
  assert.equal(differentOne.body.handle, true);
  assert.equal(differentTwo.body.handle, true);
  assert.equal((await pool.query('SELECT current_balance FROM ledger_accounts WHERE owner_user_id=$1', [memberId])).rows[0].current_balance, 1100);
  const round = (await pool.query(
    `SELECT bet_amount,win_amount,processed_serials FROM casino_game_rounds WHERE member_id=$1`,
    [memberId]
  )).rows[0];
  assert.equal(round.bet_amount, 900);
  assert.equal(round.win_amount, 0);
  assert.equal(round.processed_serials.length, 3);

  const timeoutCallback = baseCallback('locked-serial', 1);
  const advisoryKey = `${memberAccount}:${timeoutCallback.game_uid}:${timeoutCallback.game_round}:${timeoutCallback.serial_number}`;
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [advisoryKey]);
    const started = Date.now();
    const timedOut = await processBetnexCallback(timeoutCallback);
    assert.ok(Date.now() - started < 5000, 'callback exceeded the 5-second budget');
    assert.equal(timedOut.status, 200);
    assert.equal(timedOut.body.success, false);
    assert.equal(timedOut.body.handle, false);
    assert.equal((await pool.query('SELECT current_balance FROM ledger_accounts WHERE owner_user_id=$1', [memberId])).rows[0].current_balance, 1100);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }

  const auditRows = await eventually(async () => {
    const result = await pool.query(
      `SELECT request_payload,response_payload,http_status,outcome,retain_until
       FROM casino_callback_logs
       WHERE request_payload->>'member_account'=$1`,
      [memberAccount]
    );
    return result.rows.length >= 5 ? result.rows : null;
  });
  assert.ok(auditRows.every(row => row.http_status === 200));
  assert.ok(auditRows.every(row => JSON.stringify(row.request_payload).includes('[REDACTED]')));
  assert.ok(auditRows.every(row => !JSON.stringify(row.request_payload).includes('local-integration-callback-only')));
  assert.ok(auditRows.every(row => row.retain_until > new Date()));
});
