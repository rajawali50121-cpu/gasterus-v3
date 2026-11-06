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
  API_FOOTBALL_KEY: 'test-provider-key',
  API_SPORTS_ODDS_PAGES: '2',
  API_SPORTS_LIVE_REFRESH_SECONDS: '30',
  API_SPORTS_PREMATCH_REFRESH_SECONDS: '300',
  // Free tier API-Football (diverifikasi via /status: limit_day=100). Dipakai
  // eksplisit supaya hasil test deterministik walau backend/.env ikut termuat.
  API_SPORTS_DAILY_QUOTA: '100',
  THE_ODDS_API_ENABLED: 'false'
});
process.env.API_SPORTS_KEY = '';

const originalFetch = globalThis.fetch;
const calls = [];
let apiAccessError = false;
// Payload mock menyerupai bentuk asli API-Football: satu laga LIVE dengan odds
// 1X2, sehingga jalur normalisasi + stempel harga live ikut teruji.
const liveFixture = {
  fixture: { id: 999001, date: '2026-10-06T12:00:00Z', status: { short: '1H', long: 'First Half', elapsed: 23 }, venue: { name: 'Test Arena' } },
  league: { id: 1, name: 'Test League', country: 'England', logo: null },
  teams: { home: { id: 1, name: 'Alpha FC', logo: null }, away: { id: 2, name: 'Beta FC', logo: null } },
  goals: { home: 1, away: 0 },
  score: { halftime: { home: 1, away: 0 }, fulltime: { home: null, away: null } }
};
const prematchFixture = {
  fixture: { id: 999002, date: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), status: { short: 'NS', long: 'Not Started' }, venue: { name: 'Test Arena' } },
  league: { id: 2, name: 'Test Prematch League', country: 'England', logo: null },
  teams: { home: { id: 3, name: 'Gamma FC', logo: null }, away: { id: 4, name: 'Delta FC', logo: null } },
  goals: { home: null, away: null },
  score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } }
};
const liveOddsPayload = {
  response: [{
    fixture: { id: 999001 },
    bookmakers: [{ id: 1, name: 'Test Book', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.5 }, { value: 'Draw', odd: 4.2 }, { value: 'Beta FC', odd: 6.5 }
    ] }] }]
  }]
};
const prematchOddsPayload = {
  response: [{
    fixture: { id: 999002 },
    bookmakers: [{ id: 2, name: 'Test Book', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Gamma FC', odd: 2.1 }, { value: 'Draw', odd: 3.3 }, { value: 'Delta FC', odd: 3.4 }
    ] }] }]
  }]
};
globalThis.fetch = async url => {
  const target = String(url);
  calls.push(target);
  let body = apiAccessError ? { errors: { access: 'private upstream message' }, response: [] } : { response: [] };
  if (!apiAccessError && target.includes('/fixtures?live=all')) body = { response: [liveFixture] };
  else if (!apiAccessError && target.includes('/fixtures?from=')) body = { response: [prematchFixture] };
  else if (!apiAccessError && target.includes('/odds/live')) body = liveOddsPayload;
  else if (!apiAccessError && target.includes('/odds?')) body = prematchOddsPayload;
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); }
  };
};

const [{ config }, { fetchApiSports, __sportsbookProviders }] = await Promise.all([
  import('../src/config.js'),
  import('../src/sportsbook-providers.js')
]);

test('API-Football worker key alias enables the verified free API-Sports account', () => {
  assert.equal(config.apiSportsKey, 'test-provider-key');
  assert.equal(config.apiSportsEnabled, true);
  assert.equal(config.apiSportsDailyQuota, 100);
  assert.equal(config.apiSportsMonthlyQuota, 3100);
});

test('API-Sports endpoint cache prevents the 8-second aggregator loop from consuming provider quota every cycle', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  await fetchApiSports();
  const first = calls.length;
  assert.equal(first, 5, 'first refresh should call live fixtures, upcoming fixtures, live odds and two pre-match odds pages');
  await fetchApiSports();
  assert.equal(calls.length, first, 'immediate second refresh must reuse endpoint cache and make zero new provider HTTP calls');
  assert.ok(calls.some(url => url.includes('/fixtures?live=all')));
  assert.ok(calls.some(url => url.includes('/odds/live')));
  assert.equal(calls.filter(url => url.includes('/odds?')).length, 2);
});

