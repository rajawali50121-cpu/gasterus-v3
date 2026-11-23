import { randomUUID } from "node:crypto";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const KEY = "sportsbook:next:sportradar:quota:v1";
const BASELINE_KEY = "sportsbook:next:sportradar:quota-baseline:v1";

const RESERVE_SCRIPT = `
local now = tonumber(ARGV[2])
local cutoff = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

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
local hourly = redis.call('ZCOUNT', KEYS[1], now - hourlyWindow, '+inf')
local used = tonumber(baselineCount) + redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGEBYSCORE', KEYS[1], now - hourlyWindow, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
local retryAfter = 0
if #oldest >= 2 then
  retryAfter = math.max(0, tonumber(oldest[2]) + hourlyWindow - now)
end

if hourlyLimit > 0 and hourly >= hourlyLimit then return {2, hourly, used, retryAfter} end
if used >= monthlyLimit then return {0, hourly, used, 0} end

redis.call('ZADD', KEYS[1], now, ARGV[7])
redis.call('EXPIRE', KEYS[1], 2678400)
return {1, hourly + 1, used + 1, 0}
`;

export async function reserveSportradarCall(redis, config, now = Date.now()) {
  const result = await redis.eval(RESERVE_SCRIPT, {
    keys: [KEY, BASELINE_KEY],
    arguments: [
      String(now - WINDOW_MS),
      String(now),
      String(config.initialCallsUsed30Days),
      String(HOUR_MS),
      String(config.maxCallsPerHour),
      String(config.maxCallsPer30Days),
      randomUUID()
    ]
  });
  const values = Array.isArray(result) ? result.map(Number) : [Number(result), 0, config.initialCallsUsed30Days, 0];
  const [allowed, hourlyUsed, monthlyUsed, retryAfterMs] = values;
  if (allowed === 1) return;
  const hourly = allowed === 2;
  const error = new Error(hourly ? "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED" : "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED");
  error.code = hourly ? "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED" : "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED";
  error.quotaScope = hourly ? "hour" : "30_days";
  error.quotaUsed = hourly ? hourlyUsed : monthlyUsed;
  error.quotaLimit = hourly ? config.maxCallsPerHour : config.maxCallsPer30Days;
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

export const __quota = { KEY, BASELINE_KEY, RESERVE_SCRIPT, USAGE_SCRIPT, WINDOW_MS, HOUR_MS };
