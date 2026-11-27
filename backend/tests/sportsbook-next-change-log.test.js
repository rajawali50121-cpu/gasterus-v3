import test from "node:test";
import assert from "node:assert/strict";
import { getChangedSportEventIds } from "../src/sportsbook-next/change-log.js";

const tracked = new Set(["sr:sport_event:101", "sr:sport_event:202"]);

test("Change Log reads the integration-guide top-level changes envelope", () => {
  assert.deepEqual(getChangedSportEventIds({
    status: { from: 100, to: 400 },
    changes: [
      { type: "sport_event", id: "sr:sport_event:101" },
      { type: "sport_event", id: "sr:sport_event:101" },
      { type: "sport_event", id: "sr:sport_event:999" },
      { type: "competition", id: "sr:sport_event:202" }
    ]
  }, tracked), ["sr:sport_event:101"]);
});

test("Change Log also reads the endpoint-reference status.change envelope", () => {
  assert.deepEqual(getChangedSportEventIds({
    status: {
      from: 100, to: 400,
      change: [
        { type: "sport_event", id: "sr:sport_event:202" },
        { type: "sport_event", id: "sr:sport_event:101" }
      ]
    }
  }, tracked), ["sr:sport_event:202", "sr:sport_event:101"]);
});

test("Change Log rejects unknown envelopes instead of silently advancing coverage", () => {
  assert.throws(() => getChangedSportEventIds({ status: { from: 100, to: 400 } }, tracked),
    /SPORTRADAR_CHANGELOG_SHAPE_INVALID/);
});
