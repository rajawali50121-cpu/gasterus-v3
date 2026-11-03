import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/gasterus_test',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64')
});
delete process.env.ODDSPAPI_ENABLED;

const [{ config }, oddspapi, providers, oddspapiStore] = await Promise.all([
  import('../src/config.js'),
  import('../src/sportsbook-oddspapi.js'),
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-oddspapi-store.js')
]);

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const TEST_KEY = 'mock-only-oddspapi-key';

function settings(overrides = {}) {
  return {
    oddsPapiEnabled: true,
    oddsPapiKey: TEST_KEY,
    oddsPapiBaseUrl: 'https://api.oddspapi.io',
    oddsPapiTournamentIds: '17,8,7',
    oddsPapiBookmaker: 'pinnacle',
    oddsPapiRefreshSeconds: 28800,
    oddsPapiCatalogRefreshSeconds: 604800,
    oddsPapiDailyRequestBudget: 8,
    oddsPapiMonthlyRequestBudget: 240,
    sportsbookMaxPrematchPriceAgeSeconds: 900,
    ...overrides
  };
}

function testState() {
  return oddspapi.createOddsPapiState({ store: oddspapiStore.createMemoryOddsPapiStore() });
}

function tournamentRows(ids = ['17', '8', '7']) {
  return ids.map((id, index) => ({
    tournamentId: Number(id),
    tournamentName: `League ${id}`,
    categoryName: `Country ${index + 1}`,
    tournamentSlug: `league-${id}`
  }));
}

function marketRows() {
  return [
    { marketId: 101, marketLength: 3, marketName: 'Full Time Result', sportId: 10, handicap: 0, period: 'fulltime', marketType: '1x2', outcomes: [{ outcomeId: 101, outcomeName: '1' }, { outcomeId: 102, outcomeName: 'X' }, { outcomeId: 103, outcomeName: '2' }] },
    { marketId: 201, marketLength: 3, marketName: 'First Half Result', sportId: 10, handicap: 0, period: 'firsthalf', marketType: '1x2', outcomes: [{ outcomeId: 201, outcomeName: '1' }, { outcomeId: 202, outcomeName: 'X' }, { outcomeId: 203, outcomeName: '2' }] },
    { marketId: 301, marketLength: 2, marketName: 'Over Under Full Time', sportId: 10, handicap: 2.5, period: 'fulltime', marketType: 'totals', outcomes: [{ outcomeId: 301, outcomeName: 'Over' }, { outcomeId: 302, outcomeName: 'Under' }] },
    { marketId: 401, marketLength: 2, marketName: 'Over Under First Half', sportId: 10, handicap: 1.5, period: 'firsthalf', marketType: 'totals', outcomes: [{ outcomeId: 401, outcomeName: 'Over' }, { outcomeId: 402, outcomeName: 'Under' }] },
    { marketId: 501, marketLength: 2, marketName: 'Asian Handicap', sportId: 10, handicap: -0.5, period: 'fulltime', marketType: 'spreads', outcomes: [{ outcomeId: 501, outcomeName: '1' }, { outcomeId: 502, outcomeName: '2' }] },
    { marketId: 601, marketLength: 2, marketName: 'Asian Handicap', sportId: 10, handicap: -1.25, period: 'firsthalf', marketType: 'spreads', outcomes: [{ outcomeId: 601, outcomeName: '1' }, { outcomeId: 602, outcomeName: '2' }] },
    { marketId: 503, marketLength: 2, marketName: 'Point Spread', sportId: 10, handicap: -0.5, period: 'fulltime', marketType: 'spreads', outcomes: [{ outcomeId: 503, outcomeName: '1' }, { outcomeId: 504, outcomeName: '2' }] },
    { marketId: 701, marketLength: 2, marketName: 'Asian Handicap', sportId: 10, period: 'fulltime', marketType: 'spreads', outcomes: [{ outcomeId: 701, outcomeName: '1' }, { outcomeId: 702, outcomeName: '2' }] },
    { marketId: 703, marketLength: 2, marketName: 'Asian Handicap', sportId: 10, handicap: -0.75, period: 'fulltime', marketType: 'spreads', outcomes: [{ outcomeId: 703, outcomeName: '1' }, { outcomeId: 704, outcomeName: 'Home' }] },
    { marketId: 502, marketLength: 2, marketName: 'Both Teams To Score', sportId: 10, handicap: 0, period: 'fulltime', marketType: 'totals', outcomes: [{ outcomeId: 502, outcomeName: 'Yes' }, { outcomeId: 503, outcomeName: 'No' }] }
  ];
}

