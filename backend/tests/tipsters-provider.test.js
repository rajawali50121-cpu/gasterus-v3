import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 'y'.repeat(48),
  API_KEY_PEPPER: 'z'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
});

const { hasPayloadErrors, extractErrorDetail } = await import('../src/tipsters-provider.js');

test('RapidAPI/Tipsters error detection: normal response with empty errors array, empty errors object, error: null not flagged as error', () => {
  const payload = {
    games: [{ name: 'Test Game', id: 'test-1' }],
    errors: [],
    error: null,
    message: 'info message with data'
  };
  assert.equal(hasPayloadErrors(payload), false);
});

test('RapidAPI/Tipsters error detection: response with errors array containing items flagged as error with reason', () => {
  const payload = {
    games: [],
    errors: ['account suspended', 'quota exceeded']
  };
  assert.equal(hasPayloadErrors(payload), true);
  assert.ok(extractErrorDetail(payload).includes('account suspended'));
  assert.ok(extractErrorDetail(payload).includes('quota exceeded'));
});

test('RapidAPI/Tipsters error detection: response with usable data and error-like message not flagged as error', () => {
  const payload = {
    games: [{ name: 'Test Game', id: 'test-1' }],
    message: 'quota limit approaching but data returned'
  };
  assert.equal(hasPayloadErrors(payload), false);
});

test('RapidAPI/Tipsters error detection: Sportmonks no-access message appears as warning, not fatal error', () => {
  const payload = {
    games: [],
    message: "No result(s) found for this date or you don't have access to this data with your current subscription"
  };
  assert.equal(hasPayloadErrors(payload), false);
  assert.ok(extractErrorDetail(payload)?.startsWith('warning:'));
});

test('RapidAPI/Tipsters error detection: empty games array with quota message flagged as error (truthy check)', () => {
  const payload = {
    games: [],
    message: 'quota exceeded'
  };
  // games: [] is falsy, so hasUsableData = false, quota message should be flagged as error
  assert.equal(hasPayloadErrors(payload), true);
  assert.ok(extractErrorDetail(payload).includes('quota exceeded'));
});