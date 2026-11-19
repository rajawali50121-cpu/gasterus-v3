import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
});

const { resolveSportsbookProviderResults, loadRenderProviderSnapshot } = await import('../src/sportsbook-feed-source.js');
const { createStoredSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
const { createSportsbookIngestRequest } = await import('../src/sportsbook-ingest-client.js');

const SECRET = 'test-sportsbook-ingest-secret'.padEnd(48, 'x');
const NOW = Date.UTC(2026, 10, 19, 0, 0, 0);

function payload(provider = 'sportradar') {
  return {
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{
      provider,
      enabled: true,
      transportOk: true,
      events: [{
        id: 'sr-event-1',
        sport: 'Football',
        league: 'Premier League',
        country: 'England',
        startTime: new Date(NOW + 3600000).toISOString(),
        status: 'SCHEDULED',
        live: false,
        home: { name: 'Arsenal' },
        away: { name: 'Chelsea' },
        markets: [{
          id: 'sr-market-1',
          type: '1X2',
          period: 'FT',
          source: provider,
          suspended: false,
          selections: [{
            key: 'home',
            label: 'Home',
            odds: 1.9,
            source: provider,
            suspended: false
          }]
        }],
        _refs: { [provider]: 'sr:sport_event:123' },
        _sources: [provider]
      }]
    }]
  };
}

function storedSnapshot(value) {
  const signed = createSportsbookIngestRequest(value, SECRET, {
    timestamp: Math.floor(NOW / 1000)
  });
  return createStoredSportsbookSnapshot({
    serializedSnapshot: signed.body.toString('utf8'),
    timestamp: signed.headers['x-sportsbook-timestamp'],
    signature: signed.headers['x-sportsbook-signature'],
    receivedAt: NOW
  });
}

function redisWith(value) {
  return {
    isOpen: true,
    async get() { return value; }
  };
}

const logger = { warn() {}, info() {}, error() {} };

test('backend resolves only a fresh verified Sportradar worker snapshot', async () => {
  const redis = redisWith(storedSnapshot(payload()));
  const resolved = await resolveSportsbookProviderResults(redis, {
    logger,
    now: NOW,
    secret: SECRET,
    maxAgeSeconds: 600
  });
  assert.equal(resolved.source, 'render');
  assert.deepEqual(resolved.renderSnapshot.providerResults.map(item => item.provider), ['sportradar']);
  assert.equal(resolved.settled[0].result.provider, 'sportradar');
});

test('missing or invalid worker staging fails closed and never calls a local fetch callback', async () => {
  let localCalls = 0;
  const options = {
    logger,
    now: NOW,
    secret: SECRET,
    fetchLocalProviders: async () => { localCalls += 1; return []; }
  };
  await assert.rejects(
    resolveSportsbookProviderResults({ isOpen: true, async get() { return null; } }, options),
    error => error.code === 'SPORTS_SNAPSHOT_REQUIRED' && error.status === 503
  );
  await assert.rejects(
    resolveSportsbookProviderResults(redisWith('invalid-json'), options),
    error => error.code === 'SPORTS_SNAPSHOT_REQUIRED' && error.status === 503
  );
  assert.equal(localCalls, 0);
});

test('legacy provider snapshots are rejected before storage and cannot be consumed by backend', async () => {
  const invalid = storedSnapshot(payload('sportmonks'));
  const resolved = await loadRenderProviderSnapshot(redisWith(invalid), {
    logger,
    now: NOW,
    secret: SECRET,
    maxAgeSeconds: 600
  });
  assert.equal(resolved, null);
  await assert.rejects(
    resolveSportsbookProviderResults(redisWith(invalid), {
      logger,
      now: NOW,
      secret: SECRET,
      maxAgeSeconds: 600
    }),
    error => error.code === 'SPORTS_SNAPSHOT_REQUIRED'
  );
});
