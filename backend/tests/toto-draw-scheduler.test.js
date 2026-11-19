import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@example.com/db';
process.env.REDIS_URL = 'redis://example.com:6379';
process.env.MEMBER_PROXY_SECRET = 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET = 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET = 'o'.repeat(48);
process.env.SESSION_HMAC_KEY = 's'.repeat(48);
process.env.API_KEY_PEPPER = 'p'.repeat(48);

const {
  TOTO_RESULT_TIMES_WIB,
  TOTO_SKIPPED_WEEKDAYS,
  activeWakeSet,
  isDrawDay,
  wakeWindowFor,
  markDrawObservations,
  schedulerSnapshot,
  poolsInPollingPhase,
  closeAtFor,
  TOTO_POLL_INTERVAL_MINUTES,
  TOTO_SCRAPE_LEAD_MINUTES,
  TOTO_CLOSE_LEAD_MINUTES,
  measuredResultTimeFor,
  scheduleDriftFor,
  __totoDrawScheduler
} = await import('../src/toto-draw-scheduler.js');

const calibrator = await import('../src/toto-draw-calibrator.js');

// Memberi sebuah pool 'samples' pengamatan pada jam WIB tertentu, supaya
// jadwal terukur bisa diuji. Pengamatan pertama hanya mencatat tanggal.
function seedMeasured(slug, clockWib, samples) {
  calibrator.__drawCalibrator.observations.clear();
  const [hh, mm] = clockWib.split(':').map(Number);
  for (let i = 0; i <= samples; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    const utcMs = Date.parse(`2026-10-${day}T00:00:00Z`) + (hh * 60 + mm - 7 * 60) * 60000;
    calibrator.recordDrawObservations(
      [{ slug, drawDate: `2026-10-${day}`, status: 'VERIFIED' }],
      { now: new Date(utcMs) }
    );
  }
}

