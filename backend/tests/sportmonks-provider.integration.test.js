import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '******example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTMONKS_ENABLED: 'true',
  SPORTMONKS_API_KEY: 'test-sportmonks-provider-key',
  SPORTMONKS_DAYS_AHEAD: '0',
  SPORTMONKS_MAX_TOTAL_EVENTS: '50',
  SPORTMONKS_PAGE_SIZE: '25',
  SPORTMONKS_REQUEST_DELAY_MS: '0',
  SPORTMONKS_MAX_RETRIES: '1',
  SPORTMONKS_MAX_RESPONSE_BYTES: '1000000'
});

const calls = [];
let firstPageFailures = 1;
const fixture = {
  id: 90210,
  starting_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  state: { short_name: 'NS', name: 'Not Started' },
  league: { name: 'Test League', country: { name: 'Test Country' } },
  participants: [
    { name: 'Home FC', meta: { location: 'home' } },
    { name: 'Away FC', meta: { location: 'away' } }
  ],
  odds: [
    { id: 1, market_id: 1, market_description: 'Match Winner', label: 'Home', value: '1.9' },
    { id: 2, market_id: 1, market_description: 'Match Winner', label: 'Draw', value: '3.4' },
    { id: 3, market_id: 1, market_description: 'Match Winner', label: 'Away', value: '4.1' },
    { id: 4, market_id: 6, market_description: 'Asian Handicap', label: 'Home', value: '1.9', handicap: '-0.5' },
    { id: 5, market_id: 80, market_description: 'Goals Over/Under', label: 'Over', value: '1.8', total: '2.5' }
  ]
};

globalThis.fetch = async (url, options) => {
  const requestUrl = new URL(url);
  calls.push({ url: requestUrl, options });
  if (requestUrl.searchParams.get('page') === '1' && firstPageFailures-- > 0) {
    return new Response('upstream error', { status: 503 });
  }
  const page = requestUrl.searchParams.get('page');
  const body = page === '1'
    ? { data: [fixture], pagination: { current_page: 1, last_page: 2, has_more: true } }
    : { data: [], pagination: { current_page: 2, last_page: 2, has_more: false } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { fetchSportmonks } = await import('../src/sportsbook-providers.js');

test('Sportmonks fetch retries transient errors, paginates, filters markets, and normalizes each page', async () => {
  const [result, overlappingResult] = await Promise.all([fetchSportmonks(), fetchSportmonks()]);

  assert.equal(result.enabled, true);
  assert.equal(overlappingResult.events.length, 1);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].markets.map(market => market.type).sort(), ['1X2', 'HANDICAP', 'TOTALS']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('page')), ['1', '1', '2']);
  for (const { url, options } of calls) {
    assert.equal(url.searchParams.get('per_page'), '25');
    assert.equal(url.searchParams.get('include'), 'state;scores;league;odds;participants');
    assert.equal(url.searchParams.get('filters'), 'markets:1,6,80');
    assert.equal(url.searchParams.has('api_token'), false);
    assert.equal(options.headers.authorization, 'test-sportmonks-provider-key');
  }
});
