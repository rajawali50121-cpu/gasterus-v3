import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/gasterus_test',
  REDIS_URL: 'redis://localhost:6379/0',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { __sportsbookFeed } = await import('../src/sportsbook-feed.js');

test('caps feed markets at 24 while retaining every FT and 1H core market type', () => {
  const core = ['1X2:FT', '1X2:1H', 'HANDICAP:FT', 'HANDICAP:1H', 'TOTALS:FT', 'TOTALS:1H'];
  const event = {
    id: 'event-1',
    markets: [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `extra-${index}`, type: 'OTHER', period: 'FT' })),
      ...core.map((key, index) => {
        const [type, period] = key.split(':');
        return { id: `core-${index}`, type, period };
      })
    ]
  };

  const [capped] = __sportsbookFeed.capMarketsPerEvent([event]);

  assert.equal(capped.markets.length, 24);
  assert.deepEqual(
    core.filter(key => capped.markets.some(market => `${market.type}:${market.period}` === key)),
    core
  );
  assert.equal(capped.id, event.id);
});
