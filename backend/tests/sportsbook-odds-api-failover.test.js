import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { logger } from '../src/logger.js';

const primaryKey = randomBytes(24).toString('hex');
const secondaryKey = randomBytes(24).toString('hex');
const tertiaryKey = randomBytes(24).toString('hex');
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  THE_ODDS_API_ENABLED: 'true',
  THE_ODDS_API_KEY: primaryKey,
  THE_ODDS_API_KEY_2: secondaryKey,
  THE_ODDS_API_KEYS: tertiaryKey,
  THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD: '10',
  THE_ODDS_API_BASE_URL: 'https://api.the-odds-api.test/v4',
  THE_ODDS_API_SPORT_KEYS: 'soccer_test_league',
  THE_ODDS_API_REGIONS: 'eu',
  THE_ODDS_API_MARKETS: 'h2h',
  THE_ODDS_API_REFRESH_SECONDS: '60',
  THE_ODDS_API_EVENT_MARKETS_ENABLED: 'false',
  THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: '0',
  THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: '0'
});

const { fetchTheOddsApi, __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const providerLogs = [];
logger.info = (message, context) => providerLogs.push({ level: 'info', message, context });
logger.warn = (message, context) => providerLogs.push({ level: 'warn', message, context });
logger.error = (message, context) => providerLogs.push({ level: 'error', message, context });

const requestLabels = [];
let responses = [];
const staleEvent = {
  id: 'failover-stale-event',
  sport_key: 'soccer_test_league',
  sport_title: 'Test League',
  commence_time: new Date(Date.now() + 3_600_000).toISOString(),
  home_team: 'Home FC',
  away_team: 'Away FC',
  completed: false,
  bookmakers: [{
    key: 'testbook',
    title: 'Test Book',
    last_update: new Date().toISOString(),
    markets: [{
      key: 'h2h',
      last_update: new Date().toISOString(),
      outcomes: [
        { name: 'Home FC', price: 1.9 },
        { name: 'Draw', price: 3.4 },
        { name: 'Away FC', price: 4.2 }
      ]
    }]
  }]
};
globalThis.fetch = async url => {
  const actualKey = new URL(url).searchParams.get('apiKey');
  requestLabels.push(actualKey === primaryKey ? 'key#1' : actualKey === secondaryKey ? 'key#2' : actualKey === tertiaryKey ? 'key#3' : 'other');
  const next = responses.shift() || { status: 200, body: [], remaining: 100 };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'x-requests-remaining' && next.remaining !== undefined
          ? String(next.remaining)
          : null;
      }
    },
    async text() {
      return JSON.stringify(next.body);
    }
  };
};

function quotaExhausted() {
  return { status: 401, body: { error_code: 'OUT_OF_USAGE_CREDITS' } };
}

function resetState() {
  __sportsbookProviders.providerRequestCache.clear();
  __sportsbookProviders.oddsApiEventDetailCache.clear();
  __sportsbookProviders.theOddsApiQuotaGuard.reset();
  requestLabels.length = 0;
  providerLogs.length = 0;
  responses = [];
}

function expireProviderCache() {
  for (const entry of __sportsbookProviders.providerRequestCache.values()) {
    entry.fetchedAt -= 120_000;
    entry.expiresAt -= 120_000;
  }
}

function assertNoCredentialLeaks(value) {
  const output = JSON.stringify(value);
  for (const credential of [primaryKey, secondaryKey, tertiaryKey]) {
    assert.equal(output.includes(credential), false, 'provider output must not include credentials');
  }
}

test('quota exhaustion retries once with the next key and logs labels only', async () => {
  resetState();
  responses = [quotaExhausted(), { status: 200, body: [], remaining: 499 }];

  const result = await fetchTheOddsApi();

  assert.deepEqual(requestLabels, ['key#1', 'key#2']);
  assert.equal(result.errors.length, 0);
  assert.ok(providerLogs.some(entry => entry.message === 'The Odds API key failover'
    && entry.context.fromKeyLabel === 'key#1'
    && entry.context.toKeyLabel === 'key#2'));
  assert.ok(providerLogs.some(entry => entry.message === 'The Odds API quota status'
    && entry.context.keyLabel === 'key#2'
    && entry.context.requestsRemaining === 499));
  assertNoCredentialLeaks({ result, providerLogs });
});

