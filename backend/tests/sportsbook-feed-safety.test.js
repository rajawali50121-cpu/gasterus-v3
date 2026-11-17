import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../src/sportsbook-providers.js', import.meta.url), 'utf8');
const revisions = readFileSync(new URL('../src/sportsbook-feed-revisions.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('sportsbook feed cache budget accommodates a complete worker snapshot', () => {
  assert.match(config, /sportsFeedMaxEvents: unboundedInt\('SPORTS_FEED_MAX_EVENTS', 0, 0\)/);
  assert.match(config, /sportsFeedMaxCacheBytes: unboundedInt\('SPORTS_FEED_MAX_CACHE_BYTES', 0, 0\)/);
  assert.match(config, /sportsProviderCacheMaxTotalBytes: unboundedInt\('SPORTS_PROVIDER_CACHE_MAX_TOTAL_BYTES', 0, 0\)/);
  assert.match(config, /sportsbookMemberMaxEvents: unboundedInt\('SPORTSBOOK_MEMBER_MAX_EVENTS', 0, 0\)/);
  assert.match(config, /publicMarketMaxEvents: unboundedInt\('PUBLIC_MARKET_MAX_EVENTS', 0, 0\)/);
  assert.match(config, /sportsbookFinishedEventRetentionSeconds: int\('SPORTSBOOK_FINISHED_EVENT_RETENTION_SECONDS', 21600/);
  assert.match(config, /sharpApiMaxPages: unboundedInt\('SHARP_API_MAX_PAGES', 0, 0\)/);
});

test('Sportmonks feed increases event coverage with a bounded page budget and configurable league priority', () => {
  assert.match(config, /sportmonksPassthrough = bool\('SPORTMONKS_PASSTHROUGH', true\)/);
  assert.match(config, /naturalInt\('SPORTMONKS_DAYS_AHEAD', 365\)/);
  assert.match(config, /unboundedInt\('SPORTMONKS_MAX_PAGES', 0, 0\)/);
  assert.match(config, /unboundedInt\('SPORTMONKS_MAX_TOTAL_EVENTS', 0\)/);
  assert.match(config, /sportmonksPriorityLeagues: text\('SPORTMONKS_PRIORITY_LEAGUES'/);
  assert.match(config, /sportsbookRenderMaxEvents: unboundedInt\('SPORTSBOOK_RENDER_MAX_EVENTS', 0, 0\)/);
  assert.match(config, /sportsbookRenderMaxPages: unboundedInt\('SPORTSBOOK_RENDER_MAX_PAGES', 0, 0\)/);
  assert.match(providers, /SPORTMONKS_PAGE_SIZE = 50/);
  assert.doesNotMatch(providers, /SPORTMONKS_CANDIDATE_MULTIPLIER/);
  assert.doesNotMatch(providers, /maxPages = config\.sportmonksMaxPages/);
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

test('production sportsbook only uses Sportradar and honors its production key and event horizon', () => {
  const script = `
    const { config } = await import('./src/config.js');
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    console.log(JSON.stringify({
      provider: __sportsbookFeed.enabledProviders(),
      enabled: config.sportradarEnabled,
      keyConfigured: config.sportradarApiKey === 'configured-sportradar-key',
      daysAhead: config.sportradarDaysAhead,
      maxEvents: config.sportradarMaxEvents,
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
      FOOTBALLDATA_IO_ENABLED: 'true',
      FOOTBALLDATA_IO_KEY: 'unused-football-data-key',
      SPORTRADAR_DAYS_AHEAD: '7',
      SPORTRADAR_MAX_EVENTS: '50',
      SPORTRADAR_ENABLED: 'true',
      SPORTRADAR_API_KEY: 'configured-sportradar-key'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.split(/\r?\n/).find(line => line.startsWith('{"provider":'));
  assert.ok(output, `expected provider JSON in stdout; stdout=${result.stdout}; stderr=${result.stderr}`);
  const actual = JSON.parse(output);
  assert.deepEqual(actual.provider.map(provider => provider.code), ['sportradar']);
  assert.equal(actual.enabled, true);
  assert.equal(actual.keyConfigured, true);
  assert.equal(actual.daysAhead, 7);
  assert.equal(actual.maxEvents, 50);
  assert.equal(actual.liveAcceptanceDelay, 3000);
});

test('legacy Sportmonks mode keeps the previous 500-event cap', () => {
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
      SPORTMONKS_PASSTHROUGH: 'false',
      SPORTMONKS_MAX_TOTAL_EVENTS: value
    }
  });

  const result = runWithLimit('500');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"maxEvents":0}'));

  const outOfRange = runWithLimit('501');
  assert.equal(outOfRange.status, 0, outOfRange.stderr);
  assert.ok(outOfRange.stdout.split(/\r?\n/).includes('{"maxEvents":0}'));
});

test('Sportmonks day, event, and page limits are environment-configurable within safe bounds', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({
      daysAhead: config.sportmonksDaysAhead,
      maxEvents: config.sportmonksMaxTotalEvents,
      maxPages: config.sportmonksMaxPages
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      SPORTMONKS_DAYS_AHEAD: '7',
      SPORTMONKS_MAX_TOTAL_EVENTS: '250',
      SPORTMONKS_MAX_PAGES: '24',
      SPORTMONKS_PASSTHROUGH: 'true'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"daysAhead":7,"maxEvents":0,"maxPages":0}'));
});

test('legacy Sportmonks mode restores former defaults from passthrough sentinels', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({
      daysAhead: config.sportmonksDaysAhead,
      maxEvents: config.sportmonksMaxTotalEvents,
      maxPages: config.sportmonksMaxPages
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48),
      MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      SPORTMONKS_PASSTHROUGH: 'false',
      SPORTMONKS_DAYS_AHEAD: '365',
      SPORTMONKS_MAX_TOTAL_EVENTS: '0',
      SPORTMONKS_MAX_PAGES: '0'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"daysAhead":30,"maxEvents":0,"maxPages":0}'));
  assert.match(result.stderr, /using legacy value 30/);
});

test('Sportmonks responses, page sizes, and retained caches stay bounded', () => {
  assert.match(providers, /SPORTMONKS_PAGE_SIZE = 50/);
  assert.match(providers, /if \(sportmonksCache\.size > 1\)/);
  // Filter yang menyembunyikan pertandingan aktif tanpa odds harus dibuang;
  // cakupan feed tidak lagi dipotong oleh ketersediaan harga provider.
  assert.doesNotMatch(providers, /has_odds === false/);
  assert.match(providers, /if \(!event\) \{[\s\S]*?continue;/);
  // Tidak ada batas byte pada provider cache atau respons Sportmonks.
  assert.doesNotMatch(providers, /maxBytes = config\.sportsProviderCacheMaxEntryBytes/);
  assert.doesNotMatch(providers, /maxPages = config\.sportmonksMaxPages/);
});

test('member snapshot default page returns the whole active catalog for direct server curls', () => {
  assert.match(revisions, /Math\.min\(500, Math\.max\(1, Number\(limit\) \|\| 500\)\)/);
  assert.match(revisions, /limit: pageSize/);
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
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
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
  assert.equal(output.eventCount, 60);
  assert.deepEqual(output.leagues, ['Premier League', 'Regional League']);
  assert.deepEqual(output.sources, ['sportmonks']);
  assert.equal(output.pages, 2);
  assert.deepEqual(output.pageNumbers, [1, 2]);
  assert.deepEqual(output.pageSizes, ['50']);
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
        { market_id: 1, bookmaker_id: 1, market_description: 'Fulltime Result', label: 'Home', value: '2.0' },
        { market_id: 1, bookmaker_id: 1, market_description: 'Fulltime Result', label: 'Draw', value: '3.2' },
        { market_id: 1, bookmaker_id: 1, market_description: 'Fulltime Result', label: 'Away', value: '3.5' }
      ] : []
    });
    globalThis.fetch = async input => {
      const url = new URL(input);
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
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

test('Sportmonks adapter scans all pages without artificial event or page limits', () => {
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
      if (url.pathname.endsWith('/livescores')) {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
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
      const result = await fetchSportmonks({});
      const workerPages = calls.length;
      calls.length = 0;
      const highCapacity = await fetchSportmonks({ maxEvents: 999999, maxPages: 999999 });
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
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  // Tidak ada batas event atau halaman buatan: semua halaman yang diumumkan API diambil.
  assert.ok(output.workerEvents > 0, 'harus mengembalikan event tanpa batas');
  assert.ok(output.workerPages > 0, 'harus mengambil lebih dari satu halaman');
  assert.equal(output.railwayDefaultEvents, 0, 'sportmonksMaxTotalEvents harus 0 (unlimited)');
});

test('stale Sportsbook feed cache is read-only and cannot be settled', () => {
  assert.match(feed, /sportsbook:aggregated-feed:v17/);
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
      lifecycleGeneration: 'render-ingest-multisource-v2'
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

test('feed Redis cache passes all events through without byte truncation', () => {
  const source = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  const start = source.indexOf('function cacheWithinLimit');
  const end = source.indexOf('\nfunction eventBettingOpen', start);
  assert.ok(start >= 0 && end > start, 'cache limit function must exist');
  const cacheWithinLimit = new Function(
    'boundedEvents',
    'logger',
    'AppError',
    `${source.slice(start, end)}; return cacheWithinLimit;`
  )(
    events => events,
    { warn() {}, error() {} },
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
  // Tidak ada pemotongan byte: semua event lolos.
  assert.equal(cached.events.length, 100, 'semua event harus lolos tanpa batas byte');
  // Feed kosong harus gagal eksplisit.
  assert.throws(
    () => cacheWithinLimit({ events: [] }),
    error => error.code === 'SPORTS_FEED_CACHE_LIMIT',
    'feed tanpa event harus gagal eksplisit'
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
