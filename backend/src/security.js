import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
const scrypt = promisify(scryptCb);
const b64u = buffer => Buffer.from(buffer).toString('base64url');
export const randomToken = (bytes = 32) => b64u(randomBytes(bytes));
export const hmac = value => createHmac('sha256', config.sessionHmacKey).update(String(value)).digest('hex');
export const apiKeyHash = value => createHmac('sha256', config.apiKeyPepper).update(String(value)).digest('hex');
export async function hashPassword(password) {
  const raw = String(password ?? '');
  if (raw.length < 8 || raw.length > 128) throw new Error('Password must be 8-128 characters');
  const salt = randomBytes(16);
  const derived = await scrypt(raw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${b64u(salt)}$${b64u(derived)}`;
}
export async function verifyPassword(password, encoded) {
  try {
    const [kind,N,r,p,salt64,hash64] = String(encoded).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hash64, 'base64url');
    const derived = await scrypt(String(password), Buffer.from(salt64, 'base64url'), expected.length, { N:Number(N), r:Number(r), p:Number(p), maxmem:64*1024*1024 });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch { return false; }
}