test('a successful response below the threshold switches future requests without retrying it', async () => {
  resetState();
  responses = [{ status: 200, body: [], remaining: 9 }];

  await fetchTheOddsApi();
  assert.deepEqual(requestLabels, ['key#1']);

  expireProviderCache();
  responses = [{ status: 200, body: [], remaining: 400 }];
  await fetchTheOddsApi();

  assert.deepEqual(requestLabels, ['key#1', 'key#2']);
  assertNoCredentialLeaks(providerLogs);
});

test('only one key switch is allowed in a cycle and exhausted keys stay retired', async () => {
  resetState();
  responses = [quotaExhausted(), quotaExhausted()];

  await fetchTheOddsApi();
  assert.deepEqual(requestLabels, ['key#1', 'key#2'], 'the third key must not be tried during the same cycle');

  expireProviderCache();
  responses = [quotaExhausted()];
  await fetchTheOddsApi();
  assert.deepEqual(requestLabels, ['key#1', 'key#2', 'key#3']);

  expireProviderCache();
  responses = [{ status: 200, body: [], remaining: 499 }];
  await fetchTheOddsApi();
  assert.deepEqual(requestLabels, ['key#1', 'key#2', 'key#3'], 'exhausted keys must not be reused before restart');
  assertNoCredentialLeaks(providerLogs);
});

test('all exhausted keys serve the last cached payload without another request', async () => {
  resetState();
  responses = [{ status: 200, body: [staleEvent], remaining: 100 }];
  const fresh = await fetchTheOddsApi();
  assert.equal(fresh.events.length, 1);

  expireProviderCache();
  responses = [quotaExhausted(), quotaExhausted()];
  const stale = await fetchTheOddsApi();
  assert.equal(stale.events.length, 1);
  assert.equal(stale.events[0].home.name, 'Home FC');

  expireProviderCache();
  responses = [quotaExhausted()];
  const retained = await fetchTheOddsApi();
  assert.equal(retained.events.length, 1);

  expireProviderCache();
  await fetchTheOddsApi();
  assert.deepEqual(requestLabels, ['key#1', 'key#1', 'key#2', 'key#3']);
  assertNoCredentialLeaks({ stale, retained, providerLogs });
});

test('non-quota API errors remain sanitized in provider results and logs', async () => {
  resetState();
  responses = [{ status: 500, body: { message: primaryKey } }];

  const result = await fetchTheOddsApi();

  assert.deepEqual(requestLabels, ['key#1']);
  assert.match(result.errors[0], /HTTP 500/);
  assertNoCredentialLeaks({ result, providerLogs });
});

test('one-key configuration remains compatible with the existing request path', () => {
  const fakePrimaryKey = randomBytes(24).toString('hex');
  const script = `
    Object.assign(process.env, {
      NODE_ENV: 'test',
      THE_ODDS_API_ENABLED: 'true',
      THE_ODDS_API_KEY: process.env.THE_ODDS_API_KEY,
      THE_ODDS_API_KEY_2: '',
      THE_ODDS_API_KEYS: '',
      THE_ODDS_API_SPORT_KEYS: 'soccer_test_league',
      THE_ODDS_API_REGIONS: 'eu',
      THE_ODDS_API_MARKETS: 'h2h',
      THE_ODDS_API_EVENT_MARKETS_ENABLED: 'false'
    });
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(new URL(url).searchParams.get('apiKey') === process.env.THE_ODDS_API_KEY);
      return {
        ok: true,
        status: 200,
        headers: { get() { return '100'; } },
        async text() { return '[]'; }
      };
    };
    const { config } = await import(${JSON.stringify(pathToFileURL(new URL('../src/config.js', import.meta.url).pathname).href)});
    const { fetchTheOddsApi } = await import(${JSON.stringify(pathToFileURL(new URL('../src/sportsbook-providers.js', import.meta.url).pathname).href)});
    await fetchTheOddsApi();
    process.stdout.write(JSON.stringify({ calls, threshold: config.theOddsApiFailoverRemainingThreshold }));
  `;
  const singleKeyLogger = `
    const { logger } = await import(${JSON.stringify(pathToFileURL(new URL('../src/logger.js', import.meta.url).pathname).href)});
    logger.info = () => {};
    logger.warn = () => {};
  `;
  const testScript = `${singleKeyLogger}\n${script}`;
  const childEnv = {
    ...process.env,
    THE_ODDS_API_KEY: fakePrimaryKey,
    THE_ODDS_API_KEY_2: '',
    THE_ODDS_API_KEYS: ''
  };
  delete childEnv.THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', testScript], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: childEnv
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { calls: [true], threshold: 10 });
  assert.equal(result.stdout.includes(fakePrimaryKey), false);
});
