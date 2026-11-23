import test from "node:test";
import assert from "node:assert/strict";
import { loadSportsbookConfig } from "../src/sportsbook-next/config.js";
import { SportradarClient } from "../src/sportsbook-next/sportradar-client.js";
import { normalizePrematchPayload, normalizeSoccerResult } from "../src/sportsbook-next/normalize.js";

const env = {
  SPORTRADAR_API_KEY: "test-key",
  SPORTRADAR_ACCESS_LEVEL: "trial",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "100",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "10"
};

test("new sportsbook config defaults polling to 150 minutes", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.pollIntervalMs, 150 * 60 * 1000);
  assert.match(config.prematchBaseUrl, /oddscomparison-prematch\/trial\/v2\/en$/);
  assert.match(config.soccerBaseUrl, /soccer\/trial\/v4\/en$/);
});

test("new sportsbook config rejects missing API key and unknown access tier", () => {
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_API_KEY: "" }), /SPORTRADAR_API_KEY/);
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_ACCESS_LEVEL: "free" }), /trial or production/);
});

test("normalizer keeps provider event and bookmaker identity and rejects removed or invalid prices", () => {
  const snapshot = normalizePrematchPayload({
    sport_events: [{
      id: "sr:sport_event:123",
      start_time: "2026-11-23T12:00:00Z",
      competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }],
      markets: [{
        id: 1, name: "1X2",
        books: [
          { id: "sr:book:1", name: "Book A", outcomes: [{ id: "home", odds: "2.10" }, { id: "bad", odds: "0" }] },
          { id: "sr:book:2", name: "Removed", removed: true, outcomes: [{ odds: "3.0" }] }
        ]
      }]
    }]
  }, "2026-11-23T12:01:00Z");
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].markets[0].books.length, 1);
  assert.equal(snapshot.events[0].markets[0].books[0].id, "sr:book:1");
  assert.equal(snapshot.events[0].markets[0].books[0].outcomes.length, 1);
});

test("soccer result normalizer requires Sportradar event ID and preserves unknown status", () => {
  assert.equal(normalizeSoccerResult({ sport_event: { id: "other:1" } }), null);
  assert.deepEqual(normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:123", coverage: { sport_event_properties: { scores: "post" } } },
    sport_event_status: { status: "ended", home_score: 2, away_score: 1 }
  }), {
    eventId: "sr:sport_event:123", status: "ended", homeScore: 2, awayScore: 1,
    coverage: { sport_event_properties: { scores: "post" } }
  });
});

test("client sends x-api-key and stops immediately on HTTP 429", async () => {
  const config = loadSportsbookConfig(env);
  let calls = 0;
  const client = new SportradarClient(config, {
    now: () => 1_800_000_000_000,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers["x-api-key"], "test-key");
      return { status: 429, ok: false, headers: { get: () => "900" }, json: async () => ({}) };
    }
  });
  await assert.rejects(client.getSports(), error => error.code === "SPORTRADAR_RATE_LIMITED" && error.retryAfter === "900");
  assert.equal(calls, 1);
});
