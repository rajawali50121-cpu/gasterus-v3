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
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTMONKS_ENABLED: 'true',
  SPORTMONKS_API_KEY: 'test-sportmonks-key',
  SPORTMONKS_DAYS_AHEAD: '0',
  SPORTMONKS_REFRESH_SECONDS: '300',
  SPORTMONKS_ODDS_REFRESH_SECONDS: '180',
  SPORTMONKS_REQUEST_DELAY_MS: '1',
  SPORTMONKS_LIVE_REFRESH_SECONDS: '30',
  SHARP_API_ENABLED: 'true',
  SHARP_API_KEY: 'test-sharpapi-key',
  THE_ODDS_API_ENABLED: 'true',
  THE_ODDS_API_KEY: 'test-existing-odds-key',
  THE_ODDS_API_EVENT_MARKETS_ENABLED: 'true',
  THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: '5',
  THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: '8',
  THE_ODDS_API_MAX_TOTAL_EVENTS: '10',
  THE_ODDS_API_SPORT_KEYS: 'soccer_epl,basketball_nba,tennis_atp_us_open'
});

const { __sportsbookProviders, fetchSportmonks, fetchSharpApi, publicEvent } = await import('../src/sportsbook-providers.js');
const { eventSettlementAuthority } = await import('../src/sportsbook-settlement-authority.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

test('Sportmonks fixtures without provider odds stay display-only and never receive synthetic markets', () => {
    assert.equal(__sportsbookProviders.sportmonksCacheTtlMs(), 180_000);
    const fixture = {
      id: 'sportmonks-no-prices',
      state: { short_name: 'NS', name: 'Not Started' },
      starting_at: '2026-08-06T12:00:00Z',
      league: { name: 'Premier League', country: { name: 'England' } },
      participants: [
        { name: 'Arsenal', meta: { location: 'home' } },
        { name: 'Chelsea', meta: { location: 'away' } }
      ]
    };
    const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, []);
    assert.deepEqual(event.markets, []);
    const [merged] = __sportsbookProviders.mergeProviderEvents([{ provider: 'sportmonks', events: [event] }]);
    assert.deepEqual(merged.markets, []);
    assert.doesNotMatch(JSON.stringify(merged), /fallback-odds/);
  });

  test('Sportmonks preserves provider-supplied markets, periods, lines, and suspended odds', () => {
    const fixture = {
      id: 'sportmonks-full-market-coverage',
      state: { short_name: 'NS', name: 'Not Started' },
      starting_at: '2026-08-06T12:00:00Z',
      league: { name: 'Premier League', country: { name: 'England' } },
      participants: [
        { name: 'Arsenal', meta: { location: 'home' } },
        { name: 'Chelsea', meta: { location: 'away' } }
      ]
    };
    const rows = [
      { id: 1, market_id: 101, market_description: 'HT 1X2', label: 'Home', value: 1.91 },
      { id: 2, market_id: 102, market_description: 'European Handicap', label: 'Home', handicap: -1, value: 2.15 },
      { id: 3, market_id: 103, market_description: '2nd Half - Total Goals', label: 'Over', total: 2.5, value: 1.88 },
      { id: 4, market_id: 104, market_description: 'Player Assists', label: 'Player A', value: 3.25, status: 'suspended' },
      { id: 5, market_id: 105, market_description: 'Provider Special Market', label: 'Yes', value: 2.4 },
      { id: 6, market_id: 106, market_description: 'Invalid Price Market', label: 'Yes', value: 1 },
      { id: 7, market_description: 'Asian Handicap', label: 'Away', handicap: 1, value: 1.92 }
    ];
    const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, rows);
    assert.equal(event.markets.length, 7, 'all parseable supplied odds, including out-of-range values, remain');
    const firstHalf = event.markets.find(market => market.sourceMarketId === 'm101');
    const handicap = event.markets.find(market => market.sourceMarketId === 'm102');
    const secondHalfTotals = event.markets.find(market => market.sourceMarketId === 'm103');
    const playerProps = event.markets.find(market => market.sourceMarketId === 'm104');
    const unknownMarket = event.markets.find(market => market.sourceMarketId === 'm105');
    const outOfRangeOdds = event.markets.find(market => market.sourceMarketId === 'm106');
    const marketWithoutId = event.markets.find(market => market.key.startsWith('name:'));
    assert.equal(firstHalf.period, '1H');
    assert.equal(handicap.type, 'HANDICAP');
    assert.equal(handicap.selections[0].line, -1);
    assert.equal(secondHalfTotals.period, '2H');
    assert.equal(secondHalfTotals.selections[0].line, 2.5);
    assert.equal(playerProps.type, 'PLAYER_PROP');
    assert.equal(playerProps.selections[0].suspended, true);
    assert.equal(unknownMarket.type, 'OTHER');
    assert.equal(unknownMarket.label, 'Provider Special Market');
    assert.equal(outOfRangeOdds.selections[0].odds, 1);
    assert.equal(marketWithoutId.sourceMarketId, null);
    assert.equal(marketWithoutId.selections[0].line, 1);
  });

  test('Sportmonks normalizes nested relation data for fixtures and odds', () => {
    const fixture = {
      id: 'sportmonks-nested-relations',
      state: { data: { short_name: 'NS', name: 'Not Started' } },
      starting_at_timestamp: Math.floor((Date.now() + 3600000) / 1000),
      league: { data: {
        name: 'Regional League',
        country: { data: { name: 'England' } }
      } },
      participants: { data: [
        { name: 'Home', meta: { location: 'home' } },
        { name: 'Away', meta: { location: 'away' } }
      ] },
      odds: { data: { data: [
        { id: 1, market_id: 501, market: { data: { name: 'Fulltime Result' } }, bookmaker_id: 10, bookmaker: { data: { name: 'Book A' } }, label: 'Home', value: '2.1' },
        { id: 2, market_id: 501, market: { data: { name: 'Fulltime Result' } }, bookmaker_id: 10, bookmaker: { data: { name: 'Book A' } }, label: 'Draw', value: '3.2' },
        { id: 3, market_id: 501, market: { data: { name: 'Fulltime Result' } }, bookmaker_id: 10, bookmaker: { data: { name: 'Book A' } }, label: 'Away', value: '3.4' }
      ] } }
    };

    const event = __sportsbookProviders.normalizeSportmonksFixture(fixture);

    assert.equal(event.league, 'Regional League');
    assert.equal(event.country, 'England');
    assert.equal(event.markets.length, 1);
    assert.equal(event.markets[0].bookmaker, 'Book A');
    assert.deepEqual(event.markets[0].selections.map(selection => selection.odds), [2.1, 3.2, 3.4]);
  });

  test('Sportmonks scans pages through the configured budget after its candidate buffer fills', async () => {
    const originalFetch = globalThis.fetch;
    const requestedPages = [];
    const requestedPageSizes = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      const page = Number(url.searchParams.get('page'));
      requestedPages.push(page);
      requestedPageSizes.push(Number(url.searchParams.get('per_page')));
      assert.equal(url.searchParams.get('timezone'), 'UTC');
      assert.match(url.searchParams.get('include'), /odds\.market/);
      assert.match(url.searchParams.get('include'), /odds\.bookmaker/);
      assert.equal(url.searchParams.has('filters'), false);
      const fixtures = Array.from({ length: 50 }, (_, index) => {
        const fixtureId = `pagination-${page}-${index}`;
        return {
          id: fixtureId,
          state: { short_name: 'NS', name: 'Not Started' },
          starting_at_timestamp: Math.floor((Date.now() + (page * 50 + index + 1) * 60000) / 1000),
          league: { name: 'Regional League', country: { name: 'England' } },
          participants: [
            { name: `Home ${fixtureId}`, meta: { location: 'home' } },
            { name: `Away ${fixtureId}`, meta: { location: 'away' } }
          ],
          odds: []
        };
      });
      const body = JSON.stringify({ data: fixtures, pagination: { has_more: page < 3 } });
      return { ok: true, status: 200, async text() { return body; } };
    };
    try {
      const result = await fetchSportmonks({ maxEvents: 1, maxPages: 5 });
      assert.deepEqual(requestedPages, [1, 2, 3]);
      assert.deepEqual(requestedPageSizes, [50, 50, 50]);
      assert.equal(result.events.length, 1);
      assert.equal(result.diagnostics.pagesFetched, 3);
      assert.equal(result.diagnostics.fixturesFetched, 150);
    } finally {
      globalThis.fetch = originalFetch;
    }
});

