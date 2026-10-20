import test from 'node:test';
import assert from 'node:assert/strict';

for (const name of [
  'SPORTSBOOK_BETTING_KILL_SWITCH_ENABLED',
  'SPORTSBOOK_LIMITED_TEST_MODE_ENABLED',
  'SPORTSBOOK_LIMITED_TEST_MEMBER_IDS',
  'SPORTSBOOK_LIMITED_TEST_MAX_STAKE',
  'SPORTSBOOK_MAX_MEMBER_LIABILITY'
]) {
  delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/sportsbook_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { config } = await import('../src/config.js');

test('new sportsbook controls and existing member exposure cap are inactive by default', () => {
  assert.equal(config.sportsbookBettingKillSwitchEnabled, false);
  assert.equal(config.sportsbookLimitedTestModeEnabled, false);
  assert.deepEqual(config.sportsbookLimitedTestMemberIds, []);
  assert.equal(config.sportsbookLimitedTestMaxStake, 1000);
  assert.equal(config.sportsbookMaxMemberLiability, 0);
});