function fixture({ id = 'fixture-1', tournamentId = 17, startTime = new Date(NOW + 3_600_000).toISOString(), statusId = 0 } = {}) {
  return {
    fixtureId: id,
    participant1Id: 1,
    participant2Id: 2,
    participant1Name: 'Arsenal FC',
    participant2Name: 'Chelsea FC',
    sportId: 10,
    tournamentId,
    statusId,
    statusName: 'Pre-Game',
    hasOdds: true,
    startTime,
    updatedAt: new Date(NOW - 60_000).toISOString()
  };
}

function price(value, updatedAt = new Date(NOW - 60_000).toISOString()) {
  return {
    active: true,
    bookmakerOutcomeId: `outcome-${value}`,
    changedAt: updatedAt,
    price: value
  };
}

function oddsFixture(id = 'fixture-1', overrides = {}) {
  const markets = {
    101: { marketActive: true, bookmakerMarketId: 'match-result-ft', outcomes: { 101: { players: { 0: price(1.9) } }, 102: { players: { 0: price(3.4) } }, 103: { players: { 0: price(4.1) } } } },
    201: { marketActive: true, bookmakerMarketId: 'match-result-1h', outcomes: { 201: { players: { 0: price(2.1) } }, 202: { players: { 0: price(2.8) } }, 203: { players: { 0: price(4.2) } } } },
    301: { marketActive: true, bookmakerMarketId: 'totals-ft-2.5', outcomes: { 301: { players: { 0: price(1.9) } }, 302: { players: { 0: price(1.9) } } } },
    401: { marketActive: true, bookmakerMarketId: 'totals-1h-1.5', outcomes: { 401: { players: { 0: price(2.0) } }, 402: { players: { 0: price(1.8) } } } },
    501: { marketActive: true, bookmakerMarketId: 'asian-handicap-ft-minus-0.5', outcomes: { 501: { players: { 0: price(1.91) } }, 502: { players: { 0: price(1.95) } } } },
    601: { marketActive: true, bookmakerMarketId: 'asian-handicap-1h-minus-1.25', outcomes: { 601: { players: { 0: price(1.91) } }, 602: { players: { 0: price(1.95) } } } },
    503: { marketActive: true, bookmakerMarketId: 'non-asian-spread', outcomes: { 503: { players: { 0: price(1.9) } }, 504: { players: { 0: price(1.9) } } } },
    701: { marketActive: true, bookmakerMarketId: 'asian-handicap-missing-line', outcomes: { 701: { players: { 0: price(1.9) } }, 702: { players: { 0: price(1.9) } } } },
    703: { marketActive: true, bookmakerMarketId: 'asian-handicap-ambiguous-outcomes', outcomes: { 703: { players: { 0: price(1.9) } }, 704: { players: { 0: price(1.9) } } } },
    502: { marketActive: true, bookmakerMarketId: 'btts', outcomes: { 502: { players: { 0: price(1.9) } }, 503: { players: { 0: price(1.9) } } } },
    ...overrides
  };
  return { fixtureId: id, bookmakerOdds: { pinnacle: { bookmakerIsActive: true, suspended: false, markets } } };
}

function mockResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function mockApi({ ids = ['17', '8', '7'], fixtures = [fixture()], odds = [oddsFixture()], markets = marketRows() } = {}) {
  const urls = [];
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    urls.push(url);
    calls.push(options);
    if (url.pathname.endsWith('/tournaments')) return mockResponse(tournamentRows(ids));
    if (url.pathname.endsWith('/markets')) return mockResponse(markets);
    if (url.pathname.endsWith('/fixtures')) return mockResponse(fixtures);
    if (url.pathname.endsWith('/odds-by-tournaments')) {
      const selected = new Set(url.searchParams.get('tournamentIds').split(','));
      return mockResponse(odds.filter(row => selected.has(String(fixtures.find(item => item.fixtureId === row.fixtureId)?.tournamentId))));
    }
    return mockResponse({ error: 'not found' }, 404);
  };
  return { fetchImpl, urls, calls };
}

function fakeRedisServer() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async mGet(keys) {
      return keys.map(key => values.get(key) ?? null);
    },
    async set(key, value, options = {}) {
      if (options.NX && values.has(key)) return null;
      values.set(key, String(value));
      return 'OK';
    },
    async eval(script, { keys, arguments: args }) {
      if (script.includes('local cooldownMs')) {
        const [slotKey, backoffKey] = keys;
        const [nowText, cooldownText] = args;
        const now = Number(nowText);
        const backoff = Number(values.get(backoffKey) || 0);
        if (backoff > now) return [0, backoff - now];
        const slot = Math.max(now, Number(values.get(slotKey) || 0));
        values.set(slotKey, String(slot + Number(cooldownText)));
        return [1, slot - now];
      }
      if (script.includes('local current')) {
        const current = Number(values.get(keys[0]) || 0);
        const target = Number(args[0]);
        if (target > current) values.set(keys[0], String(target));
        return 1;
      }
      if (script.includes("return redis.call('DEL'")) {
        if (values.get(keys[0]) !== args[0]) return 0;
        values.delete(keys[0]);
        return 1;
      }
      throw new Error('Unexpected Redis script');
    }
  };
}

test('feature flag defaults OFF and does not make requests', async () => {
  assert.equal(config.oddsPapiEnabled, false);
  let calls = 0;
  const result = await oddspapi.fetchOddsPapi({
    settings: settings({ oddsPapiEnabled: false }),
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
    state: testState()
  });
  assert.equal(result.enabled, false);
  assert.equal(calls, 0);
});

test('requires a key only when enabled and sends it through the documented apiKey parameter', async () => {
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings({ oddsPapiKey: '' }),
    fetchImpl: async () => mockResponse([]),
    state: testState()
  }), /ODDSPAPI_API_KEY is required/);

  const api = mockApi();
  await oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async () => {},
    state: testState()
  });
  assert.ok(api.urls.every(url => url.searchParams.get('apiKey') === TEST_KEY));
  assert.ok(api.urls.every(url => url.origin === 'https://api.oddspapi.io'));
});

test('sanitizes authentication errors and never includes the key or request URL', async () => {
  const state = testState();
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: async () => mockResponse({ message: 'denied' }, 401),
    now: NOW,
    sleepImpl: async () => {},
    state
  }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(TEST_KEY), false);
    assert.equal(error.message.includes('apiKey'), false);
    return true;
  });
});

test('backs off authentication, account, permission and rate-limit errors', async () => {
  for (const [status, cooldownMs] of [
    [401, 15 * 60_000],
    [402, 60 * 60_000],
    [403, 6 * 60 * 60_000],
    [429, 15 * 60_000]
  ]) {
    const state = testState();
    let calls = 0;
    await assert.rejects(oddspapi.fetchOddsPapi({
      settings: settings(),
      fetchImpl: async () => {
        calls += 1;
        return mockResponse({}, status, status === 429 ? { 'retry-after': '120' } : {});
      },
      now: NOW,
      sleepImpl: async () => {},
      state
    }), new RegExp(`HTTP ${status}`));
    assert.equal(state.retryAt, NOW + cooldownMs);
    await assert.rejects(oddspapi.fetchOddsPapi({
      settings: settings(),
      fetchImpl: async () => { calls += 1; return mockResponse([]); },
      now: NOW,
      sleepImpl: async () => {},
      state
    }), /provider is in backoff/);
    assert.equal(calls, 1);
  }
});

