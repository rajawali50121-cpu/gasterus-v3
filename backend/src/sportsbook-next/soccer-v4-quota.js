import { randomUUID } from "node:crypto";
import { waitForSportradarRequestSlot, applySportradarRateLimitCooldown } from "./quota.js";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CALLS_KEY = "sportsbook:soccer-v4:quota:calls:v1";
const BASELINE_KEY = "sportsbook:soccer-v4:quota:baseline:v1";
const RESERVE_SCRIPT = [
"local now = tonumber(ARGV[2])",
"local cutoff = tonumber(ARGV[1])",
"redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)",
"local baselineCount = redis.call('HGET', KEYS[2], 'count')",
"local baselineAt = redis.call('HGET', KEYS[2], 'captured_at')",
"if not baselineCount then",
"  redis.call('HSET', KEYS[2], 'count', ARGV[3], 'captured_at', now)",
"  baselineCount = ARGV[3]",
"elseif tonumber(baselineAt) < cutoff then",
"  redis.call('HSET', KEYS[2], 'count', 0, 'captured_at', now)",
"  baselineCount = 0",
"end",
"local used = tonumber(baselineCount) + redis.call('ZCARD', KEYS[1])",
"local limit = tonumber(ARGV[4])",
"if used >= limit then return {0, used, limit} end",
"redis.call('ZADD', KEYS[1], now, ARGV[5])",
"redis.call('EXPIRE', KEYS[1], 2678400)",
"return {1, used + 1, limit}"
].join("\n");

export async function reserveSoccerV4Call(redis, config, now = Date.now()) {
  const result = await redis.eval(RESERVE_SCRIPT, {
    keys: [CALLS_KEY, BASELINE_KEY],
    arguments: [String(now - WINDOW_MS), String(now), String(config.initialCallsUsed30Days), String(config.maxCallsPer30Days), randomUUID()]
  });
  const [allowed, used, limit] = Array.isArray(result) ? result.map(Number) : [0, config.initialCallsUsed30Days, config.maxCallsPer30Days];
  if (allowed === 1) return { used, limit };
  const error = new Error("SOCCER_V4_30_DAY_QUOTA_EXHAUSTED");
  error.code = error.message;
  error.quotaScope = "30_days";
  error.quotaUsed = used;
  error.quotaLimit = limit;
  throw error;
}

export async function waitForSoccerV4RequestSlot(redis) {
  return waitForSportradarRequestSlot(redis);
}

export async function applySoccerV4RateLimitCooldown(redis, retryAfter) {
  return applySportradarRateLimitCooldown(redis, retryAfter);
}

export function selectSoccerV4DueDate(dates, lastPolls, now = Date.now(), todayUtc = new Date(now).toISOString().slice(0, 10)) {
  if (!Array.isArray(dates) || !lastPolls || typeof lastPolls !== "object") {
    throw new TypeError("SOCCER_V4_DATE_SELECTION_INVALID");
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  return dates.map(date => {
    const lastPoll = Number(lastPolls[date] || 0);
    const interval = date === todayUtc ? HOUR_MS : DAY_MS;
    return { date, dueAt: lastPoll > 0 ? lastPoll + interval : 0, priority: date === todayUtc ? 0 : 1 };
  }).filter(item => item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.priority - b.priority || a.date.localeCompare(b.date))[0]?.date ?? null;
}

export const __soccerQuota = { CALLS_KEY, BASELINE_KEY, RESERVE_SCRIPT, WINDOW_MS };
