import test from "node:test";
import assert from "node:assert/strict";
import { persistDiscoverySnapshotIfComplete } from "../src/sportsbook-next/normalize.js";

function fakeRedis(initial) {
  const values = new Map([["sportsbook:next:snapshot:v1", initial]]);
  const writes = [];
  return {
    values,
    writes,
    async set(key, value, options) {
      writes.push({ key, value, options });
      values.set(key, value);
      return "OK";
    }
  };
}

test("truncated discovery does not persist to database or replace last-known-good Redis snapshot", async () => {
  const previous = JSON.stringify({ complete: true, events: [{ id: "sr:sport_event:old" }] });
  const redis = fakeRedis(previous);
  let databaseCalls = 0;
  const partial = {
    complete: false,
    truncated: true,
    quotaLimited: false,
    budgetLimited: false,
    errors: [],
    events: [{ id: "sr:sport_event:new" }],
    fetchedAt: "2026-11-25T00:00:00.000Z"
  };

  const result = await persistDiscoverySnapshotIfComplete(partial, {
    persist: async () => { databaseCalls += 1; },
    redis,
    snapshotKey: "sportsbook:next:snapshot:v1",
    ttlSeconds: 300
  });

  assert.deepEqual(result, { skipped: true, reason: "SPORTRADAR_CYCLE_INCOMPLETE" });
  assert.equal(databaseCalls, 0);
  assert.equal(redis.writes.length, 0);
  assert.equal(redis.values.get("sportsbook:next:snapshot:v1"), previous);
});

test("truncated flag independently blocks persistence even if complete is incorrectly true", async () => {
  const previous = JSON.stringify({ complete: true, events: [{ id: "sr:sport_event:old" }] });
  const redis = fakeRedis(previous);
  let databaseCalls = 0;

  await persistDiscoverySnapshotIfComplete({
    complete: true,
    truncated: true,
    events: [{ id: "sr:sport_event:new" }],
    fetchedAt: "2026-11-25T00:00:00.000Z"
  }, {
    persist: async () => { databaseCalls += 1; },
    redis,
    snapshotKey: "sportsbook:next:snapshot:v1",
    ttlSeconds: 300
  });

  assert.equal(databaseCalls, 0);
  assert.equal(redis.writes.length, 0);
  assert.equal(redis.values.get("sportsbook:next:snapshot:v1"), previous);
});

test("complete discovery persists database rows before updating Redis snapshot", async () => {
  const redis = fakeRedis(JSON.stringify({ complete: true, events: [{ id: "sr:sport_event:old" }] }));
  const order = [];
  const snapshot = {
    complete: true,
    truncated: false,
    quotaLimited: false,
    budgetLimited: false,
    errors: [],
    events: [{ id: "sr:sport_event:new" }],
    fetchedAt: "2026-11-25T00:00:00.000Z"
  };
  redis.set = async (key, value, options) => {
    order.push("redis");
    redis.writes.push({ key, value, options });
    redis.values.set(key, value);
    return "OK";
  };

  const result = await persistDiscoverySnapshotIfComplete(snapshot, {
    persist: async events => {
      order.push("database");
      assert.deepEqual(events, snapshot.events);
      return { events: 1 };
    },
    redis,
    snapshotKey: "sportsbook:next:snapshot:v1",
    ttlSeconds: 300
  });

  assert.deepEqual(order, ["database", "redis"]);
  assert.deepEqual(result, { skipped: false, persisted: { events: 1 } });
  assert.deepEqual(JSON.parse(redis.values.get("sportsbook:next:snapshot:v1")), snapshot);
});
