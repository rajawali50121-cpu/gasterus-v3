import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = file => readFileSync(resolve(ROOT, file), 'utf8').replace(/^\uFEFF/, '');

// Kosakata slug lama yang harus TIDAK PERNAH muncul lagi sebagai identitas pasar.
const LEGACY_TYPO = Object.freeze([
  'newjerseymid-pool',
  'tennesse-mid-pool',
  'tennesse-eve-pool',
  'washingtonmd-pool',
  'washingtonev-pool'
]);

const canonicalSlugs = new Set(JSON.parse(read('backend/data/toto-source-map.json')).map(m => m.slug));
const seedSlugs = new Set(JSON.parse(read('backend/data/markets.seed.json')).map(m => m.slug));

const scheduler = await import('../src/toto-draw-scheduler.js');
const collectorCore = await import('../src/toto-collector-core.js');
const official = await import('../src/toto-official-source.js');

test('source map adalah kosakata kanonik dan bebas slug typo lama', () => {
  assert.equal(canonicalSlugs.size, 45);
  for (const typo of LEGACY_TYPO) {
    assert.equal(canonicalSlugs.has(typo), false, `${typo} masih ada di source map`);
  }
});

test('scheduler dan DRAW_SCHEDULE memakai slug yang sama persis dengan source map', () => {
  const sched = Object.keys(scheduler.TOTO_RESULT_TIMES_WIB);
  const draw = Object.keys(collectorCore.DRAW_SCHEDULE);
  assert.deepEqual([...sched].filter(s => !canonicalSlugs.has(s)), [], 'scheduler punya slug asing');
  assert.deepEqual([...draw].filter(s => !canonicalSlugs.has(s)), [], 'DRAW_SCHEDULE punya slug asing');
  assert.equal(sched.length, canonicalSlugs.size);
  assert.equal(draw.length, canonicalSlugs.size);
});

test('toto-official-source tidak memproduksi slug typo lama', () => {
  for (const typo of LEGACY_TYPO) {
    assert.equal(official.OFFICIAL_MARKET_SLUGS.has(typo), false, `${typo} masih diproduksi official source`);
  }
});

test('slug pasar member-facing yang diproduksi official source harus kanonik', () => {
  // Pool yang memang disembunyikan operator boleh tetap slug non-kanonik, tetapi
  // kalau slug itu hanya salah ejaan dari slug kanonik, itu bug identitas.
  for (const slug of official.OFFICIAL_MARKET_SLUGS) {
    const nearMiss = [...canonicalSlugs].some(c => c.replace(/-/g, '') === slug.replace(/-/g, ''));
    if (nearMiss) {
      assert.equal(canonicalSlugs.has(slug), true, `${slug} adalah ejaan salah dari slug kanonik`);
    }
  }
});

test('markets.seed.json memuat seluruh 45 slug kanonik dan tanpa slug typo', () => {
  const missing = [...canonicalSlugs].filter(s => !seedSlugs.has(s));
  assert.deepEqual(missing, [], 'slug kanonik hilang dari seed');
  for (const typo of LEGACY_TYPO) {
    assert.equal(seedSlugs.has(typo), false, `${typo} masih ada di markets.seed.json`);
  }
});

