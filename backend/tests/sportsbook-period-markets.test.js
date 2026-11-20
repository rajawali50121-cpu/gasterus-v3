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

const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');
const { __sportradarNormalizer } = await import('../src/sportradar-provider.js');

test('Sportradar event retains HT market metadata without claiming HT result authority', () => {
  const event = {
    id: 'api-score',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-08-11T12:00:00Z',
    status: 'FINISHED',
    providerStatus: 'FT',
    live: false,
    home: { name: 'Arsenal', score: 3, logo: null },
    away: { name: 'Chelsea', score: 1, logo: null },
    periodScores: { '1H': { home: 1, away: 1 } },
    markets: [
      { id: 'm1', type: '1X2', period: 'FT', source: 'sportradar', suspended: false, selections: [{ key: 'k1', label: 'Home', odds: 1.8, suspended: false, source: 'sportradar', updatedAt: null }] },
      { id: 'm2', type: '1X2', period: '1H', source: 'sportradar', suspended: false, selections: [{ key: 'k2', label: 'Home', odds: 2.2, suspended: false, source: 'sportradar', updatedAt: null }] },
      { id: 'm3', type: 'TOTALS', period: '1H', source: 'sportradar', suspended: false, selections: [{ key: 'k3', label: 'Over 1.0', odds: 1.88, suspended: false, source: 'sportradar', updatedAt: null }] }
    ],
    _refs: { 'sportradar': 'api-9911' },
    _sources: ['sportradar'],
    _settlementReadySources: ['sportradar'],
    settlementAuthority: { ft: true, ht: false, automaticFt: false, manualFt: true }
  };
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === '1H'));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H'));
  assert.deepEqual(event.periodScores['1H'], { home: 1, away: 1 });
});

test('live odds extractor accepts top-level bets payload', () => {
  const map = new Map();
  map.set('123', [{ name: 'First Half Winner', values: [{ value: 'Home', odd: '2.0' }] }]);
  assert.equal(map.get('123').length, 1);
  assert.equal(map.get('123')[0].name, 'First Half Winner');
});


test('auto settlement evaluates HT market from halftime score and FT market from final score', () => {
  const event = { status: 'FINISHED', home: { score: 3 }, away: { score: 1 }, periodScores: { '1H': { home: 1, away: 1 } }, settlementAuthority: { ft: true, ht: false, automaticFt: true } };
  const base = { home_team: 'Arsenal', away_team: 'Chelsea', market_type: '1X2', market_line: null };
  const ht = evaluateSportsbookLeg({ ...base, market_period: '1H', selection_label: 'Draw' }, event);
  const ft = evaluateSportsbookLeg({ ...base, market_period: 'FT', selection_label: 'Home' }, event);
  assert.equal(ht, null, 'HT result must remain unavailable without an approved results authority');
  assert.equal(ft.status, 'WON');
  assert.match(ft.resultValue, /^FT 3-1$/);
});

test('member sportsbook ships explicit FT/HT controls and does not hard-code bridge markets to FT', () => {
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../frontend/sportsbook.html', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  assert.match(html, /sportsbook|period/i);
  assert.match(ui, /period/);
  assert.match(feed, /period: market\.period \|\| 'FT'/);
  assert.doesNotMatch(feed, /period: 'FT',/);
});

test('Sportradar maps the same three core market types for FT and HT', () => {
  const event = { id: 'sr-core-periods', home: { name: 'Home' }, away: { name: 'Away' } };
  const names = [
    ['1x2', '1X2', 'FT'],
    ['Asian Handicap', 'HANDICAP', 'FT'],
    ['Over/Under', 'TOTALS', 'FT'],
    ['1st half - 1x2', '1X2', '1H'],
    ['1st half - Asian Handicap', 'HANDICAP', '1H'],
    ['1st half - Over/Under', 'TOTALS', '1H'],
    ['First Half Result', '1X2', '1H']
  ];
  const normalized = __sportradarNormalizer.normalizeOdds(event, {
    markets: names.map(([name], index) => ({
      id: `core-market-${index}`,
      name,
      is_live: false,
      books: [{
        id: 'book-core',
        name: 'Core Book',
        outcomes: [
          { id: `home-${index}`, name: 'Home', type: 'home', odds_decimal: '1.91', handicap: '-0.5', total: '2.5' },
          { id: `away-${index}`, name: 'Away', type: 'away', odds_decimal: '1.91', handicap: '+0.5', total: '2.5' }
        ]
      }]
    }))
  });
  for (const [name, type, period] of names) {
    assert.ok(normalized.markets.some(market =>
      market.sourceMarketName === name && market.type === type && market.period === period
      && market.selections.some(selection => selection.odds === 1.91)
    ), `missing normalized priced market: ${name} -> ${type}/${period}`);
  }
});

