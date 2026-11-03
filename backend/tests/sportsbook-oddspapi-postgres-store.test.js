import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

Object.assign(process.env, {
  NODE_ENV: 'test',
  ODDSPAPI_ENABLED: 'false',
  SPORTSBOOK_RENDER_WORKER: 'true',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64')
});
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const [{ config }, { createPostgresOddsPapiStore }, { assertSportsbookWorkerStorage, sportsbookWorkerStorageAvailable }, { fetchOddsPapi, createOddsPapiState }] = await Promise.all([
  import('../src/config.js'),
  import('../src/sportsbook-oddspapi-store.js'),
  import('../src/sportsbook-render-worker-runtime.js'),
  import('../src/sportsbook-oddspapi.js')
]);

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

test('provider-only worker boots without quota storage while keeping quota requests fail-closed', () => {
  assert.equal(config.databaseUrl, '');
  assert.equal(config.redisUrl, '');
  assert.equal(sportsbookWorkerStorageAvailable({}), false);
});

function createMemoryPostgres() {
  let state = { periods: new Map(), reservations: new Map() };
  let tail = Promise.resolve();
  let failMonthlyUpdate = false;

  function cloneState(source) {
    return {
      periods: new Map([...source.periods].map(([key, value]) => [key, { ...value }])),
      reservations: new Map(source.reservations)
    };
  }

  async function execute(target, sql, values) {
    const normalizedSql = sql.replace(/\s+/g, ' ');
    if (normalizedSql.includes('INSERT INTO sportsbook_provider_quota_reservations')) {
      const [provider, reservationId, day, month] = values;
      const key = `${provider}:${reservationId}`;
      if (target.reservations.has(key)) return { rowCount: 0, rows: [] };
      target.reservations.set(key, { day, month });
      return { rowCount: 1, rows: [{ reservation_id: reservationId }] };
    }

    if (normalizedSql.includes('INSERT INTO sportsbook_provider_quota_periods')) {
      const [provider, day, month] = values;
      for (const [type, start] of [['day', day], ['month', month]]) {
        const key = `${provider}:${type}:${start}`;
        if (!target.periods.has(key)) target.periods.set(key, { provider, period_type: type, period_start: start, request_count: 0 });
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalizedSql.includes('UPDATE sportsbook_provider_quota_periods')) {
      const periodType = normalizedSql.includes("period_type = 'day'") ? 'day' : 'month';
      if (periodType === 'month' && failMonthlyUpdate) {
        failMonthlyUpdate = false;
        throw new Error('injected monthly update failure');
      }
      const [provider, start, limit] = values;
      const row = target.periods.get(`${provider}:${periodType}:${start}`);
      if (!row || row.request_count >= limit) return { rowCount: 0, rows: [] };
      row.request_count += 1;
      return { rowCount: 1, rows: [{ request_count: row.request_count }] };
    }

    if (normalizedSql.includes('SELECT period_type, request_count')
      && normalizedSql.includes('FROM sportsbook_provider_quota_periods')) {
      const [provider, day, month] = values;
      const rows = [...target.periods.values()]
        .filter(row => row.provider === provider
          && ((row.period_type === 'day' && row.period_start === day)
            || (row.period_type === 'month' && row.period_start === month)))
        .map(row => ({ period_type: row.period_type, request_count: row.request_count }));
      return { rowCount: rows.length, rows };
    }
    throw new Error('Unexpected SQL in fake PostgreSQL');
  }

  return {
    async withTransaction(operation) {
      const run = tail.then(async () => {
        const draft = cloneState(state);
        const client = { query: (sql, values = []) => execute(draft, sql, values) };
        const result = await operation(client);
        state = draft;
        return result;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    async query(sql, values = []) {
      return execute(state, sql, values);
    },
    failNextMonthlyUpdate() {
      failMonthlyUpdate = true;
    },
    snapshot() {
      return cloneState(state);
    }
  };
}

function createMemoryRedis() {
  const caches = new Map();
  const locks = new Map();
  let retryAt = 0;
  let nextSlot = 0;
  return {
    async checkBackoff(now) {
      return retryAt > now;
    },
    async setBackoff(until) {
      retryAt = Math.max(retryAt, until);
    },
    async reserveCooldown({ now, cooldownMs }) {
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + cooldownMs;
      return { status: 'reserved', waitMs: slot - now };
    },
    async getCache(key) {
      return caches.get(key) ?? null;
    },
    async setCache(key, value) {
      caches.set(key, value);
    },
    async withCacheLock(key, operation) {
      if (locks.has(key)) return { cacheLockHit: true, value: caches.get(key) };
      locks.set(key, true);
      try {
        return await operation();
      } finally {
        locks.delete(key);
      }
    },
    evictVolatileState() {
      caches.clear();
      locks.clear();
      retryAt = 0;
      nextSlot = 0;
    }
  };
}

function createStore(db, redis = createMemoryRedis(), options = {}) {
  return createPostgresOddsPapiStore({
    withTransaction: db.withTransaction,
    query: db.query,
    cacheStore: redis,
    ...options
  });
}

test('PostgreSQL transactions atomically cap concurrent daily reservations across stores', async () => {
  const db = createMemoryPostgres();
  const stores = Array.from({ length: 4 }, () => createStore(db));
  const reservations = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    stores[index % stores.length].reserveRequest({
      now: NOW,
      dailyLimit: 8,
      monthlyLimit: 240,
      cooldownMs: 1000,
      reservationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    })
  ));
  assert.equal(reservations.filter(item => item.status === 'reserved').length, 8);
  assert.equal(reservations.filter(item => item.status === 'exhausted').length, 16);
  assert.deepEqual(await stores[0].getRequestCounts(NOW), {
    requestsToday: 8,
    requestsThisMonth: 8
  });
});

test('provider quota store supports a separately bounded API-Sports free allowance', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db, createMemoryRedis(), {
    providerCode: 'api-sports',
    maxDailyLimit: 100,
    maxMonthlyLimit: 3100
  });
  const reservations = await Promise.all(Array.from({ length: 110 }, (_, index) =>
    store.reserveRequest({
      now: NOW,
      dailyLimit: 100,
      monthlyLimit: 3100,
      cooldownMs: 0,
      reservationId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    })
  ));

  assert.equal(reservations.filter(item => item.status === 'reserved').length, 100);
  assert.equal(reservations.filter(item => item.status === 'exhausted').length, 10);
  assert.deepEqual(await store.getRequestCounts(NOW), {
    requestsToday: 100,
    requestsThisMonth: 100
  });
});

