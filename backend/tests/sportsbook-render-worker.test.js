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

const [{ buildSportsbookRenderSnapshot, fitSnapshotToPayloadBudget, sportsbookRenderIntervalSeconds }, { teamKey, mergeProviderEvents }, { validateSportsbookSnapshot }] = await Promise.all([
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
  assert.deepEqual(oddsApiOptions, { maxEvents: 500, maxPages: 120 });
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
    maxPayloadBytes: 6_291_456,
    teamKey,
    now: NOW
  });

  assert.deepEqual(requestedOptions, { maxEvents: 500, maxPages: 120 });
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

test('Worker logs the number of unique fixtures omitted by the 500-event catalog limit', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(JSON.parse(message));
  let snapshot;
  try {
    snapshot = await buildSportsbookRenderSnapshot({
      fetchOddsApi: async () => ({
        provider: 'the-odds-api',
        enabled: true,
        events: Array.from({ length: 501 }, (_, index) => event('the-odds-api', { id: `capped-${index}` }))
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

test('Worker fails closed if neither provider returns priced fixtures', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: false, events: [] }),
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
  assert.match(workerSource, /fetchOddsApi:\s*fetchTheOddsApi/);
  // Sportmonks primer + The Odds API cadangan keduanya disambungkan ke worker;
  // hanya adapter api-sports yang memang tidak dipakai.
  assert.match(workerSource, /fetchSportmonks/);
  assert.doesNotMatch(workerSource, /fetchApiSports/);
});

test('Worker cadence follows the fastest enabled provider without exceeding ingest freshness', () => {
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookIngestMaxAgeSeconds: 180,
    sportmonksEnabled: true,
    sportmonksRefreshSeconds: 300,
    sportmonksOddsRefreshSeconds: 180,
    sharpApiEnabled: true,
    sharpApiRefreshSeconds: 45,
    theOddsApiEnabled: true,
    theOddsApiRefreshSeconds: 720
  }), 45);
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookIngestMaxAgeSeconds: 180,
    sportmonksEnabled: true,
    sportmonksRefreshSeconds: 300,
    sportmonksOddsRefreshSeconds: 180,
    theOddsApiEnabled: true,
    theOddsApiRefreshSeconds: 720
  }), 90);
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookIngestMaxAgeSeconds: 120,
    sharpApiEnabled: false,
    sportmonksEnabled: false,
    theOddsApiEnabled: false
  }), 60);
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookIngestMaxAgeSeconds: 180,
    sportmonksEnabled: true,
    sportmonksRefreshSeconds: 300,
    sportmonksOddsRefreshSeconds: 180,
    sportmonksLiveRefreshSeconds: 30,
    theOddsApiEnabled: false
  }), 30);
});

test('Worker combines Sportmonks primary with The Odds API fallback in one snapshot', async () => {
  const order = [];
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async options => {
      order.push('sportmonks');
      assert.deepEqual(options, { maxEvents: 100, maxPages: 120 });
      return { provider: 'sportmonks', enabled: true, events: [event('sportmonks', { id: 'sm-1', league: 'Premier League' })] };
    },
    fetchOddsApi: async options => {
      order.push('the-odds-api');
      assert.deepEqual(options, { maxEvents: 100, maxPages: 120 });
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

test('Worker bounds the Sportmonks page budget before any provider fetch runs', async () => {
  let fetched = false;
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => { fetched = true; return { provider: 'sportmonks', enabled: true, events: [] }; },
      fetchOddsApi: async () => { fetched = true; return { provider: 'the-odds-api', enabled: true, events: [] }; },
      maxEvents: 100,
      maxPages: 0,
      teamKey,
      now: NOW
    }),
    /maxPages must be an integer between 1 and 120/
  );
  assert.equal(fetched, false, 'budget halaman tidak valid harus ditolak sebelum scrape dimulai');
});

test('Worker keeps active unpriced fixtures in the snapshot as display-only events', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({
      provider: 'sportmonks',
      enabled: true,
      events: [
        event('sportmonks', { id: 'priced-1', league: 'Premier League' }),
        event('sportmonks', { id: 'unpriced-1', league: 'Serie A', markets: [] }),
        event('sportmonks', { id: 'unpriced-2', league: 'La Liga', markets: [] })
      ]
    }),
    fetchOddsApi: async () => { throw new Error('quota exhausted'); },
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 3, 'fixture aktif tanpa odds tidak boleh dibuang dari snapshot');
  assert.deepEqual(
    snapshot.providerResults[0].events.map(item => item.id).sort(),
    ['priced-1', 'unpriced-1', 'unpriced-2']
  );
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['sportmonks']);
});

test('Worker prefers the priced copy when the same fixture arrives from two providers', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({
      provider: 'sportmonks',
      enabled: true,
      events: [event('sportmonks', { id: 'dup-unpriced', home: 'Alpha', away: 'Beta', markets: [] })]
    }),
    fetchOddsApi: async () => ({
      provider: 'the-odds-api',
      enabled: true,
      events: [event('the-odds-api', { id: 'dup-priced', home: 'Alpha', away: 'Beta' })]
    }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1, 'fixture ganda tetap dide-dup');
  assert.equal(snapshot.providerResults.reduce((count, result) => count + result.events.length, 0), 2,
    'salinan provider dipertahankan agar merge market tidak kehilangan data');
  const [survivor] = mergeProviderEvents(snapshot.providerResults);
  assert.deepEqual(new Set(survivor._sources), new Set(['sportmonks', 'the-odds-api']));
  assert.ok(survivor.markets.length > 0, 'market berharga tetap tersedia setelah merge kanonis');
  assert.equal(survivor.markets.length, 1, 'market identik tidak diduplikasi');
  assert.equal(survivor.markets[0].source, 'the-odds-api');
  assert.ok(survivor.markets[0].selections.every(selection => selection.source === survivor.markets[0].source));
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, 1);
});