test('retries timeouts at most once and exposes only a sanitized error', async () => {
  const state = testState();
  let calls = 0;
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    now: NOW,
    sleepImpl: async () => {},
    timeoutMs: 5,
    state
  }), /request timed out/);
  assert.equal(calls, 2);
  assert.equal(state.requestsToday, 2);
});

test('retries server errors once and reports HTTP status without leaking request details', async () => {
  let calls = 0;
  const state = testState();
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: async () => { calls += 1; return mockResponse({}, 503); },
    now: NOW,
    sleepImpl: async () => {},
    state
  }), /HTTP 503/);
  assert.equal(calls, 2);
  assert.equal(state.requestsToday, 2);
});

test('does not send a retry when its request would exceed the daily budget', async () => {
  let calls = 0;
  const state = testState();
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings({ oddsPapiDailyRequestBudget: 1 }),
    fetchImpl: async () => { calls += 1; return mockResponse({}, 503); },
    now: NOW,
    sleepImpl: async () => {},
    state
  }), /request budget exhausted/);
  assert.equal(calls, 1);
  assert.equal(state.requestsToday, 1);
});

test('rejects daily or monthly budgets above the approved free-tier limits before a provider call', async () => {
  for (const [name, value] of [
    ['oddsPapiDailyRequestBudget', 9],
    ['oddsPapiMonthlyRequestBudget', 241]
  ]) {
    let calls = 0;
    await assert.rejects(oddspapi.fetchOddsPapi({
      settings: settings({ [name]: value }),
      fetchImpl: async () => {
        calls += 1;
        return mockResponse([]);
      },
      now: NOW,
      sleepImpl: async () => {},
      state: testState()
    }), new RegExp(`${name} must be an integer`));
    assert.equal(calls, 0);
  }
});

test('groups configured tournaments into requests of at most three and observes endpoint cooldowns', async () => {
  const ids = ['11', '12', '13', '14'];
  const fixtures = ids.map((id, index) => fixture({ id: `fixture-${id}`, tournamentId: Number(id), startTime: new Date(NOW + (index + 1) * 3_600_000).toISOString() }));
  const odds = fixtures.map(row => oddsFixture(row.fixtureId));
  const api = mockApi({ ids, fixtures, odds });
  const delays = [];
  const state = testState();
  const result = await oddspapi.fetchOddsPapi({
    settings: settings({ oddsPapiTournamentIds: ids.join(',') }),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async milliseconds => delays.push(milliseconds),
    state
  });
  const oddsCalls = api.urls.filter(url => url.pathname.endsWith('/odds-by-tournaments'));
  assert.deepEqual(oddsCalls.map(url => url.searchParams.get('tournamentIds')), ['11,12,13', '14']);
  assert.ok(oddsCalls.every(url => url.searchParams.get('tournamentIds').split(',').length <= 3));
  assert.equal(result.events.length, 4);
  assert.ok(delays.some(delay => delay >= 2000), 'fixtures endpoint observes its documented 2-second cooldown');
  assert.ok(delays.some(delay => delay >= 1000));
});

test('discovers fixture-backed tournaments to maximize coverage within the eight-request cold-cache budget', async () => {
  const ids = Array.from({ length: 16 }, (_, index) => String(index + 1));
  const fixtures = ids.flatMap(id => Array.from(
    { length: id === '16' ? 4 : 1 },
    (_, index) => fixture({
      id: `fixture-${id}-${index}`,
      tournamentId: Number(id),
      startTime: new Date(NOW + (Number(id) * 60 + index) * 60_000).toISOString()
    })
  ));
  const api = mockApi({ ids, fixtures, odds: fixtures.map(row => oddsFixture(row.fixtureId)) });
  const result = await oddspapi.fetchOddsPapi({
    settings: settings({ oddsPapiTournamentIds: '1' }),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async () => {},
    state: testState()
  });
  const oddsCalls = api.urls.filter(url => url.pathname.endsWith('/odds-by-tournaments'));
  const selectedIds = oddsCalls.flatMap(url => url.searchParams.get('tournamentIds').split(','));
  assert.equal(api.urls.length, 8);
  assert.equal(oddsCalls.length, 5);
  assert.equal(selectedIds.length, 15);
  assert.ok(selectedIds.includes('1'), 'configured tournament is prioritized');
  assert.ok(selectedIds.includes('16'), 'tournament with the most upcoming fixtures is discovered');
  assert.equal(result.events.length, 18);
});