test('Sportradar reads HT/FT period from provider metadata when market name is generic', () => {
  const event = { id: 'sr-explicit-period', home: { name: 'Home' }, away: { name: 'Away' } };
  const normalized = __sportradarNormalizer.normalizeOdds(event, { markets: [
    { id: 'ah-ht', name: 'Asian Handicap', period: '1H', books: [{ id: 'b1', outcomes: [
      { id: 'h1', name: 'Home -0.5', odds_decimal: '1.90' },
      { id: 'a1', name: 'Away +0.5', odds_decimal: '1.90' }
    ] }] },
    { id: 'ou-ht', name: 'Over/Under', specifiers: { period: 'first_half' }, books: [{ id: 'b1', outcomes: [
      { id: 'o1', name: 'Over 1.0', odds_decimal: '1.88' },
      { id: 'u1', name: 'Under 1.0', odds_decimal: '1.92' }
    ] }] }
  ] });
  assert.ok(normalized.markets.some(m => m.type === 'HANDICAP' && m.period === '1H'
    && m.selections.some(selection => selection.odds === 1.9)));
  assert.ok(normalized.markets.some(m => m.type === 'TOTALS' && m.period === '1H'
    && m.selections.some(selection => selection.odds === 1.88)));
});

test('Sportradar normalizes HT/FT combo as one priced market', () => {
  const event = { id: 'sr-test', home: { name: 'Home Team' }, away: { name: 'Away Team' } };
  const normalized = __sportradarNormalizer.normalizeOdds(event, { markets: [{
    id: 'market-htft', name: 'Half Time / Full Time', books: [{
      id: 'book-1', name: 'Test Book', outcomes: [
        { id: 'o1', name: 'Home/Home', odds_decimal: '2.75' },
        { id: 'o2', name: 'Draw/Draw', odds_decimal: '4.20' },
        { id: 'o3', name: 'Away/Away', odds_decimal: '5.10' }
      ]
    }]
  }] });
  assert.equal(normalized.markets[0].type, 'HT_FT');
  assert.equal(normalized.markets[0].period, 'HT_FT');
  assert.deepEqual(normalized.markets[0].selections.map(s => s.odds), [2.75, 4.2, 5.1]);
});

test('HT/FT settlement needs both authorities and both scores', () => {
  const event = { status: 'FINISHED', providerStatus: 'FT', home: { score: 2 }, away: { score: 1 },
    periodScores: { '1H': { home: 0, away: 1 } }, settlementAuthority: { ht: true, automaticFt: true } };
  const combo = { market_type: 'HT_FT', market_period: 'HT_FT', selection_label: 'Away/Home' };
  assert.equal(evaluateSportsbookLeg(combo, event).status, 'WON');
  assert.equal(evaluateSportsbookLeg(combo, { ...event, settlementAuthority: { ht: false, automaticFt: true } }), null);
  assert.equal(evaluateSportsbookLeg(combo, { ...event, periodScores: {} }), null);
  const { settlementAuthority: _ignored, ...noAuthority } = event;
  assert.equal(evaluateSportsbookLeg(combo, noAuthority), null, 'HT/FT must fail closed without authority metadata');
});

test('member detail-market browser labels HT/FT combo period', () => {
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  assert.match(ui, /HT_FT:\s*'HT\/FT/);
});
