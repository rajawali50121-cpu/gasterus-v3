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
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTMONKS_PASSTHROUGH: 'true',
  SPORTMONKS_FEED_MAX_CACHE_BYTES: '262144'
});

const [{ __sportsbookProviders, teamKey }, { __sportsbookFeed, validateAllHandicapOdds }, { combineSportsbookProviderResults }, { paginateEvents }] = await Promise.all([
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-feed.js'),
  import('../src/sportsbook-render-worker-core.js'),
  import('../src/sportsbook-feed-revisions.js')
]);

function fixture(id, { state = 'NS', startTime = new Date(Date.now() + 60_000).toISOString() } = {}) {
  return {
    id,
    state: { short_name: state, name: state },
    starting_at: startTime,
    league: { name: 'Regional League', country: { name: 'England' } },
    participants: [
      { name: `Home ${id}`, meta: { location: 'home' } },
      { name: `Away ${id}`, meta: { location: 'away' } }
    ]
  };
}

function normalizedEvent(id) {
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture(id), []);
  return { ...event, _sources: ['sportmonks'] };
}

test('Sportmonks event without odds survives normalization and feed visibility filters', () => {
  const raw = fixture('no-odds', {
    state: 'FT',
    startTime: new Date(Date.now() - 24 * 60 * 60_000).toISOString()
  });
  const event = __sportsbookProviders.normalizeSportmonksFixture(raw, []);
  assert.deepEqual(event.markets, []);
  assert.equal(__sportsbookFeed.boundedEvents([event]).length, 1);
});

test('unknown Sportmonks markets and original names survive member projection', () => {
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture('unknown-market'), [{
    id: 'selection-1',
    market_id: 9876,
    market_description: 'Provider Special Market',
    bookmaker_id: 55,
    bookmaker: { name: 'Bookmaker X' },
    label: 'Yes',
    value: 2.4
  }]);
  const [memberEvent] = [__sportsbookFeed.memberPublicEvent({ ...event, _sources: ['sportmonks'] })];
  assert.equal(memberEvent.markets[0].type, 'OTHER');
  assert.equal(memberEvent.markets[0].label, 'Provider Special Market');
  assert.equal(memberEvent.markets[0].bookmaker, 'Bookmaker X');
  assert.equal(memberEvent.markets[0].selections[0].odds, 2.4);
});

test('abnormal Sportmonks overround is retained with a validation warning', () => {
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture('odd-overround'), [
    { id: 'home', market_id: 1, market_description: 'Fulltime Result', bookmaker_id: 1, label: 'Home', value: 2.5 },
    { id: 'draw', market_id: 1, market_description: 'Fulltime Result', bookmaker_id: 1, label: 'Draw', value: 3 },
    { id: 'away', market_id: 1, market_description: 'Fulltime Result', bookmaker_id: 1, label: 'Away', value: 5 }
  ]);
  const events = [{ ...event, _sources: ['sportmonks'] }];

  validateAllHandicapOdds(events);

  assert.equal(events[0].markets.length, 1);
  assert.ok(events[0].markets[0].validationWarnings.includes('OVERROUND_1X2'));
});

test('more than 500 Sportmonks events survive worker and feed selection and remain pageable', () => {
  const events = Array.from({ length: 501 }, (_, index) => normalizedEvent(`fixture-${index}`));
  const combined = combineSportsbookProviderResults(
    [{ provider: 'sportmonks', enabled: true, events }],
    { maxEvents: 500, teamKey }
  );
  const feedEvents = __sportsbookFeed.boundedEvents(combined.providerResults[0].events);
  const firstPage = paginateEvents(feedEvents);
  const secondPage = paginateEvents(feedEvents, { offset: 500, limit: 500 });

  assert.equal(combined.eventCount, 501);
  assert.equal(feedEvents.length, 501);
  assert.equal(firstPage.events.length, 500);
  assert.equal(secondPage.events.length, 1);
  const explicitlyCapped = combineSportsbookProviderResults(
    [{ provider: 'sportmonks', enabled: true, events }],
    { maxEvents: 500, sportmonksMaxEvents: 500, teamKey }
  );
  assert.equal(explicitlyCapped.truncatedSportmonksEventCount, 1);
});

test('unparseable Sportmonks odds rows are counted and skipped without rejecting the event', () => {
  const diagnostics = { unknownMarkets: new Map() };
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture('unparseable'), [
    { id: 'bad', market_id: 1, market_description: 'Special', bookmaker_id: 1, label: 'Yes', value: 'not-a-price' }
  ], diagnostics);

  assert.ok(event);
  assert.equal(event.markets.length, 1);
  assert.deepEqual(event.markets[0].selections, []);
  assert.equal(diagnostics.unparseableOddsRows, 1);
});
