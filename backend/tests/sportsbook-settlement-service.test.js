import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateSportsbookSettlementPayout,
  evaluateSportsbookTicketResults
} from "../src/sportsbook-next/settlement-service.js";

const leg = overrides => ({
  id: "leg-1",
  provider_event_id: "sr:sport_event:1001",
  market_code: "SOCCER_1X2_3WAY",
  outcome_code: "HOME",
  settlement_rule: "SOCCER_1X2_3WAY",
  accepted_odds: "2.100000",
  ...overrides
});

const result = overrides => ({
  provider_event_id: "sr:sport_event:1001",
  result_source: "sportradar-soccer-v4",
  event_status: "closed",
  home_score: 2,
  away_score: 1,
  source_updated_at: null,
  received_at: new Date("2026-11-27T12:00:00Z"),
  verified: true,
  ...overrides
});

test("only confirmed Soccer closed results settle a mapped 1X2 leg", () => {
  const evaluation = evaluateSportsbookTicketResults([leg()], [result()]);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ticketStatus, "WON");
  assert.deepEqual(evaluation.legStatuses, [{ legId: "leg-1", resultStatus: "WON" }]);
  assert.equal(evaluation.resultPayloads[0].providerGeneratedAt, null);
});

test("ended is not final and cannot settle a ticket", () => {
  const evaluation = evaluateSportsbookTicketResults(
    [leg()], [result({ event_status: "ended" })]
  );
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.reason, "RESULT_NOT_FINAL");
});

test("cancelled is a provider-confirmed VOID even without scores", () => {
  const evaluation = evaluateSportsbookTicketResults(
    [leg()], [result({ event_status: "cancelled", home_score: null, away_score: null })]
  );
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ticketStatus, "VOID");
  assert.deepEqual(evaluation.legStatuses, [{ legId: "leg-1", resultStatus: "VOID" }]);
  assert.equal(calculateSportsbookSettlementPayout(10_000, "VOID", [
    { accepted_odds: "2.10", resultStatus: "VOID" }
  ]), 10_000);
});

test("unverified, missing, suspended or ended results remain unsettled", () => {
  for (const rows of [
    [],
    [result({ verified: false })],
    [result({ event_status: "suspended" })]
  ]) {
    const evaluation = evaluateSportsbookTicketResults([leg()], rows);
    assert.equal(evaluation.ready, false);
  }
});

test("unmapped settlement contract is quarantined instead of graded as a loss", () => {
  const evaluation = evaluateSportsbookTicketResults(
    [leg({ market_code: "UNKNOWN", settlement_rule: "UNKNOWN" })], [result()]
  );
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.manualReview, true);
  assert.equal(evaluation.reason, "SETTLEMENT_MAPPING_UNSUPPORTED");
});

test("fixed-point parlay payout excludes void legs and truncates fractional IDR", () => {
  assert.equal(calculateSportsbookSettlementPayout(10_000, "WON", [
    { accepted_odds: "2.100000", resultStatus: "WON" },
    { accepted_odds: "1.500000", resultStatus: "VOID" },
    { accepted_odds: "1.800000", resultStatus: "WON" }
  ]), 37_800);
  assert.equal(calculateSportsbookSettlementPayout(10_000, "LOST", [
    { accepted_odds: "2.10", resultStatus: "LOST" }
  ]), 0);
});

test("settlement payout rejects invalid stored ticket values", () => {
  assert.throws(() => calculateSportsbookSettlementPayout(0, "WON", [
    { accepted_odds: "2.10", resultStatus: "WON" }
  ]), error => error.code === "SPORTSBOOK_SETTLEMENT_PAYOUT_INVALID");
});
