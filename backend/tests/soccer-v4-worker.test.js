import test from "node:test";
import assert from "node:assert/strict";
import { loadSoccerV4Config } from "../src/sportsbook-next/soccer-v4-config.js";
import { SoccerV4Client, parseSoccerCacheTtlMs, getSoccerNextPageStart } from "../src/sportsbook-next/soccer-v4-client.js";
import { __soccerQuota, selectSoccerV4DueDate, reserveSoccerV4Call } from "../src/sportsbook-next/soccer-v4-quota.js";\nimport { buildSoccerResultCandidateGroups, selectOldestDueSoccerResultDate } from "../src/sportsbook-next/results-repository.js";

test("Soccer v4 is disabled by default and does not require a key or quota", () => {
  const config = loadSoccerV4Config({});
  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 60 * 60 * 1000);
  assert.equal(config.maxCallsPerCycle, 1);
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
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "120",
    SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true"
  });
  assert.equal(config.maxCallsPer30Days, 500);
  assert.equal(config.initialCallsUsed30Days, 120);
  assert.equal(config.baseUrl, "https://api.sportradar.com/soccer/trial/v4/en");
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0"
  }), /baseline is unconfirmed/);
  assert.throws(() => loadSoccerV4Config({ SPORTRADAR_SOCCER_POLL_MINUTES: "30" }), /at least 60 minutes/);
  assert.throws(() => loadSoccerV4Config({ SPORTRADAR_SOCCER_MAX_CALLS_PER_CYCLE: "2" }), /one request per cycle/);
});

test("Soccer v4 client calls only the Soccer summaries endpoint with x-api-key", async () => {
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_API_KEY: "secret-test",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0",
    SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true"
  });
  let requested = "";
  const client = new SoccerV4Client(config, {
    fetchImpl: async (url, options) => {
      requested = String(url);
      assert.equal(options.headers["x-api-key"], "secret-test");
      return {
        ok: true, status: 200, headers: { get: name => ({ "cache-control": "public, max-age=300, s-maxage=300", "x-max-results": "250", "x-result": "200", "x-offset": "0" })[name] || null },
        json: async () => ({ generated_at: "2026-11-25T00:00:00Z", summaries: [] })
      };
    }
  });
  const response = await client.getDailySummaries("2026-11-25", { start: 0, limit: 200 });
  assert.deepEqual(response.body.summaries, []);
  assert.equal(response.metadata.cacheTtlMs, 300_000);
  assert.ok(requested.endsWith("/soccer/trial/v4/en/schedules/2026-11-25/summaries.json?start=0&limit=200"));
  assert.equal(response.metadata.maxResults, 250);
  assert.doesNotMatch(requested, /oddscomparison/);
});

test("Soccer v4 quota has a namespace separate from Odds Comparison monthly quota", () => {
  assert.equal(__soccerQuota.CALLS_KEY, "sportsbook:soccer-v4:quota:calls:v1");
  assert.equal(__soccerQuota.BASELINE_KEY, "sportsbook:soccer-v4:quota:baseline:v1");
  assert.doesNotMatch(__soccerQuota.CALLS_KEY, /sportsbook:next:sportradar:quota/);
});

test("Soccer v4 follows hourly current-date and daily previous-date refresh budgets", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const today = "2026-11-25";
  const yesterday = "2026-11-24";
  assert.equal(selectSoccerV4DueDate([yesterday, today], {}, now, today), today);
  assert.equal(selectSoccerV4DueDate([yesterday, today], { [today]: now }, now, today), yesterday);
  assert.equal(selectSoccerV4DueDate([yesterday, today], { [today]: now, [yesterday]: now }, now + 60 * 60 * 1000, today), today);
  assert.equal(selectSoccerV4DueDate([yesterday, today], { [today]: now + 60 * 60 * 1000, [yesterday]: now }, now + 23 * 60 * 60 * 1000, today), today);
  assert.equal(selectSoccerV4DueDate([yesterday, today], { [today]: now + 23 * 60 * 60 * 1000, [yesterday]: now }, now + 24 * 60 * 60 * 1000, today), yesterday);
});

