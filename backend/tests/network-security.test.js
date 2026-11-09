import test, { after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://localhost:5432/gasterus?sslmode=disable&sslrootcert=%2Ftmp%2Funtrusted.pem',
  DATABASE_SSL: 'false',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64')
});
delete process.env.DATABASE_URL_OVERRIDE;
delete process.env.TRUSTED_PROXY_IPS;

const [{ config }, { clientIp }, { pool, closeDatabase }] = await Promise.all([
  import('../src/config.js'),
  import('../src/http.js'),
  import('../src/db.js')
]);

after(async () => {
  await closeDatabase();
});

test('production PostgreSQL connections require verified TLS', () => {
  assert.equal(config.databaseSsl, true);
  assert.equal(pool.options.ssl.rejectUnauthorized, true);
  assert.doesNotMatch(pool.options.connectionString, /(?:sslmode|sslrootcert)=/i);
});

test('client IP ignores forwarded headers from untrusted peers', () => {
  assert.equal(clientIp({
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '198.51.100.8' }
  }), '203.0.113.9');
});

test('client IP uses the nearest forwarded address from the loopback gateway', () => {
  assert.equal(clientIp({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.9' }
  }), '203.0.113.9');
});

test('client IP falls back to the trusted peer when forwarded input is invalid', () => {
  assert.equal(clientIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': 'not-an-ip' }
  }), '127.0.0.1');
});
