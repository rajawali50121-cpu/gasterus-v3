import test from 'node:test';
import assert from 'node:assert/strict';

const allowlistedMember = '123e4567-e89b-42d3-a456-426614174000';
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/sportsbook_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTSBOOK_BETTING_KILL_SWITCH_ENABLED: 'false',
  SPORTSBOOK_MAX_MEMBER_LIABILITY: '5000',
  SPORTSBOOK_LIMITED_TEST_MODE_ENABLED: 'true',
  SPORTSBOOK_LIMITED_TEST_MEMBER_IDS: allowlistedMember,
  SPORTSBOOK_LIMITED_TEST_MAX_STAKE: '1000'
});

const { assertLimitedTestAccess, assertMemberLiability } = await import('../src/sportsbook-betting.js');
const { assertSportsbookBettingOpen } = await import('../src/sportsbook-betting-controls.js');
const { config } = await import('../src/config.js');

function database({ closed = false, liability = 0 } = {}) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes('system_settings')) {
        return { rows: closed ? [{ setting_value: { closed: true } }] : [] };
      }
      if (sql.includes('SUM(potential_payout)')) {
        return { rows: [{ liability }] };
      }
      return { rows: [] };
    }
  };
}

test('runtime betting switch defaults open and blocks quotes/acceptance when closed', async () => {
  const openDb = database();
  await assertSportsbookBettingOpen(openDb);
  assert.equal(openDb.statements.length, 1);
  assert.match(openDb.statements[0], /system_settings/);

  const closedDb = database({ closed: true });
  await assert.rejects(assertSportsbookBettingOpen(closedDb, { lock: true }), error => {
    assert.equal(error.code, 'SPORTSBOOK_BETTING_CLOSED');
    assert.equal(error.message, 'Penerimaan taruhan sportsbook sedang dihentikan oleh operator.');
    return true;
  });
  assert.match(closedDb.statements[0], /FOR SHARE/);
});

test('member exposure cap accepts the exact boundary and rejects the next unit', async () => {
  const sessionDb = database({ liability: 4000 });
  await assertMemberLiability(sessionDb, allowlistedMember, 1000);
  await assert.rejects(assertMemberLiability(sessionDb, allowlistedMember, 1001), error => {
    assert.equal(error.code, 'SPORTSBOOK_MEMBER_LIABILITY_LIMIT');
    assert.equal(error.message, 'Batas eksposur taruhan anggota 5000 telah tercapai.');
    return true;
  });
});

test('limited test mode requires the allowlist and enforces its configured ticket limit', () => {
  assert.equal(config.sportsbookLimitedTestModeEnabled, true);
  assert.deepEqual(config.sportsbookLimitedTestMemberIds, [allowlistedMember]);
  assert.doesNotThrow(() => assertLimitedTestAccess(allowlistedMember, 1000));
  assert.throws(() => assertLimitedTestAccess('123e4567-e89b-42d3-a456-426614174001', 1000), error => {
    assert.equal(error.code, 'SPORTSBOOK_LIMITED_TEST_MEMBER_NOT_ALLOWED');
    assert.equal(error.message, 'Akun ini tidak termasuk daftar putih mode uji sportsbook.');
    return true;
  });
  assert.throws(() => assertLimitedTestAccess(allowlistedMember, 1001), error => {
    assert.equal(error.code, 'SPORTSBOOK_LIMITED_TEST_STAKE_LIMIT');
    assert.equal(error.message, 'Total taruhan mode uji maksimum 1000.');
    return true;
  });
});
