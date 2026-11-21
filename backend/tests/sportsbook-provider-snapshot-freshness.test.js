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
  API_KEY_PEPPER: 'p'.repeat(48)
});

const { stampPriceVersions } = await import('../src/sportsbook-feed.js');

test('missing market and selection timestamps inherit the actual provider snapshot time', () => {
  const snapshotAt = Date.parse('2026-11-21T01:04:51.778Z');
  const [event] = stampPriceVersions([{
    id: 'event-1',
    markets: [{
      id: 'market-1',
      selections: [{ key: 'home', odds: 1.91 }]
    }]
  }], snapshotAt);

  assert.equal(event.markets[0].updatedAt, '2026-11-21T01:04:51.778Z');
  assert.equal(event.markets[0].selections[0].updatedAt, '2026-11-21T01:04:51.778Z');
});

test('provider-supplied market and selection timestamps are preserved', () => {
  const snapshotAt = Date.parse('2026-11-21T01:04:51.778Z');
  const [event] = stampPriceVersions([{
    id: 'event-1',
    markets: [{
      id: 'market-1',
      updatedAt: '2026-11-21T00:59:00.000Z',
      selections: [{
        key: 'home',
        odds: 1.91,
        updatedAt: '2026-11-21T01:00:00.000Z'
      }]
    }]
  }], snapshotAt);

  assert.equal(event.markets[0].updatedAt, '2026-11-21T00:59:00.000Z');
  assert.equal(event.markets[0].selections[0].updatedAt, '2026-11-21T01:00:00.000Z');
});

test('an invalid provider snapshot timestamp fails closed to the Unix epoch fallback', () => {
  const [event] = stampPriceVersions([{
    id: 'event-1',
    markets: [{ id: 'market-1', selections: [{ key: 'home', odds: 1.91 }] }]
  }], 0);

  assert.equal(event.markets[0].updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(event.markets[0].selections[0].updatedAt, '1970-01-01T00:00:00.000Z');
});

test('invalid provider timestamps are replaced with the snapshot timestamp instead of bypassing freshness checks', () => {
  const snapshotAt = Date.parse('2026-11-21T01:04:51.778Z');
  const [event] = stampPriceVersions([{
    id: 'event-1',
    markets: [{
      id: 'market-1',
      updatedAt: 'not-a-date',
      selections: [{ key: 'home', odds: 1.91, updatedAt: 'invalid' }]
    }]
  }], snapshotAt);

  assert.equal(event.markets[0].updatedAt, '2026-11-21T01:04:51.778Z');
  assert.equal(event.markets[0].selections[0].updatedAt, '2026-11-21T01:04:51.778Z');
});
