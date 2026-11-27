import test from "node:test";
import assert from "node:assert/strict";
import { syncDailySchedules } from "../src/sportsbook-next/worker.js";

function scheduleRows(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    sport_event: {
      id: `sr:sport_event:${start + index + 1}`,
      start_time: "2026-11-29T12:00:00Z",
      status: "not_started",
      competitors: [
        { qualifier: "home", name: "Home" },
        { qualifier: "away", name: "Away" }
      ]
    },
    sport_event_context: { competition: { id: "sr:competition:1", name: "League" } }
  }));
}

test("Daily Schedules sync paginates independently and persists only schedule records", async () => {
  const values = new Map();
  const calls = [];
  const persisted = [];
  const redisClient = {
    get: async key => values.get(key) ?? null,
    set: async (key, value, options) => { values.set(key, value); calls.push(["set", key, options?.EX]); return "OK"; },
    del: async key => { values.delete(key); calls.push(["del", key]); return 1; }
  };
  const client = {
    cycleCalls: 0,
    getDailySchedules: async (_sportId, _date, { start, limit }) => {
      client.cycleCalls += 1;
      calls.push(["fetch", start, limit]);
      const count = start === 0 ? 50 : 20;
      return {
        body: { schedules: scheduleRows(start, count) },
        headers: { get: name => name === "x-max-results" ? "70" : name === "x-result" ? String(count) : null }
      };
    }
  };
  const config = { sportIds: ["sr:sport:1"], daysAhead: 0, maxCallsPerCycle: 6 };
  const first = await syncDailySchedules(config, client, {
    redisClient,
    persistSchedules: async (rows, sportId) => persisted.push({ count: rows.length, sportId }),
    now: () => "2026-11-28T00:00:00.000Z"
  });
  assert.equal(first.rows.length, 50);
  assert.equal(first.status[0].complete, false);
  assert.equal(values.get("sportsbook:next:schedule-cursor:v1:sr:sport:1:2026-11-28"), "50");

  client.cycleCalls = 0;
  const second = await syncDailySchedules(config, client, {
    redisClient,
    persistSchedules: async (rows, sportId) => persisted.push({ count: rows.length, sportId }),
    now: () => "2026-11-28T02:30:00.000Z"
  });
  assert.equal(second.rows.length, 20);
  assert.equal(second.status[0].complete, true);
  assert.equal(values.has("sportsbook:next:schedule-cursor:v1:sr:sport:1:2026-11-28"), false);
  assert.equal(values.has("sportsbook:next:schedule-complete:v1:sr:sport:1:2026-11-28"), true);
  assert.deepEqual(persisted.map(item => item.count), [50, 20]);

  const callsBefore = calls.length;
  const third = await syncDailySchedules(config, client, { redisClient });
  assert.equal(third.rows.length, 0);
  assert.equal(calls.length, callsBefore);
});

test("Daily Schedules sync defers when the shared request budget is exhausted", async () => {
  const redisClient = { get: async () => null, set: async () => "OK", del: async () => 1 };
  const client = { cycleCalls: 6, getDailySchedules: async () => { throw new Error("must not request"); } };
  const result = await syncDailySchedules(
    { sportIds: ["sr:sport:1"], daysAhead: 0, maxCallsPerCycle: 6 },
    client,
    { redisClient, persistSchedules: async () => { throw new Error("must not persist"); } }
  );
  assert.equal(result.status[0].deferred, true);
  assert.equal(result.status[0].reason, "CYCLE_BUDGET");
});
