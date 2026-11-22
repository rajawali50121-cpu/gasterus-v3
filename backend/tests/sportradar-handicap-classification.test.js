import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { marketType, periodFromMarket, __sportradarNormalizer } from '../src/sportradar-provider.js';

test('generic Sportradar handicap with multiple two-way line outcomes stays Asian Handicap', () => {
  assert.equal(marketType('handicap', 6, false), 'HANDICAP');
  assert.equal(marketType('handicap {hcp}', 4, false), 'HANDICAP');
});

test('generic three-way handicap is European only when a real draw outcome exists', () => {
  assert.equal(marketType('handicap', 3, true), 'EUROPEAN_HANDICAP');
  assert.equal(marketType('three-way handicap', 2, false), 'EUROPEAN_HANDICAP');
});

test('explicit Asian Handicap names remain Asian Handicap', () => {
  assert.equal(marketType('Asian Handicap', 3, true), 'HANDICAP');
  assert.equal(marketType('Asian Spread', 4, false), 'HANDICAP');
});

test('generic Sportradar handicap names default to FT without explicit period metadata', () => {
  assert.equal(periodFromMarket('handicap'), 'FT');
  assert.equal(periodFromMarket('handicap {hcp}'), 'FT');
  assert.equal(periodFromMarket('handicap {hcp}', { period: 'first half' }), '1H');
});

test('Sportradar market 14 is European three-way handicap, not Asian Handicap', () => {
  assert.equal(marketType('handicap {hcp}', 3, true, 'sr:market:14'), 'EUROPEAN_HANDICAP');
  assert.equal(marketType('handicap {hcp}', 4, false, 'sr:market:16'), 'HANDICAP');
});

