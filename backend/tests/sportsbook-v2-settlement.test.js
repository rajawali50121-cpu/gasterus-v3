import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSoccer1x2Leg, evaluateTicketStatus, calculateTicketPayout } from "../src/sportsbook-next/settlement-rules.js";

test("verified soccer 1X2 outcomes settle home, draw, and away correctly", () => {
  assert.equal(evaluateSoccer1x2Leg({marketName:"1x2",outcomeType:"home",homeScore:2,awayScore:1}),"WON");
  assert.equal(evaluateSoccer1x2Leg({marketName:"3-way",outcomeType:"draw",homeScore:1,awayScore:1}),"WON");
  assert.equal(evaluateSoccer1x2Leg({marketName:"winner",outcomeType:"away",homeScore:0,awayScore:2}),"WON");
  assert.equal(evaluateSoccer1x2Leg({marketName:"1x2",outcomeType:"home",homeScore:0,awayScore:1}),"LOST");
});

test("unsupported market types remain pending rather than guessing a result", () => {
  assert.equal(evaluateSoccer1x2Leg({marketName:"total goals",outcomeType:"over",homeScore:2,awayScore:1}),null);
});

test("provider-confirmed cancellation voids a leg", () => {
  assert.equal(evaluateSoccer1x2Leg({marketName:"total goals",outcomeType:"over",cancelled:true}),"VOID");
});

test("ticket status waits for all legs unless one leg loses", () => {
  assert.equal(evaluateTicketStatus(["WON","PENDING"]),null);
  assert.equal(evaluateTicketStatus(["WON","LOST","PENDING"]),"LOST");
  assert.equal(evaluateTicketStatus(["WON","VOID"]),"WON");
  assert.equal(evaluateTicketStatus(["VOID","PUSH"]),"VOID");
});

test("parlay payout excludes void and push legs; all-void refunds stake", () => {
  assert.equal(calculateTicketPayout(10000,[
    {result_status:"WON",accepted_odds:2},
    {result_status:"VOID",accepted_odds:1.8},
    {result_status:"PUSH",accepted_odds:1.5}
  ]),20000);
  assert.equal(calculateTicketPayout(10000,[
    {result_status:"VOID",accepted_odds:1.8},
    {result_status:"PUSH",accepted_odds:1.5}
  ]),10000);
});
