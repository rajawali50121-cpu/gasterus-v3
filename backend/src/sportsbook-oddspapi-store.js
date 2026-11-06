import { randomUUID } from 'node:crypto';

const RESERVE_COOLDOWN_SCRIPT = `
local now = tonumber(ARGV[1])
local cooldownMs = tonumber(ARGV[2])
local backoff = tonumber(redis.call('GET', KEYS[2]) or '0')
if backoff > now then
  return {0, backoff - now}
end
local lastSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, lastSlot)
redis.call('SET', KEYS[1], tostring(slot + cooldownMs), 'PX', math.max(cooldownMs * 10, 60000))
return {1, slot - now}
`;

const BACKOFF_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local target = tonumber(ARGV[1])
if target > current then
  redis.call('SET', KEYS[1], tostring(target), 'PX', math.max(target - tonumber(ARGV[2]), 1000))
end
return 1
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const CACHE_LOCK_TTL_MS = 120_000;
const CACHE_WAIT_MS = 250;
const CACHE_WAIT_ATTEMPTS = 480;
const CACHE_PREFIX = 'sportsbook:oddspapi:v2';
const PROVIDER = 'oddspapi';
const QUOTA_TABLE = 'sportsbook_provider_quota_periods';
const RESERVATION_TABLE = 'sportsbook_provider_quota_reservations';
const DAILY_REQUEST_LIMIT = 8;
const MONTHLY_REQUEST_LIMIT = 240;

class QuotaLimitError extends Error {}

function validateLimits(dailyLimit, monthlyLimit, {
  providerCode = PROVIDER,
  maxDailyLimit = DAILY_REQUEST_LIMIT,
  maxMonthlyLimit = MONTHLY_REQUEST_LIMIT
} = {}) {
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > maxDailyLimit) {
    throw new Error(`${providerCode} daily quota limit exceeds the approved maximum`);
  }
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > maxMonthlyLimit) {
    throw new Error(`${providerCode} monthly quota limit exceeds the approved maximum`);
  }
}

async function sharedRedis() {
  const { connectRedis, redis } = await import('./redis.js');
  await connectRedis();
  return redis;
}

async function sharedTransaction(operation) {
  const { tx } = await import('./db.js');
  return tx(operation);
}

async function sharedQuery(text, values) {
  const { query } = await import('./db.js');
  return query(text, values);
}

function utcPeriods(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('OddsPapi quota timestamp is invalid');
  const day = date.toISOString().slice(0, 10);
  return { day, month: `${day.slice(0, 7)}-01` };
}

async function countsFor(client, day, month) {
  const result = await client.query(
    `SELECT period_type, request_count
       FROM ${QUOTA_TABLE}
      WHERE provider = $1
        AND ((period_type = 'day' AND period_start = $2::date)
          OR (period_type = 'month' AND period_start = $3::date))`,
    [PROVIDER, day, month]
  );
  const counts = { requestsToday: 0, requestsThisMonth: 0 };
  for (const row of result.rows) {
    if (row.period_type === 'day') counts.requestsToday = Number(row.request_count);
    if (row.period_type === 'month') counts.requestsThisMonth = Number(row.request_count);
  }
  return counts;
}