test('Sportradar documented outcome IDs map European Handicap 14 and Asian Handicap 16 without label guessing', () => {
  const event = { id: 'sr:sport_event:1', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
  const { markets } = __sportradarNormalizer.normalizeOdds(event, { markets: [
    {
      id: 'sr:market:14',
      name: 'Handicap {hcp}',
      specifiers: { hcp: '-1' },
      books: [{ id: 'sr:book:1', name: 'Book', outcomes: [
        { id: 'sr:outcome:1713', field_id: '5', odds_decimal: '4.80' },
        { id: 'sr:outcome:1712', field_id: '4', odds_decimal: '3.90' },
        { id: 'sr:outcome:1711', field_id: '3', odds_decimal: '1.55' }
      ] }]
    },
    {
      id: 'sr:market:16',
      name: 'Handicap',
      books: [{ id: 'sr:book:1', name: 'Book', outcomes: [
        { id: 'sr:outcome:1715', field_id: '2', handicap: '1', odds_decimal: '1.95' },
        { id: 'sr:outcome:1714', field_id: '1', handicap: '-1', odds_decimal: '1.91' }
      ] }]
    }
  ] });
  const european = markets.find(market => market.sourceMarketId === 'sr:market:14');
  const asian = markets.find(market => market.sourceMarketId === 'sr:market:16');
  assert.equal(european.type, 'EUROPEAN_HANDICAP');
  assert.deepEqual(european.selections.map(selection => [selection.outcomeType, selection.sourceOutcomeId, selection.line, selection.odds]), [
    ['away', 'sr:outcome:1713', -1, 4.8],
    ['draw', 'sr:outcome:1712', -1, 3.9],
    ['home', 'sr:outcome:1711', -1, 1.55]
  ]);
  assert.equal(asian.type, 'HANDICAP');
  assert.deepEqual(asian.selections.map(selection => [selection.outcomeType, selection.sourceOutcomeId]), [
    ['away', 'sr:outcome:1715'], ['home', 'sr:outcome:1714']
  ]);
});

test('Sportradar European Handicap preserves string hcp specifiers such as 1:0', () => {
  const event = { id: 'sr:sport_event:specifier', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
  const { markets } = __sportradarNormalizer.normalizeOdds(event, { markets: [{
    id: 'sr:market:14',
    name: 'Handicap {hcp}',
    specifiers: 'hcp=1:0',
    books: [{ id: 'sr:book:1', name: 'Book', outcomes: [
      { id: 'sr:outcome:1711', odds_decimal: '1.55' },
      { id: 'sr:outcome:1712', odds_decimal: '3.90' },
      { id: 'sr:outcome:1713', odds_decimal: '4.80' }
    ] }]
  }] });
  const market = markets.find(item => item.sourceMarketId === 'sr:market:14');
  assert.equal(market.type, 'EUROPEAN_HANDICAP');
  assert.deepEqual(market.selections.map(item => [item.outcomeType, item.handicapLine, item.line, item.odds]), [
    ['home', '1:0', null, 1.55],
    ['draw', '1:0', null, 3.9],
    ['away', '1:0', null, 4.8]
  ]);
});

test('Sportradar diagnostics capture only bounded handicap outcome fields without bookmaker or event payloads', () => {
  const event = { id: 'sr:sport_event:diagnostic', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
  const { diagnostics } = __sportradarNormalizer.normalizeOdds(event, { markets: [
    {
      id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: 'hcp=1:0',
      books: [{ id: 'sr:book:private', name: 'Private Book Name', outcomes: [
        { id: 'sr:outcome:1711', type: 'home', field_id: '3', handicap: '1:0', open_handicap: '0:0', odds_decimal: '1.55', open_odds_decimal: '1.60', removed: false },
        { id: 'sr:outcome:1712', type: 'draw', field_id: '4', handicap: '1:0', odds_decimal: '3.90' },
        { id: 'sr:outcome:1713', type: 'away', field_id: '5', odds_decimal: '4.80' }
      ] }]
    },
    {
      id: 'sr:market:16', name: 'Handicap',
      books: [{ outcomes: [{ id: 'sr:outcome:1714', handicap: '-1', odds_decimal: '1.91' }] }]
    }
  ] });
  assert.equal(diagnostics.outcomeSamples.length, 2);
  assert.equal(diagnostics.outcomeSamples[0].handicapSpecifier, '1:0');
  assert.deepEqual(diagnostics.outcomeSamples[0].outcomes[0], {
    id: 'sr:outcome:1711', type: 'home', field_id: '3',
    handicap: '1:0', open_handicap: '0:0',
    odds_decimal: '1.55', open_odds_decimal: '1.60', removed: false
  });
  assert.equal(JSON.stringify(diagnostics.outcomeSamples).includes('Private Book Name'), false);
  assert.equal(JSON.stringify(diagnostics.outcomeSamples).includes('sr:sport_event:diagnostic'), false);
  assert.equal(diagnostics.outcomeSamples[0].outcomes.length, 3);
});

test('Sportradar market 14 rejects undocumented outcome IDs even when raw type claims home', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:unknown', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [{ id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-1' }, books: [{ outcomes: [
      { id: 'sr:outcome:9999', type: 'home', odds_decimal: '1.50' }
    ] }] }] }
  );
  assert.equal(markets[0].selections[0].outcomeType, null);
});
test('Sportradar score-style European Handicap line remains display-only for settlement', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:scoreline', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [{ id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: 'hcp=1:0', books: [{ outcomes: [
      { id: 'sr:outcome:1711', odds_decimal: '1.55' }
    ] }] }] }
  );
  assert.equal(markets[0].selections[0].line, null);
  assert.equal(markets[0].selections[0].suspended, true);
});
test('Sportradar market identity includes handicap specifier', () => {
  const { markets } = __sportradarNormalizer.normalizeOdds(
    { id: 'sr:sport_event:lines', home: { name: 'Home FC' }, away: { name: 'Away FC' } },
    { markets: [
      { id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-1' }, books: [{ id: 'book', outcomes: [{ id: 'sr:outcome:1711', odds_decimal: '1.50' }] }] },
      { id: 'sr:market:14', name: 'Handicap {hcp}', specifiers: { hcp: '-2' }, books: [{ id: 'book', outcomes: [{ id: 'sr:outcome:1711', odds_decimal: '2.50' }] }] }
    ] }
  );
  assert.notEqual(markets[0].id, markets[1].id);
});


const sportradarProviderSource = readFileSync(new URL('../src/sportradar-provider.js', import.meta.url), 'utf8');

test('Sportradar quota exhaustion is not retried immediately', () => {
  assert.match(sportradarProviderSource, /Limit Exceeded/);
  assert.match(sportradarProviderSource, /SPORTRADAR_QUOTA_EXCEEDED/);
  assert.match(sportradarProviderSource, /if \(error\?\.code === 'SPORTRADAR_QUOTA_EXCEEDED'\) throw error/);
});
