import assert from 'node:assert/strict';
import test from 'node:test';
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
