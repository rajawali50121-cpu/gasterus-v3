import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

test('settlement worker and feed/collector worker are separate processes', () => {
  const launcher = read('deploy/launcher.js');
  const settlement = read('backend/src/worker.js');
  const feed = read('backend/src/feed-worker.js');
  assert.match(launcher, /start\('feed-worker',coreDir,\['src\/feed-worker\.js'\]/);
  assert.match(launcher, /'feed-worker':heapMB\('FEED_WORKER_HEAP_MB',256(?:,\d+)?\)/);
  assert.match(launcher, /isRecoverable = label => \['core', 'worker', 'feed-worker'/);
  assert.doesNotMatch(settlement, /refreshSportsbookFeed|runTotoCollector|DRAW_SCHEDULE/);
  assert.match(feed, /refreshSportsbookFeed/);
  assert.match(feed, /runTotoCollector/);
});

test('auto-open scheduler and cash-window reconciler never write the same market twice', () => {
  const markets = read('backend/src/markets.js');
  const openCheck = markets.slice(markets.indexOf('export async function runMarketOpenCheck'), markets.indexOf('export function startMarketOpenScheduler'));
  // Baris auto_cash_window=TRUE dimiliki reconciler; scheduler harus mengecualikannya
  // supaya betting_period tidak ditimpa dua penulis setiap menit.
  assert.match(openCheck, /COALESCE\(c\.auto_cash_window, FALSE\) = FALSE/);
  assert.match(openCheck, /COALESCE\(c\.auto_reopen_blocked, FALSE\) = FALSE/);
});

test('every market_betting_configs INSERT sets an explicit betting_status', () => {
  const insert = /INSERT INTO market_betting_configs\(market_id\)(?!,betting_status)/;
  for (const file of ['backend/src/markets.js', 'backend/src/betting.js', 'backend/src/toto-cash-lifecycle.js']) {
    assert.doesNotMatch(read(file), insert, `${file} masih INSERT tanpa betting_status eksplisit`);
  }
});
test('pasaran tanpa waktu tutup tidak pernah diumumkan sebagai OPEN', () => {
  const migrasi = read('backend/migrations/029_suspend_markets_without_close_at.sql');
  // Baris OPEN tanpa close_at harus ditutup, bukan dibiarkan menipu member.
  assert.match(migrasi, /WHERE betting_status = 'OPEN'\s+AND close_at IS NULL/);
  assert.match(migrasi, /betting_status = 'SUSPENDED'/);
  // Ditandai agar scheduler auto-open tidak membukanya lagi dengan tebakan tanggal.
  assert.match(migrasi, /auto_reopen_blocked = TRUE/);
  // Baris yang sehat tidak boleh ikut tersentuh.
  assert.doesNotMatch(migrasi, /close_at IS NOT NULL/);
});

test('kode display setiap pasar unik dan link member memakai slug', () => {
  const seed = JSON.parse(read('backend/data/markets.seed.json'));
  const codes = seed.map(item => item.code);
  const slug = new Set(seed.map(item => item.slug));
  assert.equal(slug.size, seed.length, 'slug pasar harus unik');
  assert.equal(new Set(codes).size, codes.length, 'kode display pasar tidak boleh bentrok');
  // marketByIdentifier hanya menerima slug/provider_path/id, jadi link wajib slug.
  const member = read('frontend/js/member.js');
  assert.match(member, /String\(m\.slug \|\| m\.code \|\| ''\)/);
  assert.doesNotMatch(member, /newBtn\.href = '\/market-play\.html\?code=' \+ \(m\.code/);
  const marketPlay = read('frontend/js/market-play.js');
  assert.doesNotMatch(marketPlay, /get\('code'\) \|\| 'SGP'/);
  assert.match(read('backend/migrations/031_unique_market_codes.sql'), /UPDATE markets SET code=/);
});

test('sportsbook feed and Redis cache have hard event and byte caps', () => {
  const config = read('backend/src/config.js');
  const feed = read('backend/src/sportsbook-feed.js');
  assert.match(config, /sportsFeedMaxEvents/);
  assert.match(config, /sportsFeedMaxCacheBytes/);
  assert.match(feed, /MAX_FEED_EVENTS/);
  assert.match(feed, /MAX_CACHE_BYTES/);
  assert.match(feed, /cacheWithinLimit/);
  assert.match(feed, /Buffer\.byteLength\(raw, 'utf8'\) > MAX_CACHE_BYTES/);
});
