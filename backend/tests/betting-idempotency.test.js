import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/gasterus_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBER_PROXY_SECRET: 'test-member-proxy-secret-000000000000',
  ADMIN_PROXY_SECRET: 'test-admin-proxy-secret-000000000000',
  OPS_INTERNAL_SECRET: 'test-ops-internal-secret-000000000000',
  SESSION_HMAC_KEY: 'test-session-hmac-key-00000000000000',
  API_KEY_PEPPER: 'test-api-key-pepper-0000000000000000',
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { createBet } = await import('../src/betting.js');
const sportsbookBetting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
const totoBetting = readFileSync(new URL('../src/betting.js', import.meta.url), 'utf8');

test('TOTO bet placement requires an idempotency key before opening a database transaction', async () => {
  for (const payload of [{}, { idempotencyKey: '' }, { idempotencyKey: 'short' }, { idempotency_key: 'short' }]) {
    await assert.rejects(
      createBet({ userId: 'test-member' }, payload, { draft: false }),
      error => error.code === 'BET_IDEMPOTENCY_REQUIRED'
    );
  }
});

test('TOTO and Sportsbook accept snake_case idempotency keys and lock retries in their transaction', () => {
  assert.match(totoBetting, /input\.idempotencyKey\?\?input\.idempotency_key/);
  assert.match(totoBetting, /pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/);
  assert.match(sportsbookBetting, /input\.idempotencyKey \?\? input\.idempotency_key/);
  assert.match(sportsbookBetting, /SPORTSBOOK:\$\{session\.userId\}:\$\{idempotencyKey\}/);
  assert.match(sportsbookBetting, /pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/);
});
