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
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTMONKS_ENABLED: 'true',
  SPORTMONKS_API_KEY: 'test-sportmonks-provider-key'
});

const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { validateAllHandicapOdds } = await import('../src/sportsbook-feed.js');

const fixture = {
  id: 123456,
  starting_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  state: { short_name: 'NS' },
  league: { name: 'Test League' },
  participants: [
    { name: 'Home FC', meta: { location: 'home' } },
    { name: 'Away FC', meta: { location: 'away' } }
  ],
  odds: [
    { id: 1, market_id: 1, market_description: 'Match Winner', bookmaker_id: 10, label: 'Home', value: '2.1', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 2, market_id: 1, market_description: 'Match Winner', bookmaker_id: 10, label: 'Draw', value: '3.2', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 3, market_id: 1, market_description: 'Match Winner', bookmaker_id: 10, label: 'Away', value: '3.6', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 4, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 16, label: 'Home', handicap: '-0.5', value: '1.75', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 5, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 16, label: 'Away', handicap: '-0.5', value: '2.0', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 6, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 20, label: 'Home', handicap: '-0.5', value: '1.8', latest_bookmaker_update: '2026-10-13 08:05:00' },
    { id: 7, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 20, label: 'Away', handicap: '-0.5', value: '2.05', latest_bookmaker_update: '2026-10-13 08:05:00' },
    { id: 8, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 16, label: 'Home', handicap: '-1.25', value: '4.85', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 9, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 16, label: 'Away', handicap: '-1.25', value: '1.11', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 10, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 16, label: 'Home', handicap: '1.5', value: '1.9', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 11, market_id: 6, market_description: 'Asian Handicap', bookmaker_id: 20, label: 'Away', handicap: '1.5', value: '2.0', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 12, market_id: 80, market_description: 'Goals Over/Under', bookmaker_id: 12, label: 'Over', total: '2.5', value: '1.9', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 13, market_id: 80, market_description: 'Goals Over/Under', bookmaker_id: 12, label: 'Under', total: '2.5', value: '1.9', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 14, market_id: 80, market_description: 'Goals Over/Under', bookmaker_id: 12, label: 'Over', total: '0.5', value: '1.02', latest_bookmaker_update: '2026-10-13 08:00:00' },
    { id: 15, market_id: 80, market_description: 'Goals Over/Under', bookmaker_id: 12, label: 'Under', total: '0.5', value: '10.5', latest_bookmaker_update: '2026-10-13 08:00:00' }
  ]
};

test('Sportmonks keeps complete valid markets per line and bookmaker instead of losing all alternate lines', () => {
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, fixture.odds);
  validateAllHandicapOdds([event]);

  const byTypeAndLine = new Map(event.markets.map(market => [`${market.type}|${market.line ?? ''}`, market]));
  assert.deepEqual([...byTypeAndLine.keys()].sort(), [
    '1X2|',
    'HANDICAP|-0.5',
    'TOTALS|2.5'
  ]);
  assert.deepEqual(byTypeAndLine.get('HANDICAP|-0.5').selections.map(selection => selection.odds), [1.8, 2.05]);
  assert.equal(byTypeAndLine.get('HANDICAP|-0.5').selections.length, 2);
  assert.equal(byTypeAndLine.get('TOTALS|2.5').selections.length, 2);
  assert.equal(byTypeAndLine.get('1X2|').selections.length, 3);
});