test('store enforces absolute daily and monthly limits even if a caller supplies larger values', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db);
  await assert.rejects(store.reserveRequest({
    now: NOW,
    dailyLimit: 9,
    monthlyLimit: 240,
    cooldownMs: 1000
  }), /daily quota limit exceeds/);
  await assert.rejects(store.reserveRequest({
    now: NOW,
    dailyLimit: 8,
    monthlyLimit: 241,
    cooldownMs: 1000
  }), /monthly quota limit exceeds/);
  assert.equal(db.snapshot().reservations.size, 0);
});

test('monthly cap rollback leaves the daily counter unchanged when exhausted', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db);
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await store.reserveRequest({
      now: NOW,
      dailyLimit: 8,
      monthlyLimit: 2,
      cooldownMs: 1000,
      reservationId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    })).status, 'reserved');
  }
  assert.equal((await store.reserveRequest({
    now: NOW,
    dailyLimit: 8,
    monthlyLimit: 2,
    cooldownMs: 1000,
    reservationId: '10000000-0000-4000-8000-000000000003'
  })).status, 'exhausted');
  assert.deepEqual(await store.getRequestCounts(NOW), { requestsToday: 2, requestsThisMonth: 2 });
  assert.equal(db.snapshot().reservations.size, 2);
});

test('reservation IDs are idempotent and a retry with a new ID is counted conservatively', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db);
  const request = {
    now: NOW,
    dailyLimit: 8,
    monthlyLimit: 240,
    cooldownMs: 1000,
    reservationId: '20000000-0000-4000-8000-000000000001'
  };
  assert.equal((await store.reserveRequest(request)).status, 'reserved');
  assert.equal((await store.reserveRequest(request)).status, 'duplicate');
  assert.equal((await store.reserveRequest({ ...request, reservationId: '20000000-0000-4000-8000-000000000002' })).status, 'reserved');
  assert.deepEqual(await store.getRequestCounts(NOW), { requestsToday: 2, requestsThisMonth: 2 });
});