test("Soccer v4 parses Cache-Control max-age and safely ignores absent TTL", () => {
  assert.equal(parseSoccerCacheTtlMs("public, max-age=300, s-maxage=300"), 300_000);
  assert.equal(parseSoccerCacheTtlMs("max-age=60"), 60_000);
  assert.equal(parseSoccerCacheTtlMs(null), null);
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

test("Soccer v4 paginates up to 200 events and does not silently drop later pages", () => {
  assert.equal(getSoccerNextPageStart({ start: 0, limit: 200, returned: 200, maxResults: 450 }), 200);
  assert.equal(getSoccerNextPageStart({ start: 200, limit: 200, returned: 200, maxResults: 450 }), 400);
  assert.equal(getSoccerNextPageStart({ start: 400, limit: 200, returned: 50, maxResults: 450 }), 0);
  assert.equal(getSoccerNextPageStart({ start: 0, limit: 200, returned: 200, maxResults: null }), 200);
  assert.equal(getSoccerNextPageStart({ start: 200, limit: 200, returned: 10, maxResults: null }), 0);
  assert.throws(() => getSoccerNextPageStart({ start: 200, limit: 200, returned: 0, maxResults: 450 }), /PAGINATION_STALLED/);
});


const RESULT_NOW = Date.parse("2026-11-27T12:00:00.000Z");
const resultEvent = (scheduledAt, result = {}) => ({ scheduledAt, ...result });

test("Soccer result candidates skip a date when every tracked event has verified closed results", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00.000Z", {
      resultStatus: "closed", resultVerified: true,
      providerGeneratedAt: "2026-11-26T10:00:00.000Z"
    }),
    resultEvent("2026-11-26T09:00:00.000Z", {
      resultStatus: "closed", resultVerified: true,
      providerGeneratedAt: "2026-11-26T11:00:00.000Z"
    })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, []);
  assert.equal(groups.candidateCount, 0);
});

test("Soccer result candidates include pending events on older dates and select the oldest due date", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-24T08:00:00.000Z", { resultStatus: "ended", resultVerified: false }),
    resultEvent("2026-11-26T08:00:00.000Z", { resultStatus: "closed", resultVerified: true, providerGeneratedAt: "2026-11-26T10:00:00Z" })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, ["2026-11-24"]);
  assert.equal(selectOldestDueSoccerResultDate(groups.dates, {}, RESULT_NOW), "2026-11-24");
});

test("Soccer result worker makes zero requests when there are no eligible candidates", () => {
  const groups = buildSoccerResultCandidateGroups([], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, []);
  assert.equal(selectOldestDueSoccerResultDate(groups.dates, {}, RESULT_NOW), null);
});

test("Soccer result candidates outside the configured lookback are skipped for manual review", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-18T08:00:00.000Z", { resultStatus: "ended", resultVerified: false })
  ], { now: RESULT_NOW, maxLookbackDays: 7 });
  assert.deepEqual(groups.dates, []);
  assert.equal(groups.candidateCount, 0);
  assert.equal(groups.manualReviewCount, 1);
});

test("Soccer ended status is not a verified final result; invalid provider timestamps are not final", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00.000Z", {
      resultStatus: "ended", resultVerified: true,
      providerGeneratedAt: "2026-11-26T10:00:00.000Z"
    }),
    resultEvent("2026-11-26T09:00:00.000Z", {
      resultStatus: "closed", resultVerified: true,
      providerGeneratedAt: "not-a-timestamp"
    })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, ["2026-11-26"]);
  assert.equal(groups.candidateCount, 2);
});

test("Soccer result date rotation skips a just-polled oldest date until the next interval", () => {
  const dates = ["2026-11-24", "2026-11-25"];
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-24": RESULT_NOW }, RESULT_NOW, 60_000), "2026-11-25");
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-24": RESULT_NOW }, RESULT_NOW + 60_000, 60_000), "2026-11-24");
});
