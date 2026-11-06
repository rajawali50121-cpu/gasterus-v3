import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:password@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  RAPIDAPI_CASINO_ENABLED: 'true',
  RAPIDAPI_CASINO_KEY: 'test-rapidapi-key'
});

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const { pruneExpiredCacheEntries, setBoundedCacheEntry } = await import('../src/bounded-cache.js');
const { readBoundedResponseText } = await import('../src/bounded-response.js');
const { casinoPassthrough, __casinoRapidApi } = await import('../src/casino-rapidapi.js');

test('bounded cache rejects oversized entries and evicts oldest entries to fit its total budget', () => {
  const cache = new Map(), secondCache = new Map();
  const limits = { maxEntryBytes: 20, maxTotalBytes: 24 };
  setBoundedCacheEntry(cache, 'oldest', { data: 'a' }, { fetchedAt: 1, ...limits });
  setBoundedCacheEntry(secondCache, 'newer', { data: 'b' }, { fetchedAt: 2, ...limits });
  setBoundedCacheEntry(cache, 'latest', { data: 'c' }, { fetchedAt: 3, ...limits });

  assert.equal(cache.has('oldest'), false);
  assert.equal(secondCache.has('newer'), true);
  assert.equal(cache.has('latest'), true);
  assert.ok([...cache.values(), ...secondCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0) <= limits.maxTotalBytes);
  assert.throws(
    () => setBoundedCacheEntry(cache, 'oversized', { data: 'x'.repeat(30) }, limits),
    /cache entry limit/
  );
});

test('bounded cache removes expired entries and enforces its entry-count limit', () => {
  const cache = new Map();
  const limits = { maxEntryBytes: 100, maxTotalBytes: 1000, maxEntries: 2 };
  setBoundedCacheEntry(cache, 'expired', { data: 'a' }, { fetchedAt: 1, expiresAt: 10, ...limits });
  pruneExpiredCacheEntries(cache, 10);
  assert.equal(cache.has('expired'), false);

  setBoundedCacheEntry(cache, 'oldest', { data: 'b' }, { fetchedAt: 20, ...limits });
  setBoundedCacheEntry(cache, 'newest', { data: 'c' }, { fetchedAt: 30, ...limits });
  setBoundedCacheEntry(cache, 'replacement', { data: 'd' }, { fetchedAt: 40, ...limits });
  assert.equal(cache.size, 2);
  assert.equal(cache.has('oldest'), false);
  assert.equal(cache.has('newest'), true);
  assert.equal(cache.has('replacement'), true);
});

test('bounded response reader rejects an oversized Content-Length without reading the body', async () => {
  let bodyRead = false;
  let bodyCancelled = false;
  const response = {
    headers: { get: () => '6' },
    body: {
      async cancel() { bodyCancelled = true; },
      getReader() { bodyRead = true; throw new Error('body should not be read'); }
    }
  };
  await assert.rejects(readBoundedResponseText(response, 'test provider', 5), /exceeds 5 bytes/);
  assert.equal(bodyRead, false);
  assert.equal(bodyCancelled, true);
});

test('bounded response reader cancels a streaming response that exceeds its byte limit', async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
    },
    cancel() { bodyCancelled = true; }
  });
  const response = new Response(body, { headers: { 'content-length': '4' } });
  await assert.rejects(readBoundedResponseText(response, 'test provider', 4), /exceeds 4 bytes/);
  assert.equal(bodyCancelled, true);
});

test('RapidAPI casino expires failure entries and keeps the failure cache at 100 entries maximum', async () => {
  __casinoRapidApi.failureCache.clear();
  let now = 1_800_000_000_000;
  Date.now = () => now;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return '{"message":"Unauthorized"}'; }
  });

  try {
    for (let index = 0; index < 105; index += 1) {
      await assert.rejects(
        casinoPassthrough('/casino/getgames', { provider: `PROVIDER${index}` })
      );
    }
    assert.equal(__casinoRapidApi.failureCache.size, 100);

    now += 60_001;
    await assert.rejects(
      casinoPassthrough('/casino/getgames', { provider: 'AFTER-EXPIRY' })
    );
    assert.equal(__casinoRapidApi.failureCache.size, 1);
  } finally {
    __casinoRapidApi.failureCache.clear();
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  __casinoRapidApi.failureCache.clear();
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
});