export function createMemoryOddsPapiStore() {
  const daily = new Map();
  const monthly = new Map();
  const reservations = new Set();
  const caches = new Map();
  let nextSlot = 0;
  let retryAt = 0;

  return {
    async reserveRequest({ now, dailyLimit, monthlyLimit, cooldownMs, reservationId = randomUUID() }) {
      validateLimits(dailyLimit, monthlyLimit);
      const { day, month } = utcPeriods(now);
      const reservationKey = `${PROVIDER}:${reservationId}`;
      const dayCount = daily.get(day) || 0;
      const monthCount = monthly.get(month) || 0;
      if (reservations.has(reservationKey)) {
        return { status: 'duplicate', waitMs: 0, requestsToday: dayCount, requestsThisMonth: monthCount };
      }
      if (retryAt > now) {
        return { status: 'backoff', waitMs: retryAt - now, requestsToday: dayCount, requestsThisMonth: monthCount };
      }
      if (dayCount >= dailyLimit || monthCount >= monthlyLimit) {
        return { status: 'exhausted', waitMs: 0, requestsToday: dayCount, requestsThisMonth: monthCount };
      }
      const slot = Math.max(now, nextSlot);
      daily.set(day, dayCount + 1);
      monthly.set(month, monthCount + 1);
      reservations.add(reservationKey);
      nextSlot = slot + cooldownMs;
      return {
        status: 'reserved',
        waitMs: slot - now,
        requestsToday: dayCount + 1,
        requestsThisMonth: monthCount + 1
      };
    },
    async getRequestCounts(now) {
      const { day, month } = utcPeriods(now);
      return {
        requestsToday: daily.get(day) || 0,
        requestsThisMonth: monthly.get(month) || 0
      };
    },
    async setBackoff(until) {
      retryAt = Math.max(retryAt, until);
    },
    async checkBackoff(now) {
      return retryAt > now;
    },
    async getCache(key) {
      return caches.get(key) ?? null;
    },
    async setCache(key, value, ttlMs) {
      caches.set(key, value);
      return ttlMs;
    },
    async withCacheLock(key, operation) {
      return operation();
    }
  };
}

