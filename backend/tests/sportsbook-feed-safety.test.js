import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../src/sportsbook-providers.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('sportsbook feed defaults support the full bounded catalog and stay within cache budgets', () => {
  assert.match(feed, /LIFECYCLE_GENERATION = 'render-ingest-provider-backed-v3'/);
  assert.match(feed, /sportsbook:aggregated-feed'/);
  assert.doesNotMatch(feed, /sportsbook:aggregated-feed:v\d+/);
  assert.match(feed, /sportsbook:aggregated-feed:v\*/);
  assert.match(config, /sportsFeedMaxEvents: int\('SPORTS_FEED_MAX_EVENTS', 500, 20, 500\)/);
  assert.match(config, /sportsFeedMaxCacheBytes: int\('SPORTS_FEED_MAX_CACHE_BYTES', 8_388_608, 262_144, 15_000_000\)/);
  assert.match(config, /sportsProviderCacheMaxTotalBytes: int\('SPORTS_PROVIDER_CACHE_MAX_TOTAL_BYTES', 4_000_000/);
  assert.match(config, /sportsbookMemberMaxEvents: int\('SPORTSBOOK_MEMBER_MAX_EVENTS', 500, 20, 500\)/);
  assert.match(config, /theOddsApiMaxTotalEvents: int\('THE_ODDS_API_MAX_TOTAL_EVENTS', 500, 0, 500\)/);
  assert.match(config, /publicMarketMaxEvents: int\('PUBLIC_MARKET_MAX_EVENTS', 100, 10, 500\)/);
  assert.match(config, /sportsbookFinishedEventRetentionSeconds: int\('SPORTSBOOK_FINISHED_EVENT_RETENTION_SECONDS', 21600/);
  assert.match(config, /theOddsApiEventMaxEventsPerSport: int\('THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT', 25, 0, 50\)/);
  assert.match(config, /theOddsApiEventMaxTotalEvents: int\('THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS', 120, 0, 120\)/);
  assert.match(config, /sharpApiMaxPages: int\('SHARP_API_MAX_PAGES', isProduction \? 5 : 3/);
});

test('Sportmonks feed increases event coverage with a bounded page budget and configurable league priority', () => {
  assert.match(config, /sportmonksDaysAhead: int\('SPORTMONKS_DAYS_AHEAD', 30, 0, 30\)/);
  assert.match(config, /sportmonksMaxTotalEvents: boundedInt\('SPORTMONKS_MAX_TOTAL_EVENTS', 500, 0, 500\)/);
  assert.match(config, /sportmonksPriorityLeagues: text\('SPORTMONKS_PRIORITY_LEAGUES'/);
  assert.match(config, /sportsbookRenderMaxEvents: int\('SPORTSBOOK_RENDER_MAX_EVENTS', 500, 1, 500\)/);
  assert.match(config, /sportsbookRenderMaxPages: int\('SPORTSBOOK_RENDER_MAX_PAGES', 120, 12, 120\)/);
  assert.match(providers, /SPORTMONKS_MAX_PAGES_PER_REFRESH = 120/);
  assert.match(providers, /SPORTMONKS_CANDIDATE_MULTIPLIER = 1\.2/);
  assert.match(providers, /SPORTMONKS_PAGE_SIZE = 20/);
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

test('production sportsbook only uses Sportmonks and honors its production key and event horizon', () => {
  const script = `
    const { config } = await import('./src/config.js');
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    console.log(JSON.stringify({
      provider: __sportsbookFeed.enabledProviders(),
      enabled: config.sportmonksEnabled,
      keyConfigured: config.sportmonksKey === 'configured-sportmonks-key',
      daysAhead: config.sportmonksDaysAhead,
      maxEvents: config.sportmonksMaxTotalEvents,
      liveAcceptanceDelay: config.sportsbookLiveAcceptanceDelayMs
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
      API_SPORTS_ENABLED: 'true',
      API_SPORTS_KEY: 'unused-api-sports-key',
      FOOTBALLDATA_IO_ENABLED: 'true',
      FOOTBALLDATA_IO_KEY: 'unused-football-data-key',
      SPORTMONKS_DAYS_AHEAD: '7',
      SPORTMONKS_MAX_TOTAL_EVENTS: '50',
      SPORTMONKS_ENABLED: 'true',
      SPORTMONKS_API_KEY: 'configured-sportmonks-key'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"provider":[{"name":"Sportmonks","code":"sportmonks","enabled":true}],"enabled":true,"keyConfigured":true,"daysAhead":7,"maxEvents":50,"liveAcceptanceDelay":3000}'));
});

test('Sportmonks event cap accepts 500 and falls back safely above its bound', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({ maxEvents: config.sportmonksMaxTotalEvents }));
  `;
  const runWithLimit = value => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
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
      SPORTMONKS_MAX_TOTAL_EVENTS: value
    }
  });

  const result = runWithLimit('500');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"maxEvents":500}'));

  const outOfRange = runWithLimit('501');
  assert.equal(outOfRange.status, 0, outOfRange.stderr);
  assert.ok(outOfRange.stdout.split(/\r?\n/).includes('{"maxEvents":500}'));
  assert.match(outOfRange.stderr, /SPORTMONKS_MAX_TOTAL_EVENTS is outside the supported range; using 500/);
});

test('Sportmonks responses, page sizes, and retained caches stay bounded', () => {
  assert.match(providers, /maxBytes: config\.sportsFeedMaxCacheBytes/);
  assert.match(providers, /url\.searchParams\.set\('per_page', String\(SPORTMONKS_PAGE_SIZE\)\)/);
  assert.match(providers, /SPORTMONKS_MAX_PAGES_PER_REFRESH = 120/);
  assert.match(providers, /if \(sportmonksCache\.size > 1\)/);
  // Filter yang menyembunyikan pertandingan aktif tanpa odds harus dibuang;
  // cakupan feed tidak lagi dipotong oleh ketersediaan harga provider.
  assert.doesNotMatch(providers, /has_odds === false/);
  assert.match(providers, /if \(!event\) continue;/);
});

test('member snapshot default page returns the whole active catalog for direct server curls', () => {
  assert.match(feed, /DEFAULT_SNAPSHOT_PAGE_SIZE = 500/);
  assert.match(feed, /MAX_SNAPSHOT_PAGE_SIZE = 500/);
});

test('Sportmonks prioritizes configured top leagues while normalizing paginated fixture odds', () => {
  const script = `
    const originalFetch = globalThis.fetch;
    const calls = [];
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const fixture = (id, league) => ({
      id,
      starting_at: start,
      starting_at_timestamp: Math.floor(Date.parse(start) / 1000),
      state: { short_name: 'NS', name: 'Not Started' },
      has_odds: true,
      participants: [
        { name: 'Home ' + id, meta: { location: 'home' } },
        { name: 'Away ' + id, meta: { location: 'away' } }
      ],
      league: { name: league, country: { name: 'England' } },
      odds: [
        { market_id: 1, market_description: 'Fulltime Result', label: 'Home', value: '2.0' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Draw', value: '3.2' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Away', value: '3.5' }
      ]
    });
    globalThis.fetch = async input => {
      const url = new URL(input);
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page')) || 20;
      calls.push({ page, perPage: url.searchParams.get('per_page') });
      const leagues = Array.from({ length: 60 }, (_, index) =>
        index >= 10 && index < 15 ? 'Premier League' : 'Regional League'
      );
      const data = leagues.slice((page - 1) * perPage, page * perPage).map((league, index) =>
        fixture((page - 1) * perPage + index + 1, league)
      );
      return new Response(JSON.stringify({ data, pagination: { has_more: page * perPage < 60 } }), {
        headers: { 'content-type': 'application/json' }
      });
    };
    try {
      const { fetchSportmonks } = await import('./src/sportsbook-providers.js');
      const result = await fetchSportmonks();
      console.log(JSON.stringify({
        eventCount: result.events.length,
        leagues: [...new Set(result.events.map(event => event.league))],
        sources: [...new Set(result.events.flatMap(event => event.markets.map(market => market.source)))],
        pages: calls.length,
        pageNumbers: calls.map(call => call.page),
        pageSizes: [...new Set(calls.map(call => call.perPage))]
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      SPORTMONKS_ENABLED: 'true',
      SPORTMONKS_API_KEY: 'configured-sportmonks-key',
      SPORTMONKS_DAYS_AHEAD: '0',
      SPORTMONKS_MAX_TOTAL_EVENTS: '50',
      SPORTMONKS_PRIORITY_LEAGUES: 'Premier League',
      SPORTMONKS_REQUEST_DELAY_MS: '0'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(output.eventCount, 50);
  assert.deepEqual(output.leagues, ['Premier League', 'Regional League']);
  assert.deepEqual(output.sources, ['sportmonks']);
  assert.equal(output.pages, 3);
  assert.deepEqual(output.pageNumbers, [1, 2, 3]);
  assert.deepEqual(output.pageSizes, ['20']);
});

test('Sportmonks keeps active fixtures without odds instead of hiding them from the feed', () => {
  const script = `
    const originalFetch = globalThis.fetch;
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const fixture = (id, priced) => ({
      id,
      starting_at: start,
      starting_at_timestamp: Math.floor(Date.parse(start) / 1000),
      state: { short_name: 'NS', name: 'Not Started' },
      has_odds: priced,
      participants: [
        { name: 'Home ' + id, meta: { location: 'home' } },
        { name: 'Away ' + id, meta: { location: 'away' } }
      ],
      league: { name: 'Premier League', country: { name: 'England' } },
      odds: priced ? [
        { market_id: 1, market_description: 'Fulltime Result', label: 'Home', value: '2.0' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Draw', value: '3.2' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Away', value: '3.5' }
      ] : []
    });
    globalThis.fetch = async input => {
      const url = new URL(input);
      const page = Number(url.searchParams.get('page')) || 1;
      const perPage = Number(url.searchParams.get('per_page')) || 20;
      const pool = [fixture('p-1', true), fixture('u-1', false), fixture('u-2', false)];
      const data = pool.slice((page - 1) * perPage, page * perPage);
      return new Response(JSON.stringify({ data, pagination: { has_more: false } }), {
        headers: { 'content-type': 'application/json' }
      });
    };
    try {
      const { fetchSportmonks } = await import('./src/sportsbook-providers.js');
      const result = await fetchSportmonks();
      console.log(JSON.stringify({
        eventCount: result.events.length,
        // event.id di-hash oleh normalizer; kenali lewat nama tim.
        homes: result.events.map(event => event.home.name).sort(),
        unpricedCount: result.events.filter(event => !event.markets.length).length,
        pricedCounts: result.events.map(event => event.markets.length).sort((a, b) => a - b)
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      SPORTMONKS_ENABLED: 'true',
      SPORTMONKS_API_KEY: 'configured-sportmonks-key',
      SPORTMONKS_DAYS_AHEAD: '0',
      SPORTMONKS_MAX_TOTAL_EVENTS: '50',
      SPORTMONKS_REQUEST_DELAY_MS: '0'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(output, {
    eventCount: 3,
    homes: ['Home p-1', 'Home u-1', 'Home u-2'],
    unpricedCount: 2,
    pricedCounts: [0, 0, 1]
  });
});

test('Sportmonks adapter remains bounded at 500 events and 120 pages', () => {
  const script = `
    const originalFetch = globalThis.fetch;
    const calls = [];
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const fixture = id => ({
      id,
      starting_at: start,
      starting_at_timestamp: Math.floor(Date.parse(start) / 1000),
      state: { short_name: 'NS', name: 'Not Started' },
      has_odds: true,
      participants: [
        { name: 'Home ' + id, meta: { location: 'home' } },
        { name: 'Away ' + id, meta: { location: 'away' } }
      ],
      league: { name: 'Premier League', country: { name: 'England' } },
      odds: [
        { market_id: 1, market_description: 'Fulltime Result', label: 'Home', value: '2.0' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Draw', value: '3.2' },
        { market_id: 1, market_description: 'Fulltime Result', label: 'Away', value: '3.5' }
      ]
    });
    globalThis.fetch = async input => {
      const url = new URL(input);
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page')) || 20;
      calls.push(page);
      const data = Array.from({ length: perPage }, (_, index) => fixture((page - 1) * perPage + index + 1));
      return new Response(JSON.stringify({ data, pagination: { has_more: page < 120 } }), {
        headers: { 'content-type': 'application/json' }
      });
    };
    try {
      const { config } = await import('./src/config.js');
      const { fetchSportmonks } = await import('./src/sportsbook-providers.js');
      const result = await fetchSportmonks({
        maxEvents: config.sportsbookRenderMaxEvents,
        maxPages: config.sportsbookRenderMaxPages
      });
      const workerPages = calls.length;
      calls.length = 0;
      const highCapacity = await fetchSportmonks({ maxEvents: 500, maxPages: 119 });
      console.log(JSON.stringify({
        workerEvents: result.events.length,
        workerPages,
        highCapacityEvents: highCapacity.events.length,
        highCapacityPages: calls.length,
        railwayDefaultEvents: config.sportmonksMaxTotalEvents
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      SPORTMONKS_ENABLED: 'true',
      SPORTMONKS_API_KEY: 'configured-sportmonks-key',
      SPORTMONKS_DAYS_AHEAD: '0',
      SPORTMONKS_MAX_TOTAL_EVENTS: '500',
      SPORTSBOOK_RENDER_MAX_EVENTS: '500',
      SPORTMONKS_REQUEST_DELAY_MS: '0'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    workerEvents: 500,
    workerPages: 30,
    highCapacityEvents: 500,
    highCapacityPages: 30,
    railwayDefaultEvents: 500
  });
});

test('stale Sportsbook feed cache is read-only and cannot be settled', () => {
  assert.match(feed, /sportsbook:aggregated-feed'/);
  assert.doesNotMatch(feed, /sportsbook:aggregated-feed:v\d+/);
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
      lifecycleGeneration: 'render-ingest-provider-backed-v3'
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
    'AppError',
    `${source.slice(start, end)}; return cacheWithinLimit;`
  )(
    events => events,
    6000,
    { warn() {}, error() {} },
    Buffer,
    0,
    class AppError extends Error {
      constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
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
  assert.throws(
    () => cacheWithinLimit({ events: [{ id: 'oversized', payload: 'x'.repeat(10000) }] }),
    error => error.code === 'SPORTS_FEED_CACHE_LIMIT',
    'a cache cap that cannot hold one event must fail explicitly rather than cache an empty feed'
  );
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
