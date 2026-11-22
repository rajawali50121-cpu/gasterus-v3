import test from 'node:test';
import assert from 'node:assert/strict';

const { __sportradarNormalizer } = await import('../src/sportradar-normalizer.js');

test('Sportradar event statuses map documented live, finished, suspended and scheduled states safely', () => {
  const normalize = __sportradarNormalizer.normalizedEventStatus;
  assert.equal(normalize('not_started'), 'SCHEDULED');
  assert.equal(normalize('scheduled'), 'SCHEDULED');
  assert.equal(normalize('live'), 'LIVE');
  assert.equal(normalize('in_progress'), 'LIVE');
  assert.equal(normalize('finished'), 'FINISHED');
  assert.equal(normalize('postponed'), 'SUSPENDED');
  assert.equal(normalize('provider-new-status'), 'UNKNOWN');
  assert.equal(normalize(''), 'SCHEDULED');
});
