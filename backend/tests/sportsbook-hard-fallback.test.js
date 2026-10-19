import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');

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

function runFallbackProbe() {
  const script = `
    const { __sportsbookFeed } = await import('./src/sportsbook-feed.js');
    const now = Date.now();
    const events = __sportsbookFeed.buildHardFallbackEvents(now);
    const feed = __sportsbookFeed.buildHardFallbackFeed({ now });
    const core = new Set(['1X2', 'HANDICAP', 'TOTALS', 'BTTS']);
    const allMarkets = events.flatMap(event => event.markets);
    const invalidOdds = allMarkets.flatMap(market => market.selections)
      .filter(selection => !(Number(selection.odds) >= 1.2 && Number(selection.odds) <= 100));
    const allCore = events.length > 0 && events.every(event =>
      event.markets.length === 4 && event.markets.every(market => core.has(market.type)));
    const suspended = allMarkets.filter(market => market.suspended || market.selections.some(selection => selection.suspended)).length;
    const overrounds = events.map(event => {
      const market = event.markets.find(item => item.type === '1X2');
      return market.selections.reduce((sum, selection) => sum + 1 / selection.odds, 0);
    });
    const withinTtl = __sportsbookFeed.buildHardFallbackFeed({ now: now + 1000 });
    console.log(JSON.stringify({
      events: events.length,
      allSoccer: events.every(event => event.sport === 'Football'),
      live: events.filter(event => event.live).length,
      allCore,
      invalidOdds: invalidOdds.length,
      suspended,
      minOverround: Math.min(...overrounds),
      maxOverround: Math.max(...overrounds),
      payloadBytes: Buffer.byteLength(JSON.stringify(events)),
      hardFallback: feed.hardFallback,
      readOnlySource: feed.readOnlySource,
      snapshotFallback: feed.snapshotFallback,
      pricedMarkets: feed.pricedMarkets,
      bettableMarkets: feed.bettableMarkets,
      providerCode: feed.providers[0].code,
      bettingAllowed: feed.providers[0].bettingAllowed,
      stableRevisionWithinTtl: withinTtl.revision === feed.revision
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: runtimeEnv
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('hard fallback snapshot guarantees an active match board with core markets', () => {
  const output = runFallbackProbe();
  assert.ok(output.events >= 50 && output.events <= 120, `fallback must hold 50-120 matches, got ${output.events}`);
  assert.equal(output.allSoccer, true);
  assert.ok(output.live >= 1, 'fallback board must always contain live matches');
  assert.equal(output.allCore, true, 'every event must carry exactly the 4 core markets');
  assert.equal(output.invalidOdds, 0, 'every selection odds must stay within [1.2, 100]');
  assert.equal(output.suspended, 0, 'fallback markets must render as active');
  assert.ok(output.minOverround >= 1.0 && output.maxOverround <= 1.25, '1X2 overround must stay sane');
  assert.ok(output.payloadBytes < 1024 * 1024, `fallback payload must stay lightweight, got ${output.payloadBytes}`);
  assert.equal(output.hardFallback, true);
  assert.equal(output.readOnlySource, false, 'fallback board must display as live, not read-only');
  assert.equal(output.snapshotFallback, false, 'snapshotFallback would flag the feed as stale in the member UI');
  assert.ok(output.pricedMarkets >= output.events * 4);
  assert.ok(output.bettableMarkets >= output.events * 4);
  assert.equal(output.providerCode, 'hard-fallback');
  assert.equal(output.bettingAllowed, false, 'hard fallback odds must never accept real-money bets');
  assert.equal(output.stableRevisionWithinTtl, true, 'revision stays stable within TTL to avoid SSE broadcast spam');
});

test('sportsbook feed endpoints can never answer with an empty or throwing snapshot', () => {
  assert.match(feed, /SPORTS_HARD_FALLBACK/);
  assert.match(feed, /async function activateHardFallback/);
  assert.match(feed, /events = buildHardFallbackEvents\(Date\.now\(\)\)/);
  assert.match(feed, /hardFallback: hardFallbackActive/);
  assert.match(feed, /return await buildSportsbookSnapshotResponse\(filters, memberView\)/);
  assert.match(feed, /return buildSportsbookSnapshotResponse\(filters, memberView, feed\)/);
  assert.match(feed, /feed\.readOnlySource \|\| feed\.snapshotFallback \|\| feed\.hardFallback/);
  assert.doesNotMatch(feed, /throw new AppError\(503, warnings\[0\]/, 'empty provider results must serve the hard fallback, not a 503');
});
