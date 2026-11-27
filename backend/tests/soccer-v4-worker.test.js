import test from "node:test";
import assert from "node:assert/strict";
import { loadSoccerV4Config } from "../src/sportsbook-next/soccer-v4-config.js";
import { SoccerV4Client, parseSoccerCacheTtlMs, getSoccerNextPageStart } from "../src/sportsbook-next/soccer-v4-client.js";
import { __soccerQuota, reserveSoccerV4Call } from "../src/sportsbook-next/soccer-v4-quota.js";
import { buildSoccerResultCandidateGroups, selectOldestDueSoccerResultDate } from "../src/sportsbook-next/results-repository.js";
import { normalizeSoccerResult, normalizeSoccerResults, normalizeSportEventId } from "../src/sportsbook-next/results.js";

test("Soccer v4 is disabled by default and does not require a key or quota", () => {
  const config = loadSoccerV4Config({});
  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 60 * 60 * 1000);
  assert.equal(config.resultBufferMinutes, 150);
  assert.equal(config.maxLookbackDays, 7);
  assert.equal(config.maxCallsPerCycle, 1);
});

test("enabled Soccer v4 requires an explicit independent quota and usage baseline", () => {
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_API_KEY: "test-key"
  }), /SOCCER_MAX_CALLS_PER_30_DAYS/);
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0",
    SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true"
  });
  assert.equal(config.maxCallsPer30Days, 800);
  assert.equal(config.initialCallsUsed30Days, 0);
  assert.equal(config.baseUrl, "https://api.sportradar.com/soccer/trial/v4/en");
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0"
  }), /requires confirmed Soccer product usage/);
  assert.throws(() => loadSoccerV4Config({ SPORTRADAR_SOCCER_POLL_MINUTES: "30" }), /exactly 60 minutes/);
  assert.throws(() => loadSoccerV4Config({ SPORTRADAR_SOCCER_POLL_MINUTES: "90" }), /exactly 60 minutes/);
  assert.throws(() => loadSoccerV4Config({ SPORTRADAR_SOCCER_MAX_CALLS_PER_CYCLE: "2" }), /one request per cycle/);
});

test("Soccer v4 client calls only the Soccer summaries endpoint with x-api-key", async () => {
  const config = loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_SOCCER_API_KEY: "secret-test",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
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
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_SOCCER_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
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
const resultEvent = (scheduledAt, result = {}) => ({ providerEventId: "sr:sport_event:" + Date.parse(scheduledAt), scheduledAt, ...result });

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
    resultEvent("2026-11-18T08:00:00.000Z", { providerEventId: "sr:sport_event:manual-review", resultStatus: "ended", resultVerified: false })
  ], { now: RESULT_NOW, maxLookbackDays: 7 });
  assert.deepEqual(groups.dates, []);
  assert.equal(groups.candidateCount, 0);
  assert.equal(groups.manualReviewCount, 1);
  assert.deepEqual(groups.manualReviewEventIds, ["sr:sport_event:manual-review"]);
});

test("Soccer ended remains pending while provider-confirmed closed is final without generated_at", () => {
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
  assert.equal(groups.candidateCount, 1);
});

test("Soccer result date rotation skips a just-polled oldest date until the next interval", () => {
  const dates = ["2026-11-24", "2026-11-25"];
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-24": RESULT_NOW }, RESULT_NOW, 60_000), "2026-11-25");
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-24": RESULT_NOW }, RESULT_NOW + 60_000, 60_000), "2026-11-24");
});


test("Soccer result polling is hourly for today and daily for historical dates", () => {
  const now = Date.parse("2026-11-28T12:00:00.000Z");
  const dates = ["2026-11-26", "2026-11-28"];
  const interval = date => date === "2026-11-28" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-26": now - 23 * 60 * 60 * 1000, "2026-11-28": now - 30 * 60 * 1000 }, now, 60 * 60 * 1000, {}, interval), null);
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-26": now - 24 * 60 * 60 * 1000, "2026-11-28": now - 30 * 60 * 1000 }, now, 60 * 60 * 1000, {}, interval), "2026-11-26");
  assert.equal(selectOldestDueSoccerResultDate(dates, { "2026-11-26": now, "2026-11-28": now - 60 * 60 * 1000 }, now, 60 * 60 * 1000, {}, interval), "2026-11-28");
});

test("Soccer result buffer excludes kickoffs that have not passed the configured buffer", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-27T10:00:00.000Z", { resultStatus: "unknown" })
  ], { now: RESULT_NOW, bufferMinutes: 150 });
  assert.deepEqual(groups.dates, []);
  assert.equal(groups.candidateCount, 0);
});


test("Soccer event without a stored result remains a candidate before cancellation is persisted", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00.000Z")
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, ["2026-11-26"]);
  assert.equal(groups.candidateCount, 1);
});


