import test from "node:test";
import assert from "node:assert/strict";
import { loadSportsbookConfig } from "../src/sportsbook-next/config.js";
import { SportradarClient } from "../src/sportsbook-next/sportradar-client.js";
import { getSportradarQuotaUsage, reserveSportradarCall } from "../src/sportsbook-next/quota.js";
import { normalizeDailySchedule, normalizeDailySportEventMarkets, normalizeEventMarkets, normalizeSoccerResult } from "../src/sportsbook-next/normalize.js";

const env = {
  SPORTRADAR_API_KEY: "test-key",
  SPORTRADAR_ACCESS_LEVEL: "trial",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "100",
  SPORTRADAR_MAX_CALLS_PER_HOUR: "20",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "10"
};

test("config defaults to 180-minute refresh, a two-day window and official Odds Comparison/Soccer v4 base URLs", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.pollIntervalMs, 180 * 60 * 1000);
  assert.equal(config.daysAhead, 1);
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


test("quota gate reports the exact hourly or rolling 30-day limit without exposing credentials", async () => {
  const config = { initialCallsUsed30Days: 10, maxCallsPer30Days: 100, maxCallsPerHour: 20 };
  const hourlyRedis = { eval: async () => [2, 20, 35, 9000] };
  await assert.rejects(
    reserveSportradarCall(hourlyRedis, config),
    error => error.code === "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED"
      && error.quotaScope === "hour" && error.quotaUsed === 20
      && error.quotaLimit === 20 && error.retryAfter === "9"
  );
  const monthlyRedis = { eval: async () => [0, 4, 100, 0] };
  await assert.rejects(
    reserveSportradarCall(monthlyRedis, config),
    error => error.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"
      && error.quotaScope === "30_days" && error.quotaUsed === 100
      && error.quotaLimit === 100
  );
});

test("Redis quota reservation remains authoritative when local process counter is stale", async () => {
  const config = loadSportsbookConfig({ ...env, SPORTRADAR_INITIAL_30_DAY_USAGE: "100" });
  let reserved = false;
  const client = new SportradarClient(config, {
    beforeRequest: async () => { reserved = true; },
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ sports: [] })
    })
  });
  const result = await client.getSports();
  assert.equal(reserved, true);
  assert.deepEqual(result.body, { sports: [] });
});

test("client preserves safe HTTP status codes for provider diagnostics", async () => {
  const config = loadSportsbookConfig(env);
  const client = new SportradarClient(config, {
    fetchImpl: async () => ({
      ok: false, status: 403, headers: { get: () => null },
      json: async () => ({ message: "sensitive provider payload must not be logged" })
    })
  });
  await assert.rejects(client.getSports(), error =>
    error.code === "SPORTRADAR_HTTP_403" && error.httpStatus === 403
      && !error.message.includes("sensitive")
  );
});

test("quota usage reports rolling hourly and 30-day consumption without exposing keys", async () => {
  const config = { initialCallsUsed30Days: 10, maxCallsPer30Days: 500, maxCallsPerHour: 20 };
  const usage = await getSportradarQuotaUsage({ eval: async (_script, args) => {
    assert.deepEqual(args.keys, ["sportsbook:next:sportradar:quota:v1", "sportsbook:next:sportradar:quota-baseline:v1"]);
    return [7, 123];
  } }, config, 1_800_000_000_000);
  assert.deepEqual(usage, {
    hourlyUsed: 7, hourlyLimit: 20, hourlyRemaining: 13,
    monthlyUsed: 123, monthlyLimit: 500, monthlyRemaining: 377
  });
});

test("bulk pagination continues on a full page when provider pagination headers are absent", async () => {
  const config = loadSportsbookConfig(env);
  const offsets = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      offsets.push(start);
      const count = start === 0 ? 50 : 3;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ sport_events: Array.from({ length: count }, (_, i) => ({ sport_event: { id: `sr:sport_event:${start+i}` }, markets: [] })) })
      };
    }
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-24", { maxPages: 3 });
  assert.equal(result.body.sport_events.length, 53);
  assert.deepEqual(offsets, [0, 50]);
});

test("bulk daily markets normalize embedded event boards without per-event follow-up calls", () => {
  const rows = normalizeDailySportEventMarkets({ sport_events: [{
    sport_event: {
      id: "sr:sport_event:456", start_time: "2026-11-23T12:00:00Z", status: "not_started",
      competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }]
    },
    sport_event_context: { competition: { id: "sr:competition:1", name: "League" } },
    markets: [{
      id: "sr:market:1", name: "1x2", is_live: false,
      books: [{ id: "sr:book:1", name: "Book", outcomes: [
        { id: "sr:outcome:1", type: "home", odds_decimal: "2.0" }
      ] }]
    }]
  }] }, "sr:sport:1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "sr:sport_event:456");
  assert.equal(rows[0].competition, "League");
  assert.equal(rows[0].markets[0].books[0].outcomes[0].oddsDecimal, 2);
});

test("bulk daily markets paginate with a hard page ceiling", async () => {
  const config = loadSportsbookConfig(env);
  const offsets = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      offsets.push(start);
      const count = start === 0 ? 50 : 10;
      return {
        ok: true, status: 200,
        headers: { get: name => name === "x-max-results" ? "60" : name === "x-result" ? String(count) : null },
        json: async () => ({ sport_events: Array.from({ length: count }, (_, i) => ({ sport_event: { id: `sr:sport_event:${start+i}` }, markets: [] })) })
      };
    }
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-23", { maxPages: 3 });
  assert.equal(result.body.sport_events.length, 60);
  assert.deepEqual(offsets, [0, 50]);
});
