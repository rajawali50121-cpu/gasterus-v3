// Prematch freshness guard (fungsi murni).
//
// Menentukan apakah harga odds prematch masih boleh diterima untuk sebuah taruhan.
// Modul ini berdiri sendiri: tanpa import, tanpa membaca variabel lingkungan atau
// waktu sistem, tanpa jaringan/database, dan belum dipanggil dari mana pun.
// Waktu sekarang dan konfigurasi selalu diberikan lewat parameter.
//
// Bentuk input yang sudah dinormalisasi. Pemetaan dari data snapshot nyata ke
// bentuk ini dikerjakan terpisah saat modul disambungkan ke jalur taruhan:
//   snapshot = { capturedAt, marketStatus, eventStartsAt, price }
//     capturedAt, eventStartsAt : epoch milidetik, string ISO 8601, atau Date
//     marketStatus              : 'open' | 'suspended' | 'removed'
//     price                     : odds desimal (angka > 0)
//   clientPrice : odds desimal yang dikirim klien (angka > 0)
//   now         : epoch milidetik, string ISO 8601, atau Date
//   config      : { maxAgeMinutes, cutoffBeforeKickoffMinutes } (lihat parseFreshnessConfig)
//
// Hasil selalu { ok, code, reason }. Semua data yang hilang atau tidak valid
// ditolak (fail-closed).

export const DEFAULT_ODDS_MAX_AGE_MINUTES = 180;
export const DEFAULT_ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES = 5;

export const FRESHNESS_CODES = Object.freeze({
  OK: 'OK',
  INVALID_INPUT: 'INVALID_INPUT',
  MARKET_REMOVED: 'MARKET_REMOVED',
  MARKET_SUSPENDED: 'MARKET_SUSPENDED',
  EVENT_STARTED: 'EVENT_STARTED',
  EVENT_NEAR_KICKOFF: 'EVENT_NEAR_KICKOFF',
  STALE_SNAPSHOT: 'STALE_SNAPSHOT',
  PRICE_CHANGED: 'PRICE_CHANGED',
});

const MINUTE_MS = 60_000;
// Toleransi selisih jam antar mesin: snapshot yang tampak dibuat paling lama
// 1 menit di masa depan dianggap umur 0, lebih dari itu dianggap tidak valid.
const MAX_CLOCK_SKEW_MS = MINUTE_MS;
const MARKET_STATUSES = new Set(['open', 'suspended', 'removed']);

function reject(code, reason) {
  return { ok: false, code, reason };
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toEpochMs(value) {
  if (typeof value === 'number') {
    return isPositiveNumber(value) ? value : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return isPositiveNumber(ms) ? ms : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return isPositiveNumber(ms) ? ms : null;
  }
  return null;
}

function positiveNumberOrDefault(raw, fallback) {
  let value = Number.NaN;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    value = Number(raw);
  }
  return isPositiveNumber(value) ? value : fallback;
}

// Menerima objek variabel lingkungan lewat parameter (tidak membaca apa pun sendiri).
// Nilai yang kosong, bukan angka, atau tidak positif memakai nilai bawaan.
export function parseFreshnessConfig(env) {
  const source = env && typeof env === 'object' ? env : {};
  return Object.freeze({
    maxAgeMinutes: positiveNumberOrDefault(
      source.ODDS_MAX_AGE_MINUTES,
      DEFAULT_ODDS_MAX_AGE_MINUTES,
    ),
    cutoffBeforeKickoffMinutes: positiveNumberOrDefault(
      source.ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES,
      DEFAULT_ODDS_CUTOFF_BEFORE_KICKOFF_MINUTES,
    ),
  });
}

// Urutan aturan: INVALID_INPUT, MARKET_REMOVED, MARKET_SUSPENDED, EVENT_STARTED,
// EVENT_NEAR_KICKOFF, STALE_SNAPSHOT, PRICE_CHANGED, lalu OK.
export function evaluateOddsFreshness({ snapshot, clientPrice, now, config } = {}) {
  const invalid = (detail) =>
    reject(
      FRESHNESS_CODES.INVALID_INPUT,
      `Data odds tidak valid (${detail}). Taruhan ditolak.`,
    );

  if (!snapshot || typeof snapshot !== 'object') return invalid('snapshot kosong');

  const nowMs = toEpochMs(now);
  if (nowMs === null) return invalid('waktu sekarang');

  const effectiveConfig = config === undefined ? parseFreshnessConfig({}) : config;
  if (
    !effectiveConfig ||
    typeof effectiveConfig !== 'object' ||
    !isPositiveNumber(effectiveConfig.maxAgeMinutes) ||
    !isPositiveNumber(effectiveConfig.cutoffBeforeKickoffMinutes)
  ) {
    return invalid('konfigurasi');
  }

  const capturedMs = toEpochMs(snapshot.capturedAt);
  if (capturedMs === null) return invalid('waktu snapshot');

  const startsMs = toEpochMs(snapshot.eventStartsAt);
  if (startsMs === null) return invalid('waktu mulai pertandingan');

  const status =
    typeof snapshot.marketStatus === 'string'
      ? snapshot.marketStatus.trim().toLowerCase()
      : '';
  if (!MARKET_STATUSES.has(status)) return invalid('status market');

  if (!isPositiveNumber(snapshot.price) || !isPositiveNumber(clientPrice)) {
    return invalid('harga');
  }

  const ageMs = nowMs - capturedMs;
  if (ageMs < -MAX_CLOCK_SKEW_MS) return invalid('waktu snapshot di masa depan');

  if (status === 'removed') {
    return reject(FRESHNESS_CODES.MARKET_REMOVED, 'Market ini sudah tidak tersedia.');
  }
  if (status === 'suspended') {
    return reject(FRESHNESS_CODES.MARKET_SUSPENDED, 'Market ini sedang ditangguhkan.');
  }

  const msToKickoff = startsMs - nowMs;
  if (msToKickoff <= 0) {
    return reject(FRESHNESS_CODES.EVENT_STARTED, 'Pertandingan sudah dimulai.');
  }
  if (msToKickoff <= effectiveConfig.cutoffBeforeKickoffMinutes * MINUTE_MS) {
    return reject(
      FRESHNESS_CODES.EVENT_NEAR_KICKOFF,
      `Pertandingan segera dimulai (${effectiveConfig.cutoffBeforeKickoffMinutes} menit atau kurang). Taruhan sudah ditutup.`,
    );
  }

  if (ageMs > effectiveConfig.maxAgeMinutes * MINUTE_MS) {
    return reject(
      FRESHNESS_CODES.STALE_SNAPSHOT,
      'Harga odds sudah kedaluwarsa. Muat ulang odds terbaru.',
    );
  }

  if (clientPrice !== snapshot.price) {
    return reject(
      FRESHNESS_CODES.PRICE_CHANGED,
      'Harga odds telah berubah. Periksa harga terbaru lalu coba lagi.',
    );
  }

  return { ok: true, code: FRESHNESS_CODES.OK, reason: 'Harga odds masih valid.' };
}
