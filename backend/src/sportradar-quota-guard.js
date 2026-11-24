import {
  reserveSportradarCall,
  waitForSportradarRequestSlot,
  applySportradarRateLimitCooldown
} from './sportsbook-next/quota.js';

function positiveInt(value, fallback, max = 100000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

function requestUrl(input) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(String(input));
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}

export function installSportradarQuotaGuard({
  redis,
  connectRedis,
  config,
  fetchImpl = globalThis.fetch,
  env = process.env
}) {
  if (typeof fetchImpl !== 'function') throw new Error('Native fetch is required for Sportradar quota guard.');
  if (!redis || typeof connectRedis !== 'function') throw new Error('Redis is required for Sportradar quota guard.');
  const maxCallsPer30Days = positiveInt(env.SPORTRADAR_MAX_CALLS_PER_30_DAYS, 800) || 800;
  const initialCallsUsed30Days = positiveInt(env.SPORTRADAR_INITIAL_30_DAY_USAGE, 0);
  const maxCallsPerCycle = positiveInt(env.SPORTRADAR_MAX_CALLS_PER_CYCLE, 5) || 5;
  const quotaConfig = {
    maxCallsPer30Days,
    initialCallsUsed30Days,
    maxCallsPerHour: positiveInt(config.sportradarMaxCallsPerHour, 20)
  };
  let callsThisCycle = 0;
  let installed = false;

  const guardedFetch = async (input, init) => {
    const url = requestUrl(input);
    if (!url || !/(^|\.)sportradar\.com$/i.test(url.hostname)) {
      return fetchImpl(input, init);
    }

    if (/\/sports\.json$/i.test(url.pathname)) callsThisCycle = 0;
    if (callsThisCycle >= maxCallsPerCycle) {
      const error = new Error('SPORTRADAR_CYCLE_CALL_LIMIT_REACHED: current snapshot rejected before another provider request.');
      error.code = 'SPORTRADAR_CYCLE_CALL_LIMIT_REACHED';
      throw error;
    }

    // Fail closed: no provider request is sent unless Redis pacing and the
    // rolling 30-day reservation both succeed.
    await connectRedis();
    await waitForSportradarRequestSlot(redis, { intervalMs: config.sportradarMinIntervalMs });
    await reserveSportradarCall(redis, quotaConfig);
    callsThisCycle += 1;

    const response = await fetchImpl(input, init);
    if (response.status === 429) {
      await applySportradarRateLimitCooldown(redis, response.headers?.get?.('retry-after'));
    }
    return response;
  };

  if (!installed) {
    globalThis.fetch = guardedFetch;
    installed = true;
  }

  return {
    getCallsThisCycle: () => callsThisCycle,
    config: { ...quotaConfig, maxCallsPerCycle },
    restore: () => { if (globalThis.fetch === guardedFetch) globalThis.fetch = fetchImpl; }
  };
}
