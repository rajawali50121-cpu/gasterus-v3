import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isRemoved, normalizeEventMarkets, filterPrematchEvents, isPersistableDiscoverySnapshot } from "../src/sportsbook-next/normalize.js";

const realFixtureUrl = new URL("./fixtures/sportradar/daily-sport-event-markets.sample.json", import.meta.url);
let realFixture = null;
try {
  realFixture = JSON.parse(await readFile(realFixtureUrl, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function countFields(value, predicate, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) countFields(item, predicate, result);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (predicate(key, child)) result.push(child);
      countFields(child, predicate, result);
    }
  }
  return result;
}

test("real Sportradar fixture matches the inspected Prematch v2 response contract", { skip: !realFixture }, () => {
  const response = realFixture.response;
  assert.deepEqual(Object.keys(response).sort(), ["generated_at", "sport_schedule_sport_event_markets"]);
  assert.equal(Number.isFinite(Date.parse(response.generated_at)), true);
  assert.equal(response.sport_schedule_sport_event_markets.length, 15);

  const markets = countFields(response, key => key === "is_live");
  assert.equal(markets.length, 77);
  assert.deepEqual(new Set(markets), new Set([false]));

  for (const field of ["live", "replaced_by", "resume_time"]) {
    assert.equal(countFields(response, key => key === field).length, 0, `${field} was not present in the inspected fixture`);
  }
});

test("isRemoved accepts boolean and string true only", () => {
  for (const value of [true, "true", "TRUE", " True "]) assert.equal(isRemoved(value), true);
  for (const value of [false, "false", undefined, null, 1, 0, "1"]) assert.equal(isRemoved(value), false);
});

test("normalizer excludes removed books and outcomes with string or boolean flags", () => {
  const normalized = normalizeEventMarkets({
    sport_event: { id: "sr:sport_event:1", start_time: "2099-01-01T00:00:00Z" },
    markets: [{ id: "sr:market:1", books: [
      { id: "sr:book:1", removed: "TRUE", outcomes: [{ odds_decimal: "2.0" }] },
      { id: "sr:book:2", removed: false, outcomes: [
        { id: "sr:outcome:1", removed: "true", odds_decimal: "2.0" },
        { id: "sr:outcome:2", removed: false, odds_decimal: "2.1" }
      ] }
    ] }]
  });
  assert.equal(normalized.markets[0].books.length, 1);
  assert.equal(normalized.markets[0].books[0].outcomes.length, 1);
  assert.equal(normalized.markets[0].books[0].outcomes[0].oddsDecimal, 2.1);
});

test("filterPrematchEvents drops started, invalid-time and live-market data", () => {
  const now = Date.parse("2026-11-25T00:00:00Z");
  const result = filterPrematchEvents([
    { id: "sr:sport_event:1", scheduled: "2026-11-25T00:01:00Z", markets: [{ live: false }] },
    { id: "sr:sport_event:2", scheduled: "2026-11-24T23:59:00Z", markets: [] },
    { id: "sr:sport_event:3", scheduled: "bad-date", markets: [] },
    { id: "sr:sport_event:4", scheduled: "2026-11-25T01:00:00Z", markets: [{ live: true }] }
  ], now);
  assert.deepEqual(result.filtered, { started: 1, invalidScheduled: 1, liveMarkets: 1 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].markets.length, 1);
});

test("truncated or otherwise incomplete discovery never qualifies for persistence", () => {
  const events = [{ id: "sr:sport_event:1", markets: [{ live: false }] }];
  assert.equal(isPersistableDiscoverySnapshot({ events, truncated: true }), false);
  assert.equal(isPersistableDiscoverySnapshot({ events, quotaLimited: true }), false);
  assert.equal(isPersistableDiscoverySnapshot({ events, budgetLimited: true }), false);
  assert.equal(isPersistableDiscoverySnapshot({ events, errors: [new Error("partial")] }), false);
  assert.equal(isPersistableDiscoverySnapshot({ events: [] }), false);
  assert.equal(isPersistableDiscoverySnapshot({ events, truncated: false }), true);
});
