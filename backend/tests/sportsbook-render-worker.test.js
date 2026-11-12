import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64')
});

const [{ buildSportsbookRenderSnapshot }, { teamKey, mergeProviderEvents }, { validateSportsbookSnapshot }] = await Promise.all([
  import('../src/sportsbook-render-worker-core.js'),
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-ingestion.js')
]);
const { createSportsbookIngestRequest } = await import('../src/sportsbook-ingest-client.js');
const SECRET = 'render-worker-test-secret-'.padEnd(48, 'x');
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function event(provider, {
  id,
  league = 'Regional League',
  home = `Home ${id}`,
  away = `Away ${id}`,
  startTime = new Date(NOW + 3600000).toISOString(),
  live = false
} = {}) {
  return {
    id,
    sport: 'Football',
    league,
    country: 'England',
    startTime,
    status: live ? 'LIVE' : 'SCHEDULED',
    live,
    home: { name: home, score: null, logo: null },
    away: { name: away, score: null, logo: null },
    markets: [{
      id: `market-${id}`,
      type: '1X2',
      period: 'FT',
      source: provider,
      suspended: false,
      selections: [{
        key: `selection-${id}`,
        label: 'Home',
        odds: 2.1,
        suspended: false,
        source: provider,
        updatedAt: null
      }]
    }],
    _refs: { [provider]: `provider-${id}` },
    _sources: [provider]
  };
}

test('Worker requests up to 500 fixtures from the licensed odds adapter', async () => {
  const sportmonksEvents = Array.from({ length: 300 }, (_, index) => event('sportmonks', {
    id: `sportmonks-${index}`,
    home: `Home odds-${index}`,
    away: `Away odds-${index}`,
    league: index < 200 ? 'Premier League' : 'Regional League',
    startTime: new Date(NOW + (index + 1) * 60000).toISOString()
  }));
  const oddsApi = {
    provider: 'the-odds-api',
    enabled: true,
    events: Array.from({ length: 300 }, (_, index) => event('the-odds-api', {
      id: `odds-${index}`,
      league: index < 200 ? 'Premier League' : 'Regional League',
      startTime: new Date(NOW + (index + 1) * 60000).toISOString()
    }))
  };
  let oddsApiCalled = false;
  let oddsApiOptions;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: sportmonksEvents }),
    fetchTheOddsApi: async options => {
      oddsApiCalled = true;
      oddsApiOptions = options;
      return oddsApi;
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.equal(oddsApiCalled, true);
  assert.equal(oddsApiOptions.maxEvents, 500);
  assert.ok(oddsApiOptions.signal);
  assert.equal(snapshot.eventCount, 300);
  assert.deepEqual(snapshot.providerResults.map(result => [result.provider, result.events.length]), [
    ['sportmonks', 300],
    ['the-odds-api', 300]
  ]);

  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportmonks', 'the-odds-api']);
});

