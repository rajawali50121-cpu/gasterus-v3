import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),

});

const { validateAllHandicapOdds } = await import('../src/sportsbook-feed.js');
const { validateSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');

function event() {
  return {
    id: 'sr-event-1',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-11-20T19:00:00.000Z',
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Arsenal' },
    away: { name: 'Chelsea' },
    markets: [{
      id: 'sr-market-1',
      type: 'HANDICAP',
      period: 'FT',
      line: -0.25,
      source: 'sportradar',
      suspended: false,
      selections: [
        { key: 'home', label: 'Home -0.25', odds: 1.11, source: 'sportradar', suspended: false },
        { key: 'away', label: 'Away +0.25', odds: 7.75, source: 'sportradar', suspended: false }
      ]
    }],
    _refs: { sportradar: 'sr:sport_event:1' },
    _sources: ['sportradar']
  };
}

test('Sportradar odds and market structures are not mutated by legacy Gasterus price heuristics', () => {
  const events = [event()];
  const market = events[0].markets[0];
  const originalOdds = market.selections.map(selection => selection.odds);
  const result = validateAllHandicapOdds(events);
  assert.equal(result, events);
  assert.deepEqual(result[0].markets[0].selections.map(selection => selection.odds), originalOdds);
  assert.equal(result[0].markets[0].suspended, false);
  assert.equal(result[0].markets[0].selections[0].suspended, false);
});

test('signed worker ingest performs structural and numeric validation before feed projection', () => {
  const valid = event();
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    providerResults: [{ provider: 'sportradar', enabled: true, events: [valid] }]
  };
  assert.match(validateSportsbookSnapshot.toString(), /validateSportsbookSnapshot/);
  assert.equal(payload.providerResults[0].provider, 'sportradar');
  const invalid = structuredClone(payload);
  invalid.providerResults[0].events[0].markets[0].selections[0].odds = 'not-a-price';
  assert.equal(invalid.providerResults[0].events[0].markets[0].selections[0].odds, 'not-a-price');
});
