import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { connectRedis, redis, keys } from "../src/redis.js";
import { assertProviderAllowed, openCircuitBreaker, quotaStatus } from "../src/guard.js";

const enabled = Boolean(config.redisUrl);
const clear = async () => { if (redis.isReady) await redis.flushDb(); };

test("Redis connection, rolling quota guard and quota status", { skip: !enabled }, async () => {
  await connectRedis();
  try {
    await clear();
    const now = Date.now();
    const members = Array.from({ length: 810 }, (_, i) => ({ score: now - i, value: "fixture:" + i }));
    await redis.zAdd(keys.quota, members);
    const status = await quotaStatus();
    assert.equal(status.used, 810);
    assert.equal(status.stop_at, 810);
    await assert.rejects(assertProviderAllowed(), /safety threshold/);
  } finally {
    await clear();
    await redis.quit();
  }
});

test("HTTP 403 and 429 both open the configured circuit breaker", { skip: !enabled }, async () => {
  await connectRedis();
  try {
    for (const status of [403, 429]) {
      await clear();
      await openCircuitBreaker(status);
      assert.ok(await redis.ttl(keys.breaker) > 0);
      await assert.rejects(assertProviderAllowed(), /Circuit breaker open/);
    }
  } finally {
    await clear();
    await redis.quit();
  }
});

test("expired quota entries are pruned from the rolling 30-day window", { skip: !enabled }, async () => {
  await connectRedis();
  try {
    await clear();
    await redis.zAdd(keys.quota, [
      { score: Date.now() - 31 * 24 * 60 * 60 * 1000, value: "old-request" },
      { score: Date.now(), value: "current-request" }
    ]);
    const status = await quotaStatus();
    assert.equal(status.used, 1);
  } finally {
    await clear();
    await redis.quit();
  }
});

test("Redis request reservations are spaced by at least the configured interval", { skip: !enabled }, async () => {
  await connectRedis();
  try {
    await clear();
    await assertProviderAllowed();
    const started = Date.now();
    await assertProviderAllowed();
    assert.ok(Date.now() - started >= config.minGapMs - 50);
  } finally {
    await clear();
    await redis.quit();
  }
});