test('Sportmonks retains separate bookmaker odds and reports unmapped market IDs', () => {
  const fixture = {
    id: 'sportmonks-bookmaker-markets',
    state: { short_name: 'NS', name: 'Not Started' },
    starting_at: '2026-08-06T12:00:00Z',
    league: { name: 'Regional League', country: { name: 'England' } },
    participants: [
      { name: 'Home', meta: { location: 'home' } },
      { name: 'Away', meta: { location: 'away' } }
    ]
  };
  const diagnostics = { unknownMarkets: new Map() };
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, [
    { id: 1, market_id: 501, market_description: 'Fulltime Result', bookmaker_id: 10, bookmaker: { name: 'Book A' }, label: 'Home', value: 1.9 },
    { id: 2, market_id: 501, market_description: 'Fulltime Result', bookmaker_id: 11, bookmaker: { name: 'Book B' }, label: 'Home', value: 2.1 },
    { id: 3, market_id: 9876, market_description: 'Mystery Special', bookmaker_id: 10, bookmaker: { name: 'Book A' }, label: 'Yes', value: 2.4 }
  ], diagnostics);

  const resultMarkets = event.markets.filter(market => market.sourceMarketId === 'm501');
  assert.equal(resultMarkets.length, 2);
  assert.deepEqual(resultMarkets.map(market => market.bookmaker).sort(), ['Book A', 'Book B']);
  assert.deepEqual(resultMarkets.map(market => market.selections[0].odds).sort(), [1.9, 2.1]);
  assert.equal(event.markets.find(market => market.sourceMarketId === 'm9876').type, 'OTHER');
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ provider: 'sportmonks', events: [event] }]);
  assert.equal(merged.markets.filter(market => market.sourceMarketId === 'm501').length, 2);
  assert.deepEqual([...diagnostics.unknownMarkets.values()], [
    { marketId: '9876', marketName: 'Mystery Special', count: 1 }
  ]);
});

