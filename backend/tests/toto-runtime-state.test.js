import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),

});

const scheduler = await import('../src/toto-draw-scheduler.js');
const calibrator = await import('../src/toto-draw-calibrator.js');

// Payload Redis nyata (string JSON) — memastikan objek murni, bukan referensi objek asli.
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test('status libur/draw scheduler bertahan setelah serialize → hydrate', () => {
  scheduler.__totoDrawScheduler.state.clear();
  // Pengamatan pertama mencatat tanggal tanpa menandai libur.
  scheduler.markDrawObservations(
    [{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }],
    { now: new Date('2026-09-27T11:00:00Z') }
  );
  // Lewat jam result + grace tanpa tanggal baru → pasar ditandai libur hari ini.
  const outcome = scheduler.markDrawObservations(
    [{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }],
    { now: new Date('2026-09-27T15:00:00Z') }
  );
  assert.deepEqual(outcome.skippedDays, ['jepang-pool']);
  assert.equal(scheduler.isDrawDay('jepang-pool', new Date('2026-09-27T15:00:00Z')), false);

  const snapshot = roundTrip(scheduler.serializeDrawState());

  // Simulasi restart: memori proses kosong.
  scheduler.__totoDrawScheduler.state.clear();
  assert.equal(scheduler.isDrawDay('jepang-pool', new Date('2026-09-27T15:00:00Z')), true);

  const restored = scheduler.hydrateDrawState(snapshot);
  assert.ok(restored >= 1, 'minimal satu entri dipulihkan');
  assert.equal(scheduler.isDrawDay('jepang-pool', new Date('2026-09-27T15:00:00Z')), false);
});

test('hydrateDrawState menolak payload rusak tanpa mengubah state', () => {
  scheduler.__totoDrawScheduler.state.clear();
  scheduler.markDrawObservations(
    [{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }],
    { now: new Date('2026-09-27T15:00:00Z') }
  );
  assert.equal(scheduler.hydrateDrawState({ version: 99 }), 0);
  assert.equal(scheduler.hydrateDrawState(null), 0);
  assert.ok(scheduler.__totoDrawScheduler.state.size >= 1);
});

test('kalibrasi jam result bertahan setelah serialize → hydrate', () => {
  calibrator.__drawCalibrator.observations.clear();
  // Pertama: hanya mencatat tanggal (belum ada sampel jam).
  calibrator.recordDrawObservations(
    [{ slug: 'jepang-pool', drawDate: '2026-09-25', status: 'VERIFIED' }],
    { now: new Date('2026-09-27T12:00:00Z') }
  );
  // Tanggal berganti → satu sampel jam terukur (19:47 WIB).
  calibrator.recordDrawObservations(
    [{ slug: 'jepang-pool', drawDate: '2026-09-26', status: 'VERIFIED' }],
    { now: new Date('2026-09-28T12:47:00Z') }
  );
  const before = calibrator.calibratedSchedule('jepang-pool');
  assert.ok(before && before.resultTime, 'jadwal terkalibrasi harus terbentuk');

  const snapshot = roundTrip(calibrator.serializeCalibrationState());

  calibrator.__drawCalibrator.observations.clear();
  assert.equal(calibrator.calibratedSchedule('jepang-pool'), null);

  const restored = calibrator.hydrateCalibrationState(snapshot);
  assert.ok(restored >= 1, 'minimal satu pasar dipulihkan');
  const after = calibrator.calibratedSchedule('jepang-pool');
  assert.equal(after.resultTime, before.resultTime);
  assert.equal(after.closeTime, before.closeTime);
});
