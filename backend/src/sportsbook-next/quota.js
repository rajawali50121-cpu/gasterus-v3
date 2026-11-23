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

local hourly = redis.call('ZCOUNT', KEYS[1], now - tonumber(ARGV[4]), '+inf')
if hourly >= tonumber(ARGV[5]) then return 2 end

local used = tonumber(baselineCount) + redis.call('ZCARD', KEYS[1])
if used >= tonumber(ARGV[6]) then return 0 end

redis.call('ZADD', KEYS[1], now, ARGV[7])
redis.call('EXPIRE', KEYS[1], 2678400)
return 1
`;

export async function reserveSportradarCall(redis, config, now = Date.now()) {
  const allowed = Number(await redis.eval(RESERVE_SCRIPT, {
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
  }));
  if (allowed === 1) return;
  const error = new Error(allowed === 2 ? "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED" : "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED");
  error.code = allowed === 2 ? "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED" : "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED";
  throw error;
}

export const __quota = { KEY, BASELINE_KEY, RESERVE_SCRIPT, WINDOW_MS, HOUR_MS };
