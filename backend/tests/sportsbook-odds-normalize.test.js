import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOdds, PARSER_VERSION } from '../src/sportsbook-odds-normalize.js';

test('decimal 1.429 accepted', () => {
  const r = normalizeOdds({ rawValue: '1.429', rawFormat: 'decimal', provider: 'x' });
  assert.equal(r.status, 'ACCEPTED');
  assert.equal(r.decimal, 1.429);
});

test('empty rejected', () => {
  const r = normalizeOdds({ rawValue: '', rawFormat: 'decimal', provider: 'x' });
  assert.equal(r.status, 'REJECTED');
});

test('unknown format quarantined', () => {
  const r = normalizeOdds({ rawValue: '1.5', rawFormat: 'weird', provider: 'x' });
  assert.equal(r.status, 'QUARANTINED');
});

test('<=1 rejected', () => {
  const r = normalizeOdds({ rawValue: '1.0', rawFormat: 'decimal', provider: 'x' });
  assert.equal(r.status, 'REJECTED');
});

test('american +150', () => {
  const r = normalizeOdds({ rawValue: 150, rawFormat: 'american', provider: 'x' });
  assert.equal(r.status, 'ACCEPTED');
  assert.equal(r.decimal, 2.5);
});
