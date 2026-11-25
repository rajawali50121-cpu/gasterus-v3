import test from "node:test";
import assert from "node:assert/strict";
import { isRemoved, normalizeEventMarkets, filterPrematchEvents, isPersistableDiscoverySnapshot } from "../src/sportsbook-next/normalize.js";

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
