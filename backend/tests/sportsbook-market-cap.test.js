import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

const feedSource = await readFile(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const { mergeProviderEvents } = await import('../src/sportsbook-providers.js');

test('feed and provider merge retain every market instead of truncating market lists', () => {
  assert.doesNotMatch(feedSource, /capMarketsPerEvent|MAX_MARKETS_PER_EVENT/);
  const event = {
    id: 'event-1',
    sport: 'Football',
    league: 'Regional League',
    country: 'England',
    startTime: new Date(Date.now() + 3600000).toISOString(),
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Home', score: null, logo: null },
    away: { name: 'Away', score: null, logo: null },
    markets: Array.from({ length: 40 }, (_, index) => ({
      id: `market-${index}`,
      type: 'OTHER',
      period: 'FT',
      label: `Market ${index}`,
      line: null,
      source: 'sportmonks',
      suspended: false,
      selections: [{
        key: `selection-${index}`,
        label: 'Yes',
        odds: 2,
        line: null,
        suspended: false,
        source: 'sportmonks'
      }]
    })),
    _refs: { sportmonks: 'fixture-1' },
    _sources: ['sportmonks']
  };

  const [merged] = mergeProviderEvents([{ provider: 'sportmonks', events: [event] }]);

  assert.equal(merged.markets.length, 40);
});