test('UTC day and month rollover use separate durable period rows without reset gaps', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db);
  const beforeMidnight = Date.UTC(2026, 10, 3, 23, 59, 59);
  const afterMidnight = Date.UTC(2026, 10, 4, 0, 0, 1);
  const beforeMonth = Date.UTC(2026, 10, 30, 23, 59, 59);
  const afterMonth = Date.UTC(2026, 11, 1, 0, 0, 1);
  const reserve = (now, id) => store.reserveRequest({
    now, dailyLimit: 8, monthlyLimit: 240, cooldownMs: 0, reservationId: id
  });
  await reserve(beforeMidnight, '30000000-0000-4000-8000-000000000001');
  assert.deepEqual(await store.getRequestCounts(afterMidnight), { requestsToday: 0, requestsThisMonth: 1 });
  await reserve(afterMidnight, '30000000-0000-4000-8000-000000000002');
  await reserve(beforeMonth, '30000000-0000-4000-8000-000000000003');
  assert.deepEqual(await store.getRequestCounts(afterMonth), { requestsToday: 0, requestsThisMonth: 0 });
  await reserve(afterMonth, '30000000-0000-4000-8000-000000000004');
  assert.deepEqual(await store.getRequestCounts(afterMonth), { requestsToday: 1, requestsThisMonth: 1 });
});

test('a process restart after reservation preserves counters and Redis eviction cannot reset quota', async () => {
  const db = createMemoryPostgres();
  const redis = createMemoryRedis();
  const firstProcessStore = createStore(db, redis);
  await firstProcessStore.reserveRequest({
    now: NOW,
    dailyLimit: 8,
    monthlyLimit: 240,
    cooldownMs: 1000,
    reservationId: '40000000-0000-4000-8000-000000000001'
  });
  redis.evictVolatileState();
  const restartedStore = createStore(db, redis);
  assert.deepEqual(await restartedStore.getRequestCounts(NOW), { requestsToday: 1, requestsThisMonth: 1 });
  assert.equal((await restartedStore.reserveRequest({
    now: NOW,
    dailyLimit: 8,
    monthlyLimit: 240,
    cooldownMs: 1000,
    reservationId: '40000000-0000-4000-8000-000000000002'
  })).status, 'reserved');
  assert.deepEqual(await restartedStore.getRequestCounts(NOW), { requestsToday: 2, requestsThisMonth: 2 });
});

test('PostgreSQL failure and transaction rollback fail closed without Redis quota fallback', async () => {
  const redis = createMemoryRedis();
  const unavailable = createPostgresOddsPapiStore({
    withTransaction: async () => { throw new Error('database unavailable'); },
    query: async () => { throw new Error('database unavailable'); },
    cacheStore: redis
  });
  await assert.rejects(unavailable.reserveRequest({
    now: NOW, dailyLimit: 8, monthlyLimit: 240, cooldownMs: 1000,
    reservationId: '50000000-0000-4000-8000-000000000001'
  }), /database unavailable/);

  const db = createMemoryPostgres();
  const store = createStore(db);
  db.failNextMonthlyUpdate();
  await assert.rejects(store.reserveRequest({
    now: NOW, dailyLimit: 8, monthlyLimit: 240, cooldownMs: 1000,
    reservationId: '50000000-0000-4000-8000-000000000002'
  }), /injected monthly update failure/);
  assert.deepEqual(await store.getRequestCounts(NOW), { requestsToday: 0, requestsThisMonth: 0 });
  assert.equal(db.snapshot().reservations.size, 0);
});