test('Sportmonks keeps every odds row for bookmaker names with colliding slugs', () => {
  const fixture = {
    id: 'sportmonks-bookmaker-slug-collision',
    state: { short_name: 'NS', name: 'Not Started' },
    starting_at: '2026-08-06T12:00:00Z',
    league: { name: 'Regional League', country: { name: 'England' } },
    participants: [
      { name: 'Home', meta: { location: 'home' } },
      { name: 'Away', meta: { location: 'away' } }
    ]
  };
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, [
    { id: 1, market_id: 501, market_description: 'Fulltime Result', bookmaker: { name: 'Book-A' }, label: 'Home', value: 2.4 },
    { id: 2, market_id: 501, market_description: 'Fulltime Result', bookmaker: { name: 'Book A' }, label: 'Home', value: 2.1 },
    { id: 3, market_id: 501, market_description: 'Fulltime Result', bookmaker: { name: 'Book-A' }, label: 'Home', value: 1.8 }
  ]);
  const resultMarkets = event.markets.filter(market => market.sourceMarketId === 'm501');

  assert.equal(resultMarkets.length, 2);
  assert.deepEqual(
    resultMarkets.map(market => [market.bookmaker, market.selections.map(selection => selection.odds).sort()]).sort(([a], [b]) => a.localeCompare(b)),
    [['Book A', [2.1]], ['Book-A', [1.8, 2.4]]]
  );
});

test('Sportmonks isolates odds rows without bookmaker identity and reports their count', () => {
  const fixture = {
    id: 'sportmonks-bookmaker-identity-missing',
    state: { short_name: 'NS', name: 'Not Started' },
    starting_at: '2026-08-06T12:00:00Z',
    league: { name: 'Regional League', country: { name: 'England' } },
    participants: [
      { name: 'Home', meta: { location: 'home' } },
      { name: 'Away', meta: { location: 'away' } }
    ]
  };
  const diagnostics = { unknownMarkets: new Map() };
  const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, [
    { id: 1, market_id: 501, market_description: 'Fulltime Result', label: 'Home', value: 1.9 },
    { id: 2, market_id: 501, market_description: 'Fulltime Result', label: 'Away', value: 2.1 }
  ], diagnostics);

  const resultMarkets = event.markets.filter(market => market.sourceMarketId === 'm501');
  assert.equal(resultMarkets.length, 2);
  assert.ok(resultMarkets.every(market => market.bookmaker === null && market.selections.length === 1));
  assert.equal(new Set(resultMarkets.map(market => market.key)).size, 2);
  assert.equal(diagnostics.bookmakerIdentityMissingRows, 2);
});

test('Sportmonks reports and retains fetched data when a configured page budget is reached', async () => {
  const originalFetch = globalThis.fetch;
  const cacheKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:3:1`;
  __sportsbookProviders.sportmonksCache.delete(cacheKey);
  __sportsbookProviders.sportmonksRetryState.delete(cacheKey);
  __sportsbookProviders.sportmonksLiveCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/livescores')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [{
        id: 'page-budget-fixture',
        state: { short_name: 'NS', name: 'Not Started' },
        starting_at_timestamp: Math.floor((Date.now() + 3600000) / 1000),
        league: { name: 'Regional League', country: { name: 'England' } },
        participants: [
          { name: 'Budget Home', meta: { location: 'home' } },
          { name: 'Budget Away', meta: { location: 'away' } }
        ],
        odds: []
      }],
      pagination: { has_more: true }
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 3, maxPages: 1 });
    assert.equal(result.partial, true);
    assert.equal(result.transportOk, true);
    assert.equal(result.diagnostics.pageBudgetExhausted, true);
    assert.equal(result.diagnostics.dataTruncated, true);
    assert.match(result.errors.join(' '), /page budget exhausted/i);
    assert.equal(__sportsbookProviders.sportmonksCache.has(cacheKey), true);
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.sportmonksCache.delete(cacheKey);
    __sportsbookProviders.sportmonksRetryState.delete(cacheKey);
    __sportsbookProviders.sportmonksLiveCache.clear();
  }
});

test('Sportmonks reports an invalid API envelope without discarding its prior cached data', async () => {
  const originalFetch = globalThis.fetch;
  const cacheKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:2:1`;
  __sportsbookProviders.sportmonksCache.delete(cacheKey);
  __sportsbookProviders.sportmonksRetryState.delete(cacheKey);
  __sportsbookProviders.sportmonksLiveCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/livescores')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'invalid account response' }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 2, maxPages: 1 });
    assert.equal(result.stale, false);
    assert.equal(result.transportOk, false);
    assert.equal(result.diagnostics.failedPages, 1);
    assert.match(result.errors.join(' '), /response contains error/i);
    assert.equal(__sportsbookProviders.sportmonksCache.has(cacheKey), true);
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.sportmonksCache.delete(cacheKey);
    __sportsbookProviders.sportmonksRetryState.delete(cacheKey);
    __sportsbookProviders.sportmonksLiveCache.clear();
  }
});

