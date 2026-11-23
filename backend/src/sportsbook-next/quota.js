import { randomUUID } from "node:crypto";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const KEY = "sportsbook:next:sportradar:quota:v1";

const RESERVE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local used = tonumber(ARGV[2]) + redis.call('ZCARD', KEYS[1])
if used >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
redis.call('EXPIRE', KEYS[1], 2678400)
return 1
`;

export async function reserveSportradarCall(redis, config, now = Date.now()) {
  const allowed = await redis.eval(RESERVE_SCRIPT, {
    keys: [KEY],
    arguments: [
      String(now - WINDOW_MS),
      String(config.initialCallsUsed30Days),
      String(config.maxCallsPer30Days),
      String(now),
      randomUUID()
    ]
  });
  if (Number(allowed) !== 1) {
    const error = new Error("SPORTRADAR_30_DAY_QUOTA_EXHAUSTED");
    error.code = "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED";
    throw error;
  }
}

export const __quota = { KEY, RESERVE_SCRIPT, WINDOW_MS };
