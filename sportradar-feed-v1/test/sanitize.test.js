import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePayload, getRemovalStatus } from "../src/sanitize.js";

test("removes oversized raw fields recursively without altering market IDs and odds", () => {
  const input = { id: "sr:market:1", raw: "large", nested: { raw_payload: "large", odds: 1.8 } };
  assert.deepEqual(sanitizePayload(input), { id: "sr:market:1", nested: { odds: 1.8 } });
});

test("normalizes explicit removed flags on market and nested outcome objects", () => {
  const input = { id: "sr:market:1", removed: "true", outcomes: [{ id: "sr:outcome:2", removed: true }, { id: "sr:outcome:3" }] };
  const result = sanitizePayload(input);
  assert.equal(result.is_removed, true);
  assert.equal(result.outcomes[0].is_removed, true);
  assert.equal(Object.hasOwn(result.outcomes[1], "is_removed"), false);
});

test("does not infer removal from unrelated status text", () => {
  assert.equal(getRemovalStatus({ status: "removed" }), false);
  assert.equal(getRemovalStatus({ removed: false }), false);
});
