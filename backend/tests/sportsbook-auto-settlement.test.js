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

});

const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');
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
