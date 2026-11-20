import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketBettable } from '../../frontend/js/market-readiness.js';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const readyMarket = {
  available: true,
  authorityReady: true,
  bettingStatus: 'OPEN',
  period: '2030-01-02',
  closeAt: '2030-01-01T01:00:00Z'
};

test('member UI enables betting only when backend marks result authority VERIFIED', () => {
  assert.equal(isMarketBettable(readyMarket, NOW), true);
  assert.equal(isMarketBettable({ ...readyMarket, authorityReady: false }, NOW), false);
  const missingAuthority = { ...readyMarket };
  delete missingAuthority.authorityReady;
  assert.equal(isMarketBettable(missingAuthority, NOW), false);
});

test('member UI fail-closed for non-open, missing-period, missing-close, and expired markets', () => {
  assert.equal(isMarketBettable({ ...readyMarket, bettingStatus: 'SUSPENDED' }, NOW), false);
  assert.equal(isMarketBettable({ ...readyMarket, period: null }, NOW), false);
  assert.equal(isMarketBettable({ ...readyMarket, closeAt: null }, NOW), false);
  assert.equal(isMarketBettable({ ...readyMarket, closeAt: '2029-12-31T23:59:59Z' }, NOW), false);
  assert.equal(isMarketBettable(null, NOW), false);
});
