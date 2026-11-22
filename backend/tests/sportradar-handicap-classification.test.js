import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { marketType, periodFromMarket, __sportradarNormalizer } from '../src/sportradar-normalizer.js';

test('two-way handicap without a draw outcome is Asian Handicap', () => {
  assert.equal(marketType('handicap', 2, false), 'HANDICAP');
  assert.equal(marketType('handicap {hcp}', 6, false), 'HANDICAP');
  assert.equal(marketType('Asian Handicap', 3, true), 'HANDICAP');
});

test('three-way handicap requires an actual draw outcome or explicit European name', () => {
  assert.equal(marketType('handicap', 3, true), 'EUROPEAN_HANDICAP');
  assert.equal(marketType('European Handicap', 3, false), 'EUROPEAN_HANDICAP');
  assert.equal(marketType('handicap', 3, false), 'HANDICAP');
});

test('market IDs do not override market names and outcome structure', () => {
  assert.equal(marketType('handicap', 3, true, 'sr:market:14'), 'EUROPEAN_HANDICAP');
  assert.equal(marketType('handicap', 2, false, 'sr:market:16'), 'HANDICAP');
  assert.equal(periodFromMarket('1st half - 1x2', { id: 'sr:market:60' }), '1H');
  assert.equal(periodFromMarket('1x2', { id: 'sr:market:60' }), 'FT');
});

test('provider outcome.type is the only source for normalized selection outcome type', () => {
  const event = { id: 'sr:sport_event:1', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
  const { markets } = __sportradarNormalizer.normalizeOdds(event, { markets: [
    {
      id: 'sr:market:14',
      name: 'Handicap {hcp}',
      specifiers: { hcp: '-1' },
      books: [{ id: 'sr:book:1', name: 'Book', outcomes: [
        { id: 'sr:outcome:9999', type: 'home', handicap: '-1', odds_decimal: '1.55' },
        { id: 'sr:outcome:9998', type: 'draw', handicap: '-1', odds_decimal: '3.90' },
        { id: 'sr:outcome:9997', type: 'away', handicap: '-1', odds_decimal: '4.80' }
      ] }]
    },
    {
      id: 'sr:market:16',
      name: 'Handicap',
      books: [{ id: 'sr:book:1', name: 'Book', outcomes: [
        { id: 'sr:outcome:1715', type: 'away', handicap: '1', odds_decimal: '1.95' },
        { id: 'sr:outcome:1714', type: 'home', handicap: '-1', odds_decimal: '1.91' }
      ] }]
    }
  ] });
  const european = markets.find(market => market.sourceMarketId === 'sr:market:14');
  const asian = markets.find(market => market.sourceMarketId === 'sr:market:16');
  assert.equal(european.type, 'EUROPEAN_HANDICAP');
  assert.deepEqual(european.selections.map(selection => [selection.outcomeType, selection.line, selection.odds]), [
    ['home', -1, 1.55], ['draw', -1, 3.9], ['away', -1, 4.8]
  ]);
  assert.equal(asian.type, 'HANDICAP');
  assert.deepEqual(asian.selections.map(selection => selection.outcomeType), ['away', 'home']);
});

test('missing provider outcome.type is not guessed from outcome IDs or field IDs', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:unknown', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [{ id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-1' }, books: [{ outcomes: [
      { id: 'sr:outcome:1711', field_id: '3', odds_decimal: '1.50' }
    ] }] }] }
  );
  assert.equal(markets[0].selections[0].outcomeType, null);
});

test('European Handicap preserves score-style specifiers as display-only lines', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:scoreline', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [{ id: 'sr:market:14', name: 'European Handicap', specifiers: 'hcp=1:0', books: [{ outcomes: [
      { id: 'sr:outcome:1', type: 'home', odds_decimal: '1.55' }
    ] }] }] }
  );
  assert.equal(markets[0].selections[0].line, null);
  assert.equal(markets[0].selections[0].handicapLine, '1:0');
  assert.equal(markets[0].selections[0].suspended, true);
});

test('market identity includes handicap specifier', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:lines', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [
      { id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-1' }, books: [{ id: 'book', outcomes: [{ id: 'o1', type: 'home', odds_decimal: '1.50' }] }] },
      { id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-2' }, books: [{ id: 'book', outcomes: [{ id: 'o2', type: 'home', odds_decimal: '2.50' }] }] }
    ] }
  );
  assert.notEqual(markets[0].id, markets[1].id);
});

test('normalizer diagnostics never include bookmaker or event identity', () => {
  const event = { id: 'sr:sport_event:diagnostic', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
  const { diagnostics } = __sportradarNormalizer.normalizeOdds(event, { markets: [{
    id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: 'hcp=1:0',
    books: [{ id: 'sr:book:private', name: 'Private Book Name', outcomes: [
      { id: 'sr:outcome:1', type: 'home', field_id: '3', handicap: '1:0', open_handicap: '0:0', odds_decimal: '1.55', open_odds_decimal: '1.60', removed: false }
    ] }]
  }] });
  assert.ok(Array.isArray(diagnostics.outcomeSamples));
  assert.equal(JSON.stringify(diagnostics.outcomeSamples).includes('Private Book Name'), false);
  assert.equal(JSON.stringify(diagnostics.outcomeSamples).includes('sr:sport_event:diagnostic'), false);
});

const sportradarProviderSource = readFileSync(new URL('../src/sportradar-provider-v2.js', import.meta.url), 'utf8');
test('Sportradar provider limit response is not retried immediately', () => {
  assert.match(sportradarProviderSource, /HTTP 429/);
  assert.match(sportradarProviderSource, /SPORTRADAR_LIMIT_EXCEEDED/);
});