test('rejects a configured tournament list larger than the safe daily free-tier capacity', async () => {
  let calls = 0;
  await assert.rejects(oddspapi.fetchOddsPapi({
    settings: settings({
      oddsPapiTournamentIds: Array.from({ length: 16 }, (_, index) => String(index + 1)).join(',')
    }),
    fetchImpl: async () => {
      calls += 1;
      return mockResponse([]);
    },
    now: NOW,
    sleepImpl: async () => {},
    state: testState()
  }), /tournament ID configuration is invalid/);
  assert.equal(calls, 0);
});

test('normalizes prematch events, 1X2, Asian handicap and FT/1H totals with source identities', () => {
  const api = mockApi();
  const resultPromise = oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async () => {},
    state: testState()
  });
  return resultPromise.then(result => {
    assert.equal(result.events.length, 1);
    const event = result.events[0];
    assert.equal(event.league, 'League 17');
    assert.equal(event.country, 'Country 1');
    assert.equal(event.status, 'SCHEDULED');
    assert.deepEqual(event.markets.map(market => `${market.type}:${market.period}`).sort(), [
      '1X2:1H', '1X2:FT', 'HANDICAP:1H', 'HANDICAP:FT', 'TOTALS:1H', 'TOTALS:FT'
    ]);
    const handicapFt = event.markets.find(market => market.type === 'HANDICAP' && market.period === 'FT');
    const handicap1h = event.markets.find(market => market.type === 'HANDICAP' && market.period === '1H');
    assert.equal(handicapFt.line, -0.5);
    assert.deepEqual(handicapFt.selections.map(selection => [selection.label, selection.line]), [
      ['Home', -0.5], ['Away', 0.5]
    ]);
    assert.equal(handicap1h.line, -1.25);
    assert.deepEqual(handicap1h.selections.map(selection => [selection.label, selection.line]), [
      ['Home', -1.25], ['Away', 1.25]
    ]);
    assert.equal(event.markets.some(market => market.sourceMarketId === 'non-asian-spread'), false);
    assert.equal(event.markets.some(market => market.sourceMarketId === 'asian-handicap-missing-line'), false);
    assert.equal(event.markets.some(market => market.sourceMarketId === 'asian-handicap-ambiguous-outcomes'), false);
    assert.equal(event.markets.find(market => market.type === 'TOTALS' && market.period === 'FT').line, 2.5);
    assert.deepEqual(event.markets.find(market => market.type === 'TOTALS' && market.period === 'FT').selections.map(selection => selection.label), ['Over', 'Under']);
    assert.ok(event.markets.every(market => market.source === 'oddspapi' && market.bookmaker === 'pinnacle'));
    assert.ok(event.markets.every(market => market.selections.every(selection =>
      selection.source === 'oddspapi' && selection.sourceSelectionId && selection.updatedAt
    )));
  });
});

