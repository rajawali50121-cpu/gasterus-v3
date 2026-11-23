import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSoccerLeg, evaluateTicketStatus, calculateTicketPayout } from "../src/sportsbook-next/settlement-rules.js";

test("verified soccer 1X2 outcomes settle home, draw, and away correctly", () => {
  assert.equal(evaluateSoccerLeg({marketName:"1x2",outcomeType:"home",homeScore:2,awayScore:1}),"WON");
  assert.equal(evaluateSoccerLeg({marketName:"3-way",outcomeType:"draw",homeScore:1,awayScore:1}),"WON");
  assert.equal(evaluateSoccerLeg({marketName:"winner",outcomeType:"away",homeScore:0,awayScore:2}),"WON");
  assert.equal(evaluateSoccerLeg({marketName:"1x2",outcomeType:"home",homeScore:0,awayScore:1}),"LOST");
});

test("full-time totals and handicaps settle pushes and wins", () => {
  assert.equal(evaluateSoccerLeg({marketName:"total",outcomeType:"over",line:"2.5",homeScore:2,awayScore:1}),"WON");
  assert.equal(evaluateSoccerLeg({marketName:"total",outcomeType:"under",line:"3",homeScore:2,awayScore:1}),"PUSH");
  assert.equal(evaluateSoccerLeg({marketName:"handicap",outcomeType:"home",line:"-1",homeScore:2,awayScore:1}),"PUSH");
  assert.equal(evaluateSoccerLeg({marketName:"asian handicap",outcomeType:"away",line:"1",homeScore:2,awayScore:1}),"PUSH");
});

test("double chance, draw-no-bet and both-teams-to-score settle from final scores", () => {
  assert.equal(evaluateSoccerLeg({marketName:"double chance",outcomeType:"home_draw",homeScore:1,awayScore:1}),"WON");
  assert.equal(evaluateSoccerLeg({marketName:"draw no bet",outcomeType:"home",homeScore:1,awayScore:1}),"PUSH");
  assert.equal(evaluateSoccerLeg({marketName:"both teams to score",outcomeType:"yes",homeScore:1,awayScore:1}),"WON");
});

test("unsupported market types remain pending rather than guessing a result", () => {
  assert.equal(evaluateSoccerLeg({marketName:"player props",outcomeType:"over",homeScore:2,awayScore:1}),null);
});

test("provider-confirmed cancellation voids a leg", () => {
  assert.equal(evaluateSoccerLeg({marketName:"player props",outcomeType:"over",cancelled:true}),"VOID");
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