test('error detection: normal response with empty errors array, empty errors object, error: null not flagged as error', async () => {
  const originalFetch = globalThis.fetch;
  __sportsbookProviders.sportmonksCache.clear();
  __sportsbookProviders.sportmonksRetryState.clear();
  __sportsbookProviders.sportmonksLiveCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/livescores')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ 
      data: [{ id: 'test-1', state: { short_name: 'NS' }, starting_at_timestamp: Math.floor((Date.now() + 3600000) / 1000), league: { name: 'Test League', country: { name: 'England' } }, participants: [{ name: 'Home', meta: { location: 'home' } }, { name: 'Away', meta: { location: 'away' } }], odds: [] }],
      errors: [],
      error: null,
      message: 'info message with data'
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 2, maxPages: 1 });
    assert.equal(result.transportOk, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.events.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.sportmonksCache.clear();
    __sportsbookProviders.sportmonksRetryState.clear();
    __sportsbookProviders.sportmonksLiveCache.clear();
  }
});

test('error detection: response with errors array containing items flagged as error with reason', async () => {
  const originalFetch = globalThis.fetch;
  __sportsbookProviders.sportmonksCache.clear();
  __sportsbookProviders.sportmonksRetryState.clear();
  __sportsbookProviders.sportmonksLiveCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/livescores')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ 
      data: [],
      errors: ['account suspended', 'quota exceeded']
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 2, maxPages: 1 });
    assert.equal(result.transportOk, false);
    assert.ok(result.errors.join(' ').includes('account suspended'));
    assert.ok(result.errors.join(' ').includes('quota exceeded'));
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.sportmonksCache.clear();
    __sportsbookProviders.sportmonksRetryState.clear();
    __sportsbookProviders.sportmonksLiveCache.clear();
  }
});

test('error detection: Sportmonks no-access message appears as warning, not fatal error', async () => {
  const originalFetch = globalThis.fetch;
  __sportsbookProviders.sportmonksCache.clear();
  __sportsbookProviders.sportmonksRetryState.clear();
  __sportsbookProviders.sportmonksLiveCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/livescores')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ 
      data: [],
      message: 'No result(s) found for this date or you don\'t have access to this data with your current subscription'
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 2, maxPages: 1 });
    // Should NOT be transportOk: false, should be transportOk: true with warnings
    assert.equal(result.transportOk, true);
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings);
    assert.ok(result.warnings.join(' ').includes('No result'));