test('maps documented live-shaped Asian Handicap First Half period p1 without relabeling other p1 markets', () => {
  const definition = oddspapi.marketDefinition({
    marketId: 10564,
    marketLength: 2,
    marketName: 'Asian Handicap First Half',
    sportId: 10,
    handicap: -0.75,
    period: 'p1',
    marketType: 'spreads',
    outcomes: [{ outcomeId: 10564, outcomeName: '1' }, { outcomeId: 10565, outcomeName: '2' }]
  });
  assert.equal(definition.type, 'HANDICAP');
  assert.equal(definition.period, '1H');
  assert.equal(definition.line, -0.75);
  assert.deepEqual(definition.outcomes.map(outcome => outcome.side), ['home', 'away']);
  assert.equal(oddspapi.marketDefinition({
    marketId: 10566,
    marketLength: 2,
    marketName: 'Generic Spread',
    sportId: 10,
    handicap: -0.75,
    period: 'p1',
    marketType: 'spreads',
    outcomes: [{ outcomeId: 10566, outcomeName: '1' }, { outcomeId: 10567, outcomeName: '2' }]
  }), null);
});

test('rejects live, stale, incomplete and invalid-price markets without fabricating replacements', () => {
  const rawMarket = marketRows()[0];
  const catalog = new Map([[String(rawMarket.marketId), {
    id: String(rawMarket.marketId),
    type: '1X2',
    period: 'FT',
    line: null,
    name: '1X2',
    outcomes: rawMarket.outcomes.map(outcome => ({
      id: String(outcome.outcomeId),
      side: outcome.outcomeName === '1' ? 'home' : outcome.outcomeName === 'X' ? 'draw' : 'away'
    }))
  }]]);
  const tournamentCatalog = new Map([['17', { tournamentName: 'League 17', categoryName: 'England' }]]);
  const base = fixture();
  const rawOdds = oddsFixture();

  assert.equal(oddspapi.normalizeOddsPapiEvent({ ...base, statusId: 1 }, rawOdds, catalog, tournamentCatalog, { now: NOW }), null);
  const invalid = structuredClone(rawOdds);
  invalid.bookmakerOdds.pinnacle.markets[101].outcomes[101].players[0].price = 0;
  const event = oddspapi.normalizeOddsPapiEvent(base, invalid, catalog, tournamentCatalog, { now: NOW });
  assert.equal(event.markets.length, 1);
  assert.equal(event.markets[0].suspended, true);
  assert.equal(event.markets[0].selections.length, 2);
  assert.ok(event.markets[0].selections.every(selection => selection.suspended));
  assert.ok(event.markets[0].selections.every(selection => selection.odds > 1));

  const stale = structuredClone(rawOdds);
  stale.bookmakerOdds.pinnacle.markets[101].outcomes[101].players[0].changedAt = new Date(NOW - 901_000).toISOString();
  const staleMarket = oddspapi.normalizeOddsPapiEvent(base, stale, catalog, tournamentCatalog, { now: NOW }).markets[0];
  assert.equal(staleMarket.suspended, true);
  assert.ok(staleMarket.selections.every(selection => selection.suspended));

  const incomplete = structuredClone(rawOdds);
  delete incomplete.bookmakerOdds.pinnacle.markets[101].outcomes[103];
  const incompleteMarket = oddspapi.normalizeOddsPapiEvent(base, incomplete, catalog, tournamentCatalog, { now: NOW }).markets[0];
  assert.equal(incompleteMarket.suspended, true);
  assert.equal(incompleteMarket.selections.length, 2);
  assert.ok(incompleteMarket.selections.every(selection => selection.suspended));
});

