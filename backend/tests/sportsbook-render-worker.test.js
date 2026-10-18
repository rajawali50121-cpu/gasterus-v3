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

const [{ buildSportsbookRenderSnapshot }, { teamKey }, { validateSportsbookSnapshot }] = await Promise.all([
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
    fetchOddsApi: async options => {
      oddsApiCalled = true;
      oddsApiOptions = options;
      return oddsApi;
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.equal(oddsApiCalled, true);
  assert.deepEqual(oddsApiOptions, { maxEvents: 500 });
  assert.equal(snapshot.eventCount, 300);
  assert.deepEqual(snapshot.providerResults.map(result => result.provider), ['the-odds-api']);
  assert.equal(snapshot.providerResults[0].events.length, 300);

  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['the-odds-api']);
});

test('Worker snapshot signs and validates as a bounded ingestion payload', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'odds-only' })] }),
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
  assert.deepEqual(result.providerResults, ['the-odds-api']);
  assert.equal(stored.providerResults[0].events[0].id, 'odds-only');
  assert.ok(signed.body.length < 6_291_456);
});

test('Worker signs and delivers a full 500-fixture snapshot within the payload budget', async () => {
  const bulk = Array.from({ length: 500 }, (_, index) => event('the-odds-api', {
    id: `bulk-${index}`,
    league: index % 2 ? 'Premier League' : 'Regional League',
    startTime: new Date(NOW + (index + 1) * 60000).toISOString()
  }));
  let requestedOptions;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchOddsApi: async options => {
      requestedOptions = options;
      return { provider: 'the-odds-api', enabled: true, events: bulk };
    },
    maxEvents: 500,
    teamKey,
    now: NOW
  });

  assert.deepEqual(requestedOptions, { maxEvents: 500 });
  assert.equal(snapshot.eventCount, 500, 'seluruh 500 fixture lolos normalisasi tanpa dedupe keliru');
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['the-odds-api']);

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

  assert.equal(result.eventCount, 500);
  assert.deepEqual(result.providerResults, ['the-odds-api']);
  assert.equal(stored.providerResults[0].events.length, 500);
});

test('Worker fails closed if neither provider returns priced fixtures', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: false, events: [] }),
      teamKey
    }),
    /No enabled sportsbook provider returned normalized, priced fixtures/
  );
});

test('Worker republishes cached snapshots before their ingestion freshness window expires', async () => {
  const workerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8')
  );
  assert.match(workerSource, /Math\.min\(config\.theOddsApiRefreshSeconds,\s*Math\.floor\(config\.sportsbookIngestMaxAgeSeconds\s*\/\s*2\)\)/);
  assert.match(workerSource, /fetchOddsApi:\s*fetchTheOddsApi/);
  // Sportmonks primer + The Odds API cadangan keduanya disambungkan ke worker;
  // hanya adapter api-sports yang memang tidak dipakai.
  assert.match(workerSource, /fetchSportmonks/);
  assert.doesNotMatch(workerSource, /fetchApiSports/);
});

test('Worker combines Sportmonks primary with The Odds API fallback in one snapshot', async () => {
  const order = [];
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async options => {
      order.push('sportmonks');
      assert.deepEqual(options, { maxEvents: 100 });
      return { provider: 'sportmonks', enabled: true, events: [event('sportmonks', { id: 'sm-1', league: 'Premier League' })] };
    },
    fetchOddsApi: async options => {
      order.push('the-odds-api');
      assert.deepEqual(options, { maxEvents: 100 });
      return { provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'odds-1', league: 'Serie A' })] };
    },
    maxEvents: 100,
    teamKey,
    now: NOW
  });

  assert.deepEqual(order, ['sportmonks', 'the-odds-api'], 'provider berjalan sekuensial, Sportmonks lebih dulu');
  assert.equal(snapshot.eventCount, 2);
  assert.deepEqual(snapshot.providerResults.map(result => result.provider), ['sportmonks', 'the-odds-api']);
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportmonks', 'the-odds-api']);
});

test('Worker keeps publishing when Sportmonks fails (The Odds API fallback survives)', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => { throw new Error('Sportmonks down'); },
    fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'fallback-1' })] }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1);
  assert.deepEqual(snapshot.providerResults.map(result => result.provider), ['the-odds-api']);
});

test('Worker still publishes when The Odds API fails (Sportmonks primary survives)', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: [event('sportmonks', { id: 'primary-1' })] }),
    fetchOddsApi: async () => { throw new Error('quota exhausted'); },
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1);
  assert.deepEqual(snapshot.providerResults.map(result => result.provider), ['sportmonks']);
});

test('Worker dedupes overlapping fixtures preferring Sportmonks as primary', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: [event('sportmonks', { id: 'dup', home: 'Alpha', away: 'Beta' })] }),
    fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'dup-odds', home: 'Alpha', away: 'Beta' })] }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1, 'fixture sama dari dua provider tidak boleh ganda');
  const selected = snapshot.providerResults.find(result => result.events.length);
  assert.equal(selected.provider, 'sportmonks', 'Sportmonks menang untuk fixture prematch yang sama');
});

test('Worker fails closed when every provider fetch throws', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => { throw new Error('no key'); },
      fetchOddsApi: async () => { throw new Error('quota'); },
      teamKey
    }),
    /No sportsbook provider could be fetched/
  );
});

test('Worker snapshot freshness starts after provider fetches finish', async () => {
  const startedAt = Date.now();
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchOddsApi: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'fresh-after-fetch' })] };
    },
    teamKey
  });

  assert.ok(Date.parse(snapshot.generatedAt) >= startedAt + 20);
});