test('migration 038 memakai slug kanonik yang sama dengan source map', () => {
  const sql = read('backend/migrations/038_seed_market_draw_time_from_schedule.sql');
  const slugs = [...sql.matchAll(/\('([a-z0-9-]+)',\s*'\d{2}:\d{2}',/g)].map(m => m[1]);
  assert.equal(slugs.length, canonicalSlugs.size, 'jumlah baris jadwal 038 harus 45');
  assert.deepEqual([...slugs].filter(s => !canonicalSlugs.has(s)), [], '038 memakai slug asing');
  assert.deepEqual([...canonicalSlugs].filter(s => !slugs.includes(s)), [], 'ada slug kanonik yang tak ada di 038');
});

test('migration 039 memetakan tepat 5 slug lama ke slug kanonik', () => {
  const sql = read('backend/migrations/039_canonicalize_market_slugs.sql');
  const pairs = [...sql.matchAll(/SET slug = '([a-z0-9-]+)'[^;]*?WHERE slug = '([a-z0-9-]+)'/g)]
    .map(m => ({ to: m[1], from: m[2] }));
  assert.equal(pairs.length, LEGACY_TYPO.length, 'harus ada tepat 5 pemetaan');
  for (const { to, from } of pairs) {
    assert.ok(LEGACY_TYPO.includes(from), `${from} bukan slug lama yang dikenal`);
    assert.ok(canonicalSlugs.has(to), `${to} bukan slug kanonik`);
  }
});

// --- Deteksi pasar orphan (anti pasar membeku diam-diam) ---------------------

test('slug di luar source map terdeteksi sebagai orphan, kecuali pool tersembunyi', async () => {
  const { isOrphanMarketSlug } = await import('../src/toto-market-identity.js');
  // Slug kanonik: pasti disentuh collector.
  assert.equal(isOrphanMarketSlug('hongkong-pool'), false);
  assert.equal(isOrphanMarketSlug('tennessee-mid-pool'), false);
  // Slug lama: tidak akan pernah disentuh collector -> harus terdeteksi.
  for (const typo of LEGACY_TYPO) {
    assert.equal(isOrphanMarketSlug(typo), true, `${typo} seharusnya terdeteksi orphan`);
  }
  // Pool yang memang disembunyikan operator sengaja tidak dikumpulkan.
  assert.equal(isOrphanMarketSlug('prague-pool'), false);
  assert.equal(isOrphanMarketSlug('wellington-pool'), false);
  // Slug kosong bukan sinyal apa pun.
  assert.equal(isOrphanMarketSlug(''), false);
  assert.equal(isOrphanMarketSlug(null), false);
});

test('tidak ada satu pun dari 45 slug kanonik yang salah dianggap orphan', async () => {
  const { isOrphanMarketSlug } = await import('../src/toto-market-identity.js');
  const salah = [...canonicalSlugs].filter(slug => isOrphanMarketSlug(slug));
  assert.deepEqual(salah, [], 'slug kanonik tidak boleh dianggap orphan');
});

// --- Fallback frontend (dipakai member saat API gagal) -----------------------

test('fallback frontend tidak pernah memakai slug typo lama', () => {
  const fallback = JSON.parse(read('frontend/public_markets.json')).data;
  assert.equal(fallback.length, 45);
  const slugs = fallback.map(m => m.slug);
  assert.equal(new Set(slugs).size, 45, 'slug fallback harus unik');
  for (const typo of LEGACY_TYPO) {
    assert.equal(slugs.includes(typo), false, `${typo} masih ada di public_markets.json`);
  }
  assert.deepEqual([...canonicalSlugs].filter(s => !slugs.includes(s)), [], 'slug kanonik hilang dari fallback');
});

test('fallback frontend memakai nama kanonik dari source map', () => {
  const canonicalNames = new Map(
    JSON.parse(read('backend/data/toto-source-map.json')).map(m => [m.slug, m.name])
  );
  const fallback = JSON.parse(read('frontend/public_markets.json')).data;
  const salah = fallback
    .filter(m => canonicalNames.has(m.slug) && canonicalNames.get(m.slug) !== m.name)
    .map(m => `${m.slug}: "${m.name}" bukan "${canonicalNames.get(m.slug)}"`);
  assert.deepEqual(salah, [], 'nama pasar harus sama dengan source map');
});

test('migrasi wajib membungkus perubahan dalam transaksi', () => {
  for (const file of ['039_canonicalize_market_slugs.sql']) {
    const sql = read(`backend/migrations/${file}`);
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /COMMIT;/);
  }
});

// --- Kebijakan: jangan duplikat, jangan menimpa ------------------------------

test('migrasi 039 tidak pernah INSERT atau DELETE baris pasar', () => {
  const sql = read('backend/migrations/039_canonicalize_market_slugs.sql');
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\s+markets\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+markets\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
});

test('rename markets hanya menyentuh kolom slug (tidak menimpa data hasil)', () => {
  const sql = read('backend/migrations/039_canonicalize_market_slugs.sql');
  const renames = [...sql.matchAll(/UPDATE markets SET ([^\n;]+) WHERE slug = '[a-z0-9-]+';/g)].map(m => m[1]);
  assert.equal(renames.length, 5, 'harus ada tepat 5 UPDATE rename');
  for (const clause of renames) {
    assert.match(clause, /^slug\s*=\s*'[a-z0-9-]+'$/, `kolom lain ikut ditulis: ${clause}`);
  }
  // Kolom yang harus tetap utuh.
  for (const column of ['updated_at', 'result', 'verification_status', 'draw_time', 'source_updated_at', 'period']) {
    assert.doesNotMatch(sql, new RegExp(`SET slug[^;]*${column}\\s*=`, 'i'), `kolom ${column} ikut ditimpa`);
  }
});

test('migrasi 039 batalkan diri bila slug kanonik sudah ada (anti duplikat)', () => {
  const sql = read('backend/migrations/039_canonicalize_market_slugs.sql');
  const guardAt = sql.indexOf('RAISE EXCEPTION');
  const firstRename = sql.indexOf('UPDATE markets SET slug');
  assert.ok(guardAt > -1, 'harus ada pre-flight guard');
  assert.ok(firstRename > -1, 'harus ada rename');
  assert.ok(guardAt < firstRename, 'guard duplikat harus mendahului rename');
  assert.match(sql, /JOIN markets m ON m\.slug = t\.target/);
});

test('migrasi 039 menutup diri dengan verifikasi akhir', () => {
  const sql = read('backend/migrations/039_canonicalize_market_slugs.sql');
  const lastVerify = sql.lastIndexOf('RAISE EXCEPTION');
  const lastRename = sql.lastIndexOf('UPDATE markets SET slug');
  assert.ok(lastVerify > lastRename, 'verifikasi harus berada setelah rename');
  assert.match(sql, /sisa_lama <> 0/);
  assert.match(sql, /LEFT JOIN markets m ON m\.slug = t\.target/);
});