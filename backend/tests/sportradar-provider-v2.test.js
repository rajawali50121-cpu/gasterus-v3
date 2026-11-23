import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SPORTRADAR_ENABLED: 'true',
  SPORTRADAR_API_KEY: 'test-sportradar-key',
  SPORTRADAR_BASE_URL: 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en',
  SPORTRADAR_SPORT_IDS: 'sr:sport:1',
  SPORTRADAR_MIN_INTERVAL_MS: '100',
  SPORTRADAR_MAX_CALLS_PER_HOUR: '60',
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: '50000',
  SPORTRADAR_INITIAL_30_DAY_USAGE: '0',
  SPORTRADAR_REQUEST_TIMEOUT_MS: '5000',
  REDIS_URL: 'redis://127.0.0.1:6379'
});

const { fetchSportradarV2, __sportradarV2 } = await import('../src/sportradar-provider-v2.js');

function fakeRedis({ baseline = '0' } = {}) {
  const values = new Map([
    ['sportsbook:sportradar:v2:quota:baseline', String(baseline)]
  ]);
  const sorted = new Map();
  return {
    isOpen: true,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options = {}) {
      if (options.NX && values.has(key)) return null;
      values.set(key, String(value));
      return 'OK';
    },
    async eval(script, { keys, arguments: args }) {
      if (script.includes("if redis.call('GET'")) {
        if (values.get(keys[0]) === args[0]) { values.delete(keys[0]); return 1; }
        return 0;
      }
      const [baselineKey, rollingKey, hourlyKey, qpsKey] = keys;
      const [monthlyLimit, hourlyLimit, token, interval, initialUsage, nowValue] = args;
      if (!values.has(baselineKey)) values.set(baselineKey, String(initialUsage));
      const now = Number(nowValue);
      const prune = (key, cutoff) => {
        const rows = (sorted.get(key) || []).filter(row => row.score > cutoff);
        sorted.set(key, rows);
        return rows;
      };
      const baseline = Number(values.get(baselineKey) || 0);
      const monthly = prune(rollingKey, now - 2592000 * 1000);
      const hourly = prune(hourlyKey, now - 3600 * 1000);
      if (baseline + monthly.length >= Number(monthlyLimit)) return -1;
      if (Number(hourlyLimit) > 0 && hourly.length >= Number(hourlyLimit)) return -2;
      const qps = values.get(qpsKey);
      if (qps && Number(qps.split('|')[1]) > now) return 0;
      values.set(qpsKey, `${token}|${now + Number(interval)}`);
      monthly.push({ score: now, value: token });
      hourly.push({ score: now, value: token });
      sorted.set(rollingKey, monthly);
      sorted.set(hourlyKey, hourly);
      return 1;
    }
  };
}
function installRedis(options = {}) {
  const client = fakeRedis(options);
  __sportradarV2.setRedisClientForTests(client);
  return client;
}
function json(data, headers = {}) {
  return new Response(JSON.stringify(data), { status: 200, headers });
}
function fixtureEvent(id = 'sr:sport_event:fixture-1', odds = '2.10') {
  return {
    sport_event: {
      id, start_time: '2026-12-01T18:00:00Z', status: 'not_started',
      sport_event_context: { competition: { name: 'League' } },
      competitors: [
        { id: 'sr:competitor:1', name: 'Home FC', qualifier: 'home' },
        { id: 'sr:competitor:2', name: 'Away FC', qualifier: 'away' }
      ]
    },
    markets: [{
      id: 'sr:market:1', name: '1x2', is_live: false,
      books: [{
        id: 'sr:book:25080', name: 'consensus', removed: false,
        outcomes: [
          { id: 'sr:outcome:1', type: 'home', odds_decimal: odds, removed: false },
          { id: 'sr:outcome:2', type: 'draw', odds_decimal: '3.20', removed: false },
          { id: 'sr:outcome:3', type: 'away', odds_decimal: '3.50', removed: false }
        ]
      }]
    }]
  };
}
function installFullSyncFetch({ secondDateEmpty = true } = {}) {
  const calls = [];
  const requestHeaders = [];
  const dates = __sportradarV2.utcDates(1);
  globalThis.fetch = async (input, init = {}) => {
    requestHeaders.push(init.headers || {});
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith('/sports.json')) return json({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] });
    if (url.pathname.endsWith('/books.json')) return json({ books: [{ id: 'sr:book:25080', name: 'consensus' }] }, { 'x-origin-id': 'MARKET_ORIGIN_CORE_CRAWLERS' });
    if (url.pathname.endsWith('/competitions.json')) return json({ competitions: [{ id: 'sr:competition:1', name: 'League', markets: true }] });
    if (url.pathname.includes('/sport_event_markets.json')) {
      assert.equal(url.searchParams.get('limit'), '50');
      assert.equal(url.searchParams.get('live'), 'false');
      const date = url.pathname.split('/schedules/')[1].split('/')[0];
      if (date === dates[1] && secondDateEmpty) return json({ generated_at: '2026-11-22T12:00:00Z', sport_schedule_sport_event_markets: [] }, { 'x-max-results': '0', 'x-result': '0' });
      return json({
        generated_at: '2026-11-22T12:00:00Z',
        sport_schedule_sport_event_markets: [fixtureEvent()]
      }, { 'x-max-results': '1', 'x-result': '1' });
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  };
  calls.requestHeaders = requestHeaders;
  return calls;
}

