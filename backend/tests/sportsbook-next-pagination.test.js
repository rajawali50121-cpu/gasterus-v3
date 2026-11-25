import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePaginationMeta } from "../src/sportsbook-next/pagination.js";
import { persistDiscoverySnapshotIfComplete } from "../src/sportsbook-next/normalize.js";

function fakeRedis(previous) {
  const key = "sportsbook:next:snapshot:v1";
  const values = new Map([[key, previous]]);
  const writes = [];
  return {
    values,
    writes,
    async set(writeKey, value) {
      writes.push(writeKey);
      values.set(writeKey, value);
      return "OK";
    }
  };
}

async function evaluateFeeds(feeds) {
  const pagination = aggregatePaginationMeta(feeds);
  const previous = JSON.stringify({ complete: true, events: [{ id: "sr:sport_event:last-good" }] });
  const redis = fakeRedis(previous);
  let databaseCalls = 0;
  const snapshot = {
    complete: !pagination.truncated,
    truncated: pagination.truncated,
    events: [{ id: "sr:sport_event:current" }],
    errors: [],
    quotaLimited: false,
    budgetLimited: false,
    fetchedAt: "2026-11-25T00:00:00.000Z"
  };
  const result = await persistDiscoverySnapshotIfComplete(snapshot, {
    persist: async () => { databaseCalls += 1; },
    redis,
    snapshotKey: "sportsbook:next:snapshot:v1",
    ttlSeconds: 300
  });
  return { pagination, previous, redis, databaseCalls, result };
}

test("first truncated feed remains truncated when the next feed is complete", async () => {
  const result = await evaluateFeeds([
    { sportId: "sr:sport:1", date: "2026-11-25", truncated: true, reportedTotal: 120, fetched: 100, pages: 2 },
    { sportId: "sr:sport:1", date: "2026-11-26", truncated: false, reportedTotal: 8, fetched: 8, pages: 1 }
  ]);
  assert.equal(result.pagination.truncated, true);
  assert.equal(result.pagination.reportedTotal, 128);
  assert.equal(result.pagination.fetched, 108);
  assert.equal(result.pagination.pages, 3);
  assert.equal(result.databaseCalls, 0);
  assert.deepEqual(result.redis.writes, []);
  assert.equal(result.redis.values.get("sportsbook:next:snapshot:v1"), result.previous);
});

test("later truncated feed remains visible after an earlier complete feed", async () => {
  const result = await evaluateFeeds([
    { sportId: "sr:sport:1", date: "2026-11-25", truncated: false, reportedTotal: 8, fetched: 8, pages: 1 },
    { sportId: "sr:sport:1", date: "2026-11-26", truncated: true, reportedTotal: 120, fetched: 100, pages: 2 }
  ]);
  assert.equal(result.pagination.truncated, true);
  assert.equal(result.databaseCalls, 0);
  assert.deepEqual(result.redis.writes, []);
  assert.equal(result.redis.values.get("sportsbook:next:snapshot:v1"), result.previous);
});

test("all complete feeds aggregate and permit database and Redis persistence", async () => {
  const result = await evaluateFeeds([
    { sportId: "sr:sport:1", date: "2026-11-25", truncated: false, reportedTotal: 8, fetched: 8, pages: 1 },
    { sportId: "sr:sport:1", date: "2026-11-26", truncated: false, reportedTotal: 3, fetched: 3, pages: 1 }
  ]);
  assert.equal(result.pagination.truncated, false);
  assert.equal(result.pagination.reportedTotal, 11);
  assert.equal(result.pagination.fetched, 11);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.databaseCalls, 1);
  assert.deepEqual(result.redis.writes, ["sportsbook:next:snapshot:v1"]);
  assert.equal(result.result.skipped, false);
});
