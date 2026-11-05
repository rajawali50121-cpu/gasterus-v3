import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { config } from './config.js';
import { leagueKey, teamKey } from './sportsbook-providers.js';

export const SPORTSBOOK_INGEST_REDIS_KEY = 'sportsbook:render-ingest-snapshot:v1';
const ALLOWED_PROVIDERS = new Set(['sportmonks', 'api-sports', 'sharpapi', 'oddspapi']);
const ALLOWED_STATUSES = new Set(['SCHEDULED', 'LIVE', 'FINISHED', 'SUSPENDED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID']);
const MAX_PROVIDER_RESULTS = 4;
const MAX_EVENTS = 500;
const MAX_EVENT_RECORDS = MAX_EVENTS * MAX_PROVIDER_RESULTS;
const MAX_MARKETS_PER_EVENT = 120;
const MAX_SELECTIONS_PER_MARKET = 250;
const MAX_FUTURE_SKEW_SECONDS = 30;

function invalid(message, code = 'SPORTSBOOK_INGEST_INVALID') {
  throw new AppError(400, message, code);
}

async function readRequestBytes(request, maxBytes) {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength))) {
      throw new AppError(400, 'Content-Length tidak valid.', 'SPORTSBOOK_INGEST_CONTENT_LENGTH_INVALID');
    }
    if (Number(contentLength) > maxBytes) {
      throw new AppError(413, 'Ukuran snapshot sportsbook melebihi batas.', 'SPORTSBOOK_INGEST_PAYLOAD_TOO_LARGE');
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError(413, 'Ukuran snapshot sportsbook melebihi batas.', 'SPORTSBOOK_INGEST_PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function validateTimestamp(timestamp, nowSeconds, maxAgeSeconds) {
  if (!/^\d{10}$/.test(timestamp)) {
    throw new AppError(401, 'Signature ingestion tidak valid.', 'SPORTSBOOK_INGEST_SIGNATURE_INVALID');
  }
  const sentAt = Number(timestamp);
  if (nowSeconds - sentAt > maxAgeSeconds || sentAt - nowSeconds > MAX_FUTURE_SKEW_SECONDS) {
    throw new AppError(401, 'Signature ingestion sudah kedaluwarsa.', 'SPORTSBOOK_INGEST_SIGNATURE_EXPIRED');
  }
}

function verifySignature(rawBody, timestamp, signature, secret) {
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    throw new AppError(401, 'Signature ingestion tidak valid.', 'SPORTSBOOK_INGEST_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AppError(401, 'Signature ingestion tidak valid.', 'SPORTSBOOK_INGEST_SIGNATURE_INVALID');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sameFixture(a, b) {
  if (a.sport !== b.sport
    || teamKey(a.home.name) !== teamKey(b.home.name)
    || teamKey(a.away.name) !== teamKey(b.away.name)) return false;
  const firstLeague = leagueKey(a.league);
  if (!firstLeague || firstLeague !== leagueKey(b.league)) return false;
  return Math.abs(Date.parse(a.startTime) - Date.parse(b.startTime)) <= 3 * 60 * 60 * 1000;
}

function countUniqueFixtures(providerResults) {
  const fixtures = [];
  for (const result of providerResults) {
    for (const event of result.events) {
      if (!fixtures.some(existing => sameFixture(existing, event))) fixtures.push(event);
    }
  }
  return fixtures.length;
}

function validateEvent(event, provider) {
  const problems = [];
  if (!isRecord(event)) problems.push('not a record');
  else {
    if (!requiredString(event.id, 128)) problems.push(`id=${JSON.stringify(event?.id)}`);
    if (!requiredString(event.sport, 40)) problems.push(`sport=${JSON.stringify(event?.sport)}`);
    if (!requiredString(event.league, 120)) problems.push(`league=${JSON.stringify(event?.league)}`);
    if (!(event.country === null || requiredString(event.country, 80))) problems.push(`country=${JSON.stringify(event?.country)}`);
    if (!validTimestamp(event.startTime)) problems.push(`startTime=${JSON.stringify(event?.startTime)}`);
    if (!ALLOWED_STATUSES.has(event.status)) problems.push(`status=${JSON.stringify(event?.status)}`);
    if (typeof event.live !== 'boolean') problems.push(`live=${JSON.stringify(event?.live)}`);
    if (!isRecord(event.home) || !requiredString(event.home.name, 120)) problems.push(`home=${JSON.stringify(event?.home)}`);
    if (!isRecord(event.away) || !requiredString(event.away.name, 120)) problems.push(`away=${JSON.stringify(event?.away)}`);
    if (!Array.isArray(event.markets) || event.markets.length > MAX_MARKETS_PER_EVENT) problems.push(`markets type/len=${JSON.stringify(event?.markets)?.slice?.(0, 60)}`);
    if (!isRecord(event._refs) || !requiredString(event._refs[provider], 160)) problems.push(`refs=${JSON.stringify(event?._refs)}`);
    if (!Array.isArray(event._sources) || event._sources.length !== 1 || event._sources[0] !== provider) problems.push(`sources=${JSON.stringify(event?._sources)}`);
  }
  if (problems.length) {
    invalid(`Event ${String(event?.id || '').slice(0, 40)} tidak memiliki struktur normalisasi yang valid (${provider}: ${problems.join(', ')}.`);
  }

  if ((event.status === 'LIVE') !== event.live) {
    invalid(`Status live event ${event.id} tidak konsisten.`);
  }

  for (const market of event.markets) {
    if (!isRecord(market)
      || !requiredString(market.id, 128)
      || !requiredString(market.type, 60)
      || !requiredString(market.period, 20)
      || market.source !== provider
      || typeof market.suspended !== 'boolean'
      || !Array.isArray(market.selections)
      || market.selections.length === 0
      || market.selections.length > MAX_SELECTIONS_PER_MARKET) {
      invalid(`Market pada event ${event.id} tidak valid.`);
    }
    for (const selection of market.selections) {
      if (!isRecord(selection)
        || !requiredString(selection.key, 160)
        || !requiredString(selection.label, 120)
        || !Number.isFinite(selection.odds)
        || selection.odds <= 1
        || selection.odds > 10000
        || typeof selection.suspended !== 'boolean'
        || selection.source !== provider
        || !(selection.updatedAt === null || validTimestamp(selection.updatedAt))) {
        invalid(`Selection pada event ${event.id} tidak valid.`);
      }
    }
  }
}

export function validateSportsbookSnapshot(snapshot, { now = Date.now(), maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds } = {}) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || !validTimestamp(snapshot.generatedAt)) {
    invalid('Envelope snapshot sportsbook tidak valid.');
  }

  const generatedAt = Date.parse(snapshot.generatedAt);
  const ageMs = now - generatedAt;
  if (ageMs < -MAX_FUTURE_SKEW_SECONDS * 1000 || ageMs > maxAgeSeconds * 1000) {
    throw new AppError(400, 'Snapshot sportsbook sudah kedaluwarsa atau berasal dari masa depan.', 'SPORTSBOOK_INGEST_SNAPSHOT_STALE');
  }

  if (!Array.isArray(snapshot.providerResults)
    || snapshot.providerResults.length === 0
    || snapshot.providerResults.length > MAX_PROVIDER_RESULTS) {
    invalid('Daftar provider snapshot sportsbook tidak valid.');
  }

  const providers = new Set();
  let totalEventRecords = 0;
  for (const result of snapshot.providerResults) {
    if (!isRecord(result)
      || !ALLOWED_PROVIDERS.has(result.provider)
      || providers.has(result.provider)
      || result.enabled !== true
      || !Array.isArray(result.events)) {
      invalid('Hasil provider pada snapshot sportsbook tidak valid.');
    }
    providers.add(result.provider);
    totalEventRecords += result.events.length;
    if (totalEventRecords > MAX_EVENT_RECORDS) {
      throw new AppError(413, 'Snapshot sportsbook melebihi batas record event.', 'SPORTSBOOK_INGEST_EVENT_LIMIT');
    }
    for (const event of result.events) validateEvent(event, result.provider);
  }

  const eventCount = countUniqueFixtures(snapshot.providerResults);
  if (eventCount === 0) invalid('Snapshot sportsbook harus memuat setidaknya satu event.');
  if (eventCount > MAX_EVENTS) {
    throw new AppError(413, 'Snapshot sportsbook melebihi batas 500 fixture unik.', 'SPORTSBOOK_INGEST_EVENT_LIMIT');
  }
  if (snapshot.eventCount !== undefined && snapshot.eventCount !== eventCount) {
    invalid('Jumlah event pada envelope snapshot sportsbook tidak konsisten.');
  }
  return { snapshot, eventCount, providers: [...providers] };
}

