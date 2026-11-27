import test from "node:test";
import assert from "node:assert/strict";
import { readPublicSportsbookSnapshot } from "../src/sportsbook-next/public-feed.js";

const now = Date.parse("2026-11-25T06:00:00.000Z");
const validSnapshot = {
  schemaVersion: 1,
  fetchedAt: new Date(now - 60_000).toISOString(),
  complete: true,
  quotaLimited: false,
  budgetLimited: false,
  truncated: false,
  errors: [],
  events: [{
    id: "sr:sport_event:123",
    scheduled: "2026-11-25T10:00:00.000Z",
    home: "Home",
    away: "Away",
    markets: [{
      id: "sr:market:1",
      name: "1X2",
      live: false,
      books: [{ id: "book-1", outcomes: [{ name: "Home", oddsDecimal: 1.95 }] }]
    }]
  }]
};

function redisWith(value) {
  const calls = [];
  return {
    calls,
    get: async key => { calls.push(["get", key]); return value == null ? null : JSON.stringify(value); },
    set: async () => { throw new Error("public feed must never write Redis"); }
  };
}

test("public feed returns a fresh complete snapshot with odds from Redis only", async () => {
  const redis = redisWith(validSnapshot);
  const result = await readPublicSportsbookSnapshot({ redis, now, loadMappings: async () => ({ rows: [] }) });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].markets[0].books[0].outcomes[0].oddsDecimal, 1.95);
  assert.equal(result.ageMs, 60_000);
  assert.deepEqual(redis.calls, [["get", "sportsbook:next:snapshot:v1"]]);
});

test("public feed rejects a missing snapshot", async () => {
  await assert.rejects(
    readPublicSportsbookSnapshot({ redis: redisWith(null), now }),
    error => error.code === "SPORTSBOOK_FEED_UNAVAILABLE" && error.status === 503
  );
});

test("public feed rejects an expired snapshot", async () => {
  const stale = { ...validSnapshot, fetchedAt: new Date(now - 5 * 60 * 60 * 1000 - 1).toISOString() };
  await assert.rejects(
    readPublicSportsbookSnapshot({ redis: redisWith(stale), now }),
    error => error.code === "SPORTSBOOK_FEED_STALE" && error.status === 503
  );
});

test("public feed rejects incomplete or quota-limited snapshots", async () => {
  for (const patch of [{ complete: false }, { quotaLimited: true }, { budgetLimited: true }, { truncated: true }, { errors: ["provider error"] }]) {
    await assert.rejects(
      readPublicSportsbookSnapshot({ redis: redisWith({ ...validSnapshot, ...patch }), now }),
      error => error.code === "SPORTSBOOK_FEED_INCOMPLETE" && error.status === 503
    );
  }
});

test("public feed excludes events and markets without valid prematch odds", async () => {
  const snapshot = {
    ...validSnapshot,
    events: [
      { ...validSnapshot.events[0], markets: [{ live: false, books: [{ outcomes: [{ oddsDecimal: 1 }] }] }] },
      { ...validSnapshot.events[0], id: "sr:sport_event:456", markets: [{ live: true, books: [{ outcomes: [{ oddsDecimal: 2.2 }] }] }] }
    ]
  };
  await assert.rejects(
    readPublicSportsbookSnapshot({ redis: redisWith(snapshot), now }),
    error => error.code === "SPORTSBOOK_ODDS_UNAVAILABLE" && error.status === 503
  );
});

test("public feed reports Redis read failures without attempting provider calls", async () => {
  const calls = [];
  const redis = { get: async key => { calls.push(key); throw new Error("redis unavailable"); } };
  await assert.rejects(
    readPublicSportsbookSnapshot({ redis, now, loadMappings: async () => ({ rows: [] }) }),
    error => error.code === "SPORTSBOOK_CACHE_UNAVAILABLE" && error.status === 503
  );
  assert.deepEqual(calls, ["sportsbook:next:snapshot:v1"]);
});

test("public feed marks only an exact verified full-time 1X2 mapping as bettable", async () => {
  const snapshot = {
    ...validSnapshot,
    events: [{
      ...validSnapshot.events[0],
      sportId: "sr:sport:1",
      markets: [{
        ...validSnapshot.events[0].markets[0],
        key: "sr:market:1|1X2",
        specifiers: null,
        books: [{
          id: "book-1",
          outcomes: [{
            id: "outcome-home", type: "HOME", name: "Home",
            selectionKey: "outcome-home|", oddsDecimal: 1.95
          }]
        }]
      }]
    }]
  };
  const rows = [{
    sport_id: "sr:sport:1",
    provider_market_id: "sr:market:1",
    provider_market_name: "1X2",
    specifiers: "",
    outcomes: { HOME: "HOME" },
    market_code: "SOCCER_1X2_3WAY",
    settlement_rule: "SOCCER_1X2_3WAY"
  }];
  const result = await readPublicSportsbookSnapshot({
    redis: redisWith(snapshot), now,
    loadMappings: async () => ({ rows })
  });
  assert.equal(result.events[0].markets[0].bettable, true);
  assert.equal(result.events[0].markets[0].books[0].outcomes[0].bettable, true);
  assert.equal(result.bettingMappingsAvailable, true);
});

test("ambiguous or absent mapping leaves all odds display-only", async () => {
  const result = await readPublicSportsbookSnapshot({
    redis: redisWith(validSnapshot), now,
    loadMappings: async () => ({ rows: [] })
  });
  assert.equal(result.events[0].markets[0].bettable, false);
  assert.equal(result.events[0].markets[0].books[0].outcomes[0].bettable, false);
  assert.equal(result.betAcceptanceEnabled, false);
});
