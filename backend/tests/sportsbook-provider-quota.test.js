import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  API_SPORTS_ENABLED: 'true',
  API_SPORTS_KEY: 'test-provider-key',
  API_SPORTS_DAYS_AHEAD: '0',
  API_SPORTS_ODDS_PAGES: '2',
  API_SPORTS_LIVE_REFRESH_SECONDS: '30',
  API_SPORTS_PREMATCH_REFRESH_SECONDS: '300',
  // Free tier API-Football (diverifikasi via /status: limit_day=100). Dipakai
  // eksplisit supaya hasil test deterministik walau backend/.env ikut termuat.
  API_SPORTS_DAILY_QUOTA: '100',
  THE_ODDS_API_ENABLED: 'true',
  THE_ODDS_API_KEY: 'test-odds-provider-key'
});

const originalFetch = globalThis.fetch;
const calls = [];
let failPrematchFixtures = false;
let failOddsApiRequests = false;
// Payload mock menyerupai bentuk asli API-Football: satu laga LIVE dengan odds
// 1X2, sehingga jalur normalisasi + stempel harga live ikut teruji.
const liveFixture = {
  fixture: { id: 999001, date: '2026-10-06T12:00:00Z', status: { short: '1H', long: 'First Half', elapsed: 23 }, venue: { name: 'Test Arena' } },
  league: { id: 1, name: 'Test League', country: 'England', logo: null },
  teams: { home: { id: 1, name: 'Alpha FC', logo: null }, away: { id: 2, name: 'Beta FC', logo: null } },
  goals: { home: 1, away: 0 },
  score: { halftime: { home: 1, away: 0 }, fulltime: { home: null, away: null } }
};
const liveOddsPayload = {
  response: [{
    fixture: { id: 999001 },
    bookmakers: [{ id: 1, name: 'Test Book', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.5 }, { value: 'Draw', odd: 4.2 }, { value: 'Beta FC', odd: 6.5 }
    ] }] }]
  }]
};
const prematchFixture = {
  fixture: { id: 999002, date: '2026-10-07T18:00:00Z', status: { short: 'NS', long: 'Not Started' }, venue: { name: 'Prematch Arena' } },
  league: { id: 2, name: 'Prematch League', country: 'England' },
  teams: { home: { id: 3, name: 'Gamma FC' }, away: { id: 4, name: 'Delta FC' } }
};
const prematchUpdate = '2026-10-07T00:15:10Z';
const prematchOddsPayload = {
  response: [{
    fixture: { id: 999002 },
    update: prematchUpdate,
    bookmakers: [{ id: 2, name: 'Prematch Book', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Gamma FC', odd: 1.8 }, { value: 'Draw', odd: 3.2 }, { value: 'Delta FC', odd: 4.1 }
    ] }] }]
  }]
};
globalThis.fetch = async url => {
  const target = String(url);
  calls.push(target);
  if (failOddsApiRequests && target.includes('api.the-odds-api.com')) {
    return { ok: false, status: 429, async text() { return '{"message":"quota exhausted"}'; } };
  }
  let body = { response: [] };
  if (target.includes('/fixtures?live=all')) body = { response: [liveFixture] };
  else if (target.includes('/odds/live')) body = liveOddsPayload;
  else if (target.includes('/fixtures?date=')) {
    body = failPrematchFixtures
      ? { response: [], errors: { from: 'The From field need another parameter' } }
      : { response: [prematchFixture] };
  } else if (target.includes('/odds?date=')) body = prematchOddsPayload;
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); }
  };
};

const { fetchApiSports, fetchTheOddsApi, __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { config } = await import('../src/config.js');

test('The Odds API free-tier defaults stay within a conservative monthly request budget', () => {
  assert.equal(config.theOddsApiRegions, 'uk');
  assert.equal(config.theOddsApiMarkets, 'h2h');
  assert.equal(config.theOddsApiRefreshSeconds, 43200);
  assert.equal(config.theOddsApiSportKeys.split(',').length, 6);
  assert.ok(config.theOddsApiSportKeys.split(',').every(key => key.startsWith('soccer_')));
  assert.equal(config.theOddsApiEventMarketsEnabled, false, 'per-event detail endpoint remains disabled to avoid extra credits');
});

test('The Odds API stays disabled even when its environment flag and key are configured', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  const result = await fetchTheOddsApi();
  assert.equal(config.theOddsApiEnabled, false);
  assert.deepEqual(result, { provider: 'the-odds-api', enabled: false, events: [] });
  assert.equal(calls.filter(url => url.includes('api.the-odds-api.com')).length, 0);
});

test('API-Sports endpoint cache prevents the 8-second aggregator loop from consuming provider quota every cycle', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  __sportsbookProviders.apiSportsFailureCache.clear();
  calls.length = 0;
  await fetchApiSports();
  const first = calls.length;
  assert.equal(first, 5, 'first refresh should call live fixtures, date-query fixtures, live odds and two pre-match odds pages');
  await fetchApiSports();
  assert.equal(calls.length, first, 'immediate second refresh must reuse endpoint cache and make zero new provider HTTP calls');
  assert.ok(calls.some(url => url.includes('/fixtures?live=all')));
  assert.ok(calls.some(url => url.includes('/odds/live')));
  assert.ok(calls.some(url => /\/fixtures\?date=\d{4}-\d{2}-\d{2}/.test(url)), 'prematch fixtures use the supported date query');
  assert.ok(calls.every(url => !url.includes('from=') && !url.includes('to=')), 'unsupported from/to fixture query is never sent');
  assert.equal(calls.filter(url => url.includes('/odds?')).length, 2);
});