export function mergeSportsbookSnapshots(incoming, previous, { now = Date.now(), maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds } = {}) {
  const freshIncoming = incoming.providerResults.filter(result => result.transportOk !== false && result.stale !== true);
  const incomingProviders = new Set(freshIncoming.map(result => result.provider));
  const providerReceivedAt = {};
  const providerResults = [];
  const nowIso = new Date(now).toISOString();

  for (const result of freshIncoming) {
    providerResults.push(result);
    providerReceivedAt[result.provider] = nowIso;
  }

  for (const result of previous?.snapshot?.providerResults || []) {
    if (incomingProviders.has(result.provider)) continue;
    const receivedAt = previous.snapshot.providerReceivedAt?.[result.provider]
      || previous.snapshot.generatedAt;
    const ageMs = now - Date.parse(receivedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeSeconds * 1000) continue;
    providerResults.push({ ...result, stale: true, transportOk: false });
    providerReceivedAt[result.provider] = receivedAt;
  }

  const retainedGroups = [];
  const retainedEvents = new Set();
  for (const result of providerResults) {
    for (const event of result.events) {
      let group = retainedGroups.find(items => sameFixture(items[0], event));
      if (!group) {
        if (retainedGroups.length >= MAX_EVENTS) continue;
        group = [];
        retainedGroups.push(group);
      }
      group.push(event);
      retainedEvents.add(event);
    }
  }

  const boundedResults = providerResults.map(result => ({
    ...result,
    events: result.events.filter(event => retainedEvents.has(event))
  }));
  return {
    ...incoming,
    generatedAt: nowIso,
    providerResults: boundedResults,
    providerReceivedAt,
    eventCount: retainedGroups.length
  };
}

