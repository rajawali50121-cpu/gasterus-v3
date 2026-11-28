import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderMarket, resolveProviderOutcome } from "../src/sportsbook-next/market-catalog.js";
import { normalizeSoccerResult, normalizeSoccerResults } from "../src/sportsbook-next/results.js";
import { evaluateSoccer1x2Leg, evaluateTicketStatus, calculateTicketPayout } from "../src/sportsbook-next/settlement-rules.js";

const mapping = {
  sportId: "sr:sport:1",
  providerMarketId: "sr:market:1",
  providerMarketName: "1x2",
  periodCode: "FT",
  marketCode: "SOCCER_1X2_3WAY",
  settlementRule: "SOCCER_1X2_3WAY",
  mappingStatus: "VERIFIED",
  enabled: true,
  mappingVersion: 1,
  outcomes: { HOME: "HOME", DRAW: "DRAW", AWAY: "AWAY" }
};

test("provider market mapping requires exact sport, market ID, name and period", () => {
  const resolved = resolveProviderMarket({
    sportId: "sr:sport:1", providerMarketId: "sr:market:1",
    providerMarketName: "1x2", periodCode: "FT", mappings: [mapping]
  });
  assert.equal(resolved.status, "MAPPED");
  assert.equal(resolved.bettable, true);
  assert.equal(resolved.marketCode, "SOCCER_1X2_3WAY");
  const wrongPeriod = resolveProviderMarket({
    sportId: "sr:sport:1", providerMarketId: "sr:market:1",
    providerMarketName: "1x2", periodCode: "HT", mappings: [mapping]
  });
  assert.equal(wrongPeriod.status, "UNMAPPED");
  assert.equal(wrongPeriod.bettable, false);
});

test("unverified or disabled provider market mappings can never be bettable", () => {
  const resolved = resolveProviderMarket({
    sportId: mapping.sportId, providerMarketId: mapping.providerMarketId,
    providerMarketName: mapping.providerMarketName, periodCode: mapping.periodCode,
    mappings: [{ ...mapping, mappingStatus: "PENDING", enabled: true }]
  });
  assert.equal(resolved.bettable, false);
  assert.equal(resolveProviderOutcome({ outcomeType: "HOME", mapping: resolved }).bettable, false);
});

test("market resolver accepts exact PostgreSQL snake_case mapping rows", () => {
  const row = {
    sport_id: mapping.sportId, provider_market_id: mapping.providerMarketId,
    provider_market_name: mapping.providerMarketName, period_code: mapping.periodCode,
    market_code: mapping.marketCode, settlement_rule: mapping.settlementRule,
    mapping_status: "VERIFIED", enabled: true, mapping_version: 2, outcomes: mapping.outcomes
  };
  const resolved = resolveProviderMarket({
    sportId: mapping.sportId, providerMarketId: mapping.providerMarketId,
    providerMarketName: mapping.providerMarketName, periodCode: mapping.periodCode, mappings: [row]
  });
  assert.equal(resolved.bettable, true);
  assert.equal(resolved.mappingVersion, 2);
  assert.equal(resolveProviderOutcome({ outcomeType: "HOME", mapping: resolved }).outcomeCode, "HOME");
});

test("provider outcome mapping is explicit and rejects unknown outcome types", () => {
  const resolved = resolveProviderMarket({
    sportId: mapping.sportId, providerMarketId: mapping.providerMarketId,
    providerMarketName: mapping.providerMarketName, periodCode: mapping.periodCode, mappings: [mapping]
  });
  assert.deepEqual(resolveProviderOutcome({ outcomeType: "home", mapping: resolved }),
    { status: "MAPPED", bettable: true, outcomeCode: "HOME" });
  assert.equal(resolveProviderOutcome({ outcomeType: "unknown", mapping: resolved }).bettable, false);
});

test("closed soccer results remain verifiable when optional provider generated_at is absent", () => {
  const live = normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:10" },
    sport_event_status: { status: "live", home_score: 1, away_score: 0 }
  }, { generatedAt: "2026-11-25T01:00:00Z" });
  assert.equal(live.isFinal, false);
  assert.equal(live.verified, false);
  const final = normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:10" },
    sport_event_status: { status: "closed", home_score: 2, away_score: 1 }
  }, { generatedAt: "2026-11-25T01:00:00Z" });
  assert.equal(final.isFinal, true);
  assert.equal(final.verified, true);
  const noTimestamp = normalizeSoccerResult({
    sport_event: { id: "sr:sport_event:10" },
    sport_event_status: { status: "closed", home_score: 2, away_score: 1 }
  });
  assert.equal(noTimestamp.providerGeneratedAt, null);
  assert.equal(noTimestamp.verified, true);
  assert.ok(noTimestamp.receivedAt);
});

test("result feed validates its root shape and event identity", () => {
  assert.throws(() => normalizeSoccerResults({ summaries: {} }), /SPORTRADAR_RESULTS_SHAPE_INVALID/);
  assert.throws(() => normalizeSoccerResult({ sport_event: { id: "bad" }, sport_event_status: {} }), /SPORTRADAR_RESULT_EVENT_ID_INVALID/);
});

test("settlement evaluates only explicitly mapped and verified soccer 1X2 results", () => {
  const result = { status: "closed", homeScore: 2, awayScore: 1, isFinal: true, verified: true };
  assert.equal(evaluateSoccer1x2Leg({ marketCode: "SOCCER_1X2_3WAY", outcomeCode: "HOME", result }), "WON");
  assert.equal(evaluateSoccer1x2Leg({ marketCode: "SOCCER_1X2_3WAY", outcomeCode: "DRAW", result }), "LOST");
  assert.equal(evaluateSoccer1x2Leg({ marketCode: "UNMAPPED", outcomeCode: "HOME", result }), null);
  assert.equal(evaluateSoccer1x2Leg({ marketCode: "SOCCER_1X2_3WAY", outcomeCode: "HOME", result: { ...result, verified: false } }), null);
  assert.equal(evaluateSoccer1x2Leg({ marketCode: "SOCCER_1X2_3WAY", outcomeCode: "HOME", result: { status: "cancelled", isFinal: true, verified: true } }), "VOID");
});

test("parlay settlement waits for all legs and payout excludes void or push legs", () => {
  assert.equal(evaluateTicketStatus(["WON", "PENDING"]), null);
  assert.equal(evaluateTicketStatus(["WON", "LOST", "PENDING"]), "LOST");
  assert.equal(evaluateTicketStatus(["WON", "VOID"]), "WON");
  assert.equal(evaluateTicketStatus(["VOID", "PUSH"]), "VOID");
  assert.equal(calculateTicketPayout(10000, [
    { resultStatus: "WON", acceptedOdds: 2 },
    { resultStatus: "VOID", acceptedOdds: 1.8 },
    { resultStatus: "PUSH", acceptedOdds: 1.5 }
  ]), 20000);
});