test('Worker snapshot signs and validates as a bounded ingestion payload', async (t) => {
  const sportmonksEvent = event('sportmonks', {
    id: 'sportmonks-odds-only',
    home: 'Shared Home',
    away: 'Shared Away'
  });
  const oddsEvent = event('the-odds-api', {
    id: 'odds-only',
    home: 'Shared Home',
    away: 'Shared Away'
  });
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: [sportmonksEvent] }),
    fetchTheOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: [oddsEvent] }),
    maxEvents: 300,
    teamKey,
    now: NOW
  });
  const signed = createSportsbookIngestRequest(snapshot, SECRET, { timestamp: Math.floor(NOW / 1000) });
  const request = Readable.from([signed.body]);
  request.headers = signed.headers;
  let stored;
  const { acceptSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
  const result = await acceptSportsbookSnapshot(request, {
    secret: SECRET,
    now: NOW,
    storeSnapshot: async value => { stored = value; }
  });

  await t.test('Worker retains SharpAPI prices and missing markets alongside primary Sportmonks events', async () => {
    const sportmonksEvent = event('sportmonks', {
      id: 'sportmonks-1',
      home: 'Home shared',
      away: 'Away shared'
    });
    sportmonksEvent.markets[0].label = 'Sportmonks Full Time Result';
    sportmonksEvent.markets[0].suspended = true;
    sportmonksEvent.markets[0].selections[0].suspended = true;
    const sharpEvent = event('sharpapi', {
      id: 'sharpapi-1',
      home: 'Home shared',
      away: 'Away shared'
    });
    sharpEvent.markets[0].selections[0].odds = 1.75;
    sharpEvent.markets[0].label = 'SharpAPI Match Winner';
    sharpEvent.markets.push({
      id: 'sharp-btts',
      type: 'BTTS',
      period: 'FT',
      label: 'Both Teams To Score',
      line: null,
      source: 'sharpapi',
      suspended: false,
      updatedAt: null,
      selections: [
        { key: 'yes', label: 'Yes', odds: 1.9, suspended: false, source: 'sharpapi', updatedAt: null },
        { key: 'no', label: 'No', odds: 1.9, suspended: false, source: 'sharpapi', updatedAt: null }
      ]
    });

    const snapshot = await buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: [sportmonksEvent] }),
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [sharpEvent] }),
      maxEvents: 500,
      teamKey,
      now: NOW
    });
    assert.equal(snapshot.eventCount, 1, 'provider duplicates count as one fixture');
    assert.deepEqual(snapshot.providerResults.map(result => [result.provider, result.events.length]), [
      ['sportmonks', 1],
      ['sharpapi', 1]
    ]);
    assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportmonks', 'sharpapi']);

    const [merged] = mergeProviderEvents(snapshot.providerResults);
    const resultMarket = merged.markets.find(market => market.type === '1X2');
    assert.equal(resultMarket.source, 'sportmonks');
    assert.equal(resultMarket.selections[0].odds, 2.1, 'SharpAPI cannot replace a Sportmonks price');
    assert.equal(resultMarket.suspended, true, 'SharpAPI cannot reopen a suspended Sportmonks market');
    assert.ok(merged.markets.some(market => market.type === 'BTTS' && market.source === 'sharpapi'));
  });

  await t.test('Worker includes odds-only fixtures as standalone when the result provider fails', async () => {
    const sharpSnapshot = await buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => { throw new Error('Sportmonks timeout'); },
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [event('sharpapi', { id: 'sharp-only' })] }),
      teamKey,
      now: NOW
    });
    assert.equal(sharpSnapshot.eventCount, 1);
    assert.deepEqual(sharpSnapshot.providerResults.map(result => [result.provider, result.events.length]), [
      ['sportmonks', 0],
      ['sharpapi', 1]
    ]);
  });

  await t.test('Worker retains unmatched non-trusted fixtures as standalone and merges matched supplements', async () => {
    const movioOnly = event('moviodds', { id: 'movio-only' });
    const unmatchedSnapshot = await buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => ({
        provider: 'sportmonks',
        enabled: true,
        events: [event('sportmonks', { id: 'sportmonks-sharp', home: 'Home shared', away: 'Away shared' })]
      }),
      fetchMoviOdds: async () => ({ provider: 'moviodds', enabled: true, events: [movioOnly] }),
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [event('sharpapi', { id: 'sharp-only', home: 'Home shared', away: 'Away shared' })] }),
      teamKey,
      now: NOW
    });
    assert.equal(unmatchedSnapshot.eventCount, 2);
    assert.deepEqual(unmatchedSnapshot.providerResults.map(result => [result.provider, result.events.length]), [
      ['sportmonks', 1],
      ['moviodds', 1],
      ['sharpapi', 1]
    ]);
    assert.deepEqual(unmatchedSnapshot.providerResults.find(result => result.provider === 'moviodds').diagnostics.fixtureMatching, {
      matched: 0,
      ambiguous: 0,
      unmatched: 1,
      usedAsSupplement: 1,
      ambiguousUsedAsSupplement: 0,
      ambiguousNotUsed: 0
    });
    const unmatchedDiagnostics = unmatchedSnapshot.providerResults.find(result => result.provider === 'moviodds').diagnostics;
    assert.equal(unmatchedDiagnostics.receivedFixtures, 1);
    assert.equal(unmatchedDiagnostics.snapshotFixtures, 1);
    assert.equal(unmatchedDiagnostics.discardedFixtures.unmatched, 1);

    const matchedMovio = event('moviodds', {
      id: 'movio-matched',
      home: 'Shared Home',
      away: 'Shared Away'
    });
    const matchedSharp = event('sharpapi', {
      id: 'sharp-matched',
      home: 'Shared Home',
      away: 'Shared Away'
    });
    const matchedSnapshot = await buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => ({
        provider: 'sportmonks',
        enabled: true,
        events: [event('sportmonks', { id: 'sportmonks-shared', home: 'Shared Home', away: 'Shared Away' })]
      }),
      fetchMoviOdds: async () => ({ provider: 'moviodds', enabled: true, events: [matchedMovio] }),
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [matchedSharp] }),
      teamKey,
      now: NOW
    });
    assert.equal(matchedSnapshot.eventCount, 1);
    assert.deepEqual(matchedSnapshot.providerResults.map(result => [result.provider, result.events.length]), [
      ['sportmonks', 1],
      ['moviodds', 1],
      ['sharpapi', 1]
    ]);
    assert.deepEqual(matchedSnapshot.providerResults.find(result => result.provider === 'moviodds').diagnostics.fixtureMatching, {
      matched: 1,
      ambiguous: 0,
      unmatched: 0,
      usedAsSupplement: 1,
      ambiguousUsedAsSupplement: 0,
      ambiguousNotUsed: 0
    });

    const ambiguousMovio = event('moviodds', {
      id: 'movio-ambiguous',
      home: 'Shared Home',
      away: 'Shared Away'
    });
    const ambiguousSharp = event('sharpapi', {
      id: 'sharp-ambiguous',
      home: 'Shared Home',
      away: 'Shared Away'
    });
    const ambiguousSnapshot = await buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => ({
        provider: 'sportmonks',
        enabled: true,
        events: [
          event('sportmonks', { id: 'sportmonks-ambiguous-1', home: 'Shared Home', away: 'Shared Away' }),
          event('sportmonks', { id: 'sportmonks-ambiguous-2', home: 'Shared Home', away: 'Shared Away' })
        ]
      }),
      fetchMoviOdds: async () => ({ provider: 'moviodds', enabled: true, events: [ambiguousMovio] }),
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [ambiguousSharp, { ...ambiguousSharp, id: 'sharp-duplicate', _refs: { sharpapi: 'sharp-duplicate' } }] }),
      teamKey,
      now: NOW
    });
    assert.equal(ambiguousSnapshot.eventCount, 4);
    assert.deepEqual(ambiguousSnapshot.providerResults.map(result => [result.provider, result.events.length]), [
      ['sportmonks', 1],
      ['moviodds', 1],
      ['sharpapi', 2]
    ]);
    assert.deepEqual(ambiguousSnapshot.providerResults.find(result => result.provider === 'moviodds').diagnostics.fixtureMatching, {
      matched: 0,
      ambiguous: 1,
      unmatched: 0,
      usedAsSupplement: 1,
      ambiguousUsedAsSupplement: 0,
      ambiguousNotUsed: 1
    });
    assert.deepEqual(ambiguousSnapshot.providerResults.find(result => result.provider === 'sharpapi').diagnostics.fixtureMatching, {
      matched: 0,
      ambiguous: 2,
      unmatched: 0,
      usedAsSupplement: 2,
      ambiguousUsedAsSupplement: 0,
      ambiguousNotUsed: 2
    });
    assert.deepEqual(validateSportsbookSnapshot(ambiguousSnapshot, { now: NOW }).providers, ['sportmonks', 'moviodds', 'sharpapi']);
  });

  assert.equal(result.eventCount, 2);
  assert.deepEqual(result.providerResults, ['sportmonks', 'the-odds-api']);
  assert.equal(stored.providerResults[1].events[0].id, 'odds-only');
  assert.ok(signed.body.length < 6_291_456);
});

