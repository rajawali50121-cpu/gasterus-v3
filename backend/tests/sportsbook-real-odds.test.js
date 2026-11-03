import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: 'true'
});

const { normalizeFootballDataFixture, normalizeOpenFootballFixture } = await import('../src/sportsbook-public-market.js');
const { __footballDataIo } = await import('../src/sportsbook-footballdataio.js');
const { mergeProviderEvents } = await import('../src/sportsbook-providers.js');
const { eventSettlementAuthority } = await import('../src/sportsbook-settlement-authority.js');

test('public-market pricing contains only bookmaker quotes supplied by the source', () => {
  const event = normalizeFootballDataFixture({
    Div: 'E0',
    Date: '20/10/2026',
    Time: '20:00',
    HomeTeam: 'Alpha FC',
    AwayTeam: 'Beta FC',
    B365H: '1.82',
    B365D: '3.60',
    B365A: '4.40',
    'B365>2.5': '1.90',
    'B365<2.5': '1.95',
    AHh: '-0.5',
    B365AHH: '1.91',
    B365AHA: '1.93'
  });

  assert.ok(event);
  assert.deepEqual(event.markets.map(market => market.type), ['1X2', 'TOTALS', 'HANDICAP']);
  assert.ok(event.markets.flatMap(market => market.selections).every(selection => selection.sourceSelectionId.includes('bet365')));
});

test('OpenFootball fixture/model inputs never produce sportsbook prices', () => {
  const event = normalizeOpenFootballFixture({
    competition: { code: 'ENG-PL', league: 'Premier League' },
    match: { home: 'Alpha FC', away: 'Beta FC', startTime: '2026-10-20T20:00:00.000Z' },
    anchor: { oneXtwo: { home: 1.82, draw: 3.60, away: 4.40 } }
  });

  assert.ok(event);
  assert.deepEqual(event.markets, []);
  assert.equal(event.availableMarketCount, 0);
  assert.equal(event._settlementReadySources, undefined);
});

test('FootballData.io accepts actual odds only and does not convert probabilities into prices', () => {
  const fixture = {
    match_id: 7001,
    match_date: '2026-10-20T20:00:00Z',
    status: 'NS',
    home_team: { team_name: 'Alpha FC' },
    away_team: { team_name: 'Beta FC' },
    league: { name: 'Test League' },
    probabilities: { home_win: 55, draw: 25, away_win: 20 }
  };

  assert.equal(__footballDataIo.buildEvent(fixture), null);

  const event = __footballDataIo.buildEvent({
    ...fixture,
    odds: { home_win: 1.82, draw: 3.60, away_win: 4.40 }
  });
  assert.ok(event);
  assert.deepEqual(event.markets.map(market => market.type), ['1X2']);
  assert.deepEqual(event.markets[0].selections.map(selection => selection.odds), [1.82, 3.60, 4.40]);
  const [merged] = mergeProviderEvents([{ provider: 'footballdata-io', events: [event] }]);
  assert.equal(merged.markets[0].suspended, false);
  assert.deepEqual(merged.markets[0].selections.map(selection => selection.odds), [1.82, 3.60, 4.40]);
  assert.equal(eventSettlementAuthority(merged).automaticFt, true);
  assert.equal(eventSettlementAuthority(merged).ht, false);
});
