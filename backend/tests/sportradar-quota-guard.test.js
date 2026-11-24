import test from 'node:test';
import assert from 'node:assert/strict';
import { installSportradarQuotaGuard } from '../src/sportradar-quota-guard.js';

function fakeRedis({ reserve = 1 } = {}) {
  const calls = [];
  return {
    calls,
    eval: async (script, options) => {
      calls.push({ script, options });
      if (String(script).includes('QPS')) return 0;
      if (String(script).includes('local time = redis.call')) return 0;
      return reserve;
    },
    set: async (...args) => calls.push({ set: args })
  };
}

test('Sportradar requests reserve rolling quota and shared QPS slot before network fetch', async () => {
  const redis = fakeRedis();
  let networkCalls = 0;
  const guard = installSportradarQuotaGuard({
    redis,
    connectRedis: async () => {},
    config: { sportradarMinIntervalMs: 1100, sportradarMaxCallsPerHour: 20 },
    env: { SPORTRADAR_MAX_CALLS_PER_30_DAYS: '800', SPORTRADAR_INITIAL_30_DAY_USAGE: '17', SPORTRADAR_MAX_CALLS_PER_CYCLE: '5' },
    fetchImpl: async () => { networkCalls += 1; return new Response('{}', { status: 200 }); }
  });
  const response = await globalThis.fetch('https://api.sportradar.com/oddscomparison-prematch/trial/v2/en/sports.json');
  assert.equal(response.status, 200);
  assert.equal(networkCalls, 1);
  assert.equal(redis.calls.length, 2);
  assert.equal(guard.getCallsThisCycle(), 1);
  assert.equal(guard.config.maxCallsPer30Days, 800);
  assert.equal(guard.config.initialCallsUsed30Days, 17);
  guard.restore();
});

test('monthly quota exhaustion fails closed before any provider network request', async () => {
  const redis = fakeRedis({ reserve: 0 });
  let networkCalls = 0;
  const guard = installSportradarQuotaGuard({
    redis,
    connectRedis: async () => {},
    config: { sportradarMinIntervalMs: 1100, sportradarMaxCallsPerHour: 20 },
    fetchImpl: async () => { networkCalls += 1; return new Response('{}'); }
  });
  await assert.rejects(globalThis.fetch('https://api.sportradar.com/oddscomparison-prematch/trial/v2/sports.json'), {
    code: 'SPORTRADAR_30_DAY_QUOTA_EXHAUSTED'
  });
  assert.equal(networkCalls, 0);
  guard.restore();
});

test('per-cycle limit prevents the sixth request even when monthly quota remains', async () => {
  const redis = fakeRedis();
  let networkCalls = 0;
  const guard = installSportradarQuotaGuard({
    redis,
    connectRedis: async () => {},
    config: { sportradarMinIntervalMs: 1100, sportradarMaxCallsPerHour: 20 },
    env: { SPORTRADAR_MAX_CALLS_PER_CYCLE: '5' },
    fetchImpl: async () => { networkCalls += 1; return new Response('{}'); }
  });
  for (let i = 0; i < 5; i += 1) await globalThis.fetch(`https://api.sportradar.com/oddscomparison-prematch/trial/v2/schedules/${i}.json`);
  await assert.rejects(globalThis.fetch('https://api.sportradar.com/oddscomparison-prematch/trial/v2/schedules/6.json'), {
    code: 'SPORTRADAR_CYCLE_CALL_LIMIT_REACHED'
  });
  assert.equal(networkCalls, 5);
  guard.restore();
});
