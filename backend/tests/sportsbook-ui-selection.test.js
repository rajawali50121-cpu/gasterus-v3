import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('function findMarketSelection(');
const helperEnd = source.indexOf('\nfunction renderOddCell(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'market selection helper must exist');

const findMarketSelection = new Function(
  `${source.slice(helperStart, helperEnd)}; return findMarketSelection;`
)();

test('market selection resolves 1X2 outcomes by label instead of provider array order', () => {
  const selections = [
    { key: 'home', label: 'Home' },
    { key: 'away', label: 'Away' },
    { key: 'draw', label: 'Draw' }
  ];

  assert.equal(findMarketSelection({ selections }, ['home', '1'], 0), selections[0]);
  assert.equal(findMarketSelection({ selections }, ['draw', 'x'], 1), selections[2]);
  assert.equal(findMarketSelection({ selections }, ['away', '2'], 2), selections[1]);
});

test('market selection matches outcome keys and totals labels with line values', () => {
  const selections = [
    { key: 'over', label: 'Over 2.5' },
    { key: 'under', label: 'Under 2.5' }
  ];

  assert.equal(findMarketSelection({ selections }, ['over'], 0, true), selections[0]);
  assert.equal(findMarketSelection({ selections }, ['under'], 1, true), selections[1]);
  const awaySelection = { key: 'away', label: 'Chelsea' };
  assert.equal(
    findMarketSelection({ selections: [awaySelection] }, ['away', '2'], 0),
    awaySelection
  );
});

test('market selection safely returns null when market data is missing', () => {
  assert.equal(findMarketSelection(null, ['home', '1'], 0), null);
  assert.equal(findMarketSelection({ selections: [] }, ['home', '1'], 0), null);
});

test('market selection does not reuse a known outcome as a missing outcome', () => {
  const selections = [
    { key: 'home', label: 'Home' },
    { key: 'away', label: 'Away' }
  ];

  assert.equal(findMarketSelection({ selections }, ['home', '1'], 0), selections[0]);
  assert.equal(findMarketSelection({ selections }, ['draw', 'x'], 1), null);
  assert.equal(findMarketSelection({ selections }, ['away', '2'], 2), selections[1]);
});

test('odds UI locks suspended quick selections and exposes signed odds acceptance policies', () => {
  assert.match(source, /const suspended = Boolean\(m\.suspended \|\| s\.suspended\)/);
  assert.match(source, /suspended \? ' disabled aria-disabled="true"'/);
  assert.match(source, /value="ACCEPT_BETTER"/);
  assert.match(source, /value="ACCEPT_ANY"/);
  assert.match(source, /oddsChangePolicy,\s*selections:/);
  assert.match(source, /const lineClass = Number\(lineVal\) < 0 \? 'kei-negative' : 'kei-positive'/);
});
