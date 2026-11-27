import test from "node:test";
import assert from "node:assert/strict";
import { reserveSportradarCall, __quota } from "../src/sportsbook-next/quota.js";

test("quota reservation uses a shared rolling 30-day Redis window", async () => {
  let args;
  const redis = { eval: async (script, options) => { assert.equal(script, __quota.RESERVE_SCRIPT); args = options; return 1; } };
  const config = { initialCallsUsed30Days: 12, maxCallsPer30Days: 100, maxCallsPerHour: 20 };
  await reserveSportradarCall(redis, config, 1_800_000_000_000);
  assert.deepEqual(args.keys, [__quota.KEY, __quota.BASELINE_KEY]);
  assert.equal(args.arguments[2], "12");
  assert.equal(args.arguments[4], "20");
  assert.equal(args.arguments[5], "100");
  assert.equal(Number(args.arguments[0]), 1_800_000_000_000 - __quota.WINDOW_MS);
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

test("quota reservation stops nonessential Odds polling at 90 percent of the configured ceiling", async () => {
  let optionsSeen;
  const redis = { eval: async (_script, options) => { optionsSeen = options; return [3, 0, 720, 0]; } };
  const error = await assert.rejects(
    reserveSportradarCall(redis, { initialCallsUsed30Days: 0, maxCallsPer30Days: 800, maxCallsPerHour: 0 }, 1_800_000_000_000),
    value => value.code === "SPORTRADAR_QUOTA_90_PERCENT_GUARD" &&
      value.quotaUsed === 720 && value.quotaLimit === 800 && value.quotaThreshold === 720
  );
  assert.ok(optionsSeen);
});

test("shared Sportradar QPS interval is at least 1200ms", () => {
  assert.equal(__quota.QPS_INTERVAL_MS, 1200);
});
