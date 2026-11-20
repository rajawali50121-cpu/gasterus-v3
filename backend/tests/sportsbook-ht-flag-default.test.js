import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.HT_BETTING_ENABLED;
delete process.env.SPORTRADAR_HT_RESULTS_ENABLED;
process.env.NODE_ENV = 'test';
const { config } = await import('../src/config.js');
assert.equal(config.htBettingEnabled, false);
assert.equal(config.sportradarHtResultsEnabled, false);

test('HT betting flag defaults OFF when environment variable is absent', () => {
  assert.equal(config.htBettingEnabled, false);
  assert.equal(config.sportradarHtResultsEnabled, false);
});