assert.ok(result.warnings.join(' ').includes('subscription'));
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.sportmonksCache.clear();
    __sportsbookProviders.sportmonksRetryState.clear();
    __sportsbookProviders.sportmonksLiveCache.clear();
  }
});
test('Sportmonks partial pagination retains fetched and cached data and backs off before retrying', async () => {
    const originalFetch = globalThis.fetch;
    const cache = __sportsbookProviders.sportmonksCache;
    const retryState = __sportsbookProviders.sportmonksRetryState;
    const liveCache = __sportsbookProviders.sportmonksLiveCache;
    cache.clear();
    retryState.clear();
    liveCache.clear();
    const makeFixture = id => ({
      id,
      state: { short_name: 'NS', name: 'Not Started' },
      starting_at_timestamp: Math.floor((Date.now() + 3600000) / 1000),
      league: { name: 'Regional League', country: { name: 'England' } },
      participants: [
        { name: `Home ${id}`, meta: { location: 'home' } },
        { name: `Away ${id}`, meta: { location: 'away' } }
      ],
      odds: []
    });
    let requestMode = 'complete';
    let requests = 0;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      requests += 1;
      const page = Number(url.searchParams.get('page'));
      if (requestMode === 'partial' && page === 2) {
        return new Response(JSON.stringify({ error: 'provider page unavailable' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const fixture = makeFixture(requestMode === 'recovery' ? 'recovered' : `complete-${page}`);
      return new Response(JSON.stringify({
        data: [fixture],
        pagination: { has_more: page === 1 && requestMode !== 'recovery' }
      }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      // Use unique maxEvents/maxPages to avoid cache collision with other tests
      const testMaxEvents = 999;
      const testMaxPages = 999;
      const complete = await fetchSportmonks({ maxEvents: testMaxEvents, maxPages: testMaxPages });
      assert.equal(complete.stale, undefined);
      assert.equal(complete.events.length, 2);

      // Get the actual cache key used by the function
      const cacheKey = [...cache.keys()][0];
      cache.get(cacheKey).fetchedAt = 0;
      requestMode = 'partial';
      const partial = await fetchSportmonks({ maxEvents: testMaxEvents, maxPages: testMaxPages });
      assert.equal(partial.partial, true);
      assert.equal(partial.transportOk, true);
      assert.ok(
        complete.events.every(event => partial.events.some(candidate =>
          (candidate._refs?.sportmonks || candidate.id) === (event._refs?.sportmonks || event.id)
        ))
      );
      assert.ok(partial.events.some(event => event.home.name === 'Home complete-1'));
      const requestsAfterFailure = requests;

      const throttled = await fetchSportmonks({ maxEvents: testMaxEvents, maxPages: testMaxPages });
      assert.equal(throttled.stale, undefined);
      assert.equal(throttled.transportOk, true);
      assert.equal(throttled.events.length, partial.events.length);
      assert.equal(requests, requestsAfterFailure, 'provider retry is held during the backoff window');

      cache.get(cacheKey).fetchedAt = 0;
      retryState.get(cacheKey).retryAt = 0;
      requestMode = 'recovery';
      const recovered = await fetchSportmonks({ maxEvents: testMaxEvents, maxPages: testMaxPages });
      assert.equal(recovered.stale, undefined);
      assert.equal(recovered.events[0].home.name, 'Home recovered');
      assert.equal(retryState.has(cacheKey), false);
    } finally {
      globalThis.fetch = originalFetch;
      cache.clear();
      retryState.clear();
      liveCache.clear();
    }
  });

test('API-Sports settlement authority unlocks merged FT prices', () => {
  const sharpEvent = __sportsbookProviders.normalizeSharpApiRows([
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7, line: null },
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8, line: null },
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1, line: null }
  ], { maxEvents: 1 })[0];
  const apiEvent = {
    id: 'api-authority',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-08-07T12:00:00Z',
    status: 'SCHEDULED',
    providerStatus: 'NS',
    live: false,
    home: { name: 'Liverpool', score: null, logo: null },
    away: { name: 'Everton', score: null, logo: null },
    periodScores: {},
    markets: [],
    _refs: { 'api-sports': 'api-9911' },
    _sources: ['api-sports'],
    _settlementReadySources: ['api-sports']
  };
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharpEvent] }, { events: [apiEvent] }]);
  assert.ok(merged._sources.includes('api-sports'));
  assert.ok(merged.markets.some(market => market.period === 'FT' && !market.suspended));
});

test('Sportmonks halftime authority keeps valid FT and 1H odds active while non-authority HT remains suspended', () => {
  const fixture = {
    id: 'sportmonks-ht-authority',
    state: { short_name: 'NS', name: 'Not Started' },
    starting_at: '2026-08-07T12:00:00Z',
    league: { name: 'Premier League', country: { name: 'England' } },
    participants: [
      { name: 'Liverpool', meta: { location: 'home' } },
      { name: 'Everton', meta: { location: 'away' } }
    ],
    scores: [{ description: '1ST HALF', score: { home: 0, away: 0 } }]
  };
  const rows = [
    { market_id: 1, market_description: '1X2', label: 'Home', value: 1.8, stopped: false },
    { market_id: 1, market_description: '1X2', label: 'Draw', value: 3.4, stopped: false },
    { market_id: 1, market_description: '1X2', label: 'Away', value: 4.2, stopped: false },
    { market_id: 2, market_description: '1st Half 1X2', label: 'Home', value: 2.1, stopped: false },
    { market_id: 2, market_description: '1st Half 1X2', label: 'Draw', value: 2.2, stopped: false },
    { market_id: 2, market_description: '1st Half 1X2', label: 'Away', value: 3.9, stopped: false }
  ];
  const sportmonks = __sportsbookProviders.normalizeSportmonksFixture(fixture, rows);
  const [trusted] = __sportsbookProviders.mergeProviderEvents([{ provider: 'sportmonks', events: [sportmonks] }]);
  const ft = trusted.markets.find(market => market.period === 'FT');
  const ht = trusted.markets.find(market => market.period === '1H');
  assert.ok(ft && !ft.suspended && ft.selections.every(selection => !selection.suspended));
  assert.ok(ht && !ht.suspended && ht.selections.every(selection => !selection.suspended));
  assert.deepEqual(trusted.periodScores['1H'], { home: 0, away: 0 });
  const authority = eventSettlementAuthority(trusted);
  assert.equal(authority.ht, true);
  const finished = { ...trusted, status: 'FINISHED', providerStatus: 'FT', settlementAuthority: authority };
  assert.deepEqual(evaluateSportsbookLeg({
    market_period: '1H', market_type: '1X2', selection_label: 'Home',
    home_team: 'Liverpool', away_team: 'Everton', market_line: null
  }, finished), { status: 'LOST', resultValue: 'HT 0-0' });

  const untrusted = structuredClone(sportmonks);
  untrusted._sources = ['sharpapi'];
  untrusted._settlementReadySources = ['sharpapi'];
  for (const market of untrusted.markets) {
    market.source = 'sharpapi';
    for (const selection of market.selections) selection.source = 'sharpapi';
  }
  const [nonAuthority] = __sportsbookProviders.mergeProviderEvents([{ provider: 'sharpapi', events: [untrusted] }]);
  assert.ok(nonAuthority.markets.every(market => market.suspended && market.selections.every(selection => selection.suspended)));
  assert.equal(eventSettlementAuthority(nonAuthority).ht, false);
});

