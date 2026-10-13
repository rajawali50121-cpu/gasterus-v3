import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('sportsbook feed defaults stay inside Railway free-tier event and cache budgets', () => {
  assert.match(config, /sportsFeedMaxEvents: int\('SPORTS_FEED_MAX_EVENTS', 400, 20, 500\)/);
  assert.match(config, /sportsFeedMaxCacheBytes: int\('SPORTS_FEED_MAX_CACHE_BYTES', 12_000_000, 262_144, 15_000_000\)/);
  assert.match(config, /sportsProviderCacheMaxTotalBytes: int\('SPORTS_PROVIDER_CACHE_MAX_TOTAL_BYTES', 10_000_000/);
  assert.match(config, /sportsbookMemberMaxEvents: int\('SPORTSBOOK_MEMBER_MAX_EVENTS', 400, 20, 500\)/);
  assert.match(config, /theOddsApiMaxTotalEvents: int\('THE_ODDS_API_MAX_TOTAL_EVENTS', 500, 0, 500\)/);
  assert.match(config, /publicMarketMaxEvents: int\('PUBLIC_MARKET_MAX_EVENTS', 500, 10, 500\)/);
  assert.match(config, /sportsbookFinishedEventRetentionSeconds: int\('SPORTSBOOK_FINISHED_EVENT_RETENTION_SECONDS', 21600/);
  assert.match(config, /theOddsApiEventMaxEventsPerSport: int\('THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT', 25, 0, 50\)/);
  assert.match(config, /theOddsApiEventMaxTotalEvents: int\('THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS', 120, 0, 120\)/);
  assert.match(config, /sharpApiMaxPages: int\('SHARP_API_MAX_PAGES', isProduction \? 5 : 3/);
});

test('The Odds API default catalog contains soccer leagues only', () => {
  const match = config.match(/theOddsApiSportKeys: text\('THE_ODDS_API_SPORT_KEYS', '([^']+)'/);
  assert.ok(match, 'soccer sport-key catalog should be configured');
  assert.ok(match[1].split(',').length >= 30, 'global catalog should cover many soccer competitions');
  assert.ok(match[1].split(',').every(key => key.startsWith('soccer_')));
});

test('sportsbook feed worker and background polling default to enabled in production', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({
      feedWorker: config.feedWorkerEnabled,
      backgroundPoll: config.sportsSourceBackgroundPollEnabled
    }));
  `;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: '******example.com/db',
    REDIS_URL: 'redis://example.com:6379',
    MEMBER_PROXY_SECRET: 'm'.repeat(48),
    ADMIN_PROXY_SECRET: 'a'.repeat(48),
    OPS_INTERNAL_SECRET: 'o'.repeat(48),
    SESSION_HMAC_KEY: 's'.repeat(48),
    API_KEY_PEPPER: 'p'.repeat(48),
    MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
  };
  delete env.FEED_WORKER_ENABLED;
  delete env.SPORTS_SOURCE_BACKGROUND_POLL_ENABLED;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"feedWorker":true,"backgroundPoll":true}'));
});

test('production keeps model-generated events and derived markets disabled by default', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({
      openFootball: config.publicMarketOpenFootballEnabled,
      derivedMarkets: config.publicMarketDerivedMarketsEnabled
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      PUBLIC_MARKET_OPENFOOTBALL_ENABLED: 'true',
      PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: undefined
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"openFootball":false,"derivedMarkets":false}'));
});

test('production generates supported derived markets when explicitly enabled', () => {
  const script = `
    const { config } = await import('./src/config.js');
    const { normalizeFootballDataFixture } = await import('./src/sportsbook-public-market.js');
    const event = normalizeFootballDataFixture({
      Div: 'E0', Date: '23/08/2026', Time: '16:30', HomeTeam: 'Alpha FC', AwayTeam: 'Beta FC',
      B365H: '1.91', B365D: '3.65', B365A: '4.10'
    });
    console.log(JSON.stringify({
      enabled: config.publicMarketDerivedMarketsEnabled,
      marketCount: event?.markets.length || 0,
      derivedTypes: ['BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'CORRECT_SCORE']
        .filter(type => event?.markets.some(market => market.type === type))
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '******example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: 'true'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.enabled, true);
  assert.ok(output.marketCount > 0, `marketCount=${output.marketCount}`);
  assert.deepEqual(output.derivedTypes, ['BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'CORRECT_SCORE']);
});

test('staging and development can explicitly enable derived markets', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({ derivedMarkets: config.publicMarketDerivedMarketsEnabled }));
  `;
  const baseEnv = {
    ...process.env,
    DATABASE_URL: 'postgres://test:test@example.com/db',
    REDIS_URL: 'redis://example.com:6379',
    MEMBER_PROXY_SECRET: 'm'.repeat(48),
    ADMIN_PROXY_SECRET: 'a'.repeat(48),
    OPS_INTERNAL_SECRET: 'o'.repeat(48),
    SESSION_HMAC_KEY: 's'.repeat(48),
    API_KEY_PEPPER: 'p'.repeat(48),
    MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: 'true'
  };

  for (const nodeEnv of ['staging', 'development']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...baseEnv, NODE_ENV: nodeEnv }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.split(/\r?\n/).includes('{"derivedMarkets":true}'), `${nodeEnv} should allow explicit opt-in`);
  }
});

test('Sportmonks requires an explicit enable flag and API key', () => {
  assert.match(config, /sportmonksEnabled:\s*bool\('SPORTMONKS_ENABLED',\s*false\)\s*&&\s*Boolean\(sportmonksKey\)/);
  assert.match(feed, /fetchSportmonks/);

  const script = `
    const { fetchSportmonks } = await import('./src/sportsbook-providers.js');
    const result = await fetchSportmonks();
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      SPORTMONKS_ENABLED: 'false',
      SPORTMONKS_API_KEY: 'configured-but-not-enabled'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"provider":"sportmonks","enabled":false,"events":[]}'));
});

test('stale Sportsbook feed cache is read-only and cannot be settled', () => {
  assert.match(feed, /sportsbook:aggregated-feed:v16/);
  assert.match(feed, /READ_ONLY_STALE_SOURCE/);
  assert.match(feed, /feed\.readOnlySource \|\| feed\.snapshotFallback/);
  assert.match(feed, /SPORTS_SETTLEMENT_SOURCE_STALE/);
});

test('Sportsbook event pruning prioritizes live/top-league fixtures and expires old matches', () => {
  const script = `
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    const now = Date.now();
    const event = (id, fields = {}) => ({
      id, sport: 'Football', country: 'England', league: 'Championship',
      status: 'SCHEDULED', live: false,
      startTime: new Date(now + 3600000).toISOString(),
      markets: [{ type: '1X2' }],
      ...fields
    });
    const events = [
      event('old-scheduled', { startTime: new Date(now - 86400000).toISOString() }),
      event('old-finished', { status: 'FINISHED', startTime: new Date(now - 3 * 3600000).toISOString() }),
      event('top-live', { league: 'Premier League', status: 'LIVE', live: true, startTime: new Date(now - 20 * 60000).toISOString() }),
      event('today-top', { league: 'Premier League', startTime: new Date(now + 2 * 3600000).toISOString() }),
      event('today-other', { league: 'Regional League', startTime: new Date(now + 3 * 3600000).toISOString() })
    ];
    console.log(JSON.stringify(__sportsbookFeed.boundedEvents(events).map(item => item.id)));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '******example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const ids = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(ids.includes('top-live'));
  assert.ok(ids.includes('today-top'));
  assert.ok(ids.includes('today-other'));
  assert.ok(ids.includes('old-finished'), 'recent completed fixtures remain briefly available for settlement');
  assert.ok(!ids.includes('old-scheduled'), 'expired scheduled fixtures are removed immediately');
});

test('Sportsbook Redis cache respects its configured byte budget while preferring live/upcoming events', () => {
  const script = `
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    const now = Date.now();
    const events = Array.from({ length: 24 }, (_, index) => ({
      id: String(index),
      sport: 'Football',
      status: 'SCHEDULED',
      live: false,
      startTime: new Date(now + (index < 12 ? 3600000 * (index + 1) : -86400000 * (index - 11))).toISOString(),
      markets: index < 12
        ? Array.from({ length: 25 }, (_, marketIndex) => ({
            type: ['BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'CORRECT_SCORE'][marketIndex] || 'TOTALS'
          }))
        : [],
      padding: 'x'.repeat(500000)
    }));
    const bounded = __sportsbookFeed.cacheWithinLimit({
      events,
      providers: [],
      fetchedAt: now,
      lifecycleGeneration: 'r6917'
    });
    console.log(JSON.stringify({
      retained: bounded.events.length,
      upcoming: bounded.events.filter(event => Date.parse(event.startTime) > now).length
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '******example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      SPORTS_FEED_MAX_CACHE_BYTES: '7000000',
      PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: 'true'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(output.retained < 24, 'test data must exercise cache truncation');
  assert.equal(output.upcoming, 12, 'all upcoming events should fit ahead of old results');
});

test('Sportsbook member UI disables every READ_ONLY source mode', () => {
  assert.match(ui,/readOnly|degraded|stale/i);
  assert.doesNotMatch(ui, /state\.source\?\.mode === 'READ_ONLY_SNAPSHOT'/);
});


const feedWorker = readFileSync(new URL('../src/feed-worker.js', import.meta.url), 'utf8');

test('Sportsbook feed is refreshed continuously by the isolated feed worker', () => {
  assert.doesNotMatch(worker, /refreshSportsbookFeed/);
  assert.doesNotMatch(worker, /runTotoCollector/);
  assert.match(feedWorker, /refreshSportsbookFeed/);
  const startupRefresh = feedWorker.indexOf('await refreshSportsFeedIfDue(state);');
  const pollLoop = feedWorker.indexOf('while (!stopping)');
  assert.ok(startupRefresh >= 0 && startupRefresh < pollLoop,
    'feed worker must refresh sportsbook before entering the recurring TOTO polling loop');
  assert.match(feedWorker, /sportsSourceBackgroundPollEnabled/);
  assert.match(feedWorker, /sportsFeedRefreshSeconds \* 1000/);
  assert.match(feedWorker, /feed-worker-background-poll/);
  assert.match(feed, /readRedisCache\(\)/);
  assert.match(feed, /Number\(cached\.fetchedAt/);
});

test('failed Sportsbook background refresh immediately suspends cached odds and persists read-only state', () => {
  const feedSource = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  assert.match(feedSource, /async function markCachedFeedReadOnly/);
  assert.match(feedSource, /const readOnlyEvents = suspendedEvents\(memory\.events\)/);
  assert.match(feedSource, /events:\s*readOnlyEvents/);
  assert.match(feedSource, /readOnlySource:\s*true/);
  assert.match(feedSource, /await writeRedisCache\(memory\)/);
});

test('feed Redis cache retains the maximum number of events that fit its byte cap', () => {
  const source = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  const start = source.indexOf('function cacheWithinLimit');
  const end = source.indexOf('\nfunction eventBettingOpen', start);
  assert.ok(start >= 0 && end > start, 'cache limit function must exist');
  const cacheWithinLimit = new Function(
    'boundedEvents',
    'MAX_CACHE_BYTES',
    'logger',
    'Buffer',
    'lastCacheLimitWarningAt',
    `${source.slice(start, end)}; return cacheWithinLimit;`
  )(
    events => events,
    6000,
    { warn() {} },
    Buffer,
    0
  );
  const input = {
    events: Array.from({ length: 100 }, (_, index) => ({ id: index, payload: 'x'.repeat(1000) }))
  };
  const cached = cacheWithinLimit(input);
  const canFit = count => Buffer.byteLength(JSON.stringify({
    ...input,
    events: input.events.slice(0, count)
  }), 'utf8') <= 6000;
  assert.ok(cached.events.length > 1, 'should not discard 90% of events on each reduction');
  assert.ok(canFit(cached.events.length), 'cached payload must stay inside the byte limit');
  assert.equal(canFit(cached.events.length + 1), false, 'no additional event should fit');
});

test('background poll guard skips an overlapping cycle instead of queueing it', () => {
  assert.match(feed, /let backgroundPollInFlight = false;/);
  assert.match(feed, /export async function refreshSportsbookFeedFromPoll/);
  assert.match(feed, /if \(backgroundPollInFlight\)/);
  assert.match(feed, /Sportsbook background poll skipped; previous cycle still running/);
  assert.match(feed, /backgroundPollInFlight = true;/);
  assert.match(feed, /backgroundPollInFlight = false;/);
  // the poll call site must use the guarded entry point, not the raw one
  assert.match(feedWorker, /refreshSportsbookFeedFromPoll\(\{ reason: 'feed-worker-background-poll' \}\)/);
  assert.doesNotMatch(feedWorker, /refreshSportsbookFeed\(\{ reason: 'feed-worker-background-poll' \}\)/);
});

test('Redis refresh-lock outage falls back to the in-process guard instead of running unguarded', () => {
  assert.match(feed, /let refreshInFlight = null;/);
  assert.match(feed, /async function performWithInProcessGuard/);
  assert.match(feed, /if \(!redis\.isOpen\) return performWithInProcessGuard\(reason\);/);
  assert.match(feed, /if \(held === null\) return performWithInProcessGuard\(reason\);/);
  assert.match(feed, /if \(!redis\.isOpen\) return null;/);
  assert.match(feed, /falling back to in-process guard/);
  // must NOT silently allow an unguarded refresh any more
  assert.doesNotMatch(feed, /proceeding without cross-process guard/);
  assert.doesNotMatch(feed, /if \(!redis\.isOpen\) return performRefresh\(\{ reason \}\);/);
});

test('Sportsbook feed distinguishes priced markets from settlement-safe bettable markets', () => {
  assert.match(feed, /function pricedMarketCount/);
  assert.match(feed, /function bettableMarketCount/);
  assert.match(feed, /SPORTS_PRICED_READ_ONLY/);
  assert.match(feed, /READ_ONLY_PRICED_NO_SETTLEMENT_AUTHORITY/);
  assert.match(feed, /primaryPricingProvider/);
});
