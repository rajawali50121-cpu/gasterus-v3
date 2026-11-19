import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const feedSource = readFileSync(new URL('../src/sportsbook-feed-source.js', import.meta.url), 'utf8');
const feedUtils = readFileSync(new URL('../src/sportsbook-feed-utils.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

test('backend sportsbook path is worker-only and has no legacy odds adapters', () => {
  for (const token of ['sportmonks', 'sharpapi', 'oddspapi', 'rapidapi_odds', 'therundown', 'api-sports', 'public-market', 'footballdata-io']) {
    assert.equal(feed.toLowerCase().includes(token), false, `backend feed contains retired source ${token}`);
    assert.equal(feedUtils.toLowerCase().includes(token), false, `feed utilities contain retired source ${token}`);
    assert.equal(config.toLowerCase().includes(token), false, `config contains retired source ${token}`);
  }
  assert.match(feedSource, /SPORTS_SNAPSHOT_REQUIRED/);
  assert.doesNotMatch(feed, /fetchSportradar|fetchLocalProviders/);
});

test('stale Sportsbook feed cache is read-only and cannot be settled', () => {
  assert.match(feed, /sportsbook:aggregated-feed:v17/);
  assert.match(feed, /READ_ONLY_STALE_SOURCE/);
  assert.match(feed, /feed\.readOnlySource \|\| feed\.snapshotFallback/);
  assert.match(feed, /SPORTS_SETTLEMENT_SOURCE_STALE/);
});

test('Sportsbook prematch-only pruning excludes live, finished, and expired fixtures', () => {
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
  assert.ok(!ids.includes('top-live'), 'live fixtures are disabled from the member prematch feed');
  assert.ok(ids.includes('today-top'));
  assert.ok(ids.includes('today-other'));
  assert.ok(!ids.includes('old-finished'), 'finished fixtures never appear in the prematch catalog');
  assert.ok(!ids.includes('old-scheduled'), 'expired scheduled fixtures are removed immediately');
});

test('Sportsbook Redis cache respects its configured byte budget while preferring upcoming prematch events', () => {
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
      lifecycleGeneration: 'sportradar-worker-only-v3'
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