test('Redis outage prevents request processing before quota reservation', async () => {
  const db = createMemoryPostgres();
  const cacheStore = createMemoryRedis();
  cacheStore.checkBackoff = async () => { throw new Error('Redis unavailable'); };
  const store = createStore(db, cacheStore);
  await assert.rejects(store.reserveRequest({
    now: NOW, dailyLimit: 8, monthlyLimit: 240, cooldownMs: 1000,
    reservationId: '60000000-0000-4000-8000-000000000001'
  }), /Redis unavailable/);
  assert.deepEqual(await createStore(db).getRequestCounts(NOW), { requestsToday: 0, requestsThisMonth: 0 });
});

test('PostgreSQL outage never sends a provider request', async () => {
  const cacheStore = createMemoryRedis();
  const store = createPostgresOddsPapiStore({
    withTransaction: async () => { throw new Error('database unavailable'); },
    query: async () => { throw new Error('database unavailable'); },
    cacheStore
  });
  let providerCalls = 0;
  await assert.rejects(fetchOddsPapi({
    settings: {
      oddsPapiEnabled: true,
      oddsPapiKey: 'fixture-only-key',
      oddsPapiBaseUrl: 'https://api.oddspapi.io',
      oddsPapiTournamentIds: '17',
      oddsPapiBookmaker: 'pinnacle',
      oddsPapiRefreshSeconds: 28800,
      oddsPapiCatalogRefreshSeconds: 604800,
      oddsPapiDailyRequestBudget: 8,
      oddsPapiMonthlyRequestBudget: 240,
      sportsbookMaxPrematchPriceAgeSeconds: 900
    },
    state: createOddsPapiState({ store }),
    now: NOW,
    sleepImpl: async () => {},
    fetchImpl: async () => { providerCalls += 1; throw new Error('provider must not be called'); }
  }), /database unavailable/);
  assert.equal(providerCalls, 0);
});

test('every provider retry attempt gets its own durable PostgreSQL reservation', async () => {
  const db = createMemoryPostgres();
  const store = createStore(db);
  let providerCalls = 0;
  await assert.rejects(fetchOddsPapi({
    settings: {
      oddsPapiEnabled: true,
      oddsPapiKey: 'fixture-only-key',
      oddsPapiBaseUrl: 'https://api.oddspapi.io',
      oddsPapiTournamentIds: '17',
      oddsPapiBookmaker: 'pinnacle',
      oddsPapiRefreshSeconds: 28800,
      oddsPapiCatalogRefreshSeconds: 604800,
      oddsPapiDailyRequestBudget: 8,
      oddsPapiMonthlyRequestBudget: 240,
      sportsbookMaxPrematchPriceAgeSeconds: 900
    },
    state: createOddsPapiState({ store }),
    now: NOW,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error('mock network failure');
    }
  }), /network request failed/);
  assert.equal(providerCalls, 2);
  assert.deepEqual(await store.getRequestCounts(NOW), { requestsToday: 2, requestsThisMonth: 2 });
});

test('worker storage configuration fails explicitly when PostgreSQL or Redis URL is absent', () => {
  assert.equal(config.oddsPapiEnabled, false);
  assert.equal(config.oddsPapiDailyRequestBudget, 8);
  assert.equal(config.oddsPapiMonthlyRequestBudget, 240);
  assert.throws(() => assertSportsbookWorkerStorage({ DATABASE_URL: 'present' }), /REDIS_URL is required/);
  assert.throws(() => assertSportsbookWorkerStorage({ REDIS_URL: 'present' }), /DATABASE_URL is required/);
  assert.doesNotThrow(() => assertSportsbookWorkerStorage({ DATABASE_URL: 'present', REDIS_URL: 'present' }));
  assert.throws(() => createOddsPapiState(), /explicit OddsPapi state store is required/);
});

test('quota migration stores durable counters and idempotent reservations without TTL', async () => {
  const migration = await readFile(new URL('../migrations/041_oddspapi_postgres_quota.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sportsbook_provider_quota_periods/);
  assert.match(migration, /PRIMARY KEY \(provider, period_type, period_start\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sportsbook_provider_quota_reservations/);
  assert.match(migration, /PRIMARY KEY \(provider, reservation_id\)/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM|EXPIRE/i);
});