test('full sync follows documented v2 discovery and daily market paths, preserving book/outcome data and timestamps', async () => {
  installRedis();
  const calls = installFullSyncFetch();
  const requestHeaders = calls.requestHeaders;
  const result = await fetchSportradarV2({ daysAhead: 1 });
  assert.equal(result.provider, 'sportradar');
  assert.equal(result.enabled, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'sr:sport_event:fixture-1');
  assert.equal(result.events[0].home.name, 'Home FC');
  assert.equal(result.events[0].away.name, 'Away FC');
  assert.equal(result.events[0].markets.length, 1);
  assert.equal(result.events[0].markets[0].sourceBookId, 'sr:book:25080');
  assert.equal(result.events[0].markets[0].selections[0].updatedAt, '2026-11-22T12:00:00.000Z');
  assert.equal(result.diagnostics.accessTier, 'MARKET_ORIGIN_CORE_CRAWLERS');
  assert.deepEqual(calls.map(url => url.pathname.split('/').pop()), [
    'sports.json', 'books.json', 'competitions.json', 'sport_event_markets.json', 'sport_event_markets.json'
  ]);
  assert.equal(calls[3].pathname.includes('sr:sport:1'), true);
  assert.equal(__sportradarV2.baseUrl(), 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en');
  assert.ok(requestHeaders.length >= 5);
  assert.ok(requestHeaders.every(headers => headers['x-api-key'] === 'test-sportradar-key'));
  assert.ok(requestHeaders.every(headers => !Object.keys(headers).some(key => key.toLowerCase() === 'authorization')));
});

test('full sync rejects a pagination response that ends before X-Max-Results', async () => {
  installRedis();
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith('/sports.json')) return json({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] });
    if (url.pathname.endsWith('/books.json')) return json({ books: [{ id: 'sr:book:25080', name: 'consensus' }] });
    if (url.pathname.endsWith('/competitions.json')) return json({ competitions: [{ id: 'sr:competition:1', markets: true }] });
    if (url.pathname.includes('/sport_event_markets.json')) {
      const start = Number(url.searchParams.get('start') || 0);
      if (start === 0) {
        return json({
          generated_at: '2026-11-22T12:00:00Z',
          sport_schedule_sport_event_markets: Array.from({ length: 50 }, (_, index) => fixtureEvent(`sr:sport_event:${index}`))
        }, { 'x-max-results': '60', 'x-result': '50' });
      }
      return json({ generated_at: '2026-11-22T12:00:00Z', sport_schedule_sport_event_markets: [] }, { 'x-max-results': '60', 'x-result': '0' });
    }
    throw new Error('Unexpected endpoint');
  };
  await assert.rejects(fetchSportradarV2({ daysAhead: 1 }), /pagination stalled/);
  assert.equal(calls.some(url => url.searchParams.get('start') === '50'), true);
});

test('every ten-minute cycle rebuilds an authoritative schedule snapshot without calling Change Log', async () => {
  const client = installRedis();
  installFullSyncFetch();
  const first = await fetchSportradarV2({ daysAhead: 1 });
  assert.equal(first.diagnostics.syncMode, 'full-snapshot');
  assert.equal(first.diagnostics.pollingIntervalSeconds, 600);
  assert.ok(first.diagnostics.apiRequests >= 2);

  const calls = installFullSyncFetch();
  const second = await fetchSportradarV2({ daysAhead: 1 });
  assert.equal(second.diagnostics.syncMode, 'full-snapshot');
  assert.equal(second.events.length, 1);
  assert.ok(calls.every(url => !url.pathname.includes('changelog')));
  assert.ok(calls.every(url => !url.pathname.includes('/sport_events/')));
  const persisted = JSON.parse(await client.get('sportsbook:sportradar:v2:state'));
  assert.equal(persisted.events.length, 1);
  assert.equal(Object.hasOwn(persisted, 'lastChangeByEvent'), false);
  assert.equal(Object.hasOwn(persisted, 'lastChangeLogTo'), false);
});

test('rolling quota gate rejects calls when the contracted request allowance is exhausted', async () => {
  // The configured limit is 50,000; seed Redis with the exact same count to exercise fail-closed quota rejection.
  installRedis({ baseline: '50000' });
  globalThis.fetch = async () => { throw new Error('Provider must not be called when quota is exhausted'); };
  await assert.rejects(fetchSportradarV2({ daysAhead: 1 }), /rolling 30-day quota/);
});