test('requires a valid per-price timestamp and never publishes stale or future prices', () => {
  const rawMarket = marketRows()[0];
  const catalog = new Map([[String(rawMarket.marketId), {
    id: String(rawMarket.marketId),
    type: '1X2',
    period: 'FT',
    line: null,
    name: '1X2',
    outcomes: rawMarket.outcomes.map(outcome => ({
      id: String(outcome.outcomeId),
      side: outcome.outcomeName === '1' ? 'home' : outcome.outcomeName === 'X' ? 'draw' : 'away'
    }))
  }]]);
  const tournamentCatalog = new Map([['17', { tournamentName: 'League 17', categoryName: 'England' }]]);
  const base = fixture();
  const current = oddspapi.normalizeOddsPapiEvent(base, oddsFixture(), catalog, tournamentCatalog, { now: NOW });
  assert.equal(current.markets.length, 1);
  assert.equal(current.markets[0].suspended, false);

  const missing = structuredClone(oddsFixture());
  for (const outcome of Object.values(missing.bookmakerOdds.pinnacle.markets[101].outcomes)) {
    const outcomePrice = outcome.players[0];
    delete outcomePrice.changedAt;
    delete outcomePrice.bookmakerChangedAt;
  }
  missing.bookmakerOdds.pinnacle.markets[101].updatedAt = new Date(NOW).toISOString();
  assert.equal(oddspapi.normalizeOddsPapiEvent(base, missing, catalog, tournamentCatalog, { now: NOW }).markets.length, 0);

  const future = structuredClone(oddsFixture());
  future.bookmakerOdds.pinnacle.markets[101].outcomes[101].players[0].changedAt = new Date(NOW + 1000).toISOString();
  const futureMarket = oddspapi.normalizeOddsPapiEvent(base, future, catalog, tournamentCatalog, { now: NOW }).markets[0];
  assert.equal(futureMarket.suspended, true);
  assert.equal(futureMarket.selections.length, 2);
  assert.ok(futureMarket.selections.every(selection => selection.odds !== 1.9));

  const stale = structuredClone(oddsFixture());
  for (const outcome of Object.values(stale.bookmakerOdds.pinnacle.markets[101].outcomes)) {
    outcome.players[0].changedAt = new Date(NOW - 901_000).toISOString();
  }
  assert.equal(oddspapi.normalizeOddsPapiEvent(base, stale, catalog, tournamentCatalog, { now: NOW }).markets.length, 0);
});

test('deduplicates duplicate provider fixtures and caches the board until its refresh interval', async () => {
  const api = mockApi({ fixtures: [fixture(), fixture()], odds: [oddsFixture(), oddsFixture()] });
  const state = testState();
  const options = {
    settings: settings(),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async () => {},
    state
  };
  const first = await oddspapi.fetchOddsPapi(options);
  assert.equal(first.events.length, 1);
  const second = await oddspapi.fetchOddsPapi({ ...options, now: NOW + 60_000 });
  assert.equal(second.events.length, 1);
  assert.equal(api.urls.length, 4);
});

test('shares cached board and request counters across a simulated worker restart', async () => {
  const api = mockApi();
  const store = oddspapiStore.createMemoryOddsPapiStore();
  const first = await oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: api.fetchImpl,
    now: NOW,
    sleepImpl: async () => {},
    state: oddspapi.createOddsPapiState({ store })
  });
  assert.equal(first.events.length, 1);
  assert.equal(api.urls.length, 4);

  const second = await oddspapi.fetchOddsPapi({
    settings: settings(),
    fetchImpl: api.fetchImpl,
    now: NOW + 60_000,
    sleepImpl: async () => {},
    state: oddspapi.createOddsPapiState({ store })
  });
  assert.equal(second.events.length, 1);
  assert.equal(api.urls.length, 4);
  assert.deepEqual(await store.getRequestCounts(NOW + 60_000), {
    requestsToday: 4,
    requestsThisMonth: 4
  });
});

test('atomically enforces shared daily and monthly budgets across worker instances', async () => {
  const store = oddspapiStore.createMemoryOddsPapiStore();
  const reservations = await Promise.all(Array.from({ length: 20 }, () => store.reserveRequest({
    now: NOW,
    dailyLimit: 3,
    monthlyLimit: 3,
    cooldownMs: 1000
  })));
  assert.equal(reservations.filter(item => item.status === 'reserved').length, 3);
  assert.equal(reservations.filter(item => item.status === 'exhausted').length, 17);
  assert.deepEqual(await store.getRequestCounts(NOW), {
    requestsToday: 3,
    requestsThisMonth: 3
  });

  await assert.rejects(store.reserveRequest({
    now: NOW + 86_400_000,
    dailyLimit: 3,
    monthlyLimit: 3,
    cooldownMs: 1000
  }).then(result => {
    if (result.status === 'exhausted') throw new Error('request budget exhausted');
    return result;
  }), /request budget exhausted/);
});

