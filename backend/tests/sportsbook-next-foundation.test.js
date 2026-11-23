import test from "node:test";
import assert from "node:assert/strict";
import { loadSportsbookConfig } from "../src/sportsbook-next/config.js";
import { SportradarClient } from "../src/sportsbook-next/sportradar-client.js";
import { getSportradarQuotaUsage, reserveSportradarCall } from "../src/sportsbook-next/quota.js";
import { normalizeDailySchedule, normalizeDailySportEventMarkets, normalizeEventMarkets, normalizeSoccerResult } from "../src/sportsbook-next/normalize.js";
import { getChangedSportEventIds, shouldReconcileChangeLog, SPORTRADAR_CHANGE_LOG_WINDOW_MS } from "../src/sportsbook-next/change-log.js";

const env = {
  SPORTRADAR_API_KEY: "test-key",
  SPORTRADAR_ACCESS_LEVEL: "trial",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "100",
  SPORTRADAR_MAX_CALLS_PER_HOUR: "20",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "10"
};

test("config defaults to 150-minute refresh, a two-day window and official Odds Comparison/Soccer v4 base URLs", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.pollIntervalMs, 150 * 60 * 1000);
  assert.equal(config.maxCallsPerHour, 0);
  assert.equal(config.daysAhead, 1);
  assert.equal(config.prematchBaseUrl, "https://api.sportradar.com/oddscomparison-prematch/trial/v2/en");
  assert.equal(config.soccerBaseUrl, "https://api.sportradar.com/soccer/trial/v4/en");
});

test("change-log configuration is opt-in and refuses a request budget too small for the documented five-minute window", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.changeLogEnabled, false);
  assert.equal(config.changeLogPollMs, 240_000);
  assert.equal(config.minimumChangeLogCalls30Days, 10_800);
  assert.throws(
    () => loadSportsbookConfig({ ...env, SPORTRADAR_CHANGELOG_ENABLED: "true" }),
    /requires a 30-day request budget/
  );
  const enabled = loadSportsbookConfig({
    ...env,
    SPORTRADAR_MAX_CALLS_PER_30_DAYS: "11000",
    SPORTRADAR_CHANGELOG_ENABLED: "true"
  });
  assert.equal(enabled.changeLogEnabled, true);
});

test("change log extracts only tracked Sportradar sport-event IDs", () => {
  const tracked = new Set(["sr:sport_event:1", "sr:sport_event:2"]);
  assert.deepEqual(getChangedSportEventIds({ changes: [
    { type: "sport_event", id: "sr:sport_event:1", sport_event_markets_odds_change: 123 },
    { type: "sport_event", id: "sr:sport_event:1", sport_event_markets_odds_change: 124 },
    { type: "sport_event", id: "sr:sport_event:unknown" },
    { type: "competition", id: "sr:competition:1" },
    { id: "sr:sport_event:2" }
  ] }, tracked), ["sr:sport_event:1", "sr:sport_event:2"]);
});

test("change log rejects a malformed payload instead of treating it as no changes", () => {
  assert.throws(() => getChangedSportEventIds({ unexpected: [] }, new Set()), /SPORTRADAR_CHANGELOG_SHAPE_INVALID/);
});

test("change log reconciles after startup or a gap longer than five minutes", () => {
  const now = 1_800_000_000_000;
  assert.equal(SPORTRADAR_CHANGE_LOG_WINDOW_MS, 300_000);
  assert.equal(shouldReconcileChangeLog(null, now), true);
  assert.equal(shouldReconcileChangeLog(String(now - 300_001), now), true);
  assert.equal(shouldReconcileChangeLog(String(now - 299_999), now), false);
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
  assert.match(requested, /sports\/sr:sport:1\/schedules\/2026-11-23\/schedules\.json\?start=0&limit=50/);
  assert.equal(calls, 1);
});

test("client calls the documented Prematch change-log and per-event market endpoints", async () => {
  const config = loadSportsbookConfig(env);
  const requested = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      requested.push(String(url));
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => requested.length === 1
          ? { changes: [{ type: "sport_event", id: "sr:sport_event:123", sport_event_markets_odds_change: 123 }] }
          : { sport_event: { id: "sr:sport_event:123" }, markets: [] }
      };
    }
  });
  const changeLog = await client.getSportEventMarketsChangeLog();
  assert.equal(changeLog.body.changes[0].id, "sr:sport_event:123");
  const markets = await client.getSportEventMarkets("sr:sport_event:123");
  assert.equal(markets.body.sport_event.id, "sr:sport_event:123");
  assert.match(requested[0], /sport_event_markets_changelog\.json$/);
  assert.match(requested[1], /sport_events\/sr:sport_event:123\/sport_event_markets\.json$/);
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


