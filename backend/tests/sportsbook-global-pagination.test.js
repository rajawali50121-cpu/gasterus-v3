import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const runtimeEnv = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
};

function runFeedProbe() {
  const script = `
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    const now = Date.now();
    const wibDayStart = Math.floor((now + 7 * 60 * 60 * 1000) / 86400000) * 86400000 - 7 * 60 * 60 * 1000;
    const event = (id, sport, league, startTime, live = false) => ({
      id, sport, country: 'England', league,
      startTime: new Date(startTime).toISOString(),
      status: live ? 'LIVE' : 'SCHEDULED', live
    });
    const fixtures = [
      event('live', 'Football', 'Premier League', now - 900000, true),
      event('today', 'Football', 'Championship', wibDayStart + 12 * 60 * 60 * 1000),
      event('early', 'Soccer', 'League One', now + 3 * 86400000),
      event('other-sport', 'Basketball', 'NBA', now + 3600000)
    ];
    const synthetic = Array.from({ length: 300 }, (_, index) => ({
      ...event(String(index), 'Football', 'Regional League', now + index * 60000),
      home: { name: 'Alpha United', score: null },
      away: { name: 'Beta Athletic', score: null },
      markets: Array.from({ length: 20 }, (_, market) => ({
        type: 'TOTALS', label: 'Goals', line: 2.5,
        selections: ['Over', 'Under', 'Over 3.5'].map((label, index) => ({
          key: String(market) + '-' + index, label, odds: 1.8 + index / 10
        }))
      }))
    }));
    const page = __sportsbookFeed.paginateEvents(synthetic, { offset: '30', limit: '1000' });
    const invalidPage = __sportsbookFeed.paginateEvents(synthetic, { offset: '-20', limit: 'invalid' });
    const output = {
      live: __sportsbookFeed.filterEvents(fixtures, { tab: 'live' }).map(item => item.id),
      today: __sportsbookFeed.filterEvents(fixtures, { tab: 'today' }).map(item => item.id),
      early: __sportsbookFeed.filterEvents(fixtures, { tab: 'early' }).map(item => item.id),
      england: __sportsbookFeed.filterEvents(fixtures, { country: 'england', league: 'Premier League' }).map(item => item.id),
      isSoccerOnly: fixtures.filter(__sportsbookFeed.isSoccerEvent).map(item => item.id),
      page: { size: page.events.length, offset: page.pagination.offset, total: page.pagination.total, hasMore: page.pagination.hasMore },
      defaultPage: { size: invalidPage.events.length, offset: invalidPage.pagination.offset },
      payloadBytes: Buffer.byteLength(JSON.stringify(page.events)),
      pageMarketCount: page.events.reduce((count, item) => count + item.markets.length, 0),
      rssBytes: process.memoryUsage().rss
    };
    console.log(JSON.stringify(output));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: runtimeEnv
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('soccer feed filters live, today, upcoming, and country/league selections server-side', () => {
  const output = runFeedProbe();
  assert.deepEqual(output.live, ['live']);
  assert.deepEqual(output.today, ['live', 'today']);
  assert.deepEqual(output.early, ['early']);
  assert.deepEqual(output.england, ['live']);
  assert.deepEqual(output.isSoccerOnly, ['live', 'today', 'early']);
});

test('soccer feed page sizes stay capped and expose deterministic pagination metadata', () => {
  const output = runFeedProbe();
  assert.deepEqual(output.page, { size: 270, offset: 30, total: 300, hasMore: false });
  assert.deepEqual(output.defaultPage, { size: 300, offset: 0 });
  assert.equal(output.pageMarketCount, 5400);
  assert.ok(output.payloadBytes < 2_000_000, `page payload was ${output.payloadBytes} bytes`);
});

test('synthetic 300-fixture page load remains below the Railway 512 MB RSS ceiling', t => {
  const output = runFeedProbe();
  t.diagnostic(`synthetic 300-fixture RSS=${Math.round(output.rssBytes / 1048576)} MB; page JSON=${output.payloadBytes} bytes`);
  assert.ok(output.rssBytes < 512 * 1024 * 1024, `RSS was ${Math.round(output.rssBytes / 1048576)} MB`);
});
