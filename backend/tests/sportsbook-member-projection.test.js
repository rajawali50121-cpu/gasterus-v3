import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMemberMarkets } from '../src/sportsbook-member-projection.js';

test('Sportradar member projection preserves semantic outcome and exact European handicap line', () => {
  const projected = projectMemberMarkets([{
    id: 'sr:market:14',
    source: 'sportradar',
    type: 'EUROPEAN_HANDICAP',
    period: 'FT',
    selections: [
      { key: 'home', label: 'HOME', outcomeType: 'home', handicapLine: '1:0', line: null, odds: 1.55, sourceOutcomeId: 'sr:outcome:1711' },
      { key: 'draw', label: 'DRAW', outcomeType: 'draw', handicapLine: '1:0', line: null, odds: 3.90, sourceOutcomeId: 'sr:outcome:1712' },
      { key: 'away', label: 'AWAY', outcomeType: 'away', handicapLine: '1:0', line: null, odds: 4.80, sourceOutcomeId: 'sr:outcome:1713' }
    ]
  }]);

  assert.deepEqual(projected[0].selections.map(({ outcomeType, handicapLine, line, odds }) =>
    [outcomeType, handicapLine, line, odds]), [
    ['home', '1:0', null, 1.55],
    ['draw', '1:0', null, 3.90],
    ['away', '1:0', null, 4.80]
  ]);
  // Internal provider IDs must not leak through the member-facing projection.
  assert.equal('sourceOutcomeId' in projected[0].selections[0], false);
});
