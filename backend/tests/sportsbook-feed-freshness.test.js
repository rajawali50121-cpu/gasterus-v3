import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '******example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { __sportsbookFeed } = await import('../src/sportsbook-feed.js');

function assertThrowsCode(fn, code) {
  assert.throws(fn, error => error?.code === code);
}

test('provider-priced selection without an update timestamp is rejected at bet acceptance', () => {
  const now = Date.now();
  const event = { id: 'fixture-1', live: false };
  const market = { id: 'market-1', source: 'api-sports', updatedAt: null };
  const selection = { key: 'selection-1', source: 'api-sports', updatedAt: null };

  assertThrowsCode(
    () => __sportsbookFeed.assertSelectionFresh(event, market, selection, now),
    'SPORTS_PRICE_TIMESTAMP_MISSING'
  );
});

test('fresh provider price timestamps pass, while stale timestamps remain rejected', () => {
  const now = Date.now();
  const event = { id: 'fixture-1', live: false };
  const market = { id: 'market-1', source: 'api-sports' };
  const selection = { key: 'selection-1', source: 'api-sports', updatedAt: new Date(now).toISOString() };

  assert.doesNotThrow(() => __sportsbookFeed.assertSelectionFresh(event, market, selection, now));
  selection.updatedAt = new Date(now - 60 * 60 * 1000).toISOString();
  assertThrowsCode(
    () => __sportsbookFeed.assertSelectionFresh(event, market, selection, now),
    'SPORTS_PRICE_STALE'
  );
});
