import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPORTRADAR_PRODUCTS,
  SPORTRADAR_LEGACY_PRODUCTS,
  normalizeSportradarAccessLevel,
  buildSportradarProductBaseUrl,
  buildSportradarHeaders,
  getSportradarAccessFromPrematchBaseUrl
} from '../src/sportradar-products.js';

test('one Sportradar key is sent server-side through the documented x-api-key header', () => {
  assert.deepEqual(buildSportradarHeaders('server-side-test-key'), {
    'x-api-key': 'server-side-test-key',
    accept: 'application/json'
  });
  assert.throws(() => buildSportradarHeaders(''), /SPORTRADAR_API_KEY/);
});

test('access level is only trial or production and is independent from OC coverage tier', () => {
  assert.equal(normalizeSportradarAccessLevel('production'), 'production');
  assert.equal(normalizeSportradarAccessLevel('TRIAL'), 'trial');
  assert.throws(() => normalizeSportradarAccessLevel('core'), /trial or production/);
});

test('the same key maps to separate documented product base URLs', () => {
  assert.equal(buildSportradarProductBaseUrl('prematchV2', { accessLevel: 'production' }),
    'https://api.sportradar.com/oddscomparison-prematch/production/v2/en');
  assert.equal(buildSportradarProductBaseUrl('playerPropsV2', { accessLevel: 'production' }),
    'https://api.sportradar.com/oddscomparison-player-props/production/v2/en');
  assert.equal(buildSportradarProductBaseUrl('soccerV4', { accessLevel: 'production' }),
    'https://api.sportradar.com/soccer/production/v4/en');
});

test('Soccer API is not an odds source and Odds Comparison Regular v1 stays disabled', () => {
  assert.equal(SPORTRADAR_PRODUCTS.soccerV4.suppliesOdds, false);
  assert.equal(SPORTRADAR_PRODUCTS.prematchV2.suppliesOdds, true);
  assert.equal(SPORTRADAR_PRODUCTS.playerPropsV2.suppliesOdds, true);
  assert.equal(SPORTRADAR_LEGACY_PRODUCTS.oddsComparisonRegularV1.active, false);
  assert.throws(() => buildSportradarProductBaseUrl('oddsComparisonRegularV1'), /Unsupported or legacy/);
});

test('current Prematch base URL provides the shared access level and language for package routing', () => {
  assert.deepEqual(getSportradarAccessFromPrematchBaseUrl(
    'https://api.sportradar.com/oddscomparison-prematch/production/v2/en'
  ), { accessLevel: 'production', languageCode: 'en' });
});
