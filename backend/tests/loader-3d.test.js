import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

test('menu navigasi semua halaman memakai tombol berikon, bukan teks polos', () => {
  const mobileBlue = read('frontend/css/mobile-blue.css');
  // Gaya tombol navigasi sudah ada di mobile-blue.css. Halaman yang memakai
  // nav-drawer-item tidak punya aturan apa pun sehingga tampil sebagai teks
  // polos tanpa bentuk tombol.
  assert.match(mobileBlue, /\.nav-drawer-link \{/);
  assert.match(mobileBlue, /\.nav-drawer-ico \{/);
  assert.doesNotMatch(mobileBlue, /\.nav-drawer-item\b/);

  const pages = readdirSync(resolve(root, 'frontend')).filter(name => name.endsWith('.html'));
  for (const name of pages) {
    const html = read(`frontend/${name}`);
    if (!/class="nav-drawer-body"/.test(html)) continue;
    assert.doesNotMatch(html, /nav-drawer-item/, `${name} masih memakai nav-drawer-item`);
    const links = html.match(/<a class="nav-drawer-link"[^>]*>/g) || [];
    assert.ok(links.length > 0, `${name} tidak punya tombol navigasi`);
    for (const tag of links) {
      assert.match(tag, /<span class="nav-drawer-ico">/, `tombol di ${name} belum punya ikon`);
    }
  }
});

const frontendPages = readdirSync(resolve(root, 'frontend'))
  .filter(name => name.endsWith('.html'))
  .filter(name => !name.startsWith('__') && name !== 'icon-preview.html');

// market-play dan sportsbook memakai sistem CSS token sendiri, jadi dikecualikan
// dari aturan token mobile-blue.
const mobileBluePages = frontendPages.filter(name => !['market-play.html', 'sportsbook.html'].includes(name));

test('semua halaman memakai satu token cache untuk mobile-blue.css', () => {
  const tokens = new Set();
  for (const name of mobileBluePages) {
    const found = read(`frontend/${name}`).match(/mobile-blue\.css\?v=([a-z0-9-]+)/);
    assert.ok(found, `${name} tidak punya token cache mobile-blue.css`);
    tokens.add(found[1]);
  }
  assert.equal(tokens.size, 1, `token cache harus satu, ditemukan: ${[...tokens].join(', ')}`);
});

test('halaman promosi mendefinisikan sendiri kelas dan spacing yang tidak di-load', () => {
  const html = read('frontend/promotion.html');
  // promotion.html memakai variabel spacing dan beberapa kelas dari
  // layout.css/components.css, tetapi halaman ini hanya memuat mobile-blue.css.
  // Tanpa definisi ulang, padding hilang dan footer/badge tidak punya aturan.
  const selfScoped = html.match(/\.page-promotion \{([\s\S]*?)\}/)[1];
  for (const step of ['1', '2', '3', '4', '5', '6', '8']) {
    assert.match(selfScoped, new RegExp(`--space-${step}:`), `--space-${step} belum didefinisikan`);
  }
  for (const className of ['app-main', 'container', 'app-footer', 'footer-links', 'footer-bottom', 'badge-info', 'nav-drawer-body']) {
    assert.match(html, new RegExp(`\\.page-promotion \\.${className}\\b`), `.${className} belum diberi gaya`);
  }
  // Tombol navigasi memakai kelas nav-drawer-link global, jadi halaman promosi
  // tidak boleh menimpanya dengan gaya sendiri.
  assert.doesNotMatch(html, /\.page-promotion \.nav-drawer-link/);
  // Struktur penutup harus seimbang.
  assert.equal((html.match(/<div/g) || []).length, (html.match(/<\/div>/g) || []).length, 'jumlah div tidak seimbang');
  // Semua promo dan tombol buka-tutup harus tetap utuh.
  assert.equal((html.match(/class="promo-card fade-in"/g) || []).length, 8, 'harus ada 8 kartu promo');
  assert.equal((html.match(/togglePromoDrawer\(this\)/g) || []).length, 8, 'setiap promo punya tombol syarat');
  // Perbaikan ini hanya menambah ruang kosong; desain asli tidak boleh diubah.
  assert.doesNotMatch(html, /promo-hero|promoFadeUp/);
  assert.match(html, /class="promo-card"|class="promo-card fade-in"/);
  assert.match(html, /font-size: 2\.2rem/);
});

test('setiap badge di halaman promosi memakai kelas, bukan gaya inline', () => {
  const html = read('frontend/promotion.html');
  const mobileBlue = read('frontend/css/mobile-blue.css');
  // Gaya inline membuat tampilan tidak seragam antar kartu. Semua badge harus
  // memakai kelas yang punya definisi, baik lokal maupun dari mobile-blue.css.
  assert.equal((html.match(/<span class="badge[^"]*" style=/g) || []).length, 0, 'masih ada badge dengan gaya inline');
  const used = new Set();
  for (const match of html.matchAll(/class="badge ([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) used.add(name);
  }
  assert.ok(used.size >= 4, 'zona badge harus punya beberapa variasi');
  for (const name of used) {
    const definedLocally = new RegExp(`\\.page-promotion \\.${name}\\b`).test(html);
    const definedGlobally = new RegExp(`\\.${name}\\b`).test(mobileBlue);
    assert.ok(definedLocally || definedGlobally, `.${name} tidak punya aturan warna`);
  }
  // Warna badge harus mengikuti pola semi-transparan yang sudah dipakai
  // badge-warning dan badge-success, bukan warna solid yang tidak seragam.
  const info = html.match(/\.page-promotion \.badge-info \{([^}]*)\}/)[1];
  assert.match(info, /background: rgba\(/);
  assert.match(info, /border: 1px solid rgba\(/);
});

test('animations.css dimuat tepat satu kali dan setelah mobile-blue.css', () => {
  for (const name of frontendPages) {
    const html = read(`frontend/${name}`);
    const count = (html.match(/\/css\/animations\.css/g) || []).length;
    assert.ok(count <= 1, `${name} memuat animations.css ${count} kali, harus maksimal 1`);
    if (count === 0) continue;
    const anim = html.indexOf('/css/animations.css');
    // Bandingkan dengan stylesheet utama halaman ini: mobile-blue.css untuk
    // halaman utama, tokens.css untuk market-play dan sportsbook.
    const main = Math.max(html.indexOf('mobile-blue.css'), html.indexOf('tokens.css'));
    if (main >= 0) {
      // Animasi harus dimuat setelah stylesheet utama supaya cascade-nya stabil.
      assert.ok(anim > main, `${name} memuat animations.css sebelum stylesheet utama`);
    }
  }
});

test('loader 3D GASTERUS terpasang di semua halaman tanpa mengubah layout', () => {
  const loaderJs = read('frontend/js/loader-3d.js');
  const loaderCss = read('frontend/css/loader-3d.css');
  // Dua file BARU, terpisah dari CSS/layout yang sudah ada.
  assert.match(loaderCss, /\.gasterus-loader\b/);
  assert.match(loaderCss, /@keyframes gasterusLoaderSpin/);
  assert.match(loaderCss, /prefers-reduced-motion/);
  assert.match(loaderJs, /gasterus-loader-logo/);
  assert.match(loaderJs, /GASTERUS/);
  // Loader harus punya jaring pengaman agar tidak pernah menahan halaman.
  assert.match(loaderJs, /MAX_MS/);
  assert.match(loaderJs, /halaman tetap dimuat normal/);

  const pages = readdirSync(resolve(root, 'frontend')).filter(name => name.endsWith('.html'));
  const memberPages = pages.filter(name => !name.startsWith('__') && name !== 'icon-preview.html');
  assert.ok(memberPages.length >= 24, 'halaman member harus lengkap');
  for (const name of memberPages) {
    const html = read(`frontend/${name}`);
    assert.match(html, /loader-3d\.css/, `${name} belum memuat CSS loader`);
    assert.match(html, /loader-3d\.js/, `${name} belum memuat JS loader`);
  }
});
