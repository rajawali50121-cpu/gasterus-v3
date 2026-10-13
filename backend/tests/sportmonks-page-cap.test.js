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
  SPORTMONKS_DAYS_AHEAD: '7',
  SPORTMONKS_MAX_TOTAL_EVENTS: '400',
  SPORTMONKS_PAGE_SIZE: '25',
  SPORTMONKS_REQUEST_DELAY_MS: '0',
  SPORTMONKS_MAX_RESPONSE_BYTES: '6000000'
});

const requests = [];
const odds = Array.from({ length: 318 }, (_, index) => {
  const marketId = index < 54 ? 1 : index < 182 ? 6 : 80;
  const description = marketId === 1
    ? 'Match Winner'
    : marketId === 6 ? 'Asian Handicap' : 'Goals Over/Under';
  return {
    id: index + 1,
    market_id: marketId,
    market_description: description,
    label: index % 2 === 0 ? 'Home' : 'Away',
    value: '1.95',
    handicap: '-0.5',
    total: '2.5'
  };
});

globalThis.fetch = async url => {
  const requestUrl = new URL(url);
  requests.push(requestUrl);
  const page = Number(requestUrl.searchParams.get('page'));
  const firstId = (page - 1) * 25;
  const fixtures = Array.from({ length: 25 }, (_, index) => ({
    id: firstId + index + 1,
    starting_at: new Date(Date.now() + (firstId + index + 1) * 60_000).toISOString(),
    state: { short_name: 'NS' },
    league: { name: 'Test League' },
    participants: [
      { name: 'Home FC', meta: { location: 'home' } },
      { name: 'Away FC', meta: { location: 'away' } }
    ],
    odds
  }));
  return new Response(JSON.stringify({
    data: fixtures,
    pagination: { current_page: page, last_page: 16, has_more: page < 16 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { fetchSportmonks } = await import('../src/sportsbook-providers.js');

test('Sportmonks normalizes a 400-fixture feed over sequential 25-row pages', async () => {
  const result = await fetchSportmonks();

  assert.equal(result.events.length, 400);
  assert.equal(requests.length, 16);
  assert.deepEqual(requests.map(url => url.searchParams.get('page')), Array.from({ length: 16 }, (_, index) => String(index + 1)));
  assert.ok(result.events.every(event => event.markets.length === 3));
});
