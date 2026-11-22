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

const {
  buildSportsbookRenderSnapshot,
  combineSportsbookProviderResults,
  sportsbookRenderIntervalSeconds
} = await import('../src/sportsbook-render-worker-core.js');
const { validateSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
const { __sportradarNormalizer } = await import('../src/sportradar-provider.js');

const NOW = Date.UTC(2026, 10, 19, 0, 0, 0);

function event(id = 'sr-event-1') {
  return {
    id,
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: new Date(NOW + 3600000).toISOString(),
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Arsenal', score: null, logo: null },
    away: { name: 'Chelsea', score: null, logo: null },
    markets: [{
      id: 'sr-market-1',
      key: '1x2',
      type: '1X2',
      label: '1X2',
      period: 'FT',
      line: null,
      source: 'sportradar',
      suspended: false,
      updatedAt: new Date(NOW).toISOString(),
      selections: [{
        key: 'home',
        label: 'Home',
        odds: 1.9,
        updatedAt: new Date(NOW).toISOString(),
        suspended: false,
        source: 'sportradar'
      }]
    }],
    _refs: { sportradar: 'sr:sport_event:123' },
    _sources: ['sportradar']
  };
}

test('backend quarantines one invalid event and preserves valid events in the accepted snapshot', () => {
  const invalid = event('sr-event-invalid');
  invalid.markets[0].selections[0].updatedAt = 'not-a-date';
  const valid = event('sr-event-valid');
  const result = validateSportsbookSnapshot({
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{ provider: 'sportradar', enabled: true, events: [invalid, valid] }]
  }, { now: NOW });
  assert.deepEqual(result.snapshot.providerResults[0].events.map(item => item.id), ['sr-event-valid']);
  assert.equal(result.eventCount, 1);
  assert.equal(result.rejectedEvents.length, 1);
  assert.match(result.rejectedEvents[0].message, /Selection/);
});

test('backend refuses to replace the stored snapshot when every incoming event is invalid', () => {
  const invalid = event('sr-event-invalid');
  invalid.live = true;
  assert.throws(() => validateSportsbookSnapshot({
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{ provider: 'sportradar', enabled: true, events: [invalid] }]
  }, { now: NOW }), /Seluruh event snapshot gagal validasi/);
});

test('Sportradar market period mapping prioritizes explicit HT/FT labels and does not guess FT', () => {
  const periodFromMarket = __sportradarNormalizer.periodFromMarket;
  assert.equal(periodFromMarket('First Half Asian Handicap', { period: 'Match' }), '1H');
  assert.equal(periodFromMarket('Asian Handicap', { period: '1H' }), '1H');
  assert.equal(periodFromMarket('Asian Handicap', { period: 'match' }), 'FT');
  assert.equal(periodFromMarket('Full Time 1X2'), 'FT');
  assert.equal(periodFromMarket('Half Time / Full Time'), 'HT_FT');
});

test('worker snapshot calls only Sportradar and does not impose artificial event/page limits', async () => {
  let options;
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async value => {
      options = value;
      return { provider: 'sportradar', enabled: true, transportOk: true, events: [event()] };
    },
    maxEvents: 0,
    maxPages: 0,
    now: NOW
  });
  assert.deepEqual(options, { maxEvents: 0, maxPages: 0 });
  assert.deepEqual(snapshot.providerResults.map(item => item.provider), ['sportradar']);
  assert.equal(snapshot.eventCount, 1);
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).providers[0], 'sportradar');
});

test('worker rejects any non-Sportradar or multi-provider snapshot', async () => {
  assert.throws(() => combineSportsbookProviderResults([
    { provider: 'sportmonks', enabled: true, events: [] }
  ]), /Sportradar/);
  assert.throws(() => combineSportsbookProviderResults([
    { provider: 'sportradar', enabled: true, events: [] },
    { provider: 'other', enabled: true, events: [] }
  ]), /only sportsbook provider/);
  await assert.rejects(buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportmonks', enabled: true, events: [] }),
    now: NOW
  }), /invalid provider result/);
});

