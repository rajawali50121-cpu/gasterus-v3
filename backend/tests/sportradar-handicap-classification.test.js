import assert from 'node:assert/strict';
import test from 'node:test';
import { marketType, periodFromMarket } from '../src/sportradar-provider.js';

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