test('quota floor translates the 100/day free budget into a minimum refresh window per bucket', () => {
  const { apiSportsQuotaFloorSeconds } = __sportsbookProviders;
  // Budget 100, one date: prematch 25 (3 endpoints: fixtures + 2 odds pages),
  // live 75 (2 endpoint: fixtures live + odds live).
  assert.equal(apiSportsQuotaFloorSeconds('prematch'), 86400 * 3 / 25, 'prematch floor = 10368s (~2.9 jam)');
  assert.equal(apiSportsQuotaFloorSeconds('live'), 86400 * 2 / 75, 'live floor = 2304s (~38 menit)');
});

test('live endpoints stay cached beyond their configured refresh TTL while still inside the quota window', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  await fetchApiSports();
  const first = calls.length;
  assert.equal(first, 5);
  const liveEntry = [...__sportsbookProviders.providerRequestCache.entries()]
    .find(([key]) => key.startsWith('api-sports:fixtures') && key.includes('live'));
  assert.ok(liveEntry, 'live fixtures entry cached after first refresh');
  // Age entry melewati TTL konfigurasi (30 detik) tapi masih jauh di dalam
  // jendela kuota (2304 detik) — guard harus menahannya tanpa HTTP baru.
  liveEntry[1].fetchedAt -= 60_000;
  await fetchApiSports();
  assert.equal(calls.length, first, 'quota window must hold the endpoint despite the configured 30s TTL expiring');
});

test('live price stamp ages with the real odds/live fetch time and the fail-closed guard closes it', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  __sportsbookProviders.apiSportsFailureCache.clear();
  calls.length = 0;
  const first = await fetchApiSports();
  const liveEvent = first.events.find(event => event.live);
  assert.ok(liveEvent, 'mocked live fixture normalized as LIVE');
  const market = liveEvent.markets[0];
  assert.ok(market, 'live 1X2 market built from the odds/live payload');
  const oddsLiveEntry = __sportsbookProviders.providerRequestCache.get('api-sports:odds/live:[]');
  assert.ok(oddsLiveEntry, 'odds/live payload cached');
  assert.equal(Date.parse(market.updatedAt), oddsLiveEntry.fetchedAt, 'stamp equals the real provider fetch time, not Date.now()');
  const fresh = __sportsbookProviders.suspendStaleLiveMarkets([liveEvent], Date.now());
  assert.equal(fresh[0].markets[0].suspended, false, 'fresh live price stays open for betting');
  // Tanpa fetch baru, cache di-menuakan 5 menit: stempel HARUS ikut menua (bukan
  // mengaku segar), dan guard menahan market — fail-closed.
  oddsLiveEntry.fetchedAt -= 300_000;
  const refreshed = await fetchApiSports();
  const aged = refreshed.events.find(event => event.live);
  assert.equal(Date.parse(aged.markets[0].updatedAt), oddsLiveEntry.fetchedAt, 'stamp follows the aged cache across re-normalization cycles');
  const guarded = __sportsbookProviders.suspendStaleLiveMarkets([aged], Date.now());
  assert.equal(guarded[0].markets[0].suspended, true, 'stale live market suspended fail-closed');
  assert.ok(guarded[0].markets[0].selections.every(selection => selection.suspended), 'every stale selection suspended with its market');
});

test('prematch odds are joined to their fixture and retain the provider update timestamp', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  __sportsbookProviders.apiSportsFailureCache.clear();
  calls.length = 0;
  const result = await fetchApiSports();
  const event = result.events.find(item => item.home.name === 'Gamma FC');
  assert.ok(event, 'fixture with provider odds is returned');
  const market = event.markets.find(item => item.type === '1X2');
  assert.ok(market, 'real prematch bookmaker market is normalized');
  const normalizedUpdate = new Date(prematchUpdate).toISOString();
  assert.equal(market.updatedAt, normalizedUpdate, 'record update timestamp is propagated to the market');
  assert.ok(market.selections.every(selection => selection.updatedAt === normalizedUpdate), 'provider timestamp is also propagated to each selection');
  assert.equal(market.selections.find(selection => selection.label === 'Gamma FC')?.odds, 1.8);
});

test('HTTP-200 API-Sports errors are surfaced and endpoint backoff prevents repeated quota-consuming retries', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  __sportsbookProviders.apiSportsFailureCache.clear();
  calls.length = 0;
  failPrematchFixtures = true;
  try {
    const result = await fetchApiSports();
    assert.ok(result.errors.some(error => error.includes('The From field need another parameter')));
    const fixtureCalls = calls.filter(url => url.includes('/fixtures?date=')).length;
    assert.equal(fixtureCalls, 1);
    const callsAfterFailure = calls.length;
    await fetchApiSports();
    assert.equal(calls.length, callsAfterFailure, 'failed endpoint is held in backoff instead of retried on the next feed cycle');
  } finally {
    failPrematchFixtures = false;
    __sportsbookProviders.providerRequestCache.clear();
    __sportsbookProviders.apiSportsFailureCache.clear();
  }
});

test.after(() => { globalThis.fetch = originalFetch; });
