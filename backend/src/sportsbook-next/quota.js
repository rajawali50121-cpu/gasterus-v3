import { randomUUID } from "node:crypto";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const KEY = "sportsbook:next:sportradar:quota:v1";
const BASELINE_KEY = "sportsbook:next:sportradar:quota-baseline:v1";
const WORKER_KEY = "sportsbook:next:sportradar:quota-worker:v1";
const BET_KEY = "sportsbook:next:sportradar:quota-bet-revalidation:v1";

const RESERVE_SCRIPT = `
local now = tonumber(ARGV[2])
local cutoff = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', cutoff)

local baselineCount = redis.call('HGET', KEYS[2], 'count')
local baselineAt = redis.call('HGET', KEYS[2], 'captured_at')
if not baselineCount then
  redis.call('HSET', KEYS[2], 'count', ARGV[3], 'captured_at', now)
  baselineCount = ARGV[3]
elseif tonumber(baselineAt) < cutoff then
  redis.call('HSET', KEYS[2], 'count', 0, 'captured_at', now)
  baselineCount = 0
end

local hourlyWindow = tonumber(ARGV[4])
local hourlyLimit = tonumber(ARGV[5])
local monthlyLimit = tonumber(ARGV[6])
local workerLimit = tonumber(ARGV[8])
local betLimit = tonumber(ARGV[9])
local purpose = ARGV[10]
local hourly = redis.call('ZCOUNT', KEYS[1], now - hourlyWindow, '+inf')
local used = tonumber(baselineCount) + redis.call('ZCARD', KEYS[1])
local workerUsed = tonumber(baselineCount) + redis.call('ZCARD', KEYS[3])
local betUsed = redis.call('ZCARD', KEYS[4])
local oldest = redis.call('ZRANGEBYSCORE', KEYS[1], now - hourlyWindow, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
local retryAfter = 0
if #oldest >= 2 then
  retryAfter = math.max(0, tonumber(oldest[2]) + hourlyWindow - now)
end

if hourlyLimit > 0 and hourly >= hourlyLimit then return {2, hourly, used, retryAfter} end
if used >= monthlyLimit then return {0, hourly, used, 0} end
if purpose == 'bet' and (betLimit < 1 or betUsed >= betLimit) then return {3, betUsed, used, 0} end
if purpose ~= 'bet' and workerUsed >= workerLimit then return {0, hourly, workerUsed, 0} end

redis.call('ZADD', KEYS[1], now, ARGV[7])
if purpose == 'bet' then
  redis.call('ZADD', KEYS[4], now, ARGV[7])
else
  redis.call('ZADD', KEYS[3], now, ARGV[7])
end
redis.call('EXPIRE', KEYS[1], 2678400)
redis.call('EXPIRE', KEYS[3], 2678400)
redis.call('EXPIRE', KEYS[4], 2678400)
return {1, hourly + 1, used + 1, 0}
`;

export async function reserveSportradarCall(redis, config, now = Date.now(), { purpose = "worker" } = {}) {
  const result = await redis.eval(RESERVE_SCRIPT, {
    keys: [KEY, BASELINE_KEY, WORKER_KEY, BET_KEY],
    arguments: [
      String(now - WINDOW_MS),
      String(now),
      String(config.initialCallsUsed30Days),
      String(HOUR_MS),
      String(config.maxCallsPerHour),
      String(config.maxCallsPer30Days),
      randomUUID(),
      String(config.maxCallsPer30Days - (config.betRevalidationCallsPer30Days || 0)),
      String(config.betRevalidationCallsPer30Days || 0),
      purpose
    ]
  });
  const values = Array.isArray(result) ? result.map(Number) : [Number(result), 0, config.initialCallsUsed30Days, 0];
  const [allowed, hourlyUsed, monthlyUsed, retryAfterMs] = values;
  if (allowed === 1) return;
  const hourly = allowed === 2;
  const betBudget = allowed === 3;
  const errorCode = hourly ? "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED"
    : betBudget ? "SPORTRADAR_BET_REVALIDATION_BUDGET_EXHAUSTED" : "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED";
  const error = new Error(errorCode);
  error.code = errorCode;
  error.quotaScope = hourly ? "hour" : betBudget ? "bet_revalidation_30_days" : "30_days";
  error.quotaUsed = hourly || betBudget ? hourlyUsed : monthlyUsed;
  error.quotaLimit = hourly ? config.maxCallsPerHour : betBudget
    ? (config.betRevalidationCallsPer30Days || 0)
    : purpose === "bet" ? config.maxCallsPer30Days : config.maxCallsPer30Days - (config.betRevalidationCallsPer30Days || 0);
  error.retryAfter = hourly && retryAfterMs > 0 ? String(Math.ceil(retryAfterMs / 1000)) : null;
  throw error;
}

