import test from "node:test";
import assert from "node:assert/strict";
import { reserveSportradarCall, __quota } from "../src/sportsbook-next/quota.js";

test("quota reservation uses a shared rolling 30-day Redis window", async () => {
  let args;
  const redis = { eval: async (script, options) => { assert.equal(script, __quota.RESERVE_SCRIPT); args = options; return 1; } };
  const config = { initialCallsUsed30Days: 12, maxCallsPer30Days: 100 };
  await reserveSportradarCall(redis, config, 1_800_000_000_000);
  assert.deepEqual(args.keys, [__quota.KEY]);
  assert.equal(args.arguments[1], "12");
  assert.equal(args.arguments[2], "100");
  assert.equal(Number(args.arguments[0]), 1_800_000_000_000 - __quota.WINDOW_MS);
});

test("quota exhaustion fails closed without retrying", async () => {
  let calls = 0;
  const redis = { eval: async () => { calls += 1; return 0; } };
  await assert.rejects(
    reserveSportradarCall(redis, { initialCallsUsed30Days: 100, maxCallsPer30Days: 100 }, 1_800_000_000_000),
    error => error.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"
  );
  assert.equal(calls, 1);
});
