import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const { evaluateSportsbookLeg, __sportsbookResultEvaluator } = await import('../src/sportsbook-result-evaluator.js');
const { legReturnMultiplier, settleCalculation } = await import('../src/sportsbook-settlement-calculation.js');

const leg = (marketType, selectionLabel, marketLine, period = 'FT') => ({
  market_type: marketType,
  selection_label: selectionLabel,
  market_line: marketLine,
  market_period: period,
  home_team: 'Alpha FC',
  away_team: 'Beta FC'
});

test('Asian quarter handicap settles half-win and half-loss correctly', () => {
  const draw = { status: 'FINISHED', providerStatus: 'FT', home: { score: 1 }, away: { score: 1 }, periodScores: { '1H': { home: 0, away: 0 } } };
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Alpha FC', 0.25), draw).status, 'HALF_WON');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Alpha FC', -0.25), draw).status, 'HALF_LOST');
  assert.deepEqual(__sportsbookResultEvaluator.quarterSplit(-0.75), [-1, -0.5]);
});

test('Asian quarter total settles split lines correctly', () => {
  const twoGoals = { status: 'FINISHED', providerStatus: 'FT', home: { score: 1 }, away: { score: 1 } };
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Over', 2.25), twoGoals).status, 'HALF_LOST');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Under', 2.25), twoGoals).status, 'HALF_WON');
});

test('HT market remains unsettled until an approved HT result authority is enabled', () => {
  const halftime = { status: 'LIVE', providerStatus: 'HT', home: { score: 1 }, away: { score: 0 }, periodScores: { '1H': { home: 1, away: 0 } } };
  const result = evaluateSportsbookLeg(leg('1X2', 'Home', null, '1H'), halftime);
  assert.equal(result, null, 'HT is intentionally fail-closed without an approved results authority');
});

test('postponed, suspended and abandoned matches do not auto-void open tickets', () => {
  for (const providerStatus of ['PST', 'SUSP', 'ABD']) {
    const event = { status: 'SUSPENDED', providerStatus, home: { score: 0 }, away: { score: 0 } };
    assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), event), null);
  }
  const cancelled = { status: 'SUSPENDED', providerStatus: 'CANC', home: { score: 0 }, away: { score: 0 } };
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), cancelled).status, 'VOID');
});

test('half settlement multipliers preserve correct stake fractions', () => {
  assert.equal(legReturnMultiplier({ result_status: 'HALF_LOST', accepted_odds: 1.9 }), 0.5);
  assert.equal(legReturnMultiplier({ result_status: 'HALF_WON', accepted_odds: 1.9 }), 1.45);
  const ticket = { bet_type: 'SINGLE', unit_stake: 100000 };
  assert.equal(settleCalculation(ticket, [{ result_status: 'HALF_LOST', accepted_odds: 1.9 }]), 50000);
  assert.equal(settleCalculation(ticket, [{ result_status: 'HALF_WON', accepted_odds: 1.9 }]), 145000);
});


test('missing provider scores never coerce to zero during settlement', () => {
  const halftimeWithoutScore = { status: 'LIVE', providerStatus: 'HT', home: { score: 1 }, away: { score: 0 }, periodScores: { '1H': { home: null, away: null } } };
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null, '1H'), halftimeWithoutScore), null);
  const finishedWithoutScore = { status: 'FINISHED', providerStatus: 'FT', home: { score: null }, away: { score: null } };
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null, 'FT'), finishedWithoutScore), null);
});
test('member bet contract requires provider price version and server-side risk limits', () => {
  const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/010_sportsbook_enterprise_core.sql', import.meta.url), 'utf8');
  assert.match(betting, /SPORTSBOOK_PRICE_VERSION_REQUIRED/);
  assert.match(betting, /revalidateResolvedLegs/);
  assert.match(betting, /pg_advisory_xact_lock/);
  assert.match(betting, /SPORTSBOOK_EVENT_LIABILITY_LIMIT/);
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  assert.match(feed, /SPORTS_EVENT_START_STATUS_PENDING/);
  assert.match(ui, /acceptedPriceVersion/);
  assert.match(migration, /HALF_WON/);
  assert.match(migration, /odds_version/);
});
