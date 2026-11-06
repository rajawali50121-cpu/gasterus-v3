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
  THE_ODDS_API_ENABLED: 'true',
  THE_ODDS_API_KEY: 'test-existing-odds-key',
  THE_ODDS_API_EVENT_MARKETS_ENABLED: 'true',
  THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: '5',
  THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: '8',
  THE_ODDS_API_MAX_TOTAL_EVENTS: '10',
  THE_ODDS_API_SPORT_KEYS: 'soccer_epl,basketball_nba,tennis_atp_us_open'
});

const { __sportsbookProviders, fetchSportmonks, publicEvent } = await import('../src/sportsbook-providers.js');
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

  test('Sportmonks maps market_id 28 "1st Half Goals" to TOTALS:1H (explicit, no regex widen)', () => {
  const fixture = {
    id: 'sm-m28',
    state: { short_name: 'NS', name: 'Not Started' },
    starting_at: '2026-11-06T12:00:00Z',
    league: { name: 'Test League', country: { name: 'X' } },
    participants: [
      { name: 'Home', meta: { location: 'home' } },
      { name: 'Away', meta: { location: 'away' } }
    ]
  };
  const mkRows = desc => [
    { id: 1, market_id: 28, market_description: desc, label: 'Over', name: '0.5', total: '0.5', value: 1.9 },
    { id: 2, market_id: 28, market_description: desc, label: 'Under', name: '0.5', total: '0.5', value: 1.9 }
  ];
  const check = desc => {
    const event = __sportsbookProviders.normalizeSportmonksFixture(fixture, mkRows(desc));
    const m = event.markets.find(x => String(x.sourceMarketId).replace(/^m/, '') === '28');
    assert.ok(m, 'market 28 present ' + desc);
    assert.equal(m.type, 'TOTALS');
    assert.equal(m.period, '1H');
    const over = m.selections.find(s => /over/i.test(s.label));
    const under = m.selections.find(s => /under/i.test(s.label));
    assert.ok(over && under, 'Over/Under selections');
    assert.equal(Number(over.line), 0.5);
    assert.equal(Number(under.line), 0.5);
    assert.equal(Number(over.odds), 1.9);
  };
  check('1st Half Goals');
  check('Goals Over/Under - First Period');
  // stopped odds must not be bettable (selection/market suspended; mechanism already exists)
  const stoppedEvent = __sportsbookProviders.normalizeSportmonksFixture(fixture, [
    { id: 991, market_id: 28, market_description: '1st Half Goals', label: 'Over', total: '0.5', value: 1.9, stopped: true },
    { id: 992, market_id: 28, market_description: '1st Half Goals', label: 'Under', total: '0.5', value: 1.9, stopped: true }
  ]);
  const stoppedM28 = stoppedEvent.markets.find(x => String(x.sourceMarketId).replace(/^m/, '') === '28');
  assert.ok(stoppedM28);
  assert.equal(stoppedM28.type, 'TOTALS');
  assert.equal(stoppedM28.period, '1H');
  assert.equal(stoppedM28.suspended, true);
  assert.ok(stoppedM28.selections.every(s => s.suspended));
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
    assert.equal(event.markets.length, 6, 'valid supplied markets remain and invalid odds are excluded');
    const firstHalf = event.markets.find(market => market.sourceMarketId === 'm101');
    const handicap = event.markets.find(market => market.sourceMarketId === 'm102');
    const secondHalfTotals = event.markets.find(market => market.sourceMarketId === 'm103');
    const playerProps = event.markets.find(market => market.sourceMarketId === 'm104');
    const unknownMarket = event.markets.find(market => market.sourceMarketId === 'm105');
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
    assert.equal(marketWithoutId.sourceMarketId, null);
    assert.equal(marketWithoutId.selections[0].line, 1);
  });

  test('Sportmonks scans pages through the configured budget after its candidate buffer fills', async () => {
    const originalFetch = globalThis.fetch;
    const requestedPages = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      const page = Number(url.searchParams.get('page'));
      requestedPages.push(page);
      const fixtures = Array.from({ length: 20 }, (_, index) => {
        const fixtureId = `pagination-${page}-${index}`;
        return {
          id: fixtureId,
          state: { short_name: 'NS', name: 'Not Started' },
          starting_at_timestamp: Math.floor((Date.now() + (page * 20 + index + 1) * 60000) / 1000),
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
      assert.equal(result.events.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
});

test('Sportmonks retries a timed-out page request and recovers without dropping the fixture', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async input => {
      if (new URL(String(input)).pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      requests += 1;
      if (requests === 1) {
        const error = new Error('simulated provider timeout');
        error.name = 'AbortError';
        throw error;
      }
      return new Response(JSON.stringify({
        data: [{
          id: 'timeout-recovered',
          state: { short_name: 'NS', name: 'Not Started' },
          starting_at_timestamp: Math.floor((Date.now() + 3600000) / 1000),
          league: { name: 'Regional League', country: { name: 'England' } },
          participants: [
            { name: 'Home', meta: { location: 'home' } },
            { name: 'Away', meta: { location: 'away' } }
          ],
          odds: []
        }],
        pagination: { has_more: false }
      }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await fetchSportmonks({ maxEvents: 1, maxPages: 2 });
      assert.equal(requests, 2);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].home.name, 'Home');
    } finally {
      globalThis.fetch = originalFetch;
    }
});

test('Sportmonks live window refreshes provider in-play odds without retaining stale pre-match odds', async () => {
  const originalFetch = globalThis.fetch;
    const liveCache = __sportsbookProviders.sportmonksLiveCache;
    const liveRetryState = __sportsbookProviders.sportmonksLiveRetryState;
    liveCache.clear();
    liveRetryState.clear();
    const makeFixture = (id, state, odds = []) => ({
      id,
      state: { short_name: state, name: state === 'NS' ? 'Not Started' : 'Second Half' },
      starting_at_timestamp: Math.floor((Date.now() - 3600000) / 1000),
      league: { name: 'Regional League', country: { name: 'England' } },
      participants: [
        { name: `Home ${id}`, meta: { location: 'home' } },
        { name: `Away ${id}`, meta: { location: 'away' } }
      ],
      odds
    });
    const preMatchOdds = id => [{
      id: `${id}-prematch`,
      market_id: 1,
      market_description: 'Full Time Result',
      label: 'Home',
      value: 1.8
    }];
    const liveFixtureWithOdds = {
      ...makeFixture('fast-live-1', '2H'),
      scores: [{ description: 'CURRENT', score: { home: 2, away: 1 } }],
      inplayOdds: [{
        id: 901,
        market_id: 1,
        market_description: 'Full Time Result',
        label: 'Home',
        value: '2.25',
        latest_bookmaker_update: new Date().toISOString()
      }]
    };
    const liveFixtureWithoutOdds = {
      ...makeFixture('fast-live-2', '2H'),
      inplayOdds: []
    };
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        assert.equal(url.pathname, '/v3/football/livescores');
        assert.match(url.searchParams.get('include'), /inplayOdds/);
        return new Response(JSON.stringify({
          data: [liveFixtureWithOdds, liveFixtureWithoutOdds]
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [
          makeFixture('fast-live-1', 'NS', preMatchOdds('fast-live-1')),
          makeFixture('fast-live-2', 'NS', preMatchOdds('fast-live-2'))
        ],
        pagination: { has_more: false }
      }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await fetchSportmonks({ maxEvents: 7, maxPages: 7 });
      const withOdds = result.events.find(event => event.home.name === 'Home fast-live-1');
      const withoutOdds = result.events.find(event => event.home.name === 'Home fast-live-2');
      assert.equal(withOdds.live, true);
      assert.equal(withOdds.markets[0].selections[0].odds, 2.25);
      assert.equal(withOdds.home.score, 2);
      assert.equal(withoutOdds.live, true);
      assert.deepEqual(withoutOdds.markets, [], 'old pre-match prices are not carried into a live event without in-play odds');
    } finally {
      globalThis.fetch = originalFetch;
      liveCache.clear();
      liveRetryState.clear();
      __sportsbookProviders.sportmonksCache.delete(
        `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:7:7`
      );
      __sportsbookProviders.sportmonksRetryState.delete(
        `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:7:7`
      );
    }
});

test('Sportmonks live odds without a provider timestamp remain fail-closed', async () => {
  const originalFetch = globalThis.fetch;
  const liveCache = __sportsbookProviders.sportmonksLiveCache;
  const liveRetryState = __sportsbookProviders.sportmonksLiveRetryState;
  const catalogCache = __sportsbookProviders.sportmonksCache;
  const catalogRetryState = __sportsbookProviders.sportmonksRetryState;
  const catalogKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:2:2`;
  liveCache.clear();
  liveRetryState.clear();
  const fixture = {
    id: 'live-without-source-timestamp',
    state: { short_name: '2H', name: 'Second Half' },
    starting_at_timestamp: Math.floor((Date.now() - 60 * 60 * 1000) / 1000),
    league: { name: 'Regional League', country: { name: 'England' } },
    participants: [
      { name: 'Timestamp Home', meta: { location: 'home' } },
      { name: 'Timestamp Away', meta: { location: 'away' } }
    ]
  };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith('/livescores')
      ? [{
          ...fixture,
          inplayOdds: [{
            id: 901,
            market_id: 1,
            market_description: 'Full Time Result',
            label: 'Home',
            value: 2.25
          }]
        }]
      : [{
          ...fixture,
          state: { short_name: 'NS', name: 'Not Started' },
          odds: []
        }];
    return new Response(JSON.stringify({
      data,
      pagination: { has_more: false }
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
    const event = result.events.find(item => item.home.name === 'Timestamp Home');
    assert.ok(event);
    assert.equal(event.markets[0].updatedAt, null);
    assert.equal(event.markets[0].selections[0].updatedAt, null);
    const [guarded] = __sportsbookProviders.suspendStaleLiveMarkets([event], Date.now());
    assert.equal(guarded.markets[0].suspended, true);
    assert.equal(guarded.markets[0].selections[0].suspended, true);
  } finally {
    globalThis.fetch = originalFetch;
    liveCache.clear();
    liveRetryState.clear();
    catalogCache.delete(catalogKey);
    catalogRetryState.delete(catalogKey);
  }
});

test('Sportmonks live odds fail closed during provider outage and recover after backoff', async () => {
    const originalFetch = globalThis.fetch;
    const catalogCache = __sportsbookProviders.sportmonksCache;
    const catalogRetryState = __sportsbookProviders.sportmonksRetryState;
    const liveCache = __sportsbookProviders.sportmonksLiveCache;
    const liveRetryState = __sportsbookProviders.sportmonksLiveRetryState;
    liveCache.clear();
    liveRetryState.clear();
    const catalogKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:8:8`;
    const liveKey = 'sportmonks:live-window:https://api.sportmonks.com/v3';
    const kickoff = Math.floor((Date.now() - 3600000) / 1000);
    const fixture = {
      id: 'live-recovery',
      state: { short_name: '2H', name: 'Second Half' },
      starting_at_timestamp: kickoff,
      league: { name: 'Regional League', country: { name: 'England' } },
      participants: [
        { name: 'Recovery Home', meta: { location: 'home' } },
        { name: 'Recovery Away', meta: { location: 'away' } }
      ],
      odds: [{
        id: 700,
        market_id: 1,
        market_description: 'Full Time Result',
        label: 'Home',
        value: 1.8
      }]
    };
    let liveMode = 'forbidden';
    let liveRequests = 0;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        liveRequests += 1;
        if (liveMode === 'forbidden') return new Response('provider access denied', { status: 403 });
        return new Response(JSON.stringify({
          data: [{
            ...fixture,
            inplayOdds: [{
              id: 701,
              market_id: 1,
              market_description: 'Full Time Result',
              label: 'Home',
              value: 2.4,
              latest_bookmaker_update: new Date().toISOString()
            }]
          }]
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [fixture],
        pagination: { has_more: false }
      }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const unavailable = await fetchSportmonks({ maxEvents: 8, maxPages: 8 });
      assert.equal(unavailable.events[0].markets[0].suspended, true);
      assert.equal(unavailable.events[0].markets[0].selections[0].suspended, true);
      assert.equal(liveRequests, 1);

      await fetchSportmonks({ maxEvents: 8, maxPages: 8 });
      assert.equal(liveRequests, 1, '403 cooldown prevents repeated provider requests');

      liveMode = 'recovery';
      liveRetryState.get(liveKey).retryAt = 0;
      const recovered = await fetchSportmonks({ maxEvents: 8, maxPages: 8 });
      assert.equal(liveRequests, 2);
      assert.equal(recovered.events[0].markets[0].selections[0].odds, 2.4);
      assert.equal(recovered.events[0].markets[0].suspended, false);
      assert.equal(liveRetryState.has(liveKey), false);
    } finally {
      globalThis.fetch = originalFetch;
      catalogCache.delete(catalogKey);
      catalogRetryState.delete(catalogKey);
      liveCache.delete(liveKey);
      liveRetryState.delete(liveKey);
    }
});

test('Sportmonks keeps live odds fresh while a complete fixture-catalog retry is cooling down', async () => {
    const originalFetch = globalThis.fetch;
    const catalogCache = __sportsbookProviders.sportmonksCache;
    const catalogRetryState = __sportsbookProviders.sportmonksRetryState;
    const liveCache = __sportsbookProviders.sportmonksLiveCache;
    const liveRetryState = __sportsbookProviders.sportmonksLiveRetryState;
    const catalogKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:2:2`;
    const liveKey = 'sportmonks:live-window:https://api.sportmonks.com/v3';
    const fixture = {
      id: 'catalog-cooldown-live',
      state: { short_name: '2H', name: 'Second Half' },
      starting_at_timestamp: Math.floor((Date.now() - 3600000) / 1000),
      league: { name: 'Regional League', country: { name: 'England' } },
      participants: [
        { name: 'Cooldown Home', meta: { location: 'home' } },
        { name: 'Cooldown Away', meta: { location: 'away' } }
      ]
    };
    const catalogEvent = __sportsbookProviders.normalizeSportmonksFixture(fixture, [{
      id: 800,
      market_id: 1,
      market_description: 'Full Time Result',
      label: 'Home',
      value: 1.8
    }]);
    catalogCache.set(catalogKey, { fetchedAt: 0, events: [catalogEvent] });
    catalogRetryState.set(catalogKey, {
      attempts: 1,
      retryAt: Date.now() + 60_000,
      message: 'Fixture catalog page unavailable'
    });
    liveCache.clear();
    liveRetryState.clear();
    let catalogRequests = 0;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({
          data: [{
            ...fixture,
            inplayOdds: [{
              id: 801,
              market_id: 1,
              market_description: 'Full Time Result',
              label: 'Home',
              value: 2.4,
              latest_bookmaker_update: new Date().toISOString()
            }]
          }]
        }), { headers: { 'content-type': 'application/json' } });
      }
      catalogRequests += 1;
      throw new Error('fixture catalog must remain in its retry cooldown');
    };
    try {
      const result = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
      assert.equal(result.stale, true);
      assert.equal(result.transportOk, false);
      assert.equal(result.events[0].markets[0].selections[0].odds, 2.4);
      assert.equal(result.events[0].markets[0].suspended, false);
      assert.equal(catalogRequests, 0);
    } finally {
      globalThis.fetch = originalFetch;
      catalogCache.delete(catalogKey);
      catalogRetryState.delete(catalogKey);
      liveCache.clear();
      liveRetryState.clear();
    }
});

test('Sportmonks partial pagination preserves last complete data and backs off before retrying', async () => {
    const originalFetch = globalThis.fetch;
    const cache = __sportsbookProviders.sportmonksCache;
    const retryState = __sportsbookProviders.sportmonksRetryState;
    const liveCache = __sportsbookProviders.sportmonksLiveCache;
    liveCache.clear();
  const cacheKey = `sportmonks:all-events:${new Date().toISOString().slice(0, 10)}:0:2:2`;
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
      return new Response('provider page unavailable', { status: 400 });
    }
    const fixture = makeFixture(requestMode === 'recovery' ? 'recovered' : `complete-${page}`);
    return new Response(JSON.stringify({
      data: [fixture],
      pagination: { has_more: page === 1 && requestMode !== 'recovery' }
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const complete = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
    assert.equal(complete.stale, undefined);
    assert.equal(complete.events.length, 2);

    cache.get(cacheKey).fetchedAt = 0;
    requestMode = 'partial';
    const partial = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
    assert.equal(partial.stale, true);
    assert.equal(partial.transportOk, false);
    assert.equal(partial.events[0].id, complete.events[0].id);
    const requestsAfterFailure = requests;

    const throttled = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
    assert.equal(throttled.stale, true);
    assert.equal(requests, requestsAfterFailure, 'provider retry is held during the backoff window');

    retryState.get(cacheKey).retryAt = 0;
    requestMode = 'recovery';
    const recovered = await fetchSportmonks({ maxEvents: 2, maxPages: 2 });
    assert.equal(recovered.stale, undefined);
    assert.equal(recovered.events[0].home.name, 'Home recovered');
    assert.equal(retryState.has(cacheKey), false);
  } finally {
    globalThis.fetch = originalFetch;
    cache.delete(cacheKey);
    retryState.delete(cacheKey);
    liveCache.clear();
  }
});

test('API-Sports preserves bookmaker labels while selecting coherent odds per market', () => {
  const payload = { response: [{ fixture: { id: 7711 }, bookmakers: [
    { id: 1, name: 'Book A', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.91 }, { value: 'Draw', odd: 3.7 }, { value: 'Beta FC', odd: 4.8 }
    ] }] },
    { id: 2, name: 'Book B', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.8 }, { value: 'Draw', odd: 3.8 }, { value: 'Beta FC', odd: 4.8 }
    ] }, { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: 1.85 }, { value: 'No', odd: 2.05 }] }] }
  ] }] };
  const odds = __sportsbookProviders.extractApiSportsOdds(payload).get('7711');
  const event = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 7711, date: '2027-08-06T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League' }, teams: { home: { name: 'Alpha FC' }, away: { name: 'Beta FC' } }
  }, odds);
  const winner = event.markets.find(market => market.type === '1X2');
  assert.equal(winner.bookmaker, 'Book A');
  assert.equal(winner.selections.find(selection => selection.label === 'Alpha FC').odds, 1.91);
  assert.ok(event.markets.some(market => market.type === 'BTTS' && market.bookmaker === 'Book B'));
});

test('API-Sports settlement authority unlocks merged FT prices', () => {
  const sharpEvent = __sportsbookProviders.normalizeSharpApiRows([
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7, line: null },
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8, line: null },
    { event_id: 'sharp-authority', event_uuid: 'sharp-authority-uuid', sport: 'soccer', league: 'Premier League', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-07T12:00:00Z', is_live: false, is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-07T10:00:00Z', sportsbook: 'book-a', id: 'sa-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1, line: null }
  ], { maxEvents: 1 })[0];
  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 9911, date: '2026-08-07T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League', country: 'England' },
    teams: { home: { name: 'Liverpool' }, away: { name: 'Everton' } }, goals: { home: null, away: null }
  });
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
  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 20260815, date: '2026-08-15T20:00:00Z', status: { short: 'NS' } },
    league: { name: 'epl', country: 'England' },
    teams: { home: { name: 'Liverpool' }, away: { name: 'Everton' } },
    goals: { home: null, away: null }, score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } }
  });
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
  const api = __sportsbookProviders.normalizeApiSportsFixture({
    fixture:{ id:55, date:'2026-08-14T19:00:00Z', status:{short:'HT', elapsed:45} }, league:{name:'Premier League',country:'England'},
    teams:{home:{name:'Arsenal'},away:{name:'Chelsea'}}, goals:{home:1,away:0}, score:{halftime:{home:1,away:0}}
  });
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



function mkSharpCfg(markets, patch = {}) {
  return { sharpApiEnabled: true, sharpApiKey: 'k', sharpApiBaseUrl: 'https://api.sharpapi.io', sharpApiSport: 'soccer', sharpApiMarkets: markets, sharpApiSportsbook: '', sharpApiMaxPages: 5, sharpApiMaxRequestsPerCycle: 5, sharpApiTimeBudgetMs: 15000, sharpApiMainLinesOnly: false, sharpApiPageSize: 200, sharpApiRefreshSeconds: 45, ...patch };
}
test('SharpAPI cursor pagination fetches 5 pages (next_cursor, next_offset null)', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('cursor5', { sharpApiMaxPages: 10, sharpApiMaxRequestsPerCycle: 10 });
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    calls.push({ offset: u.searchParams.get('offset'), cursor: u.searchParams.get('cursor') });
    const n = calls.length;
    const ev=`ev${n}`; const rows=[{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`H${n}`,selection_type:"home",odds_decimal:2.0,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:"Draw",selection_type:"draw",odds_decimal:3.2,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`A${n}`,selection_type:"away",odds_decimal:3.5,line:null}];
    return new Response(JSON.stringify({data:rows,pagination:n<5?{has_more:true,next_offset:null,next_cursor:`c${n}`}:{has_more:false,next_offset:null,next_cursor:null}}), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await fetchSharpApi();
    assert.equal(calls.length, 5);
    assert.equal(calls[1].cursor, 'c1');
    assert.equal(calls[1].offset, null);
    assert.equal(res.events.length, 5);
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});

test('SharpAPI cursor preferred when next_offset empty and next_cursor present', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('cursorpref');
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    calls.push({ offset: u.searchParams.get('offset'), cursor: u.searchParams.get('cursor') });
    const n = calls.length;
    const ev=`ev${n}`; const rows=[{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`H${n}`,selection_type:"home",odds_decimal:2.0,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:"Draw",selection_type:"draw",odds_decimal:3.2,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`A${n}`,selection_type:"away",odds_decimal:3.5,line:null}];
    return new Response(JSON.stringify({data:rows,pagination:n===1?{has_more:true,next_offset:'',next_cursor:'cx'}:{has_more:false}}), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await fetchSharpApi();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cursor, 'cx');
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});

test('SharpAPI page-3 failure returns 2 collected pages (warn, no throw)', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('p3fail');
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 3) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    const ev=`ev${n}`; const rows=[{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`H${n}`,selection_type:"home",odds_decimal:2.0,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:"Draw",selection_type:"draw",odds_decimal:3.2,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`A${n}`,selection_type:"away",odds_decimal:3.5,line:null}];
    return new Response(JSON.stringify({data:rows,pagination:{has_more:true,next_offset:n*200,next_cursor:null}}), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await fetchSharpApi();
    assert.equal(res.events.length, 2);
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});

test('SharpAPI page-1 failure throws', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('p1fail');
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => fetchSharpApi(), /SharpAPI/);
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});

test('SharpAPI time budget stops loop and returns collected rows', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('tbudget', { sharpApiMaxPages: 10, sharpApiMaxRequestsPerCycle: 10, sharpApiTimeBudgetMs: 60 });
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    await new Promise(r => setTimeout(r, 45));
    const ev=`ev${n}`; const rows=[{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`H${n}`,selection_type:"home",odds_decimal:2.0,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:"Draw",selection_type:"draw",odds_decimal:3.2,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`A${n}`,selection_type:"away",odds_decimal:3.5,line:null}];
    return new Response(JSON.stringify({data:rows,pagination:{has_more:true,next_offset:n*200}}), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await fetchSharpApi();
    assert.ok(n >= 1 && n <= 5, `expected budget stop, got ${n} calls`);
    assert.ok(res.events.length >= 1);
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});

test('SharpAPI legacy offset pagination unchanged when no next_cursor', async () => {
  const { fetchSharpApi } = await import('../src/sportsbook-providers.js');
  const orig = globalThis.fetch; const oc = globalThis.__sharpApiTestConfig;
  globalThis.__sharpApiTestConfig = mkSharpCfg('offsetold');
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    calls.push({ offset: u.searchParams.get('offset'), cursor: u.searchParams.get('cursor') });
    const n = calls.length;
    const ev=`ev${n}`; const rows=[{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`H${n}`,selection_type:"home",odds_decimal:2.0,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:"Draw",selection_type:"draw",odds_decimal:3.2,line:null},{event_id:ev,sport:"soccer",league:"L",home_team:`H${n}`,away_team:`A${n}`,event_start_time:"2026-11-06T10:00:00Z",is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:"2026-11-06T09:00:00Z",sportsbook:"draftkings",market_type:"moneyline",market_segment:"full_game",selection:`A${n}`,selection_type:"away",odds_decimal:3.5,line:null}];
    return new Response(JSON.stringify({data:rows,pagination:n<3?{has_more:true,next_offset:n*200}:{has_more:false,next_offset:null}}), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await fetchSharpApi();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].offset, null);
    assert.equal(calls[1].offset, '200');
    assert.equal(calls[2].offset, '400');
    assert.ok(calls.every(c => c.cursor === null));
    assert.equal(res.events.length, 3);
  } finally { globalThis.fetch = orig; globalThis.__sharpApiTestConfig = oc; }
});


test('Sharp market name classification (actual sharpDerivedMarketType/periodFromName)', async () => {
  const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
  const { sharpDerivedMarketType, periodFromName } = __sportsbookProviders;
  const CORE = new Set(['1X2:FT','1X2:1H','HANDICAP:FT','HANDICAP:1H','TOTALS:FT','TOTALS:1H']);
  const cases = [
    ['moneyline','1X2','FT','YA'],
    ['1st_half_moneyline','1X2','1H','YA'],
    ['2nd_half_moneyline','1X2','2H','TIDAK'],
    ['point_spread','HANDICAP','FT','YA'],
    ['asian_handicap_corners','CORNERS','FT','TIDAK'],
    ['1st_half_asian_handicap_corners','CORNERS','1H','TIDAK'],
    ['2nd_half_asian_handicap_corners','CORNERS','2H','TIDAK'],
    ['total_goals','TOTALS','FT','YA'],
    ['1st_half_total_corners','CORNERS','1H','TIDAK'],
    ['total_corners','CORNERS','FT','TIDAK'],
    ['match_result_total_goals','OTHER','FT','TIDAK'],
  ];
  for (const [name, et, ep, ei] of cases) {
    const row = { market_type: name, market_segment: '', market_name: name, selection_type: 'home', line: null };
    const t = sharpDerivedMarketType(row);
    const p = periodFromName(row.market_segment || name, name);
    assert.equal(t, et, `${name} type`);
    assert.equal(p, ep, `${name} period`);
    assert.equal(CORE.has(`${t}:${p}`) ? 'YA' : 'TIDAK', ei, `${name} inti`);
  }
});