test('SharpAPI normalizer maps soccer FT/HT 1X2 handicap and totals from one sportsbook', () => {
  const base = {
    event_id: 'sharp-epl-1', event_uuid: 'sharp-uuid-epl-1', sport: 'soccer', league: 'england_-_premier_league',
    home_team: 'Arsenal', away_team: 'Chelsea', event_start_time: '2026-08-14T19:00:00Z', is_live: false,
    is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-14T10:00:00Z'
  };
  const rows = [
    { ...base, sportsbook: 'book-a', id: 'a-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.9, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.5, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.1, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-sp1', market_type: 'point_spread', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.91, line: -0.5 },
    { ...base, sportsbook: 'book-a', id: 'a-sp2', market_type: 'point_spread', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 1.95, line: 0.5 },
    { ...base, sportsbook: 'book-a', id: 'a-o', market_type: 'total_points', market_segment: 'full_game', selection: 'Over', selection_type: 'over', odds_decimal: 1.88, line: 2.5 },
    { ...base, sportsbook: 'book-a', id: 'a-u', market_type: 'total_points', market_segment: 'full_game', selection: 'Under', selection_type: 'under', odds_decimal: 1.96, line: 2.5 },
    { ...base, sportsbook: 'book-a', id: 'a-1hh', market_type: '1st_half', market_segment: '1st_half', selection: 'Arsenal', selection_type: 'home', odds_decimal: 2.3, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1hd', market_type: '1st_half', market_segment: '1st_half', selection: 'Draw', selection_type: 'draw', odds_decimal: 2.1, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1ha', market_type: '1st_half', market_segment: '1st_half', selection: 'Chelsea', selection_type: 'away', odds_decimal: 3.8, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1hsp1', market_type: '1st_half', market_segment: '1st_half', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.92, line: -0.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1hsp2', market_type: '1st_half', market_segment: '1st_half', selection: 'Chelsea', selection_type: 'away', odds_decimal: 1.94, line: 0.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1ho', market_type: '1st_half', market_segment: '1st_half', selection: 'Over', selection_type: 'over', odds_decimal: 1.89, line: 1.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1hu', market_type: '1st_half', market_segment: '1st_half', selection: 'Under', selection_type: 'under', odds_decimal: 1.97, line: 1.25 },
    { ...base, sportsbook: 'book-b', id: 'b-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.95, line: null },
    { ...base, sportsbook: 'book-b', id: 'b-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.6, line: null },
    { ...base, sportsbook: 'book-b', id: 'b-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.2, line: null }
  ];
  const [event] = __sportsbookProviders.normalizeSharpApiRows(rows);
  assert.equal(event.sport, 'Football');
  assert.equal(event._refs.sharpapiSportsbook, 'book-a');
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === 'FT' && market.selections.length === 3));
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === 'FT' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === 'FT' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === '1H' && market.selections.length === 3));
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === '1H' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H' && market.selections.length === 2));
  assert.ok(event.markets.flatMap(market => market.selections).every(selection => selection.priceVersion && selection.priceVersion.length >= 20));
  assert.ok(event.markets.every(market => market.source === 'sharpapi'));
  assert.ok(event.markets.every(market => market.bookmaker === 'book-a'));
});

test('SharpAPI prices remain visible but suspended without result authority', () => {
  const rows = [
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7, is_main_line: true, is_active: true },
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8, is_main_line: true, is_active: true },
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1, is_main_line: true, is_active: true }
  ];
  const [sharpEvent] = __sportsbookProviders.normalizeSharpApiRows(rows);
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharpEvent] }]);
  assert.ok(merged.markets.length > 0);
  assert.ok(merged.markets.every(market => market.suspended));
});

test('API-Sports authority unlocks matching SharpAPI FT and HT prices', () => {
  const base = { event_id: 'sharp-3', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-15T20:00:00Z', sportsbook: 'book-a', is_main_line: true, is_active: true };
  const sharpRows = [
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7 },
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8 },
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Liverpool', selection_type: 'home', odds_decimal: 2.2 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Draw', selection_type: 'draw', odds_decimal: 2.0 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Everton', selection_type: 'away', odds_decimal: 4.0 }
  ];
  const [sharpEvent] = __sportsbookProviders.normalizeSharpApiRows(sharpRows);
  const apiEvent = {
    id: 'api-3',
    sport: 'Football',
    league: 'epl',
    country: 'England',
    startTime: '2026-08-15T20:00:00Z',
    status: 'SCHEDULED',
    providerStatus: 'NS',
    live: false,
    home: { name: 'Liverpool', score: null, logo: null },
    away: { name: 'Everton', score: null, logo: null },
    periodScores: {},
    markets: [],
    _refs: { 'api-sports': 'api-20260815' },
    _sources: ['api-sports'],
    _settlementReadySources: ['api-sports']
  };
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharpEvent] }, { events: [apiEvent] }]);
  assert.ok(merged._sources.includes('sharpapi'));
  assert.ok(merged._sources.includes('api-sports'));
  assert.ok(merged.markets.some(market => market.period === 'FT' && !market.suspended));
  assert.ok(merged.markets.some(market => market.period === '1H' && !market.suspended));
});


