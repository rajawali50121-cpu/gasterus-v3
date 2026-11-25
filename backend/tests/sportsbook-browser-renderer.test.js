import assert from 'node:assert/strict';
import test from 'node:test';
import { browserBinaryAvailable, renderSportsbookPage, __browserRenderer } from '../src/sportsbook-browser-renderer.js';

test('render cache sweep drops only expired entries and never touches in-flight renders', () => {
  const cache = __browserRenderer.renderCache;
  const grace = __browserRenderer.RENDER_CACHE_SWEEP_GRACE_MS;
  const now = Date.now();
  cache.clear();
  // sengaja melewati threshold supaya sweep benar-benar berjalan
  for (let i = 0; i < __browserRenderer.RENDER_CACHE_SWEEP_THRESHOLD; i++) {
    cache.set(`stale-${i}`, { value: { html: 'x' }, expiresAt: now - grace - 1_000, inFlight: null });
  }
  cache.set('fresh', { value: { html: 'x' }, expiresAt: now + 60_000, inFlight: null });
  cache.set('pending', { value: null, expiresAt: 0, inFlight: Promise.resolve() });
  const removed = __browserRenderer.sweepExpiredRenderCache(now, grace);
  assert.ok(removed >= 1, 'sweep must remove expired entries');
  assert.equal(cache.has('fresh'), true, 'live entry must survive');
  assert.equal(cache.has('pending'), true, 'in-flight render must never be swept');
  assert.equal(cache.size, 2);
  cache.clear();
});

test('render cache sweep stays a no-op below the sweep threshold', () => {
  const cache = __browserRenderer.renderCache;
  const now = Date.now();
  cache.clear();
  cache.set('a', { value: { html: 'x' }, expiresAt: now - 10 * 60_000, inFlight: null });
  assert.equal(__browserRenderer.sweepExpiredRenderCache(now, 0), 0);
  assert.equal(cache.has('a'), true, 'sweep must not run below threshold');
  cache.clear();
});

test('browser renderer captures client-hydrated odds DOM', { timeout: 90000, concurrency: false }, async () => {
  if (!(await browserBinaryAvailable())) return;
  const fixtureHtml = `<!doctype html><html><body><div id="catalog">Sepak Bola</div><div id="app"></div><script>
    setTimeout(() => {
      document.getElementById('app').innerHTML = '<a id="bu:od:go:ev:12345" class="IconMarkets">7</a><a class="OddsTabL"><span class="OddsR">1.95</span></a>';
    }, 120);
  </script></body></html>`;
  const result = await renderSportsbookPage('about:blank#gasterus-browser-fixture', {
    executable: process.env.SPORTS_SOURCE_BROWSER_EXECUTABLE || '',
    timeoutMs: 30000,
    settleMs: 5000,
    cacheSeconds: 1,
    maxBytes: 2 * 1024 * 1024,
    fixtureHtml
  });
  assert.match(result.html, /bu:od:go:ev:12345/);
  assert.match(result.html, /OddsTabL/);
  assert.equal(result.markerReady, true);
  assert.equal(result.renderer, 'CHROMIUM_CDP');
});

test('browser renderer safely restarts after previous Chromium DevTools port becomes stale', { timeout: 120000, concurrency: false }, async () => {
  if (!(await browserBinaryAvailable())) return;
  const fixtureHtml = `<!doctype html><html><body><div id="app"><a id="bu:od:go:ev:67890" class="IconMarkets">3</a><a class="OddsTabR"><span class="OddsR">2.05</span></a></div></body></html>`;

  const first = await renderSportsbookPage('about:blank#gasterus-browser-restart-a', {
    executable: process.env.SPORTS_SOURCE_BROWSER_EXECUTABLE || '',
    timeoutMs: 30000,
    settleMs: 1500,
    cacheSeconds: 1,
    maxBytes: 2 * 1024 * 1024,
    fixtureHtml
  });
  assert.equal(first.markerReady, true);

  const second = await renderSportsbookPage('about:blank#gasterus-browser-restart-b', {
    executable: process.env.SPORTS_SOURCE_BROWSER_EXECUTABLE || '',
    timeoutMs: 30000,
    settleMs: 1500,
    cacheSeconds: 1,
    maxBytes: 2 * 1024 * 1024,
    fixtureHtml
  });
  assert.match(second.html, /bu:od:go:ev:67890/);
  assert.equal(second.markerReady, true);
  assert.equal(second.renderer, 'CHROMIUM_CDP');
});