export function createRedisOddsPapiCacheStore({ getRedis = sharedRedis, prefix = CACHE_PREFIX } = {}) {
  async function getCache(key) {
    const client = await getRedis();
    const raw = await client.get(`${prefix}:cache:${key}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('OddsPapi shared cache contains invalid data');
    }
  }

  return {
    async reserveCooldown({ now, cooldownMs }) {
      const client = await getRedis();
      const result = await client.eval(RESERVE_COOLDOWN_SCRIPT, {
        keys: [`${prefix}:request-slot`, `${prefix}:backoff`],
        arguments: [String(now), String(cooldownMs)]
      });
      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('OddsPapi shared cooldown returned an invalid result');
      }
      const [code, waitMs] = result.map(Number);
      return { status: code === 1 ? 'reserved' : 'backoff', waitMs };
    },
    async setBackoff(until, now) {
      const client = await getRedis();
      await client.eval(BACKOFF_SCRIPT, {
        keys: [`${prefix}:backoff`],
        arguments: [String(until), String(now)]
      });
    },
    async checkBackoff(now) {
      const client = await getRedis();
      const retryAt = Number(await client.get(`${prefix}:backoff`)) || 0;
      return retryAt > now;
    },
    getCache,
    async setCache(key, value, ttlMs) {
      const client = await getRedis();
      await client.set(`${prefix}:cache:${key}`, JSON.stringify(value), {
        EX: Math.max(1, Math.ceil(ttlMs / 1000))
      });
    },
    async withCacheLock(key, operation) {
      const client = await getRedis();
      const lockKey = `${prefix}:cache-lock:${key}`;
      const token = randomUUID();
      for (let attempt = 0; attempt < CACHE_WAIT_ATTEMPTS; attempt += 1) {
        const acquired = await client.set(lockKey, token, { NX: true, PX: CACHE_LOCK_TTL_MS });
        if (acquired === 'OK') {
          try {
            return await operation();
          } finally {
            await client.eval(RELEASE_LOCK_SCRIPT, {
              keys: [lockKey],
              arguments: [token]
            });
          }
        }
        await new Promise(resolve => setTimeout(resolve, CACHE_WAIT_MS));
        const cached = await getCache(key);
        if (cached !== null) return { cacheLockHit: true, value: cached };
      }
      throw new Error('OddsPapi shared cache refresh is still in progress');
    }
  };
}

export function createPostgresOddsPapiStore({
  withTransaction = sharedTransaction,
  query = sharedQuery,
  cacheStore = createRedisOddsPapiCacheStore(),
  providerCode = PROVIDER,
  maxDailyLimit = DAILY_REQUEST_LIMIT,
  maxMonthlyLimit = MONTHLY_REQUEST_LIMIT
} = {}) {
  async function reserveQuota({ now, dailyLimit, monthlyLimit, reservationId }) {
    const { day, month } = utcPeriods(now);
    try {
      return await withTransaction(async client => {
        const insertedReservation = await client.query(
          `INSERT INTO ${RESERVATION_TABLE} (provider, reservation_id, day_start, month_start)
           VALUES ($1, $2::uuid, $3::date, $4::date)
           ON CONFLICT (provider, reservation_id) DO NOTHING
           RETURNING reservation_id`,
          [providerCode, reservationId, day, month]
        );
        if (!insertedReservation.rowCount) {
          const counts = await countsFor(client, day, month);
          return { status: 'duplicate', waitMs: 0, ...counts };
        }

        await client.query(
          `INSERT INTO ${QUOTA_TABLE} (provider, period_type, period_start, request_count)
           VALUES ($1, 'day', $2::date, 0), ($1, 'month', $3::date, 0)
           ON CONFLICT (provider, period_type, period_start) DO NOTHING`,
          [providerCode, day, month]
        );
        const daily = await client.query(
          `UPDATE ${QUOTA_TABLE}
              SET request_count = request_count + 1, updated_at = now()
            WHERE provider = $1 AND period_type = 'day' AND period_start = $2::date
              AND request_count < $3
            RETURNING request_count`,
          [providerCode, day, dailyLimit]
        );
        if (!daily.rowCount) throw new QuotaLimitError('daily');

        const monthly = await client.query(
          `UPDATE ${QUOTA_TABLE}
              SET request_count = request_count + 1, updated_at = now()
            WHERE provider = $1 AND period_type = 'month' AND period_start = $2::date
              AND request_count < $3
            RETURNING request_count`,
          [providerCode, month, monthlyLimit]
        );
        if (!monthly.rowCount) throw new QuotaLimitError('monthly');

        return {
          status: 'reserved',
          waitMs: 0,
          requestsToday: Number(daily.rows[0].request_count),
          requestsThisMonth: Number(monthly.rows[0].request_count)
        };
      });
    } catch (error) {
      if (error instanceof QuotaLimitError) {
        return { status: 'exhausted', waitMs: 0, ...(await getRequestCounts(now)) };
      }
      throw error;
    }
  }

  async function getRequestCounts(now) {
    const { day, month } = utcPeriods(now);
    const result = await query(
      `SELECT period_type, request_count
         FROM ${QUOTA_TABLE}
        WHERE provider = $1
          AND ((period_type = 'day' AND period_start = $2::date)
            OR (period_type = 'month' AND period_start = $3::date))`,
      [providerCode, day, month]
    );
    const counts = { requestsToday: 0, requestsThisMonth: 0 };
    for (const row of result.rows) {
      if (row.period_type === 'day') counts.requestsToday = Number(row.request_count);
      if (row.period_type === 'month') counts.requestsThisMonth = Number(row.request_count);
    }
    return counts;
  }

  return {
    async reserveRequest({ now, dailyLimit, monthlyLimit, cooldownMs, reservationId = randomUUID() }) {
      validateLimits(dailyLimit, monthlyLimit, { providerCode, maxDailyLimit, maxMonthlyLimit });
      if (await cacheStore.checkBackoff(now)) {
        return { status: 'backoff', waitMs: 0, ...(await getRequestCounts(now)) };
      }
      const quota = await reserveQuota({ now, dailyLimit, monthlyLimit, reservationId });
      if (quota.status !== 'reserved') return quota;
      const cooldown = await cacheStore.reserveCooldown({ now, cooldownMs });
      return { ...quota, status: cooldown.status, waitMs: cooldown.waitMs };
    },
    getRequestCounts,
    setBackoff: (until, now) => cacheStore.setBackoff(until, now),
    checkBackoff: now => cacheStore.checkBackoff(now),
    getCache: key => cacheStore.getCache(key),
    setCache: (key, value, ttlMs) => cacheStore.setCache(key, value, ttlMs),
    withCacheLock: (key, operation) => cacheStore.withCacheLock(key, operation)
  };
}