test('API-Sports provider status remains authoritative after SharpAPI merge', () => {
  const sharp = __sportsbookProviders.normalizeSharpApiRows([
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Arsenal', selection_type:'home', odds_decimal:1.9, is_main_line:true, is_active:true },
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Draw', selection_type:'draw', odds_decimal:3.4, is_main_line:true, is_active:true },
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Chelsea', selection_type:'away', odds_decimal:4.0, is_main_line:true, is_active:true }
  ])[0];
  const api = {
    id: 'api-status',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-08-14T19:00:00Z',
    status: 'LIVE',
    providerStatus: 'HT',
    live: true,
    home: { name: 'Arsenal', score: 1, logo: null },
    away: { name: 'Chelsea', score: 0, logo: null },
    periodScores: { '1H': { home: 1, away: 0 } },
    markets: [],
    _refs: { 'api-sports': 'api-55' },
    _sources: ['api-sports'],
    _settlementReadySources: ['api-sports']
  };
  const [merged] = __sportsbookProviders.mergeProviderEvents([{events:[sharp]},{events:[api]}]);
  assert.equal(merged.providerStatus, 'HT');
  assert.deepEqual(merged.periodScores['1H'], {home:1,away:0});
});

test('SharpAPI price version changes only when tradable terms change, not timestamp heartbeat', () => {
  const base={event_id:'sharp-version',sport:'soccer',league:'epl',home_team:'A',away_team:'B',event_start_time:'2026-08-14T19:00:00Z',sportsbook:'book-a',market_type:'moneyline',is_main_line:true,is_active:true};
  const make=(timestamp,homeOdds=2)=>[
    {...base,id:'home',selection:'A',selection_type:'home',odds_decimal:homeOdds,timestamp},
    {...base,id:'draw',selection:'Draw',selection_type:'draw',odds_decimal:3,timestamp},
    {...base,id:'away',selection:'B',selection_type:'away',odds_decimal:4,timestamp}
  ];
  const first=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:00Z'))[0].markets[0].selections[0];
  const heartbeat=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:30Z'))[0].markets[0].selections[0];
  const changed=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:31Z',1.95))[0].markets[0].selections[0];
  assert.equal(first.priceVersion, heartbeat.priceVersion);
  assert.notEqual(first.priceVersion, changed.priceVersion);
});


test('SharpAPI core market is fail-closed when any required outcome is suspended', () => {
  const base={event_id:'sharp-suspend',sport:'soccer',league:'epl',home_team:'A',away_team:'B',event_start_time:'2026-08-14T19:00:00Z',sportsbook:'book-a',market_type:'moneyline',is_main_line:true};
  const [event]=__sportsbookProviders.normalizeSharpApiRows([
    {...base,id:'h',selection:'A',selection_type:'home',odds_decimal:2,is_active:true},
    {...base,id:'d',selection:'Draw',selection_type:'draw',odds_decimal:3,is_active:false},
    {...base,id:'a',selection:'B',selection_type:'away',odds_decimal:4,is_active:true}
  ]);
  assert.equal(event.markets[0].suspended, true);
});


test('Live markets fail closed when the provider price timestamp is stale, missing, or heartbeat-only', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const market = updatedAt => ({ id: 'm1', suspended: false, updatedAt, selections: [{ key: 's1', suspended: false, odds: 1.9, updatedAt }] });
  const liveEvent = (updatedAt, overrides = {}) => ({ id: 'e1', live: true, status: 'LIVE', markets: [market(updatedAt)], ...overrides });
  const guard = events => __sportsbookProviders.suspendStaleLiveMarkets(events, now);

  // Harga baru (30 detik lalu, jendela live = 90 detik) tetap terbuka.
  assert.equal(guard([liveEvent('2026-10-06T11:59:30Z')])[0].markets[0].suspended, false);
  // Harga basi (10 menit lalu) ditahan, beserta seluruh selection-nya.
  const stale = guard([liveEvent('2026-10-06T11:50:00Z')])[0].markets[0];
  assert.equal(stale.suspended, true);
  assert.ok(stale.selections.every(selection => selection.suspended));
  // Tanpa timestamp = tidak bisa dibuktikan segar -> dianggap basi (fail-closed).
  assert.equal(guard([liveEvent(null)])[0].markets[0].suspended, true);
  // Prematch tidak pernah disentuh oleh guard ini.
  assert.equal(guard([liveEvent(null, { live: false, status: 'SCHEDULED' })])[0].markets[0].suspended, false);
});

