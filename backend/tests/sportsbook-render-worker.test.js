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

const [{ buildSportsbookRenderSnapshot, sportsbookRenderIntervalSeconds }, { teamKey, mergeProviderEvents }, { validateSportsbookSnapshot }] = await Promise.all([
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
  live = false,
  markets
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
    markets: markets || [{
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

test('Worker requests up to 500 fixtures from Sportradar', async () => {
  const sportradar = {
    provider: 'sportradar',
    enabled: true,
    events: Array.from({ length: 300 }, (_, index) => event('sportradar', {
      id: `sr-${index}`,
      league: index < 200 ? 'Premier League' : 'Regional League',
      startTime: new Date(NOW + (index + 1) * 60000).toISOString()
    }))
  };
  let sportradarCalled = false;
  let sportradarOptions;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async options => {
      sportradarCalled = true;
      sportradarOptions = options;
      return sportradar;
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.equal(sportradarCalled, true);
  assert.deepEqual(sportradarOptions, { maxEvents: 500, maxPages: 0 });
  assert.equal(snapshot.eventCount, 300);
  assert.deepEqual(snapshot.providerResults.map(result => result.provider), ['sportradar']);
  assert.equal(snapshot.providerResults[0].events.length, 300);

  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportradar']);
});

test('Worker snapshot signs and validates as a bounded ingestion payload', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportradar', enabled: true, events: [event('sportradar', { id: 'odds-only' })] }),
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

  assert.equal(result.eventCount, 1);
  assert.deepEqual(result.providerResults, ['sportradar']);
  assert.equal(stored.providerResults[0].events[0].id, 'odds-only');
  assert.ok(signed.body.length < 6_291_456);
});

test('Worker signs and delivers a full 500-fixture snapshot', async () => {
  const bulk = Array.from({ length: 500 }, (_, index) => event('sportradar', {
    id: `bulk-${index}`,
    league: index % 2 ? 'Premier League' : 'Regional League',
    startTime: new Date(NOW + (index + 1) * 60000).toISOString()
  }));
  let requestedOptions;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async options => {
      requestedOptions = options;
      return { provider: 'sportradar', enabled: true, events: bulk };
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.deepEqual(requestedOptions, { maxEvents: 500, maxPages: 0 });
  assert.equal(snapshot.eventCount, 500, 'seluruh 500 fixture lolos normalisasi tanpa dedupe keliru');
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportradar']);

  const signed = createSportsbookIngestRequest(snapshot, SECRET, { timestamp: Math.floor(NOW / 1000) });
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

  assert.equal(result.eventCount, 500);
  assert.deepEqual(result.providerResults, ['sportradar']);
  assert.equal(stored.providerResults[0].events.length, 500);
});

test('Worker logs the number of unique fixtures omitted by the 500-event catalog limit', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(JSON.parse(message));
  let snapshot;
  try {
    snapshot = await buildSportsbookRenderSnapshot({
      fetchSportradar: async () => ({
        provider: 'sportradar',
        enabled: true,
        events: Array.from({ length: 501 }, (_, index) => event('sportradar', { id: `capped-${index}` }))
      }),
      maxEvents: 500,
      teamKey,
      now: NOW
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(snapshot.eventCount, 500);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    service: 'sportsbook-render-worker',
    event: 'snapshot-event-limit-trimmed',
    eventCount: 500,
    omittedUniqueEvents: 1,
    maxEvents: 500
  });
});

test('Worker fails closed if no provider returns fixtures', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchSportradar: async () => ({ provider: 'sportradar', enabled: false, events: [] }),
      teamKey
    }),
    /No enabled sportsbook provider returned normalized fixtures/
  );
});

test('Worker republishes cached snapshots before their ingestion freshness window expires', async () => {
  const workerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8')
  );
  assert.match(workerSource, /sportsbookRenderIntervalSeconds\(config\)/);
  assert.doesNotMatch(workerSource, /fetchTheOddsApi/);
  // Only Sportradar provider adapter is connected to the worker.
  assert.match(workerSource, /fetchSportradar/);
  assert.doesNotMatch(workerSource, /fetchApiSports/);
  assert.doesNotMatch(workerSource, /fetchOddsPapi/);
  assert.doesNotMatch(workerSource, /fetchTheRundown/);
  assert.doesNotMatch(workerSource, /fetchBetexplorer/);
});

test('Worker cadence follows Sportradar refresh without exceeding ingest freshness (legacy mode) and supports daily schedule mode', () => {
  const legacy = { sportsbookDailyRefreshEnabled: false };
  assert.equal(sportsbookRenderIntervalSeconds({
    ...legacy,
    sportsbookIngestMaxAgeSeconds: 180,
    sportradarEnabled: true,
    sportradarRefreshMinutes: 60
  }), 3600);
  assert.equal(sportsbookRenderIntervalSeconds({
    ...legacy,
    sportsbookIngestMaxAgeSeconds: 120,
    sportradarEnabled: true,
    sportradarRefreshMinutes: 30
  }), 1800);
  assert.equal(sportsbookRenderIntervalSeconds({
    ...legacy,
    sportsbookIngestMaxAgeSeconds: 180,
    sportradarEnabled: true,
    sportradarRefreshMinutes: 1
  }), 90);
  // Daily mode polls on bounded interval to hit WIB slot without provider calls when not due.
  assert.equal(sportsbookRenderIntervalSeconds({ sportsbookDailyRefreshEnabled: true }), 60);
});

test('Worker dedupes overlapping fixtures from Sportradar', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportradar', enabled: true, events: [event('sportradar', { id: 'sr-dup', home: 'Alpha', away: 'Beta' })] }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1, 'fixture sama tidak boleh ganda');
  const [merged] = mergeProviderEvents(snapshot.providerResults);
  assert.equal(merged._refs.sportradar, 'provider-sr-dup');
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, 1);
});

test('Worker keeps same-team fixtures in different leagues separate', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({
      provider: 'sportradar',
      enabled: true,
      events: [
        event('sportradar', { id: 'sr-league-1', league: 'Premier League', home: 'Alpha', away: 'Beta' }),
        event('sportradar', { id: 'sr-league-2', league: 'Champions League', home: 'Alpha', away: 'Beta' })
      ]
    }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 2);
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, 2);
});

test('Worker fails closed when provider fetch throws', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchSportradar: async () => { throw new Error('no key'); },
      teamKey
    }),
    /No sportsbook provider could be fetched/
  );
});

test('Worker snapshot freshness starts after provider fetch finishes', async () => {
  const startedAt = Date.now();
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { provider: 'sportradar', enabled: true, events: [event('sportradar', { id: 'sr-fresh-after-fetch' })] };
    },
    teamKey
  });

  assert.ok(Date.parse(snapshot.generatedAt) >= startedAt + 20);
});