export function createStoredSportsbookSnapshot({ serializedSnapshot, timestamp, signature, receivedAt = Date.now() }) {
  const raw = Buffer.from(serializedSnapshot, 'utf8');
  return JSON.stringify({
    schemaVersion: 1,
    receivedAt: new Date(receivedAt).toISOString(),
    timestamp,
    signature,
    revision: createHash('sha256').update(raw).digest('hex'),
    rawBody: serializedSnapshot
  });
}

export async function storeMergedSportsbookSnapshot(redisClient, incoming, {
  secret = config.sportsbookIngestHmacSecret,
  maxPayloadBytes = config.sportsbookIngestMaxPayloadBytes,
  maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds,
  now = Date.now(),
  ttlSeconds = 1800,
  retries = 3
} = {}) {
  assert(redisClient?.isOpen && typeof redisClient.watch === 'function' && typeof redisClient.multi === 'function', 503,
    'Penyimpanan snapshot sportsbook belum tersedia.', 'SPORTSBOOK_INGEST_STORAGE_UNAVAILABLE');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new AppError(503, 'Ingestion sportsbook belum dikonfigurasi.', 'SPORTSBOOK_INGEST_NOT_CONFIGURED');
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    await redisClient.watch(SPORTSBOOK_INGEST_REDIS_KEY);
    try {
      const previousRaw = await redisClient.get(SPORTSBOOK_INGEST_REDIS_KEY);
      let previous = null;
      if (previousRaw) {
        try {
          previous = verifyStoredSportsbookSnapshot(previousRaw, { secret, maxPayloadBytes, maxAgeSeconds, now });
        } catch {
          previous = null;
        }
      }

      const merged = mergeSportsbookSnapshots(incoming, previous, { now, maxAgeSeconds });
      validateSportsbookSnapshot(merged, { now, maxAgeSeconds });
      const serializedSnapshot = JSON.stringify(merged);
      const rawBody = Buffer.from(serializedSnapshot, 'utf8');
      if (rawBody.length > maxPayloadBytes) {
        throw new AppError(413, 'Snapshot gabungan sportsbook melebihi batas ukuran; snapshot lama dipertahankan.', 'SPORTSBOOK_INGEST_PAYLOAD_TOO_LARGE');
      }
      const timestamp = String(Math.floor(now / 1000));
      const signature = createHmac('sha256', secret)
        .update(timestamp)
        .update('.')
        .update(rawBody)
        .digest('hex');
      const stored = createStoredSportsbookSnapshot({ serializedSnapshot, timestamp, signature, receivedAt: now });
      const transaction = redisClient.multi();
      transaction.set(SPORTSBOOK_INGEST_REDIS_KEY, stored, { EX: ttlSeconds });
      const committed = await transaction.exec();
      if (committed !== null) return merged;
    } finally {
      await redisClient.unwatch().catch(() => {});
    }
  }
  throw new AppError(503, 'Snapshot sportsbook berubah bersamaan; pembaruan tidak disimpan.', 'SPORTSBOOK_INGEST_WRITE_CONFLICT');
}

