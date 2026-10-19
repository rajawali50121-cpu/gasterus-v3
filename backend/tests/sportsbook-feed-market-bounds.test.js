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
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64'),
  SPORTS_FEED_MAX_EVENTS: '500',
  SPORTS_FEED_MAX_CACHE_BYTES: '8388608'
});

const { __sportsbookFeed } = await import('../src/sportsbook-feed.js');

test('event detail preserves provider market variety without truncating outcomes', () => {
  const types = [
    '1X2', 'HANDICAP', 'TOTALS', 'BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET',
    'HT_FT', 'CORRECT_SCORE', 'ODD_EVEN', 'CORNERS', 'CARDS', 'FIRST_TO_SCORE',
    'CLEAN_SHEET', 'TEAM_TOTAL', 'TEAM_TOTAL', 'CORNERS', 'CARDS', 'ODD_EVEN',
    'CORRECT_SCORE', 'HT_FT', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'TEAM_TOTAL', 'OTHER',
    'OTHER'
  ];
  const event = {
    id: 'event-market-bounds',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Home FC', score: null },
    away: { name: 'Away FC', score: null },
    availableMarketCount: 100,
    markets: types.map((type, index) => ({
      id: `market-${index}`,
      type,
      period: index === 4 ? '1H' : 'FT',
      mainLine: index === 1 || index === 2,
      selections: Array.from({ length: 4 }, (_, selection) => ({
        key: `selection-${index}-${selection}`,
        label: `Outcome ${selection}`,
        odds: 1.5 + selection / 10
      }))
    }))
  };

  const [bounded] = __sportsbookFeed.capMarketsPerEvent([event]);
  assert.equal(bounded.markets.length, 24);
  assert.ok(bounded.markets.some(market => market.type === 'CORNERS'));
  assert.ok(bounded.markets.some(market => market.type === 'CORRECT_SCORE'));
  assert.ok(bounded.markets.every(market => market.selections.length === 4));
  assert.equal(bounded.availableMarketCount, 24);
  assert.deepEqual(bounded.markets.slice(0, 4).map(market => market.type), [
    '1X2', 'HANDICAP', 'TOTALS', 'BTTS'
  ]);
  assert.equal(__sportsbookFeed.memberPublicEvent(bounded).markets.some(market => market.type === 'CORRECT_SCORE'), false);
  assert.ok(__sportsbookFeed.memberPublicEventDetail(bounded).markets.some(market => market.type === 'CORRECT_SCORE'));
});

test('oversized outcome markets are omitted whole and the cache fits a 500-event catalog', () => {
  const oversizedMarket = {
    id: 'market-oversized',
    type: 'CORRECT_SCORE',
    period: 'FT',
    selections: Array.from({ length: 41 }, (_, index) => ({
      key: `selection-${index}`,
      label: `Outcome ${index}`,
      odds: 2
    }))
  };
  const [bounded] = __sportsbookFeed.capMarketsPerEvent([{
    id: 'event-oversized',
    markets: [{ id: 'market-1x2', type: '1X2', period: 'FT', selections: [{ key: 'home', odds: 2 }] }, oversizedMarket]
  }]);
  assert.deepEqual(bounded.markets.map(market => market.id), ['market-1x2']);

  const now = Date.now();
  const events = Array.from({ length: 500 }, (_, index) => ({
    id: `event-${index}`,
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: new Date(now + (index + 1) * 60_000).toISOString(),
    status: 'SCHEDULED',
    live: false,
    home: { name: `Home ${index}` },
    away: { name: `Away ${index}` },
    markets: [{ id: `market-${index}`, type: '1X2', period: 'FT', selections: [] }]
  }));
  const snapshot = __sportsbookFeed.cacheWithinLimit({ events, providers: [] });
  assert.equal(snapshot.events.length, 500);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 8_388_608);
  const page = __sportsbookFeed.paginateEvents(snapshot.events, { offset: '480', limit: '30' });
  assert.equal(page.events.length, 20);
  assert.equal(page.pagination.total, 500);
  assert.equal(page.pagination.hasMore, false);
});

test('legacy sportsbook cache purge targets versioned feed and lifecycle keys only', async () => {
  const matches = [];
  const deleted = [];
  const keysByPattern = new Map([
    ['sportsbook:aggregated-feed:v*', ['sportsbook:aggregated-feed:v1', 'sportsbook:aggregated-feed:v19']],
    ['sportsbook:provider-lifecycle:v*', ['sportsbook:provider-lifecycle:v6']],
    ['sportsbook:market-lifecycle:v*', ['sportsbook:market-lifecycle:v6']]
  ]);
  const client = {
    isOpen: true,
    async *scanIterator({ MATCH }) {
      matches.push(MATCH);
      yield keysByPattern.get(MATCH) || [];
    },
    async del(keys) {
      deleted.push(...keys);
    }
  };

  assert.equal(await __sportsbookFeed.purgeLegacySportsbookCacheKeys(client), 4);
  assert.deepEqual(matches, [...keysByPattern.keys()]);
  assert.deepEqual(deleted, [...keysByPattern.values()].flat());
  assert.equal(deleted.includes('sportsbook:feed-refresh-lock:v1'), false);
  assert.equal(deleted.includes('sportsbook:render-ingest-snapshot:v1'), false);
});
