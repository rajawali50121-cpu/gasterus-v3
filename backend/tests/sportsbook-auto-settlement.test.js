import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');
const { legReturnMultiplier, settleCalculation } = await import('../src/sportsbook-settlement-calculation.js');
const event = { status: 'FINISHED', home: { score: 2 }, away: { score: 1 } };
const leg = (marketType, selectionLabel, marketLine = null) => ({
  market_type: marketType,
  selection_label: selectionLabel,
  market_line: marketLine,
  market_period: 'FT',
  home_team: 'Alpha FC',
  away_team: 'Beta FC'
});

test('auto settlement evaluates core football markets', () => {
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home'), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Draw'), event).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Alpha FC', -1), event).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Over 2.5', 2.5), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('BTTS', 'Yes'), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('CORRECT_SCORE', '2-1'), event).status, 'WON');
});

test('unsupported markets are safely voided', () => {
  assert.equal(evaluateSportsbookLeg(leg('PLAYER_PROPS', 'Player A'), event).status, 'VOID');
});

test('settlement calculator returns the expected amount for every final leg outcome', () => {
  const expected = new Map([
    ['WON', 2000],
    ['LOST', 0],
    ['VOID', 1000],
    ['PUSH', 1000],
    ['HALF_WON', 1500],
    ['HALF_LOST', 500]
  ]);
  for (const [status, payout] of expected) {
    assert.equal(legReturnMultiplier({ accepted_odds: 2, result_status: status }), payout / 1000, `${status} multiplier`);
    assert.equal(
      settleCalculation({ bet_type: 'SINGLE', unit_stake: 1000 }, [{ accepted_odds: 2, result_status: status }]),
      payout,
      `${status} payout`
    );
  }
});

test('settlement calculator handles voided legs and system combinations without double-counting stake', () => {
  const legs = [
    { accepted_odds: 2, result_status: 'WON' },
    { accepted_odds: 3, result_status: 'WON' },
    { accepted_odds: 4, result_status: 'LOST' }
  ];
  assert.equal(
    settleCalculation({ bet_type: 'PARLAY', unit_stake: 1000 }, [legs[0], { ...legs[1], result_status: 'VOID' }]),
    2000
  );
  assert.equal(
    settleCalculation({ bet_type: 'SYSTEM', system_size: 2, unit_stake: 1000 }, legs),
    6000
  );
});