test("SharpAPI does not merge distinct fixtures that reuse the same provider event ID", () => {
  const rows = [{ event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League A", home_team: "Home A", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Home A", selection_type: "home", odds_decimal: 1.9, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }, { event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League A", home_team: "Home A", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Draw", selection_type: "draw", odds_decimal: 3.4, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }, { event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League A", home_team: "Home A", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Away X", selection_type: "away", odds_decimal: 4.0, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }, { event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League B", home_team: "Home B", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Home B", selection_type: "home", odds_decimal: 2.1, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }, { event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League B", home_team: "Home B", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Draw", selection_type: "draw", odds_decimal: 3.1, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }, { event_id: "shared-id", event_uuid: "shared-id", sport: "soccer", league: "League B", home_team: "Home B", away_team: "Away X", event_start_time: "2026-08-14T19:00:00Z", sportsbook: "book-a", market_type: "moneyline", market_segment: "full_game", selection: "Away X", selection_type: "away", odds_decimal: 3.6, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" }];
  const events = __sportsbookProviders.normalizeSharpApiRows(rows);
  assert.equal(events.length, 2);
});

test("SharpAPI merges same fixture with kickoff times 5 minutes apart across sportsbooks", () => {
  const base = { event_id: "same-fixture", event_uuid: "same-fixture", sport: "soccer", league: "EPL", home_team: "Arsenal", away_team: "Chelsea", is_live: false, is_main_line: true, is_active: true, timestamp: "2026-08-14T10:00:00Z" };
  const rows = [
    { ...base, sportsbook: "book-a", event_start_time: "2026-08-14T19:00:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Arsenal", selection_type: "home", odds_decimal: 1.9 },
    { ...base, sportsbook: "book-a", event_start_time: "2026-08-14T19:00:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Draw", selection_type: "draw", odds_decimal: 3.4 },
    { ...base, sportsbook: "book-a", event_start_time: "2026-08-14T19:00:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Chelsea", selection_type: "away", odds_decimal: 4.0 },
    { ...base, sportsbook: "book-b", event_start_time: "2026-08-14T19:05:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Arsenal", selection_type: "home", odds_decimal: 2.0 },
    { ...base, sportsbook: "book-b", event_start_time: "2026-08-14T19:05:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Draw", selection_type: "draw", odds_decimal: 3.2 },
    { ...base, sportsbook: "book-b", event_start_time: "2026-08-14T19:05:00Z", market_type: "moneyline", market_segment: "full_game", selection: "Chelsea", selection_type: "away", odds_decimal: 3.8 }
  ];
  const events = __sportsbookProviders.normalizeSharpApiRows(rows);
  assert.equal(events.length, 1);
});

test('SharpAPI error detection: normal response with empty errors array, empty errors object, error: null not flagged as error', () => {
  const { hasPayloadErrors } = __sportsbookProviders;
  const payload = {
    success: true,
    data: [{ event_id: 'test-1' }],
    errors: [],
    error: null,
    message: 'info message with data'
  };
  assert.equal(hasPayloadErrors(payload), false);
});

test('SharpAPI error detection: response with errors array containing items flagged as error with reason', () => {
  const { hasPayloadErrors, extractErrorDetail } = __sportsbookProviders;
  const payload = {
    success: true,
    data: [],
    errors: ['account suspended', 'quota exceeded']
  };
  assert.equal(hasPayloadErrors(payload), true);
  assert.ok(extractErrorDetail(payload).includes('account suspended'));
  assert.ok(extractErrorDetail(payload).includes('quota exceeded'));
});

test('SharpAPI error detection: response with usable data and error-like message not flagged as error', () => {
  const { hasPayloadErrors } = __sportsbookProviders;
  const payload = {
    success: true,
    data: [{ event_id: 'test-1' }],
    message: 'quota limit approaching but data returned'
  };
  assert.equal(hasPayloadErrors(payload), false);
});

test('SharpAPI error detection: Sportmonks no-access message appears as warning, not fatal error', () => {
  const { hasPayloadErrors, extractErrorDetail } = __sportsbookProviders;
  const payload = {
    success: true,
    data: [],
    message: "No result(s) found for this date or you don't have access to this data with your current subscription"
  };
  assert.equal(hasPayloadErrors(payload), false);
  assert.ok(extractErrorDetail(payload)?.startsWith('warning:'));
});

test('SharpAPI error detection: empty data array with quota message flagged as error', () => {
  const { hasPayloadErrors, extractErrorDetail } = __sportsbookProviders;
  const payload = {
    success: true,
    data: [],
    message: 'quota exceeded'
  };
  // data: [] is falsy (empty array), so hasUsableData = false, quota message should be flagged as error
  assert.equal(hasPayloadErrors(payload), true);
  assert.ok(extractErrorDetail(payload).includes('quota exceeded'));
});
