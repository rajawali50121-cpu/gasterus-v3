import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { buildSportsbookRenderSnapshot } = await import('../src/sportsbook-render-worker-core.js');

function event(id, overrides = {}) {
  return {
    id,
    provider: 'sportradar',
    sport: 'Soccer',
    league: 'Premier League',
    country: null,
    startTime: '2026-11-21T12:00:00.000Z',
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Home FC', score: null, logo: null },
    away: { name: 'Away FC', score: null, logo: null },
    markets: [],
    _refs: { sportradar: id },
    _sources: ['sportradar'],
    ...overrides
  };
}

function providerResult(events) {
  return { provider: 'sportradar', enabled: true, transportOk: true, errors: [], events };
}

test('worker quarantines one malformed event and reports exact field-level diagnostics', async () => {
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => providerResult([
      event('sr:sport_event:100'),
      event('sr:sport_event:101', { country: 42 })
    ])
  });
  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.providerResults[0].events.length, 1);
  assert.equal(snapshot.diagnostics.invalidEventCount, 1);
  assert.deepEqual(snapshot.diagnostics.invalidEvents[0], {
    id: 'sr:sport_event:101',
    problems: ['event.country']
  });
});

test('worker rejects a snapshot when malformed events exceed the quarantine threshold', async () => {
  const events = Array.from({ length: 100 }, (_, index) => event(
    'sr:sport_event:' + (1000 + index),
    index < 3 ? { country: 42 } : {}
  ));
  await assert.rejects(
    buildSportsbookRenderSnapshot({ fetchSportradar: async () => providerResult(events) }),
    /invalid-event count exceeded safety threshold/
  );
});

test('worker rejects a snapshot when no event passes structural validation', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({ fetchSportradar: async () => providerResult([
      event('sr:sport_event:999', { country: 42 })
    ]) }),
    /No Sportradar events passed structural validation/
  );
});