test('API-Sports reserves persistent quota before every real HTTP request', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  const reservations = [];
  const quotaStore = {
    async reserveRequest(request) {
      reservations.push(request);
      return { status: 'reserved', waitMs: 0 };
    }
  };

  await fetchApiSports({ quotaStore });
  assert.equal(calls.length, 5);
  assert.equal(reservations.length, 5);
  assert.ok(reservations.every(request => request.dailyLimit === 100));
  assert.ok(reservations.every(request => request.monthlyLimit === 3100));
  assert.equal(new Set(reservations.map(request => request.reservationId)).size, 5);

  await fetchApiSports({ quotaStore });
  assert.equal(calls.length, 5, 'cached requests do not reserve quota or reach the provider again');
  assert.equal(reservations.length, 5);
});

test('API-Sports fails closed without quota storage and isolates storage failures from HTTP', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  const unavailable = await fetchApiSports({
    quotaStore: { async reserveRequest() { throw new Error('database connection includes private details'); } }
  });
  assert.equal(calls.length, 0, 'quota reservation failure must happen before the provider request');
  assert.equal(unavailable.transportOk, false);
  assert.ok(unavailable.errors.every(error => !error.includes('private details')));

  const exhausted = await fetchApiSports({
    quotaStore: { async reserveRequest() { return { status: 'exhausted', waitMs: 0 }; } }
  });
  assert.equal(calls.length, 0, 'exhausted quota must not issue an HTTP request');
  assert.ok(exhausted.errors.some(error => error.includes('quota exhausted')));
});

test('quota floor translates the 100/day free budget into a minimum refresh window per bucket', () => {
  const { apiSportsQuotaFloorSeconds } = __sportsbookProviders;
  // Budget 100: prematch 25 (3 endpoint: fixtures upcoming + 2 halaman odds),
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

test('API-Sports HTTP 200 payload errors are surfaced safely and remain quota-cached', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  apiAccessError = true;
  try {
    const result = await fetchApiSports();
    assert.equal(result.transportOk, false);
    assert.equal(result.events.length, 0);
    assert.ok(result.errors.some(error => error === 'API-Sports fixtures (prematch) response reported access error.'));
    assert.ok(result.errors.every(error => !error.includes('private upstream message')));
    const first = calls.length;
    const cachedResult = await fetchApiSports();
    assert.equal(calls.length, first, 'application-level errors must remain cached within the provider quota window');
    assert.equal(cachedResult.transportOk, false);
  } finally {
    apiAccessError = false;
    __sportsbookProviders.providerRequestCache.clear();
  }
});

test('live price stamp ages with the real odds/live fetch time and the fail-closed guard closes it', async () => {
  __sportsbookProviders.providerRequestCache.clear();
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

test('prematch API-Sports market timestamps follow quota-cached odds fetch time, not snapshot time', async () => {
  __sportsbookProviders.providerRequestCache.clear();
  calls.length = 0;
  const first = await fetchApiSports();
  const prematch = first.events.find(event => !event.live);
  assert.ok(prematch, 'prematch fixture normalized');
  const market = prematch.markets[0];
  assert.ok(market, 'prematch odds normalized');
  const oddsPageEntries = [...__sportsbookProviders.providerRequestCache.entries()]
    .filter(([key]) => key.startsWith('api-sports:odds:') && key !== 'api-sports:odds/live:[]')
    .map(([, entry]) => entry);
  assert.ok(oddsPageEntries.length, 'pre-match odds pages cached');
  assert.equal(Date.parse(market.updatedAt), Math.max(...oddsPageEntries.map(entry => entry.fetchedAt)));

  for (const entry of oddsPageEntries) entry.fetchedAt -= 1800000;
  const cached = await fetchApiSports();
  const aged = cached.events.find(event => !event.live);
  assert.equal(Date.parse(aged.markets[0].updatedAt), Math.max(...oddsPageEntries.map(entry => entry.fetchedAt)));
  assert.ok(Date.now() - Date.parse(aged.markets[0].updatedAt) > 900000, 're-normalizing cached data does not refresh its odds age');
  assert.equal(calls.filter(url => url.includes('/odds?')).length, 2, 'quota cache prevents another request for stale odds');
});

test.after(() => { globalThis.fetch = originalFetch; });