test('Worker trims oversized snapshots by dropping whole fixtures, never partial markets', async () => {
  const fat = Array.from({ length: 80 }, (_, index) => event('sportmonks', {
    id: `fat-${index}`,
    startTime: new Date(NOW + (index + 1) * 60000).toISOString()
  }));
  for (const item of fat) {
    item.markets = Array.from({ length: 40 }, (_, marketIndex) => ({
      ...item.markets[0],
      id: `market-${item.id}-${marketIndex}`,
      selections: Array.from({ length: 3 }, (_, selectionIndex) => ({
        ...item.markets[0].selections[0],
        key: `selection-${item.id}-${marketIndex}-${selectionIndex}`,
        label: ['Home', 'Draw', 'Away'][selectionIndex],
        odds: 1.5 + selectionIndex,
        padding: 'x'.repeat(200)
      }))
    }));
  }
  const maxPayloadBytes = 300_000;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: fat }),
    fetchOddsApi: async () => { throw new Error('quota exhausted'); },
    maxEvents: 100,
    maxPayloadBytes,
    teamKey,
    now: NOW
  });
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  assert.ok(bytes <= maxPayloadBytes, `payload ${bytes} bytes wajib muat dalam ${maxPayloadBytes}`);
  assert.ok(snapshot.eventCount > 0 && snapshot.eventCount < 80);
  assert.equal(snapshot.providerResults[0].events[0].id, 'fat-0', 'event berperingkat terbaik dipertahankan utuh');
  assert.ok(snapshot.providerResults[0].events.every(item => item.markets.length === 40),
    'every retained event must keep its complete market list');
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, snapshot.eventCount);

  // Anggaran terlalu kecil untuk satu event utuh must fail explicitly.
  await assert.rejects(buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: fat }),
    fetchOddsApi: async () => { throw new Error('quota exhausted'); },
    maxEvents: 100,
    maxPayloadBytes: 12_000,
    teamKey,
    now: NOW
  }), /single complete sportsbook event exceeds the ingest payload budget/i);
});

test('Payload trimming keeps provider ownership for every retained duplicate fixture', async () => {
  const buildFatEvents = provider => Array.from({ length: 80 }, (_, index) => {
    const item = event(provider, {
      id: `${provider}-${index}`,
      home: `Home ${index}`,
      away: `Away ${index}`,
      startTime: new Date(NOW + (index + 1) * 60000).toISOString()
    });
    item.markets = Array.from({ length: 40 }, (_, marketIndex) => ({
      id: `${provider}-${index}-${marketIndex}`,
      type: '1X2',
      period: 'FT',
      source: provider,
      suspended: false,
      selections: ['Home', 'Draw', 'Away'].map((label, selectionIndex) => ({
        key: `${provider}-${index}-${marketIndex}-${selectionIndex}`,
        label,
        odds: 1.8 + selectionIndex / 10,
        suspended: false,
        source: provider,
        updatedAt: null,
        padding: 'x'.repeat(200)
      }))
    }));
    return item;
  });

  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportmonks: async () => ({ provider: 'sportmonks', enabled: true, events: buildFatEvents('sportmonks') }),
    fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: buildFatEvents('the-odds-api') }),
    maxEvents: 100,
    maxPayloadBytes: 100_000,
    teamKey,
    now: NOW
  });
  const sportmonksEvents = snapshot.providerResults.find(result => result.provider === 'sportmonks').events;
  const oddsEvents = snapshot.providerResults.find(result => result.provider === 'the-odds-api').events;

  assert.ok(snapshot.eventCount > 0 && snapshot.eventCount < 80);
  assert.equal(sportmonksEvents.length, snapshot.eventCount);
  assert.equal(oddsEvents.length, snapshot.eventCount);
  assert.ok(sportmonksEvents.every(item => item.markets.length === 40));
  assert.ok(oddsEvents.every(item => item.markets.length === 40));
  assert.ok(sportmonksEvents.every(item => item._sources[0] === 'sportmonks'));
  assert.ok(oddsEvents.every(item => item._sources[0] === 'the-odds-api'));
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, snapshot.eventCount);
});

test('Payload fitting is a no-op when the snapshot already fits the budget', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: true, events: [event('the-odds-api', { id: 'small-1' })] }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(fitSnapshotToPayloadBudget(snapshot, 6_291_456), snapshot);
  assert.equal(fitSnapshotToPayloadBudget(snapshot, null), snapshot);
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
    fetchOddsApi: async () => ({
      provider: 'the-odds-api',
      enabled: true,
      events: [event('the-odds-api', {
        id: 'dup-odds', home: 'Alpha', away: 'Beta',
        markets: [{
          id: 'odds-total', type: 'TOTALS', period: 'FT', source: 'the-odds-api', suspended: false,
          selections: [{ key: 'over', label: 'Over 2.5', odds: 1.9, suspended: false, source: 'the-odds-api', updatedAt: null }]
        }]
      })]
    }),
    maxEvents: 100,
    teamKey,
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1, 'fixture sama dari dua provider tidak boleh ganda');
  const [merged] = mergeProviderEvents(snapshot.providerResults);
  assert.equal(merged._refs.sportmonks, 'provider-dup');
  assert.equal(merged._refs['the-odds-api'], 'provider-dup-odds');
  assert.deepEqual(new Set(merged.markets.map(market => market.source)), new Set(['sportmonks', 'the-odds-api']));
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).eventCount, 1);
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
