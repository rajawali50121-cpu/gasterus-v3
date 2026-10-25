import test from 'node:test';
import assert from 'node:assert/strict';

const { renderSportsbookPage, __browserRenderer } = await import('../src/sportsbook-browser-renderer.js');

const cache = __browserRenderer.renderCache;
const MAX_ENTRIES = __browserRenderer.RENDER_CACHE_MAX_ENTRIES;
const MAX_BYTES = __browserRenderer.RENDER_CACHE_MAX_BYTES;
const MAX_PENDING = __browserRenderer.RENDER_QUEUE_MAX_PENDING;

function totalBytes() {
  return [...cache.values()].reduce((sum, entry) => sum + (Number(entry?.sizeBytes) >= 0 ? Number(entry.sizeBytes) : (entry?.value?.html ? Buffer.byteLength(entry.value.html, 'utf8') : 0)), 0);
}

function makeResult(url, html = `<div>${url}</div>`) {
  return {
    html,
    finalUrl: url,
    renderer: 'CHROMIUM_CDP',
    markerReady: true,
    renderedAt: new Date().toISOString(),
    renderMs: 1
  };
}

function clearState() {
  cache.clear();
  __browserRenderer.renderImplementation = async (url) => makeResult(url);
}

test.beforeEach(() => {
  clearState();
});

test.afterEach(() => {
  cache.clear();
  __browserRenderer.renderImplementation = async (url) => makeResult(url);
});

test('render cache enforces entry count for more than 100 unique URLs', async () => {
  for (let index = 0; index < 105; index += 1) {
    await renderSportsbookPage(`https://example.com/count/${index}`, { cacheSeconds: 100 });
  }
  assert.ok(cache.size <= MAX_ENTRIES, `cache size ${cache.size} exceeds ${MAX_ENTRIES}`);
  assert.ok(__browserRenderer.renderCacheTotalBytes <= MAX_BYTES);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());
  assert.ok(!cache.has('https://example.com/count/0'), 'oldest entry should be evicted');
  assert.ok(cache.has('https://example.com/count/104'), 'newest entry should remain');
});

test('render cache enforces aggregate byte cap for large HTML', async () => {
  const bigChunk = 'x'.repeat(5 * 1024 * 1024);
  __browserRenderer.renderImplementation = async (url) => makeResult(url, `${url}:${bigChunk}`);
  for (let index = 0; index < 5; index += 1) {
    await renderSportsbookPage(`https://example.com/big/${index}`, { cacheSeconds: 100 });
  }
  assert.ok(__browserRenderer.renderCacheTotalBytes <= MAX_BYTES, `bytes ${__browserRenderer.renderCacheTotalBytes} exceed ${MAX_BYTES}`);
  assert.ok(cache.size <= 3, `expected at most 3 large entries, got ${cache.size}`);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());
});

test('oversized render result is returned but not stored', async () => {
  const huge = 'x'.repeat(MAX_BYTES + 1);
  __browserRenderer.renderImplementation = async (url) => makeResult(url, huge);
  const url = 'https://example.com/huge';
  const result = await renderSportsbookPage(url, { cacheSeconds: 100 });
  assert.match(result.html, /^x+$/);
  assert.equal(cache.has(url), false, 'oversized HTML must not be cached');
  assert.equal(__browserRenderer.renderCacheTotalBytes, 0);
  assert.equal(__browserRenderer.queuePendingCount, 0);
});

test('all in-flight entries allow fallback eviction and preserve the hard cap', async () => {
  const urls = Array.from({ length: MAX_ENTRIES }, (_, index) => `https://example.com/inflight/${index}`);
  for (const url of urls) {
    cache.set(url, { value: null, expiresAt: 0, inFlight: Promise.resolve(), sizeBytes: 0 });
  }
  __browserRenderer.renderImplementation = async (url) => makeResult(url, 'fresh');
  const newUrl = 'https://example.com/inflight/new';
  const result = await renderSportsbookPage(newUrl, { cacheSeconds: 100 });
  assert.equal(result.cacheHit, false);
  assert.ok(cache.size <= MAX_ENTRIES, 'cache must not grow beyond hard cap');
  const evicted = __browserRenderer.evictOldestRenderCacheEntry(cache, Date.now());
  assert.ok(typeof evicted === 'string' || evicted === null);
});

test('an evicted in-flight render does not write a stale cache entry', async () => {
  let resolveRender;
  const renderPromise = new Promise(resolve => { resolveRender = resolve; });
  __browserRenderer.renderImplementation = async (url) => {
    await renderPromise;
    return makeResult(url, 'late');
  };
  const url = 'https://example.com/stale-writeback';
  const pending = renderSportsbookPage(url, { cacheSeconds: 100 });
  assert.equal(cache.has(url), true);
  cache.delete(url);
  resolveRender();
  const result = await pending;
  assert.equal(result.html, 'late');
  assert.equal(cache.has(url), false, 'evicted in-flight render must not write back');
  assert.equal(__browserRenderer.queuePendingCount, 0);
});

test('mixed success and failure keeps queue running and caches only successes', async () => {
  let calls = 0;
  __browserRenderer.renderImplementation = async (url) => {
    calls += 1;
    if (calls % 2 === 0) throw new Error(`render failed for ${url}`);
    return makeResult(url, `ok-${calls}`);
  };

  const urls = Array.from({ length: 6 }, (_, index) => `https://example.com/mixed/${index}`);
  for (const url of urls) {
    if (urls.indexOf(url) % 2 === 1) {
      await assert.rejects(renderSportsbookPage(url, { cacheSeconds: 100 }), /render failed/);
    } else {
      const result = await renderSportsbookPage(url, { cacheSeconds: 100 });
      assert.equal(result.cacheHit, false);
    }
  }
  assert.ok(cache.size <= 3, `expected at most 3 successful entries, got ${cache.size}`);
  assert.equal(__browserRenderer.queuePendingCount, 0);
  const result = await renderSportsbookPage('https://example.com/mixed/final', { cacheSeconds: 100 });
  assert.equal(result.cacheHit, false);
});