test("Soccer 381-event date paginates 200 then 181 and completes from X-Result headers", () => {
  const firstNext = getSoccerNextPageStart({
    start: 0, limit: 200, returned: 200, maxResults: 381, resultCountHeader: 200
  });
  assert.equal(firstNext, 200);
  const secondNext = getSoccerNextPageStart({
    start: firstNext, limit: 200, returned: 181, maxResults: 381, resultCountHeader: 381
  });
  assert.equal(secondNext, 0);
  assert.equal(selectOldestDueSoccerResultDate(
    ["2026-11-24", "2026-11-25"],
    { "2026-11-24": RESULT_NOW, "2026-11-25": RESULT_NOW },
    RESULT_NOW, 60 * 60 * 1000,
    { "2026-11-24": firstNext }
  ), "2026-11-24");
});

test("Soccer postponed event with replaced_by is excluded and replacement ID is retained for review", () => {
  const normalized = normalizeSoccerResult({
    sport_event: { id: "sr:match:7001", replaced_by: { id: "sr:sport_event:8001" } },
    sport_event_status: { status: "postponed" }
  }, { generatedAt: "2026-11-26T12:00:00Z", receivedAt: "2026-11-27T12:00:00Z" });
  assert.equal(normalized.eventId, "sr:sport_event:7001");
  assert.equal(normalized.replacedBy, "sr:sport_event:8001");
  assert.equal(normalized.reviewRequired, true);
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00Z", {
      resultStatus: "postponed", providerPayload: normalized.payload
    })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, []);
  assert.deepEqual(groups.manualReviewEvents, [{
    eventId: "sr:sport_event:7001",
    replacedBy: "sr:sport_event:8001",
    reason: "postponed_replaced"
  }]);
});

test("Soccer suspended remains a result candidate", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00Z", { resultStatus: "suspended" })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, ["2026-11-26"]);
});

test("Soccer cancelled is provider-confirmed terminal state and can be voided without a score", () => {
  const result = normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:9001" },
    sport_event_status: { status: "cancelled", home_score: 2, away_score: 1 }
  }, { generatedAt: "2026-11-26T12:00:00Z", receivedAt: "2026-11-27T12:00:00Z" });
  assert.equal(result.isFinal, true);
  assert.equal(result.verified, true);
  assert.equal(result.homeScore, null);
  assert.equal(result.awayScore, null);
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00Z", {
      resultStatus: "cancelled", resultVerified: false,
      providerGeneratedAt: "2026-11-26T12:00:00Z"
    })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, []);
});

test("Soccer abandoned is excluded from polling and flagged for manual review", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00Z", { resultStatus: "abandoned" })
  ], { now: RESULT_NOW });
  assert.deepEqual(groups.dates, []);
  assert.equal(groups.manualReviewEvents[0].reason, "abandoned");
});

test("Soccer match and sport_event prefixes normalize to one ID and duplicate summaries", () => {
  assert.equal(normalizeSportEventId("sr:match:123"), "sr:sport_event:123");
  assert.equal(normalizeSportEventId("sr:sport_event:123"), "sr:sport_event:123");
  assert.equal(normalizeSportEventId("other:match:123"), null);
  const results = normalizeSoccerResults({
    generated_at: "2026-11-26T12:00:00Z",
    summaries: [
      { sport_event: { id: "sr:match:123" }, sport_event_status: { status: "ended" } },
      { sport_event: { id: "sr:sport_event:123" }, sport_event_status: { status: "closed", home_score: 1, away_score: 0 } }
    ]
  }, "2026-11-27T12:00:00Z");
  assert.equal(results.length, 1);
  assert.equal(results[0].eventId, "sr:sport_event:123");
  assert.equal(results[0].status, "closed");
  assert.equal(results[0].homeScore, 1);
});


test("Soccer candidate repository deduplicates sr:match and sr:sport_event aliases", () => {
  const groups = buildSoccerResultCandidateGroups([
    resultEvent("2026-11-26T08:00:00Z", { providerEventId: "sr:match:123" }),
    resultEvent("2026-11-26T08:00:00Z", { providerEventId: "sr:sport_event:123" })
  ], { now: RESULT_NOW });
  assert.equal(groups.candidateCount, 1);
  assert.deepEqual(groups.dates, ["2026-11-26"]);
});

test("Soccer result remains verified when generated_at is absent and receipt time stays separate", () => {
  const results = normalizeSoccerResults({
    summaries: [{
      sport_event: { id: "sr:sport_event:9002" },
      sport_event_status: { status: "closed", home_score: 2, away_score: 1 }
    }]
  }, "2026-11-27T12:00:00Z");
  assert.equal(results.length, 1);
  assert.equal(results[0].providerGeneratedAt, null);
  assert.equal(results[0].verified, true);
  assert.equal(results[0].receivedAt, "2026-11-27T12:00:00.000Z");
});

test("Soccer v4 rejects a polling cadence that exceeds remaining rolling quota", () => {
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_SOCCER_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "500",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0",
    SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true",
    SPORTRADAR_SOCCER_POLL_MINUTES: "60"
  }), /quota budget is insufficient/);
  assert.throws(() => loadSoccerV4Config({
    SPORTRADAR_SOCCER_ENABLED: "true",
    SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS: "2",
    SPORTRADAR_SOCCER_API_KEY: "test-key",
    SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
    SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0",
    SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true",
    SPORTRADAR_SOCCER_POLL_MINUTES: "90"
  }), /exactly 60 minutes/);
});
