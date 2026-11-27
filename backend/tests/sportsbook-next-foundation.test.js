import test from "node:test";
import assert from "node:assert/strict";
import { loadSportsbookConfig } from "../src/sportsbook-next/config.js";
import { SportradarClient } from "../src/sportsbook-next/sportradar-client.js";
import { getSportradarQuotaUsage, reserveSportradarCall } from "../src/sportsbook-next/quota.js";
import { normalizeDailySchedule, normalizeDailySportEventMarkets, normalizeEventMarkets, normalizeSoccerResult } from "../src/sportsbook-next/normalize.js";
import { getChangedSportEventIds, shouldReconcileChangeLog, SPORTRADAR_CHANGE_LOG_WINDOW_MS } from "../src/sportsbook-next/change-log.js";

const env = {
  SPORTRADAR_API_KEY: "test-key",
  SPORTRADAR_ACCESS_LEVEL: "production",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "2500",
  SPORTRADAR_MAX_CALLS_PER_HOUR: "20",
  SPORTRADAR_MAX_CALLS_PER_CYCLE: "6",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "10",
  SPORTRADAR_QUOTA_BASELINE_CONFIRMED: "true"
};

test("config defaults to 150-minute refresh, current UTC date only and official Odds Comparison/Soccer v4 base URLs", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.pollIntervalMs, 150 * 60 * 1000);
  assert.equal(config.maxCallsPerHour, 0);
  assert.equal(config.daysAhead, 0);
  assert.equal(config.maxCallsPerCycle, 6);
  assert.equal(config.prematchBaseUrl, "https://api.sportradar.com/oddscomparison-prematch/production/v2/en");
  assert.equal(config.soccerBaseUrl, "https://api.sportradar.com/soccer/production/v4/en");
});

