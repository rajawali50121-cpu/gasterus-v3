import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  connectionState,
  filterVisibleEvents,
  mergeEventsAtOffset,
  nextPageOffset,
  normalizeSnapshot,
  renderItemsSafely,
  shouldApplySnapshot
} from '../../frontend/js/sportsbook-feed-state.js';

function event(id, extra = {}) {
  return { id, league: 'League', home: { name: `Home ${id}` }, away: { name: `Away ${id}` }, markets: [], ...extra };
}

function snapshot(events, fetchedAt, feedRevision) {
  return { events, source: { fetchedAt, feedRevision }, pagination: { offset: 0, limit: events.length, total: events.length, hasMore: false } };
}

test('REST snapshot remains visibly available while SSE is failing or reconnecting', () => {
  assert.equal(connectionState(false, false), 'connecting');
  assert.equal(connectionState(false, true), 'connecting');
  assert.equal(connectionState(true, false), 'snapshot');
  assert.equal(connectionState(true, true), 'online');
  assert.equal(connectionState(true, true, 'OFFLINE'), 'offline');
});

test('a late REST revision cannot replace a newer SSE snapshot', () => {
  const current = snapshot([event('new')], '2026-11-02T10:01:00.000Z', 'revision-new');
  const late = snapshot([event('old')], '2026-11-02T10:00:00.000Z', 'revision-old');
  assert.equal(shouldApplySnapshot(current, late), false);
  assert.equal(shouldApplySnapshot(current, snapshot([event('tie')], '2026-11-02T10:01:00.000Z', 'revision-tie')), false);
  assert.equal(shouldApplySnapshot(current, snapshot([event('newer')], '2026-11-02T10:02:00.000Z', 'revision-newer')), true);
});

test('pagination keeps the loaded page offset for SSE and advances requests by one page', () => {
  const pageSize = 30;
  const currentPageOffset = 0;
  const nextRequestOffset = nextPageOffset(currentPageOffset, pageSize);
  assert.equal(nextRequestOffset, 30);
  assert.equal(nextRequestOffset, currentPageOffset + pageSize);
  const loadedPageOffset = nextRequestOffset;
  assert.equal(loadedPageOffset, 30);
  assert.equal(nextPageOffset(loadedPageOffset, pageSize), 60);
});

test('page replacement and append preserve ordering without duplicate event IDs', () => {
  const firstPage = [event('a'), event('b')];
  const appended = mergeEventsAtOffset(firstPage, [event('b'), event('c')], 1);
  assert.deepEqual(appended.map(item => item.id), ['a', 'b', 'c']);

  const updatedPage = mergeEventsAtOffset([event('a'), event('b'), event('c'), event('d')], [event('b', { home: { name: 'Updated B' } }), event('c', { home: { name: 'Updated C' } })], 1);
  assert.deepEqual(updatedPage.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(mergeEventsAtOffset(firstPage, [event('gap')], 3), null);

  const loadedPages = Array.from({ length: 60 }, (_, index) => event(`e${index}`));
  const lateBootstrap = Array.from({ length: 30 }, (_, index) => event(`e${index}`, { home: { name: `Updated ${index}` } }));
  const preserved = mergeEventsAtOffset(loadedPages, lateBootstrap, 0, { preserveTail: true });
  assert.equal(preserved.length, 60);
  assert.equal(preserved[0].home.name, 'Updated 0');
  assert.equal(preserved[59].id, 'e59');
});

test('all filter retains every valid event regardless of date or market status', () => {
  const events = [event('scheduled'), event('live', { live: true }), event('unpriced', { markets: [] }), null];
  assert.deepEqual(filterVisibleEvents(events).map(item => item.id), ['scheduled', 'live', 'unpriced']);
});

test('malformed markets and selections do not remove their valid event card', () => {
  const normalized = normalizeSnapshot(snapshot([
    event('kept', { markets: [null, 'bad', { id: 'm1', selections: [null, { key: 'home', odds: '2.1' }] }] })
  ], '2026-11-02T10:00:00.000Z', 'revision'));
  assert.equal(normalized.events.length, 1);
  assert.equal(normalized.events[0].markets.length, 1);
  assert.deepEqual(normalized.events[0].markets[0].selections.map(item => item.key), ['home']);
  assert.equal(normalizeSnapshot(snapshot([null, { markets: [] }], '2026-11-02T10:00:00.000Z', 'bad')), null);
});

test('one render exception produces a fallback without discarding other event cards', () => {
  const errors = [];
  const html = renderItemsSafely(
    [event('a'), event('bad'), event('c')],
    item => { if (item.id === 'bad') throw new Error('malformed market'); return `<article>${item.id}</article>`; },
    item => `<article>${item.id}:unavailable</article>`,
    (error, item) => errors.push(`${item.id}:${error.message}`)
  );
  assert.equal(html, '<article>a</article><article>bad:unavailable</article><article>c</article>');
  assert.deepEqual(errors, ['bad:malformed market']);
});

test('frontend wires snapshot status, ready handshake, revision guard, and safe event rendering', () => {
  const source = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!streamActive\) setStatus\(connectionState\(hasFeedSnapshot, streamActive, feed\.source\?\.status\)\)/);
  assert.match(source, /event === 'ready'[\s\S]*streamActive = true;[\s\S]*connectionState\(hasFeedSnapshot, streamActive, feed\.source\?\.status\)/);
  assert.match(source, /if \(generation !== feedViewGeneration\) return false;[\s\S]*shouldApplySnapshot\(feed, snapshot\)/);
  assert.match(source, /currentOffset = nextPageOffset\(currentOffset, pageSize\);\s*restartStreamAtCurrentPage\(\)/);
  assert.match(source, /offset: String\(currentOffset\)/);
  assert.doesNotMatch(source, /streamOffset/);
  const reconnect = source.slice(source.indexOf('async function connectStream'), source.indexOf('function handleFrame'));
  assert.match(reconnect, /await loadRestSnapshot\(\)/);
  assert.doesNotMatch(reconnect, /feed\.events\s*=\s*\[\]/);
  assert.match(source, /renderItemsSafely\([\s\S]*renderMatchFallback/);
  assert.match(source, /if \(!eventsEl\?\.innerHTML\) setEmpty/);
});