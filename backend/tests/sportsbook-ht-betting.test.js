import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  HT_BETTING_ENABLED: 'true',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48)
});

const { config } = await import('../src/config.js');
const { mergeProviderEvents } = await import('../src/sportsbook-feed-utils.js');
const { eventSettlementAuthority } = await import('../src/sportsbook-settlement-authority.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');
const { __sportradarNormalizer } = await import('../src/sportradar-provider.js');

const market = (id, period, type = '1X2') => ({
  id, type, period, source: 'sportradar', suspended: false,
  selections: [{ key: id + '-home', label: 'Home', odds: 1.9, suspended: false, source: 'sportradar' }]
});

function htEvent(overrides = {}) {
  return {
    id: 'sr:match:ht-test', status: 'FINISHED', providerStatus: 'ENDED', live: false,
    home: { name: 'Home FC', score: 3 }, away: { name: 'Away FC', score: 1 },
    periodScores: { '1H': { home: 1, away: 1 } },
    _sources: ['sportradar'], _settlementReadySources: ['sportradar'],
    settlementAuthority: { ht: true, automaticFt: false },
    ...overrides
  };
}

const leg = (type, label, line, period = '1H') => ({
  home_team: 'Home FC', away_team: 'Away FC',
  market_type: type, market_period: period,
  selection_label: label, market_line: line
});

test('HT_BETTING_ENABLED is explicitly enabled for this test suite', () => {
  assert.equal(config.htBettingEnabled, true);
});

test('HT markets become bettable behind flag while FT settlement policy remains unchanged', () => {
  const event = {
    ...htEvent({ status: 'SCHEDULED', providerStatus: 'NOT_STARTED', periodScores: {} }),
    markets: [market('ft', 'FT'), market('ht', '1H')]
  };
  const [merged] = mergeProviderEvents([{ provider: 'sportradar', enabled: true, events: [event] }]);
  assert.equal(eventSettlementAuthority(merged).ht, true);
  assert.equal(merged.markets.find(item => item.period === '1H').suspended, false);
  assert.equal(merged.markets.find(item => item.period === 'FT').suspended, true);
  assert.equal(eventSettlementAuthority(merged).automaticFt, false);
});

test('Sportradar normalizer maps first-half score only from provider period-score data', () => {
  const normalized = __sportradarNormalizer.normalizeScheduleEvent({
    id: 'sr:match:score',
    status: 'ended',
    start_time: '2026-11-20T10:00:00Z',
    competitors: [
      { name: 'Home FC', qualifier: 'home' },
      { name: 'Away FC', qualifier: 'away' }
    ]
  }, {
    sport_event_status: {
      status: 'ended', home_score: 3, away_score: 1,
      period_scores: { period_score: [
        { number: 1, home_score: 1, away_score: 0, type: 'regular_period' },
        { number: 2, home_score: 2, away_score: 1, type: 'regular_period' }
      ] }
    }
  }, { id: 'sr:sport:1', name: 'Football' }, '2026-11-20T12:00:00Z');
  assert.deepEqual(normalized.event.periodScores['1H'], { home: 1, away: 0 });
  assert.equal(normalized.event.home.score, 3);
  assert.equal(normalized.event.away.score, 1);
});

test('HT 1X2 evaluates win, loss and draw from first-half score', () => {
  const event = htEvent();
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Draw', null), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), event).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Away', null), event).status, 'LOST');
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), htEvent({
    periodScores: { '1H': { home: 2, away: 0 } }
  })).status, 'WON');
});

test('HT Asian Handicap evaluates win, loss, push and quarter-line half outcomes', () => {
  const tied = htEvent();
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', 0), tied).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', 0.25), tied).status, 'HALF_WON');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -0.25), tied).status, 'HALF_LOST');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -1), htEvent({
    periodScores: { '1H': { home: 2, away: 1 } }
  })).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('HANDICAP', 'Home', -0.5), tied).status, 'LOST');
});

test('HT Over/Under evaluates win, loss, push and quarter-line half outcomes', () => {
  const tied = htEvent();
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Over 2.0', 2), tied).status, 'PUSH');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Over 2.25', 2.25), tied).status, 'HALF_LOST');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Under 2.25', 2.25), tied).status, 'HALF_WON');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Over 1.5', 1.5), tied).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('TOTALS', 'Under 1.5', 1.5), tied).status, 'LOST');
});

test('HT missing first-half score stays pending; cancelled match is void', () => {
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), htEvent({
    periodScores: { '1H': { home: null, away: null } }
  })), null);
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null), htEvent({
    providerStatus: 'CANCELLED', periodScores: {}
  })).status, 'VOID');
});

test('FT evaluation remains based only on final score and existing FT authority', () => {
  const event = htEvent({
    settlementAuthority: { ht: true, automaticFt: true },
    home: { name: 'Home FC', score: 3 }, away: { name: 'Away FC', score: 1 }
  });
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Home', null, 'FT'), event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(leg('1X2', 'Away', null, 'FT'), event).status, 'LOST');
  assert.match(evaluateSportsbookLeg(leg('1X2', 'Home', null, 'FT'), event).resultValue, /^FT 3-1$/);
});
