import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://example.com/gasterus-test',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64')
});

const { persistSportsbookEventStates } = await import('../src/sportsbook-event-state.js');

test('event state projection persists normalized scores, lifecycle and provider provenance in one upsert', async () => {
  let statement;
  let values;
  const result = await persistSportsbookEventStates([
    {
      id: 'fixture-1',
      sport: 'Football',
      league: 'Premier League',
      startTime: '2026-10-22T05:00:00.000Z',
      status: 'FINISHED',
      providerStatus: 'FT',
      live: false,
      home: { name: 'Alpha', score: 2 },
      away: { name: 'Beta', score: 0 },
      periodScores: { '1H': { home: 1, away: 0 } },
      _sources: ['sportmonks'],
      _refs: { sportmonks: 'provider-1' }
    },
    { id: 'invalid', status: 'UNKNOWN' }
  ], {
    feedRevision: 'feed-1',
    observedAt: '2026-10-22T06:00:00.000Z',
    queryImpl: async (sql, params) => {
      statement = sql;
      values = params;
      return { rowCount: 1 };
    }
  });

  assert.equal(result.rowCount, 1);
  assert.match(statement, /INSERT INTO sportsbook_event_states/);
  assert.match(statement, /ON CONFLICT \(event_id\) DO UPDATE/);
  assert.match(statement, /IS DISTINCT FROM/);
  assert.equal(values.length, 15);
  assert.equal(values[0], 'fixture-1');
  assert.equal(values[4], 'FINISHED');
  assert.equal(values[9], 2);
  assert.equal(values[10], 0);
  assert.deepEqual(JSON.parse(values[11]), { '1H': { home: 1, away: 0 } });
  assert.deepEqual(JSON.parse(values[12]), {
    sources: ['sportmonks'],
    refs: { sportmonks: 'provider-1' }
  });
  assert.equal(values[13], 'feed-1');
});

test('event state projection skips empty snapshots and preserves unknown scores as null', async () => {
  let calls = 0;
  const queryImpl = async (_sql, values) => {
    calls += 1;
    assert.equal(values[9], null);
    assert.equal(values[10], null);
    return { rowCount: 1 };
  };
  assert.deepEqual(await persistSportsbookEventStates([], { queryImpl }), { rowCount: 0 });
  await persistSportsbookEventStates([{
    id: 'upcoming-1',
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Alpha', score: null },
    away: { name: 'Beta', score: undefined }
  }], { queryImpl });
  assert.equal(calls, 1);
});

test('successful feed refresh wires PostgreSQL status projection before publishing its cache', () => {
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/044_sportsbook_event_states.sql', import.meta.url), 'utf8');
  const projectionCall = feed.indexOf('await persistSportsbookEventStates(nextFeed.events');
  const publishCall = feed.indexOf('await writeRedisCache(nextFeed, { alreadyBounded: true })');

  assert.ok(projectionCall >= 0);
  assert.ok(publishCall > projectionCall, 'event statuses persist before the new feed is published');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sportsbook_event_states/);
  for (const status of ['SCHEDULED', 'LIVE', 'FINISHED']) {
    assert.ok(migration.includes(`'${status}'`), `${status} status is stored in PostgreSQL`);
  }
});