export function verifyStoredSportsbookSnapshot(stored, {
  secret = config.sportsbookIngestHmacSecret,
  maxPayloadBytes = config.sportsbookIngestMaxPayloadBytes,
  maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds,
  now = Date.now()
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new AppError(503, 'Ingestion sportsbook belum dikonfigurasi.', 'SPORTSBOOK_INGEST_NOT_CONFIGURED');
  }

  let record;
  try {
    record = JSON.parse(stored);
  } catch {
    throw new AppError(400, 'Record staging sportsbook tidak valid.', 'SPORTSBOOK_INGEST_STAGING_INVALID');
  }
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1 || typeof record.rawBody !== 'string') {
    throw new AppError(400, 'Record staging sportsbook tidak valid.', 'SPORTSBOOK_INGEST_STAGING_INVALID');
  }

  const receivedAt = Date.parse(record.receivedAt);
  if (!Number.isFinite(receivedAt) || receivedAt > now + MAX_FUTURE_SKEW_SECONDS * 1000 || now - receivedAt > maxAgeSeconds * 1000) {
    throw new AppError(400, 'Snapshot staging sportsbook sudah kedaluwarsa.', 'SPORTSBOOK_INGEST_STAGING_STALE');
  }

  const rawBody = Buffer.from(record.rawBody, 'utf8');
  if (rawBody.length > maxPayloadBytes) {
    throw new AppError(413, 'Snapshot staging sportsbook melebihi batas ukuran.', 'SPORTSBOOK_INGEST_PAYLOAD_TOO_LARGE');
  }

  validateTimestamp(String(record.timestamp || ''), Math.floor(now / 1000), maxAgeSeconds);
  const revision = createHash('sha256').update(rawBody).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(String(record.revision || ''))
    || !timingSafeEqual(Buffer.from(revision, 'hex'), Buffer.from(record.revision, 'hex'))) {
    throw new AppError(400, 'Revision snapshot staging tidak valid.', 'SPORTSBOOK_INGEST_REVISION_INVALID');
  }
  verifySignature(rawBody, record.timestamp, record.signature, secret);

  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    throw new AppError(400, 'Format JSON snapshot staging tidak valid.', 'SPORTSBOOK_INGEST_JSON_INVALID');
  }
  const validated = validateSportsbookSnapshot(snapshot, { now, maxAgeSeconds });
  return {
    snapshot,
    revision,
    receivedAt: new Date(receivedAt).toISOString(),
    providerResults: validated.providers
  };
}

export async function acceptSportsbookSnapshot(request, {
  secret = config.sportsbookIngestHmacSecret,
  maxPayloadBytes = config.sportsbookIngestMaxPayloadBytes,
  maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds,
  now = Date.now(),
  storeSnapshot
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new AppError(503, 'Ingestion sportsbook belum dikonfigurasi.', 'SPORTSBOOK_INGEST_NOT_CONFIGURED');
  }
  assert(typeof storeSnapshot === 'function', 500, 'Penyimpanan snapshot sportsbook belum tersedia.', 'SPORTSBOOK_INGEST_STORAGE_UNAVAILABLE');
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError(415, 'Content-Type harus application/json.', 'SPORTSBOOK_INGEST_CONTENT_TYPE_INVALID');
  }

  const timestamp = String(request.headers['x-sportsbook-timestamp'] || '');
  const signature = String(request.headers['x-sportsbook-signature'] || '');
  validateTimestamp(timestamp, Math.floor(now / 1000), maxAgeSeconds);
  const rawBody = await readRequestBytes(request, maxPayloadBytes);
  verifySignature(rawBody, timestamp, signature, secret);

  let snapshot;
  let serializedSnapshot;
  try {
    serializedSnapshot = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    snapshot = JSON.parse(serializedSnapshot);
  } catch {
    throw new AppError(400, 'Format JSON snapshot tidak valid.', 'SPORTSBOOK_INGEST_JSON_INVALID');
  }
  const validated = validateSportsbookSnapshot(snapshot, { now, maxAgeSeconds });
  await storeSnapshot(snapshot, serializedSnapshot, {
    timestamp,
    signature,
    receivedAt: now
  });
  return {
    accepted: true,
    generatedAt: snapshot.generatedAt,
    providerResults: validated.providers,
    eventCount: validated.eventCount
  };
}
