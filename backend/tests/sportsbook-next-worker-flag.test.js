import test from "node:test";
import assert from "node:assert/strict";
import { isSportradarOddsEnabled } from "../src/sportsbook-next/config.js";

test("Sportradar Odds worker is OFF when unset, empty, false, or any non-true value", () => {
  for (const value of [undefined, "", " ", "false", "0", "1", "yes", " true ", "true\n"]) {
    assert.equal(isSportradarOddsEnabled({ SPORTRADAR_ODDS_ENABLED: value }), false, String(value));
  }
  assert.equal(isSportradarOddsEnabled({}), false);
});

test("Sportradar Odds worker is ON only for exact true, case-insensitive", () => {
  for (const value of ["true", "TRUE", "True", "tRuE"]) {
    assert.equal(isSportradarOddsEnabled({ SPORTRADAR_ODDS_ENABLED: value }), true, value);
  }
});