test('concurrent identical URLs deduplicate renders', async () => {
  let calls = 0;
  __browserRenderer.renderImplementation = async (url) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 25));
    return makeResult(url, `deduped-${calls}`);
  };
  const url = 'https://example.com/same';
  const results = await Promise.all(
    Array.from({ length: 5 }, () => renderSportsbookPage(url, { cacheSeconds: 100 }))
  );
  assert.equal(calls, 1, 'identical in-flight URL must render only once');
  assert.equal(cache.size, 1);
  assert.ok(results.every(result => result.html === results[0].html));
  const cachedResult = await renderSportsbookPage(url, { cacheSeconds: 100 });
  assert.equal(cachedResult.cacheHit, true);
});

test('concurrent different URLs render independently and respect cache bounds', async () => {
  let calls = 0;
  __browserRenderer.renderImplementation = async (url) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return makeResult(url, `different-${calls}`);
  };
  const urls = Array.from({ length: 8 }, (_, index) => `https://example.com/different/${index}`);
  const results = await Promise.all(urls.map(url => renderSportsbookPage(url, { cacheSeconds: 100 })));
  assert.equal(calls, 8);
  assert.equal(results.length, 8);
  assert.ok(cache.size <= MAX_ENTRIES);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());
});

test('evicts at full cache and completes render after eviction', async () => {
  for (let index = 0; index < MAX_ENTRIES; index += 1) {
    await renderSportsbookPage(`https://example.com/full/${index}`, { cacheSeconds: 100 });
  }
  assert.equal(cache.size, MAX_ENTRIES);
  await renderSportsbookPage('https://example.com/full/new', { cacheSeconds: 100 });
  assert.equal(cache.size, MAX_ENTRIES);
  assert.ok(cache.has('https://example.com/full/new'));
  assert.ok(!cache.has('https://example.com/full/0'));
  assert.ok(__browserRenderer.renderCacheTotalBytes <= MAX_BYTES);
});

test('TTL sweep, deletion, and byte counter accuracy', async () => {
  const now = Date.now();
  const grace = __browserRenderer.RENDER_CACHE_SWEEP_GRACE_MS;
  cache.clear();
  for (let index = 0; index < __browserRenderer.RENDER_CACHE_SWEEP_THRESHOLD; index += 1) {
    cache.set(`stale-${index}`, {
      value: { html: 'x'.repeat(1000) },
      expiresAt: now - grace - 1000,
      inFlight: null,
      sizeBytes: 1000
    });
  }
  cache.set('fresh', { value: { html: 'fresh' }, expiresAt: now + 60000, inFlight: null, sizeBytes: 5 });
  cache.set('pending', { value: null, expiresAt: 0, inFlight: Promise.resolve(), sizeBytes: 0 });

  const removed = __browserRenderer.sweepExpiredRenderCache(now, grace);
  assert.ok(removed >= 1);
  assert.equal(cache.has('fresh'), true);
  assert.equal(cache.has('pending'), true);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());

  cache.delete('fresh');
  assert.equal(cache.has('fresh'), false);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());
});

test('queue continues after render error or timeout', async () => {
  __browserRenderer.renderImplementation = async (url) => {
    if (url.endsWith('/bad')) throw new Error('timeout-like failure');
    return makeResult(url, 'after-error');
  };

  await assert.rejects(renderSportsbookPage('https://example.com/bad', { cacheSeconds: 100 }), /timeout-like failure/);
  const result = await renderSportsbookPage('https://example.com/good', { cacheSeconds: 100 });
  assert.equal(result.html, 'after-error');
  assert.equal(__browserRenderer.queuePendingCount, 0);
});

test('backpressure rejects when pending queue is full', async () => {
  const original = __browserRenderer.renderImplementation;
  __browserRenderer.renderImplementation = async (url) => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return makeResult(url, 'queued');
  };

  const accepted = [];
  for (let index = 0; index < MAX_PENDING; index += 1) {
    accepted.push(renderSportsbookPage(`https://example.com/queue/${index}`, { cacheSeconds: 100 }));
  }
  await assert.rejects(
    () => renderSportsbookPage('https://example.com/queue/overflow', { cacheSeconds: 100 }),
    /Render queue is full/
  );
  const results = await Promise.all(accepted);
  assert.equal(results.length, MAX_PENDING);
  assert.equal(__browserRenderer.queuePendingCount, 0);
  __browserRenderer.renderImplementation = original;
});

test('byte counter remains accurate after eviction and completion', async () => {
  const big = 'y'.repeat(1024 * 1024);
  __browserRenderer.renderImplementation = async (url) => makeResult(url, big);
  for (let index = 0; index < 20; index += 1) {
    await renderSportsbookPage(`https://example.com/byte/${index}`, { cacheSeconds: 100 });
  }
  assert.ok(__browserRenderer.renderCacheTotalBytes <= MAX_BYTES);
  assert.equal(__browserRenderer.renderCacheTotalBytes, totalBytes());
  for (const entry of cache.values()) {
    assert.ok(Number(entry.sizeBytes) >= 0);
  }
});
