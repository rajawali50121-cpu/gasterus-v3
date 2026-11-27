import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateSportsbookBetAmounts,
  decimalOddsToMicros,
  normalizeSportsbookLegInput,
  getSportsbookBetAcceptanceReadiness,
  __sportsbookBetting
} from "../src/sportsbook-next/betting-service.js";

const readyEnv = {
  SPORTSBOOK_BET_ACCEPTANCE_ENABLED: "true",
  SPORTSBOOK_SETTLEMENT_ENABLED: "true",
  SPORTRADAR_ODDS_ENABLED: "true",
  SPORTRADAR_CHANGELOG_ENABLED: "true",
  SPORTRADAR_ACCESS_LEVEL: "production",
  SPORTRADAR_SOCCER_ENABLED: "true",
  SPORTRADAR_SOCCER_ACCESS_LEVEL: "production",
  SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED: "true",
  SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "800",
  SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE: "0",
  SPORTRADAR_SOCCER_POLL_MINUTES: "60",
  SPORTRADAR_QUOTA_BASELINE_CONFIRMED: "true",
  SPORTRADAR_MAX_CALLS_PER_30_DAYS: "14000",
  SPORTRADAR_SCHEDULE_POLL_MINUTES: "60",
  SPORTSBOOK_POLL_MINUTES: "150",
  SPORTRADAR_DAYS_AHEAD: "0",
  SPORTRADAR_SPORT_IDS: "sr:sport:1",
  SPORTRADAR_INITIAL_30_DAY_USAGE: "0",
  SPORTRADAR_CHANGELOG_POLL_SECONDS: "240",
  SPORTRADAR_MAX_CALLS_PER_CYCLE: "80",
  SPORTSBOOK_BET_MAX_STAKE_IDR: "100000",
  SPORTSBOOK_BET_MAX_PAYOUT_IDR: "10000000"
};

function healthyRedis(now, { refreshPending = false, lastSuccessAgeMs = 15_000 } = {}) {
  const values = new Map([
    [__sportsbookBetting.FEED_STATUS_KEY, JSON.stringify({
      complete: true, changeLogPoll: true, quotaLimited: false, errorCount: 0,
      reconcilePending: 0, changedPending: 0
    })],
    [__sportsbookBetting.SNAPSHOT_KEY, JSON.stringify({ complete: true, refreshPending })],
    [__sportsbookBetting.CHANGE_LOG_LAST_SUCCESS_KEY, String(now - lastSuccessAgeMs)],
    [__sportsbookBetting.SOCCER_STATUS_KEY, JSON.stringify({ cycleComplete: true, dateComplete: true })],
    [__sportsbookBetting.SOCCER_HEARTBEAT_KEY, new Date(now - 15_000).toISOString()],
    [__sportsbookBetting.SETTLEMENT_STATUS_KEY, JSON.stringify({ healthy: true })],
    [__sportsbookBetting.SETTLEMENT_HEARTBEAT_KEY, new Date(now - 15_000).toISOString()]
  ]);
  return { get: async key => values.get(key) ?? null };
}

test("client bet selections must use canonical Sportradar sport-event URNs", () => {
  const leg = normalizeSportsbookLegInput({
    providerEventId: "sr:sport_event:123456",
    providerMarketKey: "sr:market:1|Match Winner",
    providerBookId: "sr:book:1",
    providerSelectionKey: "sr:outcome:home|",
    expectedOdds: "2.10"
  });
  assert.equal(leg.providerEventId, "sr:sport_event:123456");
  assert.equal(leg.expectedOddsMicros, 2_100_000n);
  for (const providerEventId of ["sr:match:123456", "sr:sport_event:abc", "sr:sport_event:\\123"]) {
    assert.throws(() => normalizeSportsbookLegInput({
      providerEventId, providerMarketKey: "m", providerBookId: "b",
      providerSelectionKey: "s", expectedOdds: "2.10"
    }), error => error.code === "SPORTSBOOK_EVENT_ID_INVALID");
  }
});

test("decimal odds are parsed to exact six-decimal integer precision", () => {
  assert.equal(decimalOddsToMicros("2.10"), 2_100_000n);
  assert.equal(decimalOddsToMicros("12.345678"), 12_345_678n);
  assert.throws(() => decimalOddsToMicros("1.00"), error => error.code === "SPORTSBOOK_ODDS_OUT_OF_RANGE");
  assert.throws(() => decimalOddsToMicros("2e0"), error => error.code === "SPORTSBOOK_ODDS_INVALID");
  assert.throws(() => decimalOddsToMicros("2.1234567"), error => error.code === "SPORTSBOOK_ODDS_INVALID");
});