test("hourly internal cap is disabled while rolling 30-day quota remains enforced", async () => {
  const config = { initialCallsUsed30Days: 10, maxCallsPer30Days: 100, maxCallsPerHour: 0 };
  const unlimitedHourlyRedis = { eval: async script => {
    assert.match(script, /hourlyLimit > 0 and hourly >= hourlyLimit/);
    return [1, 21, 36, 0];
  } };
  await assert.doesNotReject(reserveSportradarCall(unlimitedHourlyRedis, config));
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
  const config = { initialCallsUsed30Days: 10, maxCallsPer30Days: 500, maxCallsPerHour: 0 };
  const usage = await getSportradarQuotaUsage({ eval: async (_script, args) => {
    assert.deepEqual(args.keys, ["sportsbook:next:sportradar:quota:v1", "sportsbook:next:sportradar:quota-baseline:v1"]);
    return [7, 123];
  } }, config, 1_800_000_000_000);
  assert.deepEqual(usage, {
    hourlyUsed: 7, hourlyLimit: null, hourlyRemaining: null, hourlyEnforced: false,
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
        json: async () => ({ sport_schedule_sport_event_markets: Array.from({ length: count }, (_, i) => ({ sport_event: { id: `sr:sport_event:${start+i}` }, markets: [] })) })
      };
    }
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-24", { maxPages: 3 });
  assert.equal(result.body.sport_events.length, 53);
  assert.deepEqual(offsets, [0, 50]);
});


test("bulk daily markets reads the official Prematch root key and logs safe response metadata", async () => {
  const config = loadSportsbookConfig(env);
  let diagnostic = null;
  const client = new SportradarClient(config, {
    onResponse: value => { diagnostic = value; },
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => ({
        "content-type": "application/json",
        "content-length": "512",
        "x-max-results": "1",
        "x-offset": "0",
        "x-result": "1"
      }[name] ?? null) },
      json: async () => ({
        generated_at: "2026-11-24T00:00:00Z",
        sport_schedule_sport_event_markets: [{
          sport_event: {
            id: "sr:sport_event:987", start_time: "2026-11-25T20:00:00Z", status: "not_started",
            competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }]
          },
          markets: [{
            id: "sr:market:1", name: "Winner", is_live: false,
            books: [{ id: "sr:book:1", name: "Book", outcomes: [
              { id: "sr:outcome:1", type: "home", odds_decimal: "2.10" }
            ] }]
          }]
        }]
      })
    })
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-25");
  assert.equal(result.body.sport_events.length, 1);
  assert.equal(result.body.sport_events[0].sport_event.id, "sr:sport_event:987");
  const normalized = normalizeDailySportEventMarkets(result.body, "sr:sport:1");
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, "sr:sport_event:987");
  assert.equal(normalized[0].markets[0].books[0].outcomes[0].oddsDecimal, 2.1);
  assert.equal(diagnostic.httpStatus, 200);
  assert.deepEqual(diagnostic.topLevelKeys, ["generated_at", "sport_schedule_sport_event_markets"]);
  assert.deepEqual(diagnostic.arrayCounts, { sport_schedule_sport_event_markets: 1 });
  assert.deepEqual(diagnostic.pagination, { maxResults: "1", offset: "0", result: "1" });
});

test("normalizer accepts the documented raw sport_schedule_sport_event_markets response", () => {
  const rows = normalizeDailySportEventMarkets({
    generated_at: "2026-11-24T00:00:00Z",
    sport_schedule_sport_event_markets: [{
      sport_event: {
        id: "sr:sport_event:654", start_time: "2026-11-25T12:00:00Z", status: "not_started",
        competitors: [{ qualifier: "home", name: "Home" }, { qualifier: "away", name: "Away" }]
      },
      markets: [{
        id: "sr:market:1", name: "1x2", is_live: false,
        books: [{ id: "sr:book:1", name: "Book", outcomes: [
          { id: "sr:outcome:1", type: "home", field_id: "1", odds_decimal: "2.15" }
        ] }]
      }]
    }]
  }, "sr:sport:1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "sr:sport_event:654");
  assert.equal(rows[0].markets[0].books[0].outcomes[0].fieldId, "1");
  assert.equal(rows[0].markets[0].books[0].outcomes[0].oddsDecimal, 2.15);
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
        json: async () => ({ sport_schedule_sport_event_markets: Array.from({ length: count }, (_, i) => ({ sport_event: { id: `sr:sport_event:${start+i}` }, markets: [] })) })
      };
    }
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-23", { maxPages: 3 });
  assert.equal(result.body.sport_events.length, 60);
  assert.deepEqual(offsets, [0, 50]);
});


test("bulk daily markets fails loudly when the documented response array is missing", async () => {
  const config = loadSportsbookConfig(env);
  const client = new SportradarClient(config, {
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ unexpected_payload: [] })
    })
  });
  await assert.rejects(
    client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-25"),
    error => error.code === "SPORTRADAR_BULK_MARKETS_SHAPE_INVALID"
  );
});
