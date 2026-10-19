import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64')
});

const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');

test('The Odds API event detail cache enforces an aggregate byte ceiling and evicts oldest entries', () => {
  const cache = __sportsbookProviders.oddsApiEventDetailCache;
  cache.clear();
  const now = Date.now();
  for (let index = 0; index < 20; index += 1) {
    cache.set(`event-${index}`, {
      fetchedAt: now - index * 1000,
      commenceTime: new Date(now + 3_600_000).toISOString(),
      completed: false,
      sizeBytes: 150_000,
      payload: {}
    });
  }

  __sportsbookProviders.pruneOddsApiEventDetailCache(now, 60_000);

  const totalBytes = [...cache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  assert.ok(totalBytes <= 2_000_000);
  assert.ok(cache.size <= 100);
  assert.equal(cache.has('event-19'), false, 'oldest entry should be evicted first');
  cache.clear();
});