test('Worker signs and delivers a full 500-fixture snapshot within the payload budget', async () => {
  const bulk = Array.from({ length: 500 }, (_, index) => event('the-odds-api', {
    id: `bulk-${index}`,
    league: index % 2 ? 'Premier League' : 'Regional League',
    startTime: new Date(NOW + (index + 1) * 60000).toISOString()
  }));
  const resultEvents = bulk.map((oddsEvent, index) => event('sportmonks', {
    id: `result-${index}`,
    home: oddsEvent.home.name,
    away: oddsEvent.away.name,
    league: oddsEvent.league,
    startTime: oddsEvent.startTime
  }));
  let requestedOptions;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: resultEvents }),
    fetchTheOddsApi: async options => {
      requestedOptions = options;
      return { provider: 'the-odds-api', enabled: true, events: bulk };
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.equal(requestedOptions.maxEvents, 500);
  assert.ok(requestedOptions.signal);
  assert.equal(snapshot.eventCount, 500, 'seluruh 500 fixture lolos normalisasi tanpa dedupe keliru');
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportmonks', 'the-odds-api']);

  const signed = createSportsbookIngestRequest(snapshot, SECRET, { timestamp: Math.floor(NOW / 1000) });
  assert.ok(signed.body.length < 6_291_456, `payload ${signed.body.length} bytes wajib di bawah 6MB`);
  assert.equal(signed.headers['x-sportsbook-signature'].length, 64);
  assert.equal(signed.headers['x-sportsbook-timestamp'], String(Math.floor(NOW / 1000)));

  // Ronde penuh: request HMAC dari Render diterima & divalidasi backend Railway.
  const request = Readable.from([signed.body]);
  request.headers = signed.headers;
  const { acceptSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
  let stored;
  const result = await acceptSportsbookSnapshot(request, {
    secret: SECRET,
    now: NOW,
    storeSnapshot: async value => { stored = value; }
  });

  assert.equal(result.eventCount, 1000);
  assert.deepEqual(result.providerResults, ['sportmonks', 'the-odds-api']);
  assert.equal(stored.providerResults[0].events.length, 500);
});

test('Worker fails closed if neither provider returns priced fixtures', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchTheOddsApi: async () => ({ provider: 'the-odds-api', enabled: false, events: [] }),
      teamKey
    }),
    /No enabled sportsbook provider returned normalized, priced fixtures/
  );
});

test('Worker refreshes both primary and complementary providers before ingestion snapshots expire', async () => {
  const workerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8')
  );
  assert.match(workerSource, /config\.sportmonksRefreshSeconds/);
  assert.match(workerSource, /config\.sharpApiRefreshSeconds/);
  assert.match(workerSource, /fetchSportmonks,\s*fetchSharpApi/);
  assert.match(workerSource, /fetchTheOddsApi|fetchApiSports/);
});

test('Worker snapshot freshness starts after provider fetches finish', async () => {
  const startedAt = Date.now();
  const resultEvent = event('sportmonks', {
    id: 'result-fresh-after-fetch',
    home: 'Shared Home',
    away: 'Shared Away'
  });
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: [resultEvent] }),
    fetchTheOddsApi: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', {
        id: 'fresh-after-fetch',
        home: 'Shared Home',
        away: 'Shared Away'
      })] };
    },
    teamKey
  });

  assert.ok(Date.parse(snapshot.generatedAt) >= startedAt + 20);
});
