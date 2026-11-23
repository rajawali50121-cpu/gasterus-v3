import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { escapeHtml } from '../../frontend/js/utils.js';

const root = resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

test('escapeHtml encodes all HTML-sensitive characters and preserves zero-like values', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('xss')">&`), '&lt;img src=x onerror=&quot;alert(&#039;xss&#039;)&quot;&gt;&amp;');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('bet history uses the shared HTML escaper', () => {
  const source = read('frontend/bet-history.html');
  assert.match(source, /import \{ formatRupiah, formatDateTime, escapeHtml \} from '\/js\/utils\.js'/);
  assert.doesNotMatch(source, /\.replace\(\/&\/g, '&'\)/);
  assert.match(source, /const esc = escapeHtml;/);
});

test('pendaftaran gagal tertutup saat captcha tidak dapat diterbitkan', () => {
  const register = read('frontend/js/register.js');
  // Kode captcha palsu tidak boleh pernah ditampilkan ke calon member.
  assert.doesNotMatch(register, /local-dummy-challenge/);
  assert.doesNotMatch(register, /using offline placeholder/);
  assert.doesNotMatch(register, /89X2B/);
  // Kalau server tidak bisa menerbitkan captcha, challenge harus dibatalkan
  // dan member diberi tahu harus memuat ulang, bukan menebak jawaban.
  assert.match(register, /currentChallengeId = null;/);
  assert.match(register, /Kode keamanan sedang tidak tersedia/);
  assert.match(register, /reg-captcha-code/);
});

test('halaman pasang wager gagal tertutup dan tidak pernah membuat angka palsu', () => {
  const mp = read('frontend/js/market-play.js');
  // Angka palsu yang dulu dipakai saat API gagal harus benar-benar hilang.
  assert.doesNotMatch(mp, /using fallback data/);
  assert.doesNotMatch(mp, /period:\s*'2982'/);
  assert.doesNotMatch(mp, /closeAt:\s*new Date\(/);
  // Guard readiness dipisah agar aturan dapat diuji tanpa DOM.
  assert.match(mp, /import \{ isMarketBettable \} from '\.\/market-readiness\.js'/);
  const readiness = read('frontend/js/market-readiness.js');
  assert.match(readiness, /function isMarketBettable/);
  assert.match(readiness, /market\.authorityReady !== true/);
  assert.match(readiness, /bettingStatus \|\| ''\)\.toUpperCase\(\) !== 'OPEN'/);
  assert.match(readiness, /!String\(market\.period \|\| ''\)\.trim\(\)/);
  assert.match(readiness, /Number\.isFinite\(closeMs\) && closeMs > now/);
  // Saat data gagal dimuat, pasar harus dinyatakan tidak tersedia.
  assert.match(mp, /bettingStatus: 'UNAVAILABLE'/);
  assert.match(mp, /Pasaran sedang tidak tersedia/);
  // Form wager harus dimatikan agar member tidak bisa mengirim.
  assert.match(mp, /setBettingControlsDisabled\(!isMarketBettable\(currentMarket\)\)/);
  assert.match(mp, /if \(!isMarketBettable\(currentMarket\)\)/);
});

test('server-fed frontend renderers escape dynamic values before HTML interpolation', () => {
  const member = read('frontend/js/member.js');
  const landing = read('frontend/js/landing.js');
  const marketPlay = read('frontend/js/market-play.js');
  const transaction = read('frontend/js/transaction.js');
  const register = read('frontend/js/register.js');
  const sportsbook = read('frontend/js/sportsbook-v2.js');
  const index = read('frontend/index.html');

  for (const [name, source] of Object.entries({ member, landing, marketPlay, transaction, register })) {
    assert.match(source, /escapeHtml/, `${name} must import/use escapeHtml`);
  }
  assert.match(member, /escapeHtml\(m\.name/);
  assert.match(member, /encodeURIComponent\(marketCode\)/);
  assert.match(landing, /escapeHtml\(m\.result/);
  // Form wager wajib menyandikan nilai ke escapeHtml. Bentuk yang aman boleh
  // memakai fallback nullish (escapeHtml(r.selection || '')) sehingga tetap
  // ter-escape walau selection kosong/undefined.
  assert.match(marketPlay, /escapeHtml\(r\.selection\s*(?:\|\|\s*''\s*)?\)/);
  assert.match(register, /escapeHtml\(data\.image\)/);
  assert.match(transaction, /escapeHtml\(String\(m\.id\)\)/);
  assert.match(sportsbook, /textContent/);
  assert.match(sportsbook, /createTextNode/);
  assert.doesNotMatch(sportsbook, /innerHTML/);
  assert.match(index, /escapeHtml\(result\)/);
  assert.match(index, /escapeHtml\(marketSlug\)/);
});
