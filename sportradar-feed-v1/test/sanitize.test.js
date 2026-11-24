import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePayload, getRemovalStatus } from "../src/sanitize.js";

test("removes oversized raw fields recursively without altering market data", () => {
  const input = { id: "sr:market:1", raw: "large", nested: { raw_payload: "large", odds: 1.8 } };
  assert.deepEqual(sanitizePayload(input), { id: "sr:market:1", nested: { odds: 1.8 } });
});

test("recognizes removed only when the provider explicitly supplies true", () => {
  assert.equal(getRemovalStatus({ removed: "true" }), true);
  assert.equal(getRemovalStatus({ removed: true }), true);
  assert.equal(getRemovalStatus({ removed: false }), false);
  assert.equal(getRemovalStatus({ status: "removed" }), false);
});
