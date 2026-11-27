import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES,
  DEFAULT_ODDS_MAX_AGE_MINUTES,
  FRESHNESS_CODES,
  evaluateOddsFreshness,
  parseFreshnessConfig,
} from '../src/sportsbook-next/prematch-freshness-guard.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-28T10:00:00.000Z');
const CONFIG = parseFreshnessConfig({});

function makeSnapshot(overrides = {}) {
  return {
    capturedAt: NOW - 30 * MIN,
    marketStatus: 'open',
    eventStartsAt: NOW + 360 * MIN,
    price: 1.85,
    ...overrides,
  };
}

function check(snapshotOverrides = {}, extra = {}) {
  return evaluateOddsFreshness({
    snapshot: makeSnapshot(snapshotOverrides),
    clientPrice: 1.85,
    now: NOW,
    config: CONFIG,
    ...extra,
  });
}

function assertRejected(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

test('odds masih fresh diterima', () => {
  const result = check();
  assert.equal(result.ok, true);
  assert.equal(result.code, FRESHNESS_CODES.OK);
  assert.equal(typeof result.reason, 'string');
});

test('hasil selalu berisi tepat ok, code, dan reason', () => {
  assert.deepEqual(Object.keys(check()).sort(), ['code', 'ok', 'reason']);
  assert.deepEqual(
    Object.keys(check({ marketStatus: 'removed' })).sort(),
    ['code', 'ok', 'reason'],
  );
});

test('snapshot lebih tua dari batas umur ditolak', () => {
  const result = check({ capturedAt: NOW - (DEFAULT_ODDS_MAX_AGE_MINUTES * MIN + 1) });
  assertRejected(result, FRESHNESS_CODES.STALE_SNAPSHOT);
});

test('snapshot tepat di batas umur masih diterima', () => {
  const result = check({ capturedAt: NOW - DEFAULT_ODDS_MAX_AGE_MINUTES * MIN });
  assert.equal(result.ok, true);
});

test('snapshot sesuai siklus polling 150 menit diterima pada batas 180 menit', () => {
  const result = check({ capturedAt: NOW - 150 * MIN });
  assert.equal(result.ok, true);
});

test('market suspended ditolak', () => {
  assertRejected(check({ marketStatus: 'suspended' }), FRESHNESS_CODES.MARKET_SUSPENDED);
});

test('market removed ditolak', () => {
  assertRejected(check({ marketStatus: 'removed' }), FRESHNESS_CODES.MARKET_REMOVED);
});

test('status market tidak peka huruf besar dan spasi', () => {
  assertRejected(check({ marketStatus: ' Suspended ' }), FRESHNESS_CODES.MARKET_SUSPENDED);
});

test('pertandingan yang sudah mulai ditolak', () => {
  assertRejected(check({ eventStartsAt: NOW - 1 }), FRESHNESS_CODES.EVENT_STARTED);
  assertRejected(check({ eventStartsAt: NOW }), FRESHNESS_CODES.EVENT_STARTED);
});

test('pertandingan mendekati kickoff ditolak, tepat di batas juga ditolak', () => {
  const cutoffMs = DEFAULT_ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES * MIN;
  assertRejected(
    check({ eventStartsAt: NOW + cutoffMs - 1 }),
    FRESHNESS_CODES.EVENT_NEAR_KICKOFF,
  );
  assertRejected(
    check({ eventStartsAt: NOW + cutoffMs }),
    FRESHNESS_CODES.EVENT_NEAR_KICKOFF,
  );
});

test('sedikit di luar batas kickoff masih diterima', () => {
  const cutoffMs = DEFAULT_ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES * MIN;
  assert.equal(check({ eventStartsAt: NOW + cutoffMs + 1 }).ok, true);
});

test('harga klien yang berbeda dari snapshot ditolak', () => {
  assertRejected(check({}, { clientPrice: 1.9 }), FRESHNESS_CODES.PRICE_CHANGED);
});

test('harga klien harus sama persis', () => {
  assertRejected(check({}, { clientPrice: 1.8500001 }), FRESHNESS_CODES.PRICE_CHANGED);
  assert.equal(check({}, { clientPrice: 1.85 }).ok, true);
});

test('urutan aturan: removed mengalahkan stale dan harga berubah', () => {
  const result = check(
    { marketStatus: 'removed', capturedAt: NOW - 1000 * MIN },
    { clientPrice: 9.99 },
  );
  assertRejected(result, FRESHNESS_CODES.MARKET_REMOVED);
});

test('urutan aturan: sudah mulai mengalahkan stale, stale mengalahkan harga berubah', () => {
  assertRejected(
    check({ eventStartsAt: NOW - MIN, capturedAt: NOW - 1000 * MIN }),
    FRESHNESS_CODES.EVENT_STARTED,
  );
  assertRejected(
    check({ capturedAt: NOW - 1000 * MIN }, { clientPrice: 9.99 }),
    FRESHNESS_CODES.STALE_SNAPSHOT,
  );
});

test('waktu boleh berupa string ISO atau Date', () => {
  const result = evaluateOddsFreshness({
    snapshot: makeSnapshot({
      capturedAt: new Date(NOW - 10 * MIN).toISOString(),
      eventStartsAt: new Date(NOW + 360 * MIN),
    }),
    clientPrice: 1.85,
    now: new Date(NOW).toISOString(),
    config: CONFIG,
  });
  assert.equal(result.ok, true);
});

test('input tidak valid ditolak (fail-closed)', () => {
  const cases = [
    evaluateOddsFreshness(),
    evaluateOddsFreshness({}),
    evaluateOddsFreshness({ snapshot: null, clientPrice: 1.85, now: NOW, config: CONFIG }),
    check({ capturedAt: 'bukan-tanggal' }),
    check({ capturedAt: undefined }),
    check({ eventStartsAt: null }),
    check({ marketStatus: 'unknown' }),
    check({ marketStatus: undefined }),
    check({ price: '1.85' }),
    check({ price: 0 }),
    check({ price: Number.NaN }),
    check({}, { clientPrice: '1.85' }),
    check({}, { clientPrice: undefined }),
    check({}, { clientPrice: -1 }),
    check({}, { now: 'rusak' }),
    check({}, { now: undefined }),
    check({}, { config: null }),
    check({}, { config: { maxAgeMinutes: 0, cutoffBeforeKickoffMinutes: 5 } }),
    check({}, { config: { maxAgeMinutes: 180 } }),
  ];
  for (const result of cases) {
    assertRejected(result, FRESHNESS_CODES.INVALID_INPUT);
  }
});

test('snapshot dari masa depan melebihi toleransi jam ditolak, di dalam toleransi diterima', () => {
  assertRejected(
    check({ capturedAt: NOW + 2 * MIN }),
    FRESHNESS_CODES.INVALID_INPUT,
  );
  assert.equal(check({ capturedAt: NOW + 30_000 }).ok, true);
});

test('config tidak diberikan memakai nilai bawaan', () => {
  const result = evaluateOddsFreshness({
    snapshot: makeSnapshot({ capturedAt: NOW - (DEFAULT_ODDS_MAX_AGE_MINUTES * MIN + 1) }),
    clientPrice: 1.85,
    now: NOW,
  });
  assertRejected(result, FRESHNESS_CODES.STALE_SNAPSHOT);
});

test('parseFreshnessConfig memakai nilai bawaan 180 dan 5', () => {
  assert.deepEqual(parseFreshnessConfig({}), {
    maxAgeMinutes: 180,
    cutoffBeforeKickoffMinutes: 5,
  });
  assert.deepEqual(parseFreshnessConfig(), {
    maxAgeMinutes: 180,
    cutoffBeforeKickoffMinutes: 5,
  });
  assert.deepEqual(parseFreshnessConfig(null), {
    maxAgeMinutes: 180,
    cutoffBeforeKickoffMinutes: 5,
  });
});

test('parseFreshnessConfig membaca nilai env yang valid', () => {
  assert.deepEqual(
    parseFreshnessConfig({
      ODDS_MAX_AGE_MINUTES: '200',
      ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES: '10',
    }),
    { maxAgeMinutes: 200, cutoffBeforeKickoffMinutes: 10 },
  );
});

test('parseFreshnessConfig memakai nilai bawaan untuk env yang tidak valid', () => {
  const invalidValues = ['', '   ', 'abc', '0', '-5', 'NaN', 'Infinity', '12abc'];
  for (const value of invalidValues) {
    assert.deepEqual(
      parseFreshnessConfig({
        ODDS_MAX_AGE_MINUTES: value,
        ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES: value,
      }),
      { maxAgeMinutes: 180, cutoffBeforeKickoffMinutes: 5 },
      `nilai env ${JSON.stringify(value)} harus memakai nilai bawaan`,
    );
  }
});

test('config dari env dipakai oleh evaluasi', () => {
  const config = parseFreshnessConfig({
    ODDS_MAX_AGE_MINUTES: '60',
    ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES: '30',
  });
  assertRejected(
    check({ capturedAt: NOW - 61 * MIN }, { config }),
    FRESHNESS_CODES.STALE_SNAPSHOT,
  );
  assertRejected(
    check({ eventStartsAt: NOW + 30 * MIN }, { config }),
    FRESHNESS_CODES.EVENT_NEAR_KICKOFF,
  );
  assert.equal(check({ capturedAt: NOW - 60 * MIN }, { config }).ok, true);
});

test('evaluasi tidak mengubah input', () => {
  const snapshot = Object.freeze(makeSnapshot());
  const config = Object.freeze({ maxAgeMinutes: 180, cutoffBeforeKickoffMinutes: 5 });
  const result = evaluateOddsFreshness({ snapshot, clientPrice: 1.85, now: NOW, config });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot, makeSnapshot());
});

test('hasil sama untuk input yang sama (deterministik)', () => {
  assert.deepEqual(check(), check());
  assert.deepEqual(
    check({ marketStatus: 'suspended' }),
    check({ marketStatus: 'suspended' }),
  );
});
