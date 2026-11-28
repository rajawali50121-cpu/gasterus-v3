import test from "node:test";
import assert from "node:assert/strict";
import { reserveSportradarCall, getSportradarQuotaUsage, __quota } from "../src/sportsbook-next/quota.js";

test("quota reservation uses a shared rolling 30-day Redis window", async () => {
  let args;
  const redis = { eval: async (script, options) => { assert.equal(script, __quota.RESERVE_SCRIPT); args = options; return 1; } };
  const config = { initialCallsUsed30Days: 12, maxCallsPer30Days: 100, maxCallsPerHour: 20 };
  await reserveSportradarCall(redis, config, 1_800_000_000_000);
  assert.deepEqual(args.keys, [__quota.KEY, __quota.BASELINE_KEY, __quota.WORKER_KEY, __quota.BET_KEY]);
  assert.equal(args.arguments[2], "12");
  assert.equal(args.arguments[4], "20");
  assert.equal(args.arguments[5], "100");
  assert.equal(args.arguments[7], "100");
  assert.equal(args.arguments[8], "0");
  assert.equal(args.arguments[9], "worker");
  assert.equal(Number(args.arguments[0]), 1_800_000_000_000 - __quota.WINDOW_MS);
});

test("provider revalidation quota is reserved separately from worker quota", async () => {
  let args;
  const redis = { eval: async (_script, options) => { args = options; return 1; } };
  const config = {
    initialCallsUsed30Days: 100, maxCallsPer30Days: 800,
    maxCallsPerHour: 0, betRevalidationCallsPer30Days: 120
  };
  await reserveSportradarCall(redis, config, 1_800_000_000_000, { purpose: "bet" });
  assert.equal(args.arguments[7], "680");
  assert.equal(args.arguments[8], "120");
  assert.equal(args.arguments[9], "bet");
});

test("provider revalidation budget exhaustion has a dedicated fail-closed signal", async () => {
  const redis = { eval: async () => [3, 120, 500, 0] };
  await assert.rejects(
    reserveSportradarCall(redis, {
      initialCallsUsed30Days: 100, maxCallsPer30Days: 800,
      maxCallsPerHour: 0, betRevalidationCallsPer30Days: 120
    }, 1_800_000_000_000, { purpose: "bet" }),
    error => error.code === "SPORTRADAR_BET_REVALIDATION_BUDGET_EXHAUSTED" &&
      error.quotaScope === "bet_revalidation_30_days"
  );
});

test("quota telemetry reports worker and provider revalidation reserves independently", async () => {
  let options;
  const redis = { eval: async (script, args) => {
    assert.equal(script, __quota.USAGE_SCRIPT);
    options = args;
    return [8, 350, 300, 50];
  }};
  const usage = await getSportradarQuotaUsage(redis, {
    initialCallsUsed30Days: 100, maxCallsPer30Days: 800,
    maxCallsPerHour: 0, betRevalidationCallsPer30Days: 120
  }, 1_800_000_000_000);
  assert.deepEqual(options.keys, [__quota.KEY, __quota.BASELINE_KEY, __quota.WORKER_KEY, __quota.BET_KEY]);
  assert.equal(usage.monthlyRemaining, 450);
  assert.equal(usage.workerLimit, 680);
  assert.equal(usage.workerRemaining, 380);
  assert.equal(usage.betRevalidationUsed, 50);
  assert.equal(usage.betRevalidationRemaining, 70);
});

test("quota exhaustion fails closed without retrying", async () => {
  let calls = 0;
  const redis = { eval: async () => { calls += 1; return 0; } };
  await assert.rejects(
    reserveSportradarCall(redis, { initialCallsUsed30Days: 100, maxCallsPer30Days: 100, maxCallsPerHour: 20 }, 1_800_000_000_000),
    error => error.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"
  );
  assert.equal(calls, 1);
});

test("hourly quota exhaustion has its own fail-closed signal", async () => {
  const redis = { eval: async () => 2 };
  await assert.rejects(
    reserveSportradarCall(redis, { initialCallsUsed30Days: 0, maxCallsPer30Days: 100, maxCallsPerHour: 20 }, 1_800_000_000_000),
    error => error.code === "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED"
  );
});
