import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('production sportsbook cannot enable model-generated events or derived markets', () => {
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
      PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: 'true'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"openFootball":false,"derivedMarkets":false}'));
});

test('Sportmonks is hard-disabled and cannot be re-enabled by production environment variables', () => {
  assert.match(config, /sportmonksEnabled:\s*false/);
  assert.doesNotMatch(feed, /fetchSportmonks|code:\s*'sportmonks'/);

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
      SPORTMONKS_ENABLED: 'true',
      SPORTMONKS_API_KEY: 'configured-but-disabled'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"provider":"sportmonks","enabled":false,"events":[]}'));
});

test('The Odds API remains disabled even when production env configures a key and enable flag', () => {
  const script = `
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({ enabled: config.theOddsApiEnabled }));
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
      THE_ODDS_API_ENABLED: 'true',
      THE_ODDS_API_KEY: 'configured-but-disabled'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('{"enabled":false}'));
});

test('stale Sportsbook feed cache is read-only and cannot be settled', () => {
  assert.match(feed, /sportsbook:aggregated-feed:v14/);
  assert.match(feed, /READ_ONLY_STALE_SOURCE/);
  assert.match(feed, /feed\.readOnlySource \|\| feed\.snapshotFallback/);
  assert.match(feed, /SPORTS_SETTLEMENT_SOURCE_STALE/);
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