const SLUGS = Object.keys(TOTO_RESULT_TIMES_WIB);
const wib = (iso) => new Date(Date.parse(iso) + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

test('jam result operator mengikuti tabel dan semuanya WIB', () => {
  assert.equal(TOTO_RESULT_TIMES_WIB['jepang-pool'][0], '20:45');
  assert.equal(TOTO_RESULT_TIMES_WIB['hongkong-pool'][0], '23:25');
  assert.equal(TOTO_RESULT_TIMES_WIB['pcso-pool'][0], '23:25');
  assert.equal(TOTO_RESULT_TIMES_WIB['sydney-pool'][0], '20:00');
  assert.equal(TOTO_RESULT_TIMES_WIB['taiwan-pool'][0], '21:55');
  assert.equal(TOTO_RESULT_TIMES_WIB['california-pool'][0], '21:15');
  assert.equal(TOTO_RESULT_TIMES_WIB['china-pool'][0], '21:35');
  // Pool dengan lebih dari satu undian per hari tetap sebuah entri.
  assert.equal(TOTO_RESULT_TIMES_WIB['toto-macau-night'].length, 1);
  for (const slug of SLUGS) {
    for (const time of TOTO_RESULT_TIMES_WIB[slug]) {
      assert.match(time, /^([01]\d|2[0-3]):[0-5]\d$/, `${slug} jam tidak valid`);
    }
  }
});

test('collector hanya bangun di dekat jam result, tidak sepanjang hari', () => {
  // Jauh dari jam result pool mana pun: 11:30 dan 17:30 WIB tidak ada yang waking.
  for (const iso of ['2026-09-27T04:30:00Z', '2026-09-27T10:30:00Z']) {
    assert.equal(activeWakeSet(new Date(iso), SLUGS).length, 0, `${wib(iso)} seharusnya tidak ada pool aktif`);
    assert.equal(poolsInPollingPhase(new Date(iso), SLUGS).length, 0, `${wib(iso)} seharusnya tidak ada polling`);
  }
  // 20:40 WIB (T-5 Jepang): hanya pool dengan jam result 20:00–20:45 yang polling.
  const sore = poolsInPollingPhase(new Date('2026-09-27T13:40:00Z'), SLUGS);
  assert.ok(sore.some(item => item.slug === 'jepang-pool'), 'Jepang 20:45 masih menunggu result di 20:40');
  for (const item of sore) {
    assert.ok(item.resultTime >= 20 * 60 && item.resultTime <= 20 * 60 + 45, `${item.slug} di luar band jam result 20:00–20:45`);
  }
  assert.ok(sore.some(item => item.slug === 'sydney-pool'), 'Sydney 20:00 masih dalam masa T+55');
  assert.ok(sore.some(item => item.slug === 'cambodia-pool'), 'Cambodia 20:35 masih menunggu result');
  // Tepat pada T-5 jam result Jepang (20:40 WIB) pool Jepang wajib waking.
  const tMinus5Jepang = new Date('2026-09-27T13:40:00Z');
  assert.ok(activeWakeSet(tMinus5Jepang, SLUGS).includes('jepang-pool'));
});

test('polling hanya mulai pada T-5, ditutup pada T-20, dan berlangsung tiap 3 menit', () => {
  const resultTime = 16 * 60; // 16:00 WIB
  // 15:40 WIB = T-20: betting ditutup, tapi belum ada polling.
  const tMinus20 = new Date('2026-09-27T08:40:00Z');
  // 15:41 WIB: masih tidak ada scraping.
  const tMinus19 = new Date('2026-09-27T08:41:00Z');
  // 15:54 WIB = T-6: belum.
  const tMinus6 = new Date('2026-09-27T08:54:00Z');
  // 15:55 WIB = T-5: polling pertama.
  const tMinus5 = new Date('2026-09-27T08:55:00Z');
  assert.equal(poolsInPollingPhase(tMinus20).some(item => item.slug === 'toto-macau-sore'), false, 'T-20 tidak boleh poll pool 16:00');
  assert.equal(poolsInPollingPhase(tMinus19).some(item => item.slug === 'toto-macau-sore'), false, 'T-19 tidak boleh poll');
  assert.equal(poolsInPollingPhase(tMinus6).some(item => item.slug === 'toto-macau-sore'), false, 'T-6 tidak boleh poll');
  const mulai = poolsInPollingPhase(tMinus5);
  assert.ok(mulai.some(item => item.slug === 'toto-macau-sore' && item.resultTime === resultTime), 'T-5 harus poll');

  // Betting ditutup 20 menit sebelum result.
  const close = closeAtFor(resultTime, { now: new Date('2026-09-27T08:00:00Z') });
  assert.equal(close.closeClock, '15:40');
  assert.equal(close.resultClock, '16:00');
});

test('interval antar poll tepat 3 menit', () => {
  assert.equal(TOTO_POLL_INTERVAL_MINUTES, 3);
  assert.equal(TOTO_SCRAPE_LEAD_MINUTES, 5);
  assert.equal(TOTO_CLOSE_LEAD_MINUTES, 20);
});

test('hari libur yang sudah diketahui dilewati tanpa membangkitkan pool', () => {
  // 2026-09-29 adalah Selasa, 2026-09-25 adalah Jumat.
  const selasa = new Date('2026-09-29T15:20:00Z');
  assert.equal(isDrawDay('singapore-pool', selasa), false);
  assert.equal(activeWakeSet(selasa, SLUGS).includes('singapore-pool'), false);
  const jumat = new Date('2026-09-25T15:20:00Z');
  assert.equal(isDrawDay('singapore-pool', jumat), false);
  // Hari lain tetap waking seperti biasa.
  assert.equal(isDrawDay('singapore-pool', new Date('2026-09-30T15:20:00Z')), true);
  assert.deepEqual(TOTO_SKIPPED_WEEKDAYS['singapore-pool'], [2, 5]);
});

test('hari libur yang tidak terdaftar tetap terdeteksi dari sumber', () => {
  __totoDrawScheduler.state.clear();
  const sebelumResult = new Date('2026-09-27T11:00:00Z');
  // Angka pools masih 25-09 saat jendela result berjalan.
  markDrawObservations([{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }], { now: sebelumResult });
  // Lewat jam result Jepang (20:45 WIB) + grace, sumber tidak mengeluarkan tanggal baru.
  const sesudahResult = new Date('2026-09-27T15:00:00Z'); // 22:00 WIB
  const hasil = markDrawObservations([{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }], { now: sesudahResult });
  assert.deepEqual(hasil.skippedDays, ['jepang-pool']);
  assert.equal(isDrawDay('jepang-pool', sesudahResult), false);
  // Hari berikutnya jadwal berjalan lagi.
  assert.equal(isDrawDay('jepang-pool', new Date('2026-09-28T11:00:00Z')), true);
});

test('angka yang benar-benar berganti membatalkan status libur', () => {
  __totoDrawScheduler.state.clear();
  const sebelum = new Date('2026-09-27T11:00:00Z');
  markDrawObservations([{ slug: 'taiwan-pool', drawDate: '2026-09-25', status: 'VERIFIED' }], { now: sebelum });
  const sesudah = new Date('2026-09-27T14:00:00Z');
  markDrawObservations([{ slug: 'taiwan-pool', drawDate: '2026-09-25', status: 'VERIFIED' }], { now: sesudah });
  const hasil = markDrawObservations([{ slug: 'taiwan-pool', drawDate: '2026-09-26', status: 'VERIFIED' }], { now: sesudah });
  assert.deepEqual(hasil.advanced, ['taiwan-pool']);
  assert.equal(isDrawDay('taiwan-pool', sesudah), true);
});

test('status scheduler memakai T-20/T-5/3 menit dan tidak menyimpan apa pun di luar daftar pool', () => {
  __totoDrawScheduler.state.clear();
  const snap = schedulerSnapshot(new Date('2026-09-27T12:00:00Z'));
  assert.equal(snap.configuredMarkets, SLUGS.length);
  assert.equal(snap.closeLeadMinutes, 20);
  assert.equal(snap.scrapeLeadMinutes, 5);
  assert.equal(snap.pollIntervalMinutes, 3);
  assert.equal(snap.holidayGraceMinutes, 90);
  for (let i = 0; i < 300; i += 1) {
    markDrawObservations([{ slug: `entah-${i}`, drawDate: '2026-09-26', status: 'VERIFIED' }], { now: new Date() });
  }
  assert.ok(__totoDrawScheduler.state.size <= 96, 'state scheduler harus dibatasi');
});

test('registry jadwal tidak punya tabel jam kedua yang bertentangan', async () => {
  const registry = await import('../src/toto-schedule-registry.js');
  const bySlug = new Map(registry.SCHEDULE_REGISTRY.map(row => [row.slug, row]));
  for (const [slug, times] of Object.entries(TOTO_RESULT_TIMES_WIB)) {
    const row = bySlug.get(slug);
    assert.ok(row, `${slug} tidak ada di SCHEDULE_REGISTRY`);
    assert.equal(row.drawWib, times[0], `jam ${slug} berbeda dari scheduler kanonik`);
  }
  assert.equal(registry.SCHEDULE_COUNTS.total, Object.keys(TOTO_RESULT_TIMES_WIB).length);
  // Nilai lama yang bertentangan dengan scheduler harus hilang total.
  assert.equal(bySlug.get('sydney-pool').drawWib, '20:00');
  assert.equal(bySlug.get('jepang-pool').drawWib, '20:45');
  assert.equal(bySlug.get('california-pool').drawWib, '21:15');
});

test('jadwal mengikuti jam terukur begitu cukup bukti; tabel operator hanya cadangan', () => {
  const slug = 'bullseye-pool';
  assert.equal(TOTO_RESULT_TIMES_WIB[slug][0], '22:15', 'tabel operator adalah titik awal');
  // Tanpa bukti dari sumber, tabel yang dipakai.
  calibrator.__drawCalibrator.observations.clear();
  assert.equal(measuredResultTimeFor(slug), null);
  assert.equal(scheduleDriftFor(slug), null);

  // Bukti cukup: jam yang benar-benar dilaporkan sumber (12:10) menggantikan tabel.
  seedMeasured(slug, '12:10', 5);
  const measured = measuredResultTimeFor(slug);
  assert.ok(measured, 'jam terukur harus dipakai setelah cukup sampel');
  assert.equal(measured.resultTime, '12:10');
  const drift = scheduleDriftFor(slug);
  assert.equal(drift.table, '22:15');
  assert.equal(drift.measured, '12:10');
  assert.equal(drift.deltaMinutes, 12 * 60 + 10 - (22 * 60 + 15));

  // Jendela polling ikut pindah ke jam terukur: T-5 = 12:05 WIB = 05:05Z.
  assert.ok(poolsInPollingPhase(new Date('2026-10-07T05:05:00Z'), [slug]).some(item => item.slug === slug));
  // Jam lama dari tabel tidak lagi dipakai: 22:20 WIB bukan lagi fase polling.
  assert.equal(poolsInPollingPhase(new Date('2026-10-07T15:20:00Z'), [slug]).length, 0);

  calibrator.__drawCalibrator.observations.clear();
});

test('pool tanpa jam operator tidak pernah membangunkan collector sendiri', () => {
  assert.equal(TOTO_RESULT_TIMES_WIB['pool-tanpa-jadwal'], undefined);
  assert.equal(wakeWindowFor('pool-tanpa-jadwal', new Date('2026-09-27T12:00:00Z')), null);
  assert.equal(activeWakeSet(new Date('2026-09-27T12:00:00Z'), SLUGS).includes('pool-tanpa-jadwal'), false);
});