test("change-log configuration is opt-in and refuses a request budget too small for the documented five-minute window", () => {
  const config = loadSportsbookConfig(env);
  assert.equal(config.changeLogEnabled, false);
  assert.equal(config.changeLogPollMs, 240_000);
  assert.equal(config.minimumChangeLogCalls30Days, 10_800);
  assert.throws(
    () => loadSportsbookConfig({ ...env, SPORTRADAR_CHANGELOG_ENABLED: "true" }),
    /30-day budget is insufficient/
  );
  assert.throws(
    () => loadSportsbookConfig({
      ...env,
      SPORTRADAR_MAX_CALLS_PER_30_DAYS: "14000",
      SPORTRADAR_CHANGELOG_ENABLED: "true"
    }),
    /must not exceed 800/
  );
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

test("trial configuration cannot exceed the 800-call internal budget or fan out across sports", () => {
  assert.throws(
    () => loadSportsbookConfig({ ...env, SPORTRADAR_ACCESS_LEVEL: "trial", SPORTRADAR_MAX_CALLS_PER_30_DAYS: "801" }),
    /must not exceed 800/
  );
  assert.throws(
    () => loadSportsbookConfig({ ...env, SPORTRADAR_ACCESS_LEVEL: "trial", SPORTRADAR_MAX_CALLS_PER_30_DAYS: "800", SPORTRADAR_SPORT_IDS: "sr:sport:1,sr:sport:2" }),
    /exactly one sport/
  );
});

test("config rejects missing API key, unsupported tier, and unverified quota baselines", () => {
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_API_KEY: "" }), /SPORTRADAR_API_KEY/);
  assert.throws(() => loadSportsbookConfig({ ...env, SPORTRADAR_ACCESS_LEVEL: "free" }), /trial or production/);
  assert.throws(() => loadSportsbookConfig({ SPORTRADAR_API_KEY: "test" }), /explicit SPORTRADAR_MAX_CALLS_PER_30_DAYS/);
  assert.throws(() => loadSportsbookConfig({
    SPORTRADAR_API_KEY: "test",
    SPORTRADAR_MAX_CALLS_PER_30_DAYS: "800",
    SPORTRADAR_INITIAL_30_DAY_USAGE: "0"
  }), /baseline is unconfirmed/);
  const defaults = loadSportsbookConfig({
    SPORTRADAR_API_KEY: "test",
    SPORTRADAR_ACCESS_LEVEL: "production",
    SPORTRADAR_MAX_CALLS_PER_30_DAYS: "2000",
    SPORTRADAR_MAX_CALLS_PER_CYCLE: "6",
    SPORTRADAR_INITIAL_30_DAY_USAGE: "120",
    SPORTRADAR_QUOTA_BASELINE_CONFIRMED: "true"
  });
  assert.equal(defaults.maxCallsPer30Days, 2500);
  assert.equal(defaults.initialCallsUsed30Days, 120);
  assert.equal(defaults.daysAhead, 0);
  assert.equal(defaults.maxCallsPerCycle, 6);
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

test("client calls documented endpoints, authenticates by x-api-key and captures safe 429 diagnostics", async () => {
  const config = loadSportsbookConfig(env);
  let calls = 0;
  let requested = "";
  let diagnostic = null;
  const client = new SportradarClient(config, {
    now: () => 1_800_000_000_000,
    onResponse: value => { diagnostic = value; },
    fetchImpl: async (url, options) => {
      calls += 1; requested = String(url);
      assert.equal(options.headers["x-api-key"], "test-key");
      return {
        status: 429, ok: false,
        headers: { get: name => ({
          "retry-after": "900", "x-origin-id": "MARKET_ORIGIN_MAGIC_CRAWLERS",
          "content-type": "application/json", "content-length": "50"
        }[name] ?? null) },
        json: async () => ({ message: "Rate limit reached for key test-key" })
      };
    }
  });
  await assert.rejects(client.getDailySchedules("sr:sport:1", "2026-11-23"), error =>
    error.code === "SPORTRADAR_RATE_LIMITED" && error.retryAfter === "900"
      && error.providerMessage === "Rate limit reached for key [REDACTED]"
      && error.originId === "MARKET_ORIGIN_MAGIC_CRAWLERS"
  );
  assert.equal(diagnostic.providerMessage, "Rate limit reached for key [REDACTED]");
  assert.equal(diagnostic.originId, "MARKET_ORIGIN_MAGIC_CRAWLERS");
  assert.equal(diagnostic.retryAfter, "900");
  assert.ok(requested.includes("/sports/sr:sport:1/schedules/2026-11-23/schedules.json?start=0&limit=50"));
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

test("Prematch discovery uses official Sports, Books and Sport Competitions endpoints", async () => {
  const config = loadSportsbookConfig(env);
  const requested = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      requested.push(String(url));
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => requested.length === 1 ? { sports: [{ id: "sr:sport:1", name: "Soccer" }] }
          : requested.length === 2 ? { books: [{ id: "sr:book:1", name: "Book" }] }
          : { competitions: [{ id: "sr:competition:1", name: "League", markets: true }] }
      };
    }
  });
  assert.equal((await client.getSports()).body.sports[0].id, "sr:sport:1");
  assert.equal((await client.getBooks()).body.books[0].id, "sr:book:1");
  assert.equal((await client.getCompetitions("sr:sport:1")).body.competitions[0].markets, true);
  assert.match(requested[0], /\/sports\.json$/);
  assert.match(requested[1], /\/books\.json$/);
  assert.match(requested[2], /\/sports\/sr:sport:1\/competitions\.json$/);
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


test("global Sportradar QPS limiter uses Redis server time and shared cooldown", async () => {
  const { waitForSportradarRequestSlot, applySportradarRateLimitCooldown, __qps } = await import("../src/sportsbook-next/quota.js");
  assert.match(__qps.QPS_RESERVE_SCRIPT, /redis.call\('TIME'\)/);
  assert.equal(__qps.QPS_INTERVAL_MS, 1100);
  const calls=[];
  const redis={
    eval: async (_script,args) => { calls.push(args); return 0; },
    set: async (...args) => { calls.push(args); return "OK"; }
  };
  await waitForSportradarRequestSlot(redis);
  assert.deepEqual(calls[0].keys,[__qps.QPS_NEXT_KEY,__qps.QPS_COOLDOWN_KEY]);
  assert.equal(await applySportradarRateLimitCooldown(redis,"7"),7000);
  assert.equal(calls[1][2].PX,7000);
});

test("Sportradar 429 propagates Retry-After into shared cooldown callback", async () => {
  const config=loadSportsbookConfig(env);
  let cooldown=null;
  const client=new SportradarClient(config,{
    onRateLimit: async details => { cooldown=details; },
    fetchImpl: async () => ({status:429,ok:false,headers:{get:name=>name==="retry-after"?"12":null},json:async()=>({})})
  });
  await assert.rejects(client.getSports(),error=>error.code==="SPORTRADAR_RATE_LIMITED");
  assert.deepEqual(cooldown,{retryAfter:"12",httpStatus:429});
});

test("bulk daily market pagination reports incomplete when the hard page cap truncates results", async () => {
  const config = loadSportsbookConfig(env);
  const offsets = [];
  const client = new SportradarClient(config, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      offsets.push(Number(parsed.searchParams.get("start")));
      return {
        ok: true, status: 200,
        headers: { get: name => name === "x-max-results" ? "150" : name === "x-result" ? "50" : null },
        json: async () => ({
          generated_at: "2026-11-25T00:00:00Z",
          sport_schedule_sport_event_markets: Array.from({ length: 50 }, (_, i) => ({ sport_event: { id: `sr:sport_event:${offsets.at(-1)+i}` }, markets: [] }))
        })
      };
    }
  });
  const result = await client.getAllDailySportEventMarkets("sr:sport:1", "2026-11-25", { pageSize: 50, maxPages: 2 });
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.received, 100);
  assert.equal(result.body.generated_at, "2026-11-25T00:00:00Z");
});

test("normalizer preserves scheduled events with no available markets and provider generated_at", () => {
  const rows = normalizeDailySportEventMarkets({
    generated_at: "2026-11-25T01:02:03Z",
    sport_schedule_sport_event_markets: [{
      sport_event: { id: "sr:sport_event:888", start_time: "2026-11-25T20:00:00Z", status: "not_started" },
      markets: []
    }]
  }, "sr:sport:1", "2026-11-25T01:02:05Z");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "sr:sport_event:888");
  assert.deepEqual(rows[0].markets, []);
  assert.equal(rows[0].providerGeneratedAt, "2026-11-25T01:02:03.000Z");
});

test("normalizer rejects malformed event identity instead of silently dropping the row", () => {
  assert.throws(() => normalizeDailySportEventMarkets({
    sport_schedule_sport_event_markets: [{ sport_event: { id: "not-a-provider-event" }, markets: [] }]
  }, "sr:sport:1"), /SPORTRADAR_EVENT_ID_INVALID/);
});