const USAGE_SCRIPT = `
local now = tonumber(ARGV[1])
local cutoff = now - tonumber(ARGV[2])
local baselineCount = tonumber(redis.call('HGET', KEYS[2], 'count') or ARGV[3])
local baselineAt = tonumber(redis.call('HGET', KEYS[2], 'captured_at') or now)
if baselineAt < cutoff then baselineCount = 0 end
local hourly = redis.call('ZCOUNT', KEYS[1], now - tonumber(ARGV[4]), '+inf')
local rolling = redis.call('ZCOUNT', KEYS[1], cutoff, '+inf')
return {hourly, baselineCount + rolling}
`;

export async function getSportradarQuotaUsage(redis, config, now = Date.now()) {
  const result = await redis.eval(USAGE_SCRIPT, {
    keys: [KEY, BASELINE_KEY],
    arguments: [String(now), String(WINDOW_MS), String(config.initialCallsUsed30Days), String(HOUR_MS)]
  });
  const [hourlyUsed, monthlyUsed] = Array.isArray(result) ? result.map(Number) : [0, config.initialCallsUsed30Days];
  return {
    hourlyUsed,
    hourlyLimit: config.maxCallsPerHour > 0 ? config.maxCallsPerHour : null,
    hourlyRemaining: config.maxCallsPerHour > 0 ? Math.max(0, config.maxCallsPerHour - hourlyUsed) : null,
    hourlyEnforced: config.maxCallsPerHour > 0,
    monthlyUsed,
    monthlyLimit: config.maxCallsPer30Days,
    monthlyRemaining: Math.max(0, config.maxCallsPer30Days - monthlyUsed)
  };
}

export const __quota = { KEY, BASELINE_KEY, WORKER_KEY, BET_KEY, RESERVE_SCRIPT, USAGE_SCRIPT, WINDOW_MS, HOUR_MS };

const QPS_NEXT_KEY = "sportsbook:next:sportradar:qps-next:v1";
const QPS_COOLDOWN_KEY = "sportsbook:next:sportradar:qps-cooldown:v1";
const QPS_INTERVAL_MS = 1100;
const QPS_RESERVE_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cooldown = redis.call('PTTL', KEYS[2])
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
local wait = math.max(0, nextAt - now, cooldown)
if wait <= 0 then
  redis.call('SET', KEYS[1], now + tonumber(ARGV[1]), 'PX', tonumber(ARGV[1]) * 3)
  return 0
end
return wait
`;

export async function waitForSportradarRequestSlot(redis, { intervalMs = QPS_INTERVAL_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const waitMs = Number(await redis.eval(QPS_RESERVE_SCRIPT, { keys: [QPS_NEXT_KEY, QPS_COOLDOWN_KEY], arguments: [String(intervalMs)] }));
    if (!Number.isFinite(waitMs) || waitMs <= 0) return;
    await sleep(Math.min(waitMs + 5, 30000));
  }
  const error = new Error("SPORTRADAR_QPS_WAIT_TIMEOUT"); error.code = error.message; throw error;
}

export async function applySportradarRateLimitCooldown(redis, retryAfter, { fallbackMs = 30000 } = {}) {
  const seconds = Number(retryAfter);
  const delayMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 900000) : fallbackMs;
  await redis.set(QPS_COOLDOWN_KEY, "1", { PX: delayMs });
  return delayMs;
}

export const __qps = { QPS_NEXT_KEY, QPS_COOLDOWN_KEY, QPS_INTERVAL_MS, QPS_RESERVE_SCRIPT };
