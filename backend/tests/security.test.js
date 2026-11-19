import test from 'node:test';import assert from 'node:assert/strict';
const env={DATABASE_URL:'postgresql://user:pass@localhost/db',REDIS_URL:'redis://localhost:6379',MEMBER_PROXY_SECRET:'m'.repeat(48),ADMIN_PROXY_SECRET:'a'.repeat(48),OPS_INTERNAL_SECRET:'o'.repeat(48),SESSION_HMAC_KEY:'y'.repeat(48),API_KEY_PEPPER:'z'.repeat(48),MFA_ENCRYPTION_KEY_BASE64:Buffer.alloc(32,7).toString('base64')};Object.assign(process.env,env);
const security=await import('../src/security.js');
test('password hashing and verification',async()=>{const hash=await security.hashPassword('Strong-Test-Password-2026!');assert.equal(await security.verifyPassword('Strong-Test-Password-2026!',hash),true);assert.equal(await security.verifyPassword('wrong-password',hash),false);});
