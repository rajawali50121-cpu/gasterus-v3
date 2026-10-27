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
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64'),
  SPORTS_FEED_MAX_CACHE_BYTES: '300000'
});

const [{ loadRenderProviderSnapshot, resolveSportsbookProviderResults }, ingestion, { createSportsbookIngestRequest }, providers, feed] = await Promise.all([
  import('../src/sportsbook-feed-source.js'),
  import('../src/sportsbook-ingestion.js'),
  import('../src/sportsbook-ingest-client.js'),
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-feed.js')
]);
const SECRET = 'feed-staging-test-secret-'.padEnd(48, 'x');

function normalizedEvent(provider, { id, kickoff = Date.now() + 3600000, home = 'Arsenal FC', away = 'Chelsea FC' } = {}) {
  const startTime = new Date(kickoff).toISOString();
  return {
    id,
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime,
    status: 'SCHEDULED',
    live: false,
    home: { name: home, score: null, logo: null },
    away: { name: away, score: null, logo: null },
    markets: [{
      id: `market-${provider}`,
      key: 'fulltime-result',
      type: '1X2',
      label: '1X2',
      period: 'FT',
      line: null,
      suspended: false,
      updatedAt: startTime,
      source: provider,
      selections: [{
        key: `selection-${provider}`,
        label: 'Home',
        odds: provider === 'api-sports' ? 1.9 : 2.0,
        suspended: false,
        source: provider,
        updatedAt: startTime
      }]
    }],
    _refs: { [provider]: `provider-${provider}` },
    _sources: [provider]
  };
}

function signedStagingRecord(snapshot, now) {
  const request = createSportsbookIngestRequest(snapshot, SECRET, { timestamp: Math.floor(now / 1000) });
  return ingestion.createStoredSportsbookSnapshot({
    serializedSnapshot: request.body.toString('utf8'),
    timestamp: request.headers['x-sportsbook-timestamp'],
    signature: request.headers['x-sportsbook-signature'],
    receivedAt: now
  });
}

function snapshot(now) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    providerResults: [
      { provider: 'sportmonks', enabled: true, events: [normalizedEvent('sportmonks', { id: 'sm-event', kickoff: now + 3600000 })] },
      { provider: 'api-sports', enabled: true, events: [normalizedEvent('api-sports', { id: 'api-event', kickoff: now + 3660000, home: 'Arsenal', away: 'Chelsea' })] }
    ]
  };
}

test('aggregator loads only a fresh staging snapshot with a valid HMAC and revision', async () => {
  const now = Date.now();
  const stored = signedStagingRecord(snapshot(now), now);
  const result = await loadRenderProviderSnapshot(
    { isOpen: true, async get() { return stored; } },
    { secret: SECRET, now }
  );

  assert.ok(result);
  assert.equal(result.providerResults.length, 2);
  assert.equal(result.generatedAt, new Date(now).toISOString());
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.receivedAt, new Date(now).toISOString());
});

test('aggregator rejects stale or altered staging data so caller can fall back to local providers', async () => {
  const now = Date.now();
  const oldSnapshot = snapshot(now - 181000);
  const staleRecord = signedStagingRecord(oldSnapshot, now - 181000);
  const stale = await loadRenderProviderSnapshot(
    { isOpen: true, async get() { return staleRecord; } },
    { secret: SECRET, now }
  );
  assert.equal(stale, null);

  const tampered = JSON.parse(signedStagingRecord(snapshot(now), now));
  tampered.rawBody = tampered.rawBody.replace('sm-event', 'xx-event');
  const altered = await loadRenderProviderSnapshot(
    { isOpen: true, async get() { return JSON.stringify(tampered); } },
    { secret: SECRET, now }
  );
  assert.equal(altered, null);
});

test('aggregator selects local fetching when staging is absent or invalid', async () => {
  const now = Date.now();
  const staleRecord = signedStagingRecord(snapshot(now - 181000), now - 181000);
  let fallbackCalls = 0;
  const resolved = await resolveSportsbookProviderResults(
    { isOpen: true, async get() { return staleRecord; } },
    {
      secret: SECRET,
      now,
      fetchLocalProviders: async () => {
        fallbackCalls += 1;
        return [{ result: { provider: 'sportmonks', enabled: true, events: [] }, elapsedMs: 12 }];
      }
    }
  );
  assert.equal(resolved.source, 'local');
  assert.equal(resolved.renderSnapshot, null);
  assert.equal(fallbackCalls, 1);
  assert.equal(resolved.settled[0].result.provider, 'sportmonks');
});

test('Railway provider merge deduplicates the same cross-provider fixture before final cache bounds', async () => {
  const now = Date.now();
  const loaded = await loadRenderProviderSnapshot(
    { isOpen: true, async get() { return signedStagingRecord(snapshot(now), now); } },
    { secret: SECRET, now }
  );
  const events = providers.mergeProviderEvents(loaded.providerResults);
  assert.equal(events.length, 1);
  assert.deepEqual(new Set(events[0]._sources), new Set(['sportmonks', 'api-sports']));
  assert.equal(events[0]._refs.sportmonks, 'provider-sportmonks');
  assert.equal(events[0]._refs['api-sports'], 'provider-api-sports');

  const authorityPayload = snapshot(now);
  authorityPayload.providerResults[0].events[0]._settlementReadySources = ['api-sports'];
  authorityPayload.providerResults[0].events[0]._settlementMode = 'UNTRUSTED_WORKER_OVERRIDE';
  authorityPayload.providerResults[0].events[0].markets[0].lifecycleState = 'ACTIVE';
  authorityPayload.providerResults[0].events[0].markets[0].selections[0].priceVersion = 'untrusted-version';
  const sanitized = await loadRenderProviderSnapshot(
    { isOpen: true, async get() { return signedStagingRecord(authorityPayload, now); } },
    { secret: SECRET, now }
  );
  const safeEvent = sanitized.providerResults[0].events[0];
  assert.equal('_settlementReadySources' in safeEvent, false, 'Worker cannot grant settlement authority');
  assert.equal('_settlementMode' in safeEvent, false, 'Worker cannot choose settlement mode');
  assert.equal('lifecycleState' in safeEvent.markets[0], false, 'Railway retains market lifecycle ownership');
  assert.equal('priceVersion' in safeEvent.markets[0].selections[0], false, 'Railway derives feed price versions');

  const feedValue = {
    lifecycleGeneration: 'render-ingest-multisource-v2',
    events: Array.from({ length: 60 }, (_, index) => ({
      ...normalizedEvent('sportmonks', {
        id: `large-event-${index}`,
        kickoff: now + (index + 1) * 3600000,
        home: `Home ${index}`,
        away: `Away ${index}`
      }),
      padding: 'x'.repeat(12000)
    }))
  };
  const bounded = feed.__sportsbookFeed.cacheWithinLimit(feedValue);
  const bytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
  assert.ok(bounded.events.length <= 500);
  assert.ok(bytes <= 300000, `serialized feed cache ${bytes} exceeds configured byte budget`);
  assert.ok(bounded.events.length > 0, 'bounded cache preserves events where the byte cap allows');
});