test('worker rejects incomplete Sportradar transport and malformed events', async () => {
  await assert.rejects(buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportradar', enabled: true, transportOk: false, events: [event()] }),
    now: NOW
  }), /incomplete result/);
  const invalid = event();
  invalid._sources = ['sportmonks'];
  await assert.rejects(buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportradar', enabled: true, transportOk: true, events: [invalid] }),
    now: NOW
  }), /every event failed normalization validation/);
});

test('one malformed Sportradar event is quarantined while valid events are published', async () => {
  const invalid = event('sr-event-invalid');
  invalid.status = '';
  const valid = event('sr-event-valid');
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({
      provider: 'sportradar', enabled: true, transportOk: true, events: [invalid, valid]
    }),
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1);
  assert.deepEqual(snapshot.providerResults[0].events.map(item => item.id), ['sr-event-valid']);
  assert.equal(snapshot.diagnostics.eventValidation.rejectedEventCount, 1);
  assert.ok(snapshot.diagnostics.eventValidation.samples[0].issues.includes('status:unsupported'));
  assert.equal(validateSportsbookSnapshot(snapshot, { now: NOW }).providers[0], 'sportradar');
});

test('worker accepts a Sportradar schedule event with an explicit UNKNOWN status', async () => {
  const item = event('sr-event-unknown-status');
  item.status = 'UNKNOWN';
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({
      provider: 'sportradar', enabled: true, transportOk: true, events: [item]
    }),
    now: NOW
  });
  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.providerResults[0].events[0].status, 'UNKNOWN');
});

test('worker publishes a valid empty Sportradar schedule without fabricating fixtures', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => ({ provider: 'sportradar', enabled: true, transportOk: true, events: [] }),
    now: NOW
  });
  assert.equal(snapshot.eventCount, 0);
  assert.deepEqual(snapshot.providerResults[0].events, []);
});

test('worker cadence follows Sportradar freshness or the daily WIB schedule', () => {
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookDailyRefreshEnabled: true,
    sportradarRefreshSeconds: 300,
    sportsbookIngestMaxAgeSeconds: 600
  }), 60);
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookDailyRefreshEnabled: false,
    sportradarEnabled: true,
    sportradarRefreshSeconds: 45,
    sportsbookIngestMaxAgeSeconds: 600
  }), 45);
  assert.equal(sportsbookRenderIntervalSeconds({
    sportsbookDailyRefreshEnabled: false,
    sportradarRefreshSeconds: 300,
    sportsbookIngestMaxAgeSeconds: 60
  }), 30);
});

test('One-shot Cron bypasses the daily refresh gate and fetches immediately', async () => {
  const workerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8')
  );
  assert.match(workerSource, /if \(config\.sportsbookDailyRefreshEnabled !== false && !cronOnce\)/);
  assert.match(workerSource, /if \(cronOnce\) \{[\s\S]*?process\.exitCode[\s\S]*?break;/);
  assert.match(workerSource, /nextSportsbookDailyRefreshMs/);
});


test('production Sportradar requests require a configured rolling quota baseline and shared Redis guards', async () => {
  const providerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportradar-provider.js', import.meta.url), 'utf8')
  );
  assert.match(providerSource, /SPORTRADAR_MAX_CALLS_PER_30_DAYS/);
  assert.match(providerSource, /SPORTRADAR_HOURLY_BUDGET_GUARD/);
  const configSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/config.js', import.meta.url), 'utf8')
  );
  assert.match(configSource, /sportradarMaxCallsPerHour: int\('SPORTRADAR_MAX_CALLS_PER_HOUR', 20, 1, 1000\)/);
  assert.match(providerSource, /SPORTRADAR_INITIAL_30_DAY_USAGE/);
  assert.match(providerSource, /ROLLING_BUDGET_LUA/);
  assert.match(providerSource, /:qps-slot/);
  assert.match(providerSource, /:sports-feed/);
  assert.match(providerSource, /PX: 55 \* 60 \* 1000/);
});

test('worker treats a duplicate hourly Sportradar cycle as a safe skip', async () => {
  const workerSource = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8')
  );
  assert.match(workerSource, /SPORTRADAR_CYCLE_ALREADY_RUNNING/);
  assert.match(workerSource, /snapshot-skipped-duplicate/);
  assert.match(workerSource, /Math\.max\(intervalMs, 60 \* 60 \* 1000\)/);
});
