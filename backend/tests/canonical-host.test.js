import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const worker = readFileSync(resolve(import.meta.dirname, '..', '..', 'frontend', '_worker.js'), 'utf8');

// www dan domain utama harus jadi satu situs. Kalau keduanya dilayani terpisah,
// cookie sesi dan localStorage terpecah sehingga member terlihat "turun" padahal
// akunnya sama.
test('www diarahkan permanen ke domain utama',()=>{
  assert.match(worker, /const CANONICAL_HOST = 'gasterus\.fun'/, 'domain kanonik harus dideklarasikan');
  assert.match(worker, /url\.hostname\.toLowerCase\(\) !== `www\.\$\{CANONICAL_HOST\}`/, 'perbandingan host www wajib ada');
  assert.match(worker, /status: 301/, 'redirect harus 301 (permanen)');
  assert.match(worker, /target\.hostname = CANONICAL_HOST/, 'tujuan redirect harus domain utama');
  assert.match(worker, /x-redirect-reason': 'canonical-host'/, 'redirect harus diberi alasan untuk tracing');
});

test('redirect host dijalankan sebelum proxy dan sebelum aset',()=>{
  const redirectAt = worker.indexOf('canonicalRedirect(request)');
  const proxyAt = worker.indexOf('shouldProxyToBackend(url.pathname, env)');
  const assetAt = worker.indexOf('env.ASSETS.fetch(request)');
  assert.ok(redirectAt > 0, 'canonicalRedirect harus dipanggil');
  assert.ok(redirectAt < proxyAt, 'canonical host harus dicek sebelum proxy backend');
  assert.ok(redirectAt < assetAt, 'canonical host harus dicek sebelum melayani aset');
});

test('health and readiness routes are proxied to the backend',()=>{
  assert.match(worker,/pathname\.startsWith\('\/api\/'\) \|\| pathname === '\/healthz' \|\| pathname === '\/readyz'/);
});