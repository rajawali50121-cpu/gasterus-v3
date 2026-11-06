import test from 'node:test';
import assert from 'node:assert/strict';

const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

const finishedEvent = (home, away, halfHome = null, halfAway = null) => ({
  status: 'FINISHED',
  providerStatus: 'FT',
  home: { score: home },
  away: { score: away },
  periodScores: halfHome === null ? {} : { '1H': { home: halfHome, away: halfAway } },
  settlementAuthority: { ft: true, ht: true }
});
const leg = (marketType, selectionLabel, marketLine = null, marketPeriod = 'FT') => ({
  market_type: marketType,
  selection_label: selectionLabel,
  market_line: marketLine,
  market_period: marketPeriod,
  home_team: 'Alpha FC',
  away_team: 'Beta FC'
});

test('derived-market settlement handles Double Chance, DNB refunds, BTTS, and Correct Score', () => {
  const draw = finishedEvent(1, 1);
  assert.equal(evaluateSportsbookLeg(leg('DOUBLE_CHANCE', '1X'), draw).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('DOUBLE_CHANCE', '12'), draw).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('DRAW_NO_BET', 'Home'), draw).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('BTTS', 'Yes'), draw).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('BTTS', 'No'), draw).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('CORRECT_SCORE', '1-1'), draw).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('CORRECT_SCORE', '2-1'), draw).status, 'LOST');

  const homeWin = finishedEvent(2, 1);
  assert.equal(evaluateSportsbookLeg(leg('DOUBLE_CHANCE', 'X2'), homeWin).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('DRAW_NO_BET', 'Home'), homeWin).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('BTTS', 'No'), finishedEvent(2, 0)).status, 'WON');
});

test('derived HT/FT settlement uses both authoritative half-time and full-time scores', () => {
  const event = finishedEvent(2, 1, 0, 1);
  assert.equal(evaluateSportsbookLeg(leg('HT_FT', 'Away / Home'), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('HT_FT', 'Home / Home'), event).status, 'LOST');

  const missingHalfScore = finishedEvent(2, 1);
  assert.equal(evaluateSportsbookLeg(leg('HT_FT', 'Away / Home'), missingHalfScore), null);
  assert.equal(evaluateSportsbookLeg(leg('HT_FT', 'Away / Home'), {
    ...event,
    settlementAuthority: { ft: false, ht: true }
  }), null);
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null, '1H'), {
    ...event,
    settlementAuthority: { ft: true, ht: false }
  }), null);
});

test('quarter-line Asian Handicap settlement computes half wins, half losses, and pushes', () => {
  const event = finishedEvent(2, 1);
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -0.75), event).status, 'HALF_WON');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -1.25), event).status, 'HALF_LOST');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -1), event).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Away', 0.75), event).status, 'HALF_LOST');
});
