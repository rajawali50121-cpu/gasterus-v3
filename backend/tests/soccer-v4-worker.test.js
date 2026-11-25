import test from "node:test";
import assert from "node:assert/strict";
import { loadSoccerV4Config } from "../src/sportsbook-next/soccer-v4-config.js";
import { SoccerV4Client } from "../src/sportsbook-next/soccer-v4-client.js";
import { __soccerQuota, selectSoccerV4DatesRoundRobin, reserveSoccerV4Call } from "../src/sportsbook-next/soccer-v4-quota.js";

test("Soccer v4 is disabled by default and does not require a key or quota", () => {
  const config = loadSoccerV4Config({});
  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 150 * 60 * 1000);
});

test("enabled Soccer v4 requires an explicit independent quota and usage baseline", () => {
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_API_KEY: "test-key"
  }), /SOCCER_MAX_CALLS_PER_30_DAYS/);
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "120"
  });
  assert.equal(config.maxCallsPer30Days, 500);
  assert.equal(config.initialCallsUsed30Days, 120);
  assert.equal(config.baseUrl, "https://api.sportradar.com/soccer/trial/v4/en");
});

test("Soccer v4 client calls only the Soccer summaries endpoint with x-api-key", async () => {
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_API_KEY: "secret-test",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0"
  });
  let requested = "";
  const client = new SoccerV4Client(config, {
    fetchImpl: async (url, options) => {
      requested = String(url);
      assert.equal(options.headers["x-api-key"], "secret-test");
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ generated_at: "2026-11-25T00:00:00Z", summaries: [] })
      };
    }
  });
  const response = await client.getDailySummaries("2026-11-25");
  assert.deepEqual(response.body.summaries, []);
  assert.ok(requested.endsWith("/soccer/trial/v4/en/schedules/2026-11-25/summaries.json"));
  assert.doesNotMatch(requested, /oddscomparison/);
});

test("Soccer v4 quota has a namespace separate from Odds Comparison monthly quota", () => {
  assert.equal(__soccerQuota.CALLS_KEY, "sportsbook:soccer-v4:quota:calls:v1");
  assert.equal(__soccerQuota.BASELINE_KEY, "sportsbook:soccer-v4:quota:baseline:v1");
  assert.doesNotMatch(__soccerQuota.CALLS_KEY, /sportsbook:next:sportradar:quota/);
});

test("Soccer v4 date selection rotates through tracked dates without starvation", () => {
  const first = selectSoccerV4DatesRoundRobin(["2026-11-21", "2026-11-22", "2026-11-23"], 0, 2);
  assert.deepEqual(first.dates, ["2026-11-21", "2026-11-22"]);
  assert.equal(first.nextCursor, 2);
  const second = selectSoccerV4DatesRoundRobin(["2026-11-21", "2026-11-22", "2026-11-23"], first.nextCursor, 2);
  assert.deepEqual(second.dates, ["2026-11-23", "2026-11-21"]);
  assert.equal(second.nextCursor, 1);
});

test("Soccer v4 reserves against its own rolling quota keys", async () => {
  let argsSeen;
  const redis = { eval: async (_script, args) => { argsSeen = args; return [1, 121, 500]; } };
  const config = { initialCallsUsed30Days: 120, maxCallsPer30Days: 500 };
  const result = await reserveSoccerV4Call(redis, config, 1_800_000_000_000);
  assert.deepEqual(result, { used: 121, limit: 500 });
  assert.deepEqual(argsSeen.keys, [__soccerQuota.CALLS_KEY, __soccerQuota.BASELINE_KEY]);
});

test("Soccer v4 monthly quota fails closed when its independent limit is exhausted", async () => {
  const redis = { eval: async () => [0, 500, 500] };
  await assert.rejects(
    reserveSoccerV4Call(redis, { initialCallsUsed30Days: 500, maxCallsPer30Days: 500 }),
    error => error.code === "SOCCER_V4_30_DAY_QUOTA_EXHAUSTED" && error.quotaUsed === 500
  );
});

test("Soccer v4 429 stops the request and invokes the shared provider cooldown", async () => {
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0"
  });
  let cooldown;
  const client = new SoccerV4Client(config, {
    onRateLimit: async value => { cooldown = value; },
    fetchImpl: async () => ({
      ok: false, status: 429,
      headers: { get: name => name === "retry-after" ? "300" : null },
      json: async () => ({})
    })
  });
  await assert.rejects(client.getDailySummaries("2026-11-25"), error =>
    error.code === "SOCCER_V4_RATE_LIMITED" && error.retryAfter === "300"
  );
  assert.deepEqual(cooldown, { retryAfter: "300", httpStatus: 429 });
});