test("parlay odds and payout use fixed-point integer arithmetic", () => {
  assert.deepEqual(
    calculateSportsbookBetAmounts(10_000, ["2.10", "1.80"], 50_000),
    { totalOdds: "3.780000", potentialPayout: 37_800, oddsMicros: ["2100000", "1800000"] }
  );
  assert.equal(calculateSportsbookBetAmounts(1_000, ["1.91", "1.91"], 10_000).potentialPayout, 3_648);
});

test("payout ceiling and invalid stake are enforced before ledger debit", () => {
  assert.throws(() => calculateSportsbookBetAmounts(10_000, ["2.10"], 20_000),
    error => error.code === "SPORTSBOOK_PAYOUT_LIMIT");
  assert.throws(() => calculateSportsbookBetAmounts(0, ["2.10"], 20_000),
    error => error.code === "SPORTSBOOK_STAKE_INVALID");
});

test("bet acceptance requires production entitlement and continuous complete Change Log coverage", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now), env: readyEnv, now
  });
  assert.equal(readiness.enabled, true);
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.lastChangeLogSuccessAt, new Date(now - 15_000).toISOString());
});

test("trial quota and an unverified Change Log window fail closed", async () => {
  const now = 1_800_000_000_000;
  const trial = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now), env: { ...readyEnv, SPORTRADAR_ACCESS_LEVEL: "trial", SPORTRADAR_MAX_CALLS_PER_30_DAYS: "800" }, now
  });
  assert.equal(trial.enabled, false);
  assert.ok(trial.reasons.includes("PRODUCTION_ENTITLEMENT_REQUIRED"));
  assert.ok(trial.reasons.includes("CHANGE_LOG_QUOTA_BUDGET_INSUFFICIENT"));

  const pending = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now, { refreshPending: true }), env: readyEnv, now
  });
  assert.equal(pending.enabled, false);
  assert.ok(pending.reasons.includes("SPORTSBOOK_RECONCILIATION_PENDING"));
});

test("stale Change Log coverage blocks ticket acceptance", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now, { lastSuccessAgeMs: 5 * 60 * 1000 + 1 }), env: readyEnv, now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("CHANGE_LOG_WINDOW_STALE"));
});

test("no approved verified full-time mapping keeps betting disabled", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 0,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now), env: readyEnv, now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("NO_VERIFIED_MARKET_MAPPINGS"));
});

test("stale Soccer result or settlement worker heartbeat blocks new bets", async () => {
  const now = 1_800_000_000_000;
  const values = new Map([
    [__sportsbookBetting.FEED_STATUS_KEY, JSON.stringify({
      complete: true, changeLogPoll: true, quotaLimited: false, errorCount: 0
    })],
    [__sportsbookBetting.SNAPSHOT_KEY, JSON.stringify({ complete: true, refreshPending: false })],
    [__sportsbookBetting.CHANGE_LOG_LAST_SUCCESS_KEY, String(now - 15_000)],
    [__sportsbookBetting.SOCCER_STATUS_KEY, JSON.stringify({ cycleComplete: true })],
    [__sportsbookBetting.SOCCER_HEARTBEAT_KEY, new Date(now - 5 * 60 * 60 * 1000).toISOString()],
    [__sportsbookBetting.SETTLEMENT_STATUS_KEY, JSON.stringify({ healthy: false })],
    [__sportsbookBetting.SETTLEMENT_HEARTBEAT_KEY, new Date(now - 15_000).toISOString()]
  ]);
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: { get: async key => values.get(key) ?? null },
    env: readyEnv, now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("SOCCER_RESULTS_HEARTBEAT_STALE"));
  assert.ok(readiness.reasons.includes("SETTLEMENT_WORKER_UNHEALTHY"));
});

test("insufficient independent Soccer product quota blocks bet acceptance", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now),
    env: { ...readyEnv, SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS: "300" },
    now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("SOCCER_QUOTA_BUDGET_INSUFFICIENT"));
});

test("unfunded sportsbook risk reserve blocks bet acceptance before any ticket is placed", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 1,
    loadRiskReserveBalance: async () => 9_999_999,
    redis: healthyRedis(now), env: readyEnv, now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("RISK_RESERVE_BELOW_MAX_SINGLE_TICKET_PAYOUT"));
  assert.equal(readiness.riskReserveBalance, 9_999_999);
  assert.equal(readiness.requiredRiskReserveBalance, 10_000_000);
});

test("stale or missing Daily Schedules verification blocks ticket acceptance", async () => {
  const now = 1_800_000_000_000;
  const readiness = await getSportsbookBetAcceptanceReadiness({
    loadMappingCount: async () => 1,
    loadScheduleCount: async () => 0,
    loadRiskReserveBalance: async () => 10_000_000,
    redis: healthyRedis(now), env: readyEnv, now
  });
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.reasons.includes("NO_FRESH_DAILY_SCHEDULES"));
});
