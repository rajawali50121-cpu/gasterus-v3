import test from "node:test";
import assert from "node:assert/strict";
import { loadSportsbookConfig } from "../src/sportsbook-next/config.js";
import { SportradarClient } from "../src/sportsbook-next/sportradar-client.js";
import { normalizeDailySchedule, normalizeEventMarkets, normalizeSoccerResult } from "../src/sportsbook-next/normalize.js";

const env = {
  SPORTRADAR_API_KEY: "test-key",
  SPORTRADAR_ACCESS_LEVEL: "trial",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "100",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "10"
};

test("config defaults to 150-minute refresh and official Odds Comparison/Soccer v4 base URLs", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.pollIntervalMs, 150 * 60 * 1000);
  assert.equal(config.prematchBaseUrl, "https://api.sportradar.com/oddscomparison-prematch/trial/v2/en");
  assert.equal(config.soccerBaseUrl, "https://api.sportradar.com/soccer/trial/v4/en");
});

test("config rejects missing API key, unsupported tier and unknown quota", () => {
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_API_KEY: "" }), /SPORTRADAR_API_KEY/);
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_ACCESS_LEVEL: "free" }), /trial or production/);
  assert.throws(() => loadSportsbookConfig({ SPORTRADAR_API_KEY: "test" }), /SPORTRADAR_MAX_CALLS_PER_30_DAYS/);
});

test("daily schedule normalization uses sport_event and provider SR identifiers", () => {
  const rows = normalizeDailySchedule({ schedules: [{
    sport_event: {
      id: "sr:sport_event:123", start_time: "2026-11-23T12:00:00Z", status: "not_started",
      competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }]
    },
    sport_event_context: { competition: { name: "League" } }
  }, { sport_event: { id: "invalid" } }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "sr:sport_event:123");
  assert.equal(rows[0].competition, "League");
});

test("event market normalization follows documented odds_decimal and removed bookmaker fields", () => {
  const snapshot = normalizeEventMarkets({
    sport_event: {
      id: "sr:sport_event:123", start_time: "2026-11-23T12:00:00Z", status: "not_started",
      competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }]
    },
    markets: [{
      id: "sr:market:251", name: "Winner", is_live: false,
      books: [
        { id: "sr:book:1", name: "Book A", removed: false, outcomes: [
          { id: "sr:outcome:1", type: "home", odds_decimal: "2.10", open_odds_decimal: "2.00" },
          { id: "sr:outcome:2", type: "away", odds_decimal: "0" }
        ] },
        { id: "sr:book:2", name: "Removed", removed: true, outcomes: [{ odds_decimal: "3.0" }] }
      ]
    }]
  }, "2026-11-23T12:01:00Z");
  assert.equal(snapshot.markets[0].books.length, 1);
  assert.equal(snapshot.markets[0].books[0].outcomes.length, 1);
  assert.equal(snapshot.markets[0].books[0].outcomes[0].oddsDecimal, 2.1);
  assert.equal(snapshot.markets[0].key, "sr:market:251|Winner");
});

test("Soccer result normalizer requires a Sportradar event ID", () => {
  assert.equal(normalizeSoccerResult({ sport_event: { id: "bad" } }), null);
  assert.deepEqual(normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:123", coverage: { sport_event_properties: { scores: "post" } } },
    sport_event_status: { status: "ended", home_score: 2, away_score: 1 }
  }), {
    eventId: "sr:sport_event:123", status: "ended", homeScore: 2, awayScore: 1,
    coverage: { sport_event_properties: { scores: "post" } }
  });
});

test("client calls documented endpoints, authenticates by x-api-key and stops on 429", async () => {
  const config = loadSportsbookConfig(env);
  let calls = 0;
  let requested = "";
  const client = new SportradarClient(config, {
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      calls += 1; requested = String(url);
      assert.equal(options.headers["x-api-key"], "test-key");
      return { status: 429, ok: false, headers: { get: () => "900" }, json: async () => ({}) };
    }
  });
  await assert.rejects(client.getDailySchedules("sr:sport:1", "2026-11-23"), error => error.code === "SPORTRADAR_RATE_LIMITED" && error.retryAfter === "900");
  assert.match(requested, /sports\/sr%3Asport%3A1\/schedules\/2026-11-23\/schedules\.json\?start=0&limit=50/);
  assert.equal(calls, 1);
});

test("daily schedules use bounded offset pagination and stop at provider total", async () => {
  const config = loadSportsbookConfig(env);
  const offsets = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      offsets.push(start);
      const count = start === 0 ? 50 : 20;
      return {
        ok: true, status: 200,
        headers: { get: name => name === "x-max-results" ? "70" : name === "x-result" ? String(count) : null },
        json: async () => ({ schedules: Array.from({ length: count }, (_, i) => ({ id: start + i })) })
      };
    }
  });
  const rows = await client.getAllDailySchedules("sr:sport:1", "2026-11-23");
  assert.equal(rows.length, 70);
  assert.deepEqual(offsets, [0, 50]);
});

test("daily schedules pagination has a hard page ceiling", async () => {
  const config = loadSportsbookConfig(env);
  let calls = 0;
  const client = new SportradarClient(config, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => "10000" }, json: async () => ({ schedules: Array.from({ length: 50 }, () => ({})) }) };
    }
  });
  const rows = await client.getAllDailySchedules("sr:sport:1", "2026-11-23", { maxPages: 3 });
  assert.equal(rows.length, 150);
  assert.equal(calls, 3);
});
