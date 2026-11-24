import { config } from "./config.js";
import { redis, keys } from "./redis.js";

const stopAt = Math.max(1, Math.floor(config.quotaLimit * 0.9));
const reserveQuotaScript = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local count = redis.call('ZCARD', KEYS[1])
  if count >= tonumber(ARGV[2]) then return 0 end
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3] .. ':' .. ARGV[4])
  redis.call('EXPIRE', KEYS[1], 2678400)
  return count + 1
`;

export async function assertProviderAllowed() {
  const breakerTtl = await redis.ttl(keys.breaker);
  if (breakerTtl > 0) throw new Error(`Circuit breaker open (${breakerTtl}s remaining)`);

  // One shared Redis key enforces the minimum gap across all worker replicas.
  while (true) {
    const acquired = await redis.set(keys.lastRequest, String(Date.now()), { NX: true, PX: config.minGapMs });
    if (acquired) break;
    const ttl = await redis.pTTL(keys.lastRequest);
    await new Promise(resolve => setTimeout(resolve, Math.max(50, ttl > 0 ? ttl : config.minGapMs)));
    if (await redis.ttl(keys.breaker) > 0) throw new Error("Circuit breaker opened while waiting");
  }

  const now = Date.now();
  const result = await redis.eval(reserveQuotaScript, {
    keys: [keys.quota],
    arguments: [String(now - 30 * 24 * 60 * 60 * 1000), String(stopAt), String(now), crypto.randomUUID()]
  });
  if (Number(result) === 0) throw new Error("Rolling 30-day quota safety threshold reached; serving cached data");
  return Number(result);
}

export async function openCircuitBreaker(status) {
  if (status === 403 || status === 429) {
    await redis.set(keys.breaker, String(status), { EX: config.breakerMinutes * 60 });
  }
}

export async function quotaStatus() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await redis.zRemRangeByScore(keys.quota, "-inf", cutoff);
  const used = await redis.zCard(keys.quota);
  return {
    used, limit: config.quotaLimit, stop_at: stopAt,
    remaining: Math.max(0, config.quotaLimit - used),
    refreshes_before_stop: Math.max(0, stopAt - used)
  };
}
