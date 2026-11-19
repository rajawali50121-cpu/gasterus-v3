import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config, mfaEncryptionKey } from './config.js';
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
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g,'');
  let bits=0,value=0; const out=[];
  for (const char of clean) { const idx=B32.indexOf(char); if(idx<0)continue; value=(value<<5)|idx; bits+=5; if(bits>=8){out.push((value >>> (bits-8))&255);bits-=8;} }
  return Buffer.from(out);
}
export function generateTotpSecret() { return base32Encode(randomBytes(20)); }
export function totp(secret, time = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length-1] & 15;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 10**digits).toString().padStart(digits,'0');
  return code;
}
export function verifyTotp(secret, code, window = 1) {
  const candidate = String(code ?? '').replace(/\D/g,'');
  if (candidate.length !== 6) return false;
  for (let i=-window;i<=window;i++) {
    const expected = totp(secret, Date.now() + i*30000);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
  }
  return false;
}
export function encryptSecret(plain) {
  const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',mfaEncryptionKey,iv);
  const encrypted=Buffer.concat([cipher.update(String(plain),'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
  return `${b64u(iv)}.${b64u(tag)}.${b64u(encrypted)}`;
}
export function decryptSecret(encoded) {
  const [iv64,tag64,data64]=String(encoded).split('.');
  const decipher=createDecipheriv('aes-256-gcm',mfaEncryptionKey,Buffer.from(iv64,'base64url'));
  decipher.setAuthTag(Buffer.from(tag64,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data64,'base64url')),decipher.final()]).toString('utf8');
}
