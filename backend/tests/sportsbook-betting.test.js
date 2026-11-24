import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),

});

const { combinations, choose, ticketCalculation } = await import('../src/sportsbook-calculation.js');
const leg = value => ({ selection: { odds: value } });

test('parlay calculation multiplies odds and uses one stake', () => {
  const result = ticketCalculation('PARLAY', 10000, [leg(1.8), leg(2.0)]);
  assert.equal(result.combinationCount, 1);
  assert.equal(result.totalStake, 10000);
  assert.equal(result.potentialPayout, 36000);
});

test('system 2/3 creates three combinations and calculates combined payout', () => {
  const result = ticketCalculation('SYSTEM', 10000, [leg(2), leg(2), leg(2)], 2);
  assert.equal(choose(3, 2), 3);
  assert.equal(result.combinationCount, 3);
  assert.equal(result.totalStake, 30000);
  assert.equal(result.potentialPayout, 120000);
  assert.equal(combinations([1, 2, 3], 2).length, 3);
});
