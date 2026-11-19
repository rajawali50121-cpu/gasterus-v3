import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@example.com/db';
process.env.REDIS_URL = 'redis://example.com:6379';
process.env.MEMBER_PROXY_SECRET = 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET = 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET = 'o'.repeat(48);
process.env.SESSION_HMAC_KEY = 's'.repeat(48);
process.env.API_KEY_PEPPER = 'p'.repeat(48);

const {
  recordDrawObservations,
  calibratedSchedule,
  conservativeFallbackSchedule,
  drawCalibrationSnapshot,
  __drawCalibrator
} = await import('../src/toto-draw-calibrator.js');

function wibClock(isoUtc) {
  return new Date(Date.parse(isoUtc) + 7 * 3600 * 1000).toISOString().slice(11, 16);
}

test('sampling hanya terjadi saat tanggal draw berubah', () => {
  __drawCalibrator.observations.clear();
  const decision = { slug: 'sydney-pool', drawDate: '2026-09-26', status: 'VERIFIED' };
  // Pengamatan pertama tidak boleh mengarang jam.
  assert.equal(recordDrawObservations([decision], { now: new Date('2026-09-26T12:00:00Z') }).recorded, 0);
  assert.equal(calibratedSchedule('sydney-pool'), null);
  // Siklus berikutnya di hari yang sama tidak menambah sampel.
  assert.equal(recordDrawObservations([decision], { now: new Date('2026-09-26T12:05:00Z') }).recorded, 0);
  // Tanggal baru = hasil baru, satu sampel baru.
  const next = { slug: 'sydney-pool', drawDate: '2026-09-27', status: 'VERIFIED' };
  assert.equal(recordDrawObservations([next], { now: new Date('2026-09-27T12:00:00Z') }).recorded, 1);
  const entry = __drawCalibrator.observations.get('sydney-pool');
  assert.equal(entry.samples.length, 1);
  assert.equal(entry.samples.at(-1).minutes, 19 * 60);
});

test('restart collector tidak boleh menutup semua pasar pada jam yang sama', () => {
  __drawCalibrator.observations.clear();
  // Setelah restart, collector melihat semua pasar untuk pertama kali. Jadwal
  // manual harus tetap dipakai supaya tiap pasar punya jamnya sendiri.
  const markets = ['sydney-pool', 'hongkong-pool', 'jepang-pool', 'taiwan-pool', 'pcso-pool'];
  const decisions = markets.map(slug => ({ slug, drawDate: '2026-09-26', status: 'VERIFIED' }));
  assert.equal(recordDrawObservations(decisions, { now: new Date() }).recorded, 0);
  for (const slug of markets) assert.equal(calibratedSchedule(slug), null, `${slug} tidak boleh terkalibrasi di awal`);
  // Jadwal cadangan tetap berbeda-beda sesuai jadwal pool masing-masing.
  const closes = new Set(markets.map(slug => {
    const mapping = JSON.parse(readFileSync(new URL('../data/toto-source-map.json', import.meta.url), 'utf8')).find(item => item.slug === slug);
    return conservativeFallbackSchedule(mapping).closeTime;
  }));
  assert.ok(closes.size > 1, 'jam tutup cadangan antar pasar tidak boleh seragam');
});

test('jadwal terkalibrasi menutup 5 menit sebelum hasil terlihat', () => {
  __drawCalibrator.observations.clear();
  // Hari pertama hanya mencatat tanggal; sampel jam mulai terkumpul sejak hari kedua.
  for (let day = 1; day <= 4; day += 1) {
    recordDrawObservations(
      [{ slug: 'hongkong-pool', drawDate: `2026-09-2${day}`, status: 'VERIFIED' }],
      { now: new Date(`2026-09-2${day}T16:05:00Z`) }
    );
  }
  const schedule = calibratedSchedule('hongkong-pool');
  assert.equal(schedule.status, 'CALIBRATED');
  assert.equal(schedule.samples, 3);
  // 23:05 WIB hasil terlihat, tutup 23:00 WIB.
  assert.equal(schedule.resultTime, '23:05');
  assert.equal(schedule.closeTime, '23:00');
});

test('pasar tanpa sampel memakai jadwal pool yang digeser lebih awal', () => {
  __drawCalibrator.observations.clear();
  assert.equal(calibratedSchedule('belum-terukur'), null);
  const fallback = conservativeFallbackSchedule({ schedule: { closeTime: '23:10', resultTime: '23:25', timezone: 'Asia/Jakarta' } });
  assert.equal(fallback.status, 'CONFIGURED');
  assert.equal(fallback.safetyMinutes, 60);
  // Jadwal 23:10 digeser 60 menit supaya pasar menutup sebelum perkiraan hasil.
  assert.equal(fallback.closeTime, '22:10');
  assert.equal(fallback.resultTime, '22:10');
});

test('jadwal yang benar-benar tidak ada tetap tidak ditebak', () => {
  assert.equal(conservativeFallbackSchedule(null), null);
  assert.equal(conservativeFallbackSchedule({}), null);
  assert.equal(conservativeFallbackSchedule({ schedule: {} }), null);
});

test('penyimpanan kalibrasi dibatasi agar tidak tumbuh tanpa batas', () => {
  __drawCalibrator.observations.clear();
  const snapshot = drawCalibrationSnapshot();
  assert.equal(snapshot.maxSlugs, 96);
  assert.equal(snapshot.maxSamples, 7);
  for (let day = 1; day <= 12; day += 1) {
    recordDrawObservations([{ slug: 'jepang-pool', drawDate: `2026-09-${String(day).padStart(2, '0')}`, status: 'VERIFIED' }], { now: new Date() });
  }
  assert.ok(__drawCalibrator.observations.get('jepang-pool').samples.length <= 7);
  for (let i = 0; i < 200; i += 1) {
    recordDrawObservations([{ slug: `pool-${i}`, drawDate: '2026-09-26', status: 'VERIFIED' }], { now: new Date() });
  }
  assert.ok(drawCalibrationSnapshot().count <= 96);
});

test('keputusan bukan VERIFIED tidak boleh mengarang sampel jam', () => {
  __drawCalibrator.observations.clear();
  const before = drawCalibrationSnapshot().count;
  recordDrawObservations([
    { slug: 'x', drawDate: '2026-09-26', status: 'CONFLICT' },
    { slug: 'y', drawDate: '2026-09-26', status: 'SINGLE_SOURCE' },
    { slug: 'z', drawDate: '', status: 'VERIFIED' }
  ], { now: new Date() });
  assert.equal(drawCalibrationSnapshot().count, before);
});
