import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryMarketColumns } from '../../frontend/js/sportsbook-markets.js';

test('primary market columns show live FT markets in sportsbook order with mapped outcomes', () => {
  const handicap = { type: 'HANDICAP', period: 'FT', line: -0.5, selections: [
    { key: 'home', label: 'Home', odds: 1.9 },
    { key: 'away', label: 'Away', odds: 2.0 }
  ] };
  const totals = { type: 'TOTALS', period: 'FT', line: 2.5, selections: [
    { key: 'over', label: 'Over 2.5', odds: 1.8 },
    { key: 'under', label: 'Under 2.5', odds: 2.1 }
  ] };
  const result = primaryMarketColumns({
    markets: [
      { type: '1X2', period: 'FT', selections: [
        { key: 'home', label: 'Home', odds: 2.1 },
        { key: 'draw', label: 'Draw', odds: 3.2 },
        { key: 'away', label: 'Away', odds: 3.4 }
      ] },
      { ...handicap, id: 'main' },
      { ...handicap, id: 'alt' },
      totals,
      { type: '1X2', period: '1H', selections: [{ key: 'home', odds: 2 }] },
      { type: 'CORNERS', label: 'Corners', period: 'FT', selections: [{ key: 'over-9.5', label: 'Over 9.5', odds: 1.9 }] }
    ]
  }, 'FT');

  assert.deepEqual(result.map((market) => market.title), ['Asian Handicap', 'Over / Under', '1X2']);
  assert.deepEqual(result.slice(0, 3).map((market) => market.outcomes.map(([label]) => label)), [
    ['1', '2'], ['O', 'U'], ['1', 'X', '2']
  ]);
  assert.equal(result[0].market.id, 'main');
  assert.equal(result[1].outcomes[0][1], totals.selections[0]);
});

test('primary market columns retain suspended state and provide non-selectable unavailable slots', () => {
  const result = primaryMarketColumns({ markets: [
    { type: '1X2', period: 'FT', suspended: true, selections: [{ key: 'home', odds: 2 }] },
    { type: 'HANDICAP', period: '1H', selections: [{ key: 'home', odds: 2 }] },
    { type: 'TOTALS', period: 'FT', selections: [] }
  ] }, 'FT');
  assert.deepEqual(result.map(item => item.type), ['HANDICAP', 'TOTALS', '1X2']);
  assert.equal(result[0].market, null);
  assert.equal(result[1].market.type, 'TOTALS');
  assert.equal(result[1].market.selections.length, 0);
  assert.equal(result[2].market.suspended, true);
  assert.deepEqual(result[0].outcomes.map(([label, selection]) => [label, selection]), [['1', null], ['2', null]]);
  assert.deepEqual(result[1].outcomes.map(([label, selection]) => [label, selection]), [['O', null], ['U', null]]);
});

test('primary market columns fill missing selections without creating selectable odds', () => {
  const result = primaryMarketColumns({ markets: [{
    id: 'partial',
    type: '1X2',
    period: 'FT',
    selections: [{ key: 'home', label: 'Home', odds: 2.1 }]
  }] }, 'FT');
  assert.deepEqual(result[2].outcomes.map(([label, selection]) => [label, selection?.key || null]), [
    ['1', 'home'], ['X', null], ['2', null]
  ]);
});
