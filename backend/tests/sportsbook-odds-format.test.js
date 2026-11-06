import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOdds, oddsColorClass } from '../../frontend/js/sportsbook-odds.js';

test('renders decimal and Asian odds formats from canonical decimal prices', () => {
  assert.equal(formatOdds(2.5), '2.50');
  assert.equal(formatOdds(2.5, 'HONG_KONG'), '1.50');
  assert.equal(formatOdds(1.5, 'INDONESIAN'), '-2.00');
  assert.equal(formatOdds(3, 'INDONESIAN'), '2.00');
  assert.equal(formatOdds(1.5, 'MALAY'), '2.00');
  assert.equal(formatOdds(3, 'MALAY'), '-2.00');
});

test('negative Asian prices are red and rising or falling odds use live movement colors', () => {
  assert.equal(oddsColorClass(null, '1X2', 1.5, 'INDONESIAN'), 'odds-red');
  assert.equal(oddsColorClass(null, '1X2', 3, 'MALAY'), 'odds-red');
  assert.equal(oddsColorClass(null, '1X2', 3, 'HONG_KONG'), 'odds-blue');
  assert.equal(oddsColorClass(null, '1X2', 2, 'DECIMAL'), 'odds-black');
  assert.equal(oddsColorClass('up', '1X2', 2), 'odds-green');
  assert.equal(oddsColorClass('down', '1X2', 2), 'odds-red');
});

test('invalid decimal odds do not produce a displayed price', () => {
  assert.equal(formatOdds(1), '—');
  assert.equal(formatOdds(Number.NaN), '—');
});