test('Redis cache store shares cooldown, backoff and cache across store instances', async () => {
  const redis = fakeRedisServer();
  const createStore = () => oddspapiStore.createRedisOddsPapiCacheStore({
    getRedis: async () => redis,
    prefix: 'test:oddspapi'
  });
  const first = createStore();
  const second = createStore();
  const slots = await Promise.all([
    first.reserveCooldown({ now: NOW, cooldownMs: 1000 }),
    second.reserveCooldown({ now: NOW, cooldownMs: 1000 })
  ]);
  assert.deepEqual(slots.map(item => item.waitMs).sort((a, b) => a - b), [0, 1000]);

  await first.setBackoff(NOW + 60_000, NOW);
  assert.equal(await second.checkBackoff(NOW), true);
  assert.equal((await second.reserveCooldown({ now: NOW, cooldownMs: 1000 })).status, 'backoff');
  await first.setCache('board:17:pinnacle', { value: ['cached-board'], fetchedAt: NOW }, 60_000);
  assert.deepEqual(await second.getCache('board:17:pinnacle'), {
    value: ['cached-board'],
    fetchedAt: NOW
  });
});

test('Redis cache lock prevents concurrent board refreshes across store instances', async () => {
  const redis = fakeRedisServer();
  const createStore = () => oddspapiStore.createRedisOddsPapiCacheStore({
    getRedis: async () => redis,
    prefix: 'test:oddspapi-lock'
  });
  const first = createStore();
  const second = createStore();
  let refreshes = 0;
  const refresh = store => store.withCacheLock('board', async () => {
    refreshes += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    await store.setCache('board', { value: 'ready', fetchedAt: NOW }, 60_000);
    return 'ready';
  });
  const results = await Promise.all([refresh(first), refresh(second)]);
  assert.equal(refreshes, 1);
  assert.ok(results.some(result => result === 'ready'));
  assert.ok(results.some(result => result?.cacheLockHit === true));
});

test('OddsPapi enriches absent markets but cannot replace a valid existing provider price', () => {
  const startTime = new Date(NOW + 3_600_000).toISOString();
  const home = { name: 'Arsenal FC', score: null };
  const away = { name: 'Chelsea FC', score: null };
  const sourceMarket = (source, type, odds) => ({
    id: `${source}-${type}`,
    key: `${type}:FT`,
    type,
    label: type === '1X2' ? '1X2' : 'Over / Under',
    period: 'FT',
    line: type === '1X2' ? null : 2.5,
    suspended: false,
    updatedAt: new Date(NOW - 30_000).toISOString(),
    source,
    sourceMarketId: `${source}-${type}`,
    bookmaker: 'book',
    selections: (type === '1X2' ? [['Home', odds], ['Draw', 3.4], ['Away', 4.1]] : [['Over', odds], ['Under', 1.9]])
      .map(([label, price]) => ({
        key: `${source}-${type}-${label}`,
        label,
        odds: price,
        line: type === '1X2' ? null : 2.5,
        suspended: false,
        source,
        updatedAt: new Date(NOW - 30_000).toISOString()
      }))
  });
  const sourceEvent = (provider, markets) => ({
    id: 'same-event',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime,
    status: 'SCHEDULED',
    live: false,
    home,
    away,
    markets,
    _refs: { [provider]: `${provider}-fixture` },
    _sources: [provider]
  });
  const [merged] = providers.mergeProviderEvents([
    { provider: 'sportmonks', events: [sourceEvent('sportmonks', [sourceMarket('sportmonks', '1X2', 2.1)])] },
    { provider: 'oddspapi', events: [sourceEvent('oddspapi', [sourceMarket('oddspapi', '1X2', 1.8), sourceMarket('oddspapi', 'TOTALS', 1.9)])] }
  ]);
  assert.equal(merged.markets.find(market => market.type === '1X2').source, 'sportmonks');
  assert.equal(merged.markets.find(market => market.type === 'TOTALS').source, 'oddspapi');
});
