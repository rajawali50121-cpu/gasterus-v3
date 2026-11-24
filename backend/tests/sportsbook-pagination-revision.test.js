import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFeedRevision, paginateEvents, readFeedRevision } from '../src/sportsbook-feed-revisions.js';

const NOW = Date.UTC(2026, 10, 2);
const revision = value => String(value).repeat(32);
const feed = (id, rev, fetchedAt) => ({ revision: revision(rev), fetchedAt, events: [{ id }] });

test('pagination appends the next 30 events from the same immutable revision', () => {
  const events = Array.from({ length: 75 }, (_, index) => ({ id: `event-${index}` }));
  const first = paginateEvents(events, { offset: 0, limit: 30 });
  const second = paginateEvents(events, { offset: 30, limit: 30 });
  const displayed = [...first.events, ...second.events];

  assert.equal(first.events[0].id, 'event-0');
  assert.equal(second.events[0].id, 'event-30');
  assert.equal(displayed.length, 60);
  assert.equal(new Set(displayed.map(item => item.id)).size, 60);
  assert.deepEqual(displayed, events.slice(0, 60));
});

test('batch two remains on revision A when the latest catalog changes to revision B', () => {
  const maxAgeMs = 180_000;
  const revisionA = { ...feed('revision-a', 'a', NOW), events: Array.from({ length: 75 }, (_, index) => ({ id: `a-${index}` })) };
  let cache = appendFeedRevision(null, revisionA, { now: NOW, maxAgeMs });
  const firstPage = paginateEvents(readFeedRevision(cache, revision('a'), { now: NOW, maxAgeMs }).events, { offset: 0, limit: 30 });

  cache = appendFeedRevision(cache, { ...feed('revision-b', 'b', NOW + 1000), events: Array.from({ length: 75 }, (_, index) => ({ id: `b-${index}` })) }, {
    now: NOW + 1000,
    maxAgeMs
  });
  const pinnedSnapshot = readFeedRevision(cache, revision('a'), { now: NOW + 1000, maxAgeMs });
  const secondPage = paginateEvents(pinnedSnapshot.events, { offset: 30, limit: 30 });
  const displayed = [...firstPage.events, ...secondPage.events];

  assert.equal(firstPage.events[0].id, 'a-0');
  assert.equal(secondPage.events[0].id, 'a-30');
  assert.equal(displayed.length, 60);
  assert.equal(new Set(displayed.map(item => item.id)).size, 60);
  assert.deepEqual(displayed, revisionA.events.slice(0, 60));
});

test('revision cache serves the prior catalog after refresh and expires revisions explicitly', () => {
  const maxAgeMs = 180_000;
  const first = feed('old-first-event', 'a', NOW);
  let cache = appendFeedRevision(null, first, { now: NOW, maxAgeMs });
  const refreshed = feed('new-first-event', 'b', NOW + 60_000);
  cache = appendFeedRevision(cache, refreshed, { now: NOW + 60_000, maxAgeMs });

  assert.equal(readFeedRevision(cache, revision('a'), { now: NOW + 60_000, maxAgeMs }).events[0].id, 'old-first-event');
  assert.equal(readFeedRevision(cache, revision('b'), { now: NOW + 60_000, maxAgeMs }).events[0].id, 'new-first-event');
  assert.equal(readFeedRevision(cache, revision('a'), { now: NOW + 181_000, maxAgeMs }), null);
  assert.equal(readFeedRevision(cache, 'invalid', { now: NOW + 60_000, maxAgeMs }), null);
});

test('revision cache retains only the current and immediately previous catalog', () => {
  const maxAgeMs = 180_000;
  let cache = appendFeedRevision(null, feed('one', 'a', NOW), { now: NOW, maxAgeMs });
  cache = appendFeedRevision(cache, feed('two', 'b', NOW + 1), { now: NOW + 1, maxAgeMs });
  cache = appendFeedRevision(cache, feed('three', 'c', NOW + 2), { now: NOW + 2, maxAgeMs });

  assert.equal(readFeedRevision(cache, revision('a'), { now: NOW + 2, maxAgeMs }), null);
  assert.equal(readFeedRevision(cache, revision('b'), { now: NOW + 2, maxAgeMs }).events[0].id, 'two');
});