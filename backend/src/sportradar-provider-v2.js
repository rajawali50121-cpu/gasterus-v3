import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { __sportradarNormalizer } from './sportradar-normalizer.js';
import { buildSportradarHeaders, buildSportradarProductBaseUrl, getSportradarAccessFromPrematchBaseUrl } from './sportradar-products.js';
import { createClient } from 'redis';
import { logger } from './logger.js';

const PROVIDER = 'sportradar';
const DEFAULT_BASE_URL = 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en';
const PAGE_SIZE = 50;
const STATE_KEY = 'sportsbook:sportradar:v2:state';
const LEASE_KEY = 'sportsbook:sportradar:v2:lease';
const BASELINE_KEY = 'sportsbook:sportradar:v2:quota:baseline';
const BASELINE_INIT_KEY = 'sportsbook:sportradar:v2:quota:baseline-initialized';
const ROLLING_KEY = 'sportsbook:sportradar:v2:quota:rolling';
const HOURLY_KEY = 'sportsbook:sportradar:v2:quota:hourly';
const QPS_KEY = 'sportsbook:sportradar:v2:quota:qps';
const STATE_TTL_SECONDS = 48 * 60 * 60;
const LEASE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = { value: null, expiresAt: 0 };
const redisClient = createClient({
  url: config.redisUrl,
  disableOfflineQueue: true,
  commandOptions: { timeout: 8000 },
  pingInterval: 20000,
  socket: {
    connectTimeout: 8000,
    socketTimeout: 45000,
    keepAlive: true,
    keepAliveInitialDelay: 10000,
    reconnectStrategy: retries => Math.min(1000 + retries * 250, 10000)
  }
});
redisClient.on('error', error => logger.error('Sportradar Redis client error', { error: error.message }));
redisClient.on('reconnecting', () => logger.warn('Sportradar Redis reconnecting'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function dateKey(date) { return date.toISOString().slice(0, 10); }
function utcDates(daysAhead, now = new Date()) {
  const dates = [];
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = 0; offset <= Math.max(1, Number(daysAhead) || 1); offset += 1) {
    dates.push(dateKey(new Date(start + offset * 86400000)));
  }
  return dates;
}
function baseUrl() {
  const configured = config.sportradarBaseUrl || DEFAULT_BASE_URL;
  const { accessLevel, languageCode } = getSportradarAccessFromPrematchBaseUrl(configured);
  return buildSportradarProductBaseUrl('prematchV2', { accessLevel, languageCode });
}
function parseDate(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}
async function ensureRedis() {
  if (!config.redisUrl) throw new Error('REDIS_URL is required for shared Sportradar state and quota protection.');
  if (!redisClient.isOpen) {
    if (typeof redisClient.connect === 'function') await redisClient.connect();
    else throw new Error('Injected Sportradar Redis client is not connected.');
  }
}
async function acquireLease() {
  const token = randomUUID();
  const result = await redisClient.set(LEASE_KEY, token, { NX: true, PX: LEASE_TTL_MS });
  if (result !== 'OK') throw new Error('Another Sportradar worker owns the shared sync lease; this cycle was skipped.');
  return token;
}
async function releaseLease(token) {
  await redisClient.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    { keys: [LEASE_KEY], arguments: [token] }
  );
}
async function reserveRequest() {
  const monthlyLimit = Number(config.sportradarMaxCallsPer30Days || 0);
  const initialUsage = Number(config.sportradarInitial30DayUsage || 0);
  const hourlyLimit = Number(config.sportradarSharedMaxCallsPerHour || 0);
  if (!Number.isSafeInteger(monthlyLimit) || monthlyLimit < 1) {
    throw new Error('SPORTRADAR_MAX_CALLS_PER_30_DAYS must be configured to the contracted quota before provider requests are allowed.');
  }
  if (!Number.isSafeInteger(initialUsage) || initialUsage < 0 || initialUsage > monthlyLimit) {
    throw new Error('SPORTRADAR_INITIAL_30_DAY_USAGE must be set to the current rolling usage and cannot exceed the contracted quota.');
  }
  const minInterval = Math.max(100, Number(config.sportradarMinIntervalMs || 1100));
  const script = `
    if redis.call('SET', KEYS[5], '1', 'NX') then
      redis.call('SET', KEYS[1], ARGV[5], 'EX', 2592000)
    end
    local baseline = tonumber(redis.call('GET', KEYS[1]) or '0')
    redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[6]) - 2592000)
    redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', tonumber(ARGV[6]) - 3600)
    local monthly = redis.call('ZCARD', KEYS[2])
    local hourly = redis.call('ZCARD', KEYS[3])
    if baseline + monthly >= tonumber(ARGV[1]) then return -1 end
    if tonumber(ARGV[2]) > 0 and hourly >= tonumber(ARGV[2]) then return -2 end
    if redis.call('SET', KEYS[4], ARGV[3], 'NX', 'PX', ARGV[4]) == false then return 0 end
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[3])
    redis.call('EXPIRE', KEYS[2], 2592000)
    redis.call('ZADD', KEYS[3], ARGV[5], ARGV[3])
    redis.call('EXPIRE', KEYS[3], 3600)
    return 1
  `;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const now = Date.now();
    const token = `${now}:${randomUUID()}`;
    const result = Number(await redisClient.eval(script, {
      keys: [BASELINE_KEY, ROLLING_KEY, HOURLY_KEY, QPS_KEY, BASELINE_INIT_KEY],
      arguments: [String(monthlyLimit), String(hourlyLimit), token, String(minInterval), String(initialUsage), String(now)]
    }));
    if (result === 1) return;
    if (result === -1) throw new Error('Sportradar rolling 30-day quota exhausted; sync stopped without publishing partial data.');
    if (result === -2) throw new Error('Sportradar hourly request quota exhausted; sync stopped without publishing partial data.');
    await wait(result === 0 ? Math.min(minInterval, 1000) : 250);
  }
  throw new Error('Sportradar shared QPS gate remained busy; this cycle was skipped.');
}
async function requestJson(path, params = {}) {
  await reserveRequest();
  const url = new URL(path, baseUrl() + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.sportradarRequestTimeoutMs || 30000));
  try {
    const response = await fetch(url, {
      headers: buildSportradarHeaders(config.sportradarApiKey),
      signal: controller.signal
    });
    if (response.status === 429) {
      const retryAfter = response.headers?.get?.('retry-after');
      const body = clean(await response.text().catch(() => ''), 160);
      const error = new Error(`Sportradar Limit Exceeded (HTTP 429); retry-after=${retryAfter || 'not-provided'}; ${body}`);
      error.code = 'SPORTRADAR_LIMIT_EXCEEDED';
      throw error;
    }
    if (response.status === 404) {
      const error = new Error(`Sportradar event/feed not found: ${url.pathname}`);
      error.status = 404;
      throw error;
    }
    if (!response.ok) {
      const body = clean(await response.text().catch(() => ''), 200);
      throw new Error(`Sportradar HTTP ${response.status} at ${url.pathname}: ${body}`);
    }
    const data = await response.json();
    return {
      data,
      headers: response.headers,
      status: response.status,
      responseMeta: {
        contentType: response.headers?.get?.('content-type') || null,
        originId: response.headers?.get?.('x-origin-id') || null,
        result: response.headers?.get?.('x-result') || null,
        maxResults: response.headers?.get?.('x-max-results') || null
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}
function responseItems(data) {
  if (Array.isArray(data?.sport_schedule_sport_event_markets)) {
    return data.sport_schedule_sport_event_markets;
  }
  if (Array.isArray(data?.sport_event_markets)) return data.sport_event_markets;
  return null;
}
function safePayloadShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { payloadType: Array.isArray(data) ? 'array' : typeof data };
  }
  return {
    topLevelKeys: Object.keys(data).slice(0, 24),
    arrays: Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .slice(0, 12)
      .map(([key, value]) => ({
        key,
        count: value.length,
        firstItemKeys: value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
          ? Object.keys(value[0]).slice(0, 20)
          : []
      }))
  };
}
async function discoverCoverage() {
  if (discoveryCache.value && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  const sportsResponse = await requestJson('sports.json');
  const booksResponse = await requestJson('books.json');
  const sports = Array.isArray(sportsResponse.data?.sports) ? sportsResponse.data.sports : [];
  const books = Array.isArray(booksResponse.data?.books) ? booksResponse.data.books : [];
  if (!sports.length) throw new Error('Sportradar sports.json returned no sports.');
  if (!books.length) throw new Error('Sportradar books.json returned no configured bookmakers.');
  const requested = String(config.sportradarSportIds || 'sr:sport:1').split(',').map(x => x.trim()).filter(Boolean);
  const selected = requested.includes('*') ? sports : sports.filter(s => requested.includes(String(s.id)));
  const missing = requested.filter(id => id !== '*' && !sports.some(s => String(s.id) === id));
  if (missing.length) throw new Error(`Configured sport IDs absent from sports.json: ${missing.join(', ')}`);
  if (!selected.length) throw new Error('No configured Sportradar sports were discovered.');
  const covered = [];
  for (const sport of selected) {
    if (String(sport.type).toLowerCase() === 'stage') {
      covered.push(sport);
      continue;
    }
    const response = await requestJson(`sports/${sport.id}/competitions.json`);
    const competitions = Array.isArray(response.data?.competitions) ? response.data.competitions : [];
    if (competitions.some(item => item.markets === true)) covered.push(sport);
  }
  if (!covered.length) throw new Error('No configured sport has prematch markets=true coverage.');
  const result = {
    sports: covered,
    books,
    accessTier: booksResponse.responseMeta?.originId || null
  };
  discoveryCache.value = result;
  discoveryCache.expiresAt = Date.now() + DISCOVERY_TTL_MS;
  return result;
}
function buildEvent(rawEvent, item, sport, generatedAt) {
  if (!rawEvent?.id) return null;
  const status = __sportradarNormalizer.normalizedEventStatus(rawEvent.status);
  const event = {
    id: String(rawEvent.id), provider: PROVIDER, providerId: String(rawEvent.id),
    sport: clean(sport.name || sport.id, 40), sportId: sport.id,
    league: clean(rawEvent.sport_event_context?.competition?.name || rawEvent.sport_event_context?.tournament?.name || 'Unclassified competition', 120),
    country: clean(rawEvent.sport_event_context?.category?.country || '', 80) || null,
    startTime: rawEvent.start_time, status, state: status, live: status === 'LIVE',
    providerStatus: rawEvent.status || 'unknown', replacedBy: rawEvent.replaced_by || null,
    startTimeConfirmed: rawEvent.start_time_confirmed ?? null, resumeTime: rawEvent.resume_time || null,
    sourceData: { sportEvent: rawEvent, sportEventContext: rawEvent.sport_event_context || null, generatedAt },
    clock: null, home: { name: 'TBD', score: null, logo: null }, away: { name: 'TBD', score: null, logo: null },
    homeScore: null, awayScore: null, markets: [],
    _refs: { [PROVIDER]: String(rawEvent.id) }, _sources: [PROVIDER]
  };
  for (const competitor of Array.isArray(rawEvent.competitors) ? rawEvent.competitors : []) {
    const name = clean(competitor?.name, 120);
    if (!name) continue;
    if (String(competitor.qualifier).toLowerCase() === 'home') event.home.name = name;
    if (String(competitor.qualifier).toLowerCase() === 'away') event.away.name = name;
  }
  const normalized = __sportradarNormalizer.normalizeOdds(event, item);
  const priceUpdatedAt = parseDate(generatedAt) ? new Date(parseDate(generatedAt)).toISOString() : null;
  event.markets = normalized.markets.map(market => ({
    ...market,
    updatedAt: priceUpdatedAt,
    selections: market.selections.map(selection => ({
      ...selection,
      updatedAt: selection.updatedAt || priceUpdatedAt
    }))
  }));
  return event;
}
async function fullDailySync(coverage, daysAhead) {
  const events = new Map();
  const diagnostics = { fullSync: true, pagesFetched: 0, eventsSeen: 0, booksDiscovered: coverage.books.length };
  for (const sport of coverage.sports) {
    for (const date of utcDates(daysAhead)) {
      let start = 0;
      while (true) {
        const { data, headers, status, responseMeta } = await requestJson(
          `sports/${sport.id}/schedules/${date}/sport_event_markets.json`,
          { start, limit: PAGE_SIZE, live: false }
        );
        diagnostics.pagesFetched += 1;
        const items = responseItems(data);
        if (!items) {
          const payloadDiagnostics = {
            feed: 'daily-sport-event-markets',
            httpStatus: status ?? null,
            ...responseMeta,
            payload: safePayloadShape(data)
          };
          const error = new Error('Daily Sport Event Markets response shape does not match the documented sport_event_markets array; refusing incomplete sync.');
          error.diagnostics = payloadDiagnostics;
          throw error;
        }
        if (!parseDate(data.generated_at)) throw new Error('Daily Sport Event Markets payload is missing a valid generated_at timestamp.');
        const total = Number(headers?.get?.('x-max-results'));
        const pageCount = Number(headers?.get?.('x-result'));
        diagnostics.eventsSeen += items.length;
        for (const item of items) {
          const event = buildEvent(item.sport_event, item, sport, data.generated_at);
          if (!event) continue;
          events.set(event.id, event);
        }
        if (Number.isFinite(total) && Number.isFinite(pageCount)) {
          if (pageCount !== items.length) throw new Error('Sportradar X-Result does not match response item count.');
          if (start + pageCount >= total) break;
          if (pageCount === 0) throw new Error('Sportradar pagination stalled before X-Max-Results.');
          start += pageCount;
          continue;
        }
        if (items.length < PAGE_SIZE) break;
        start += items.length;
      }
    }
  }
  if (!events.size) throw new Error('Sportradar daily markets returned zero events; existing accepted snapshot remains untouched.');
  return { events, diagnostics };
}
async function refreshOneEvent(eventId, previous, sports) {
  const response = await requestJson(`sport_events/${eventId}/sport_event_markets.json`);
  const rawEvent = response.data?.sport_event;
  if (!rawEvent?.id) throw new Error(`Sportradar event markets response missing sport_event for ${eventId}.`);
  if (!parseDate(response.data.generated_at)) throw new Error(`Sportradar event markets response missing a valid generated_at timestamp for ${eventId}.`);
  const sport = sports.find(item => String(item.id) === String(previous?.sportId)) || { id: previous?.sportId || 'unknown', name: previous?.sport || 'Unknown' };
  const event = buildEvent(rawEvent, response.data, sport, response.data.generated_at);
  if (!event) throw new Error(`Sportradar event ${eventId} could not be normalized.`);
  return event;
}
async function pollChanges(coverage, state) {
  const { data } = await requestJson('sport_event_markets_changelog.json');
  const changes = data?.changes;
  if (!parseDate(data?.generated_at)) throw new Error('Sportradar Change Log response is missing a valid generated_at timestamp.');
  const verifiedAt = new Date(parseDate(data.generated_at)).toISOString();
  const windowFrom = Number(data?.status?.from);
  const windowTo = Number(data?.status?.to);
  if (!Array.isArray(changes) || !Number.isFinite(windowFrom) || !Number.isFinite(windowTo) || windowTo < windowFrom) {
    throw new Error('Sportradar Change Log response is missing valid status window or changes array.');
  }
  const lastPollAt = Number(state.lastPollAt || 0);
  const gap = lastPollAt > 0 && Date.now() - lastPollAt > 5 * 60 * 1000;
  const trackedIds = gap ? [...state.events.keys()] : [...new Set(changes
    .filter(item => item?.type === 'sport_event' && item.id && state.events.has(String(item.id)))
    .map(item => String(item.id)))];
  const updated = new Map(state.events);
  for (const eventId of trackedIds) {
    try {
      const next = await refreshOneEvent(eventId, updated.get(eventId), coverage.sports);
      updated.set(eventId, next);
    } catch (error) {
      if (error.status === 404) {
        updated.delete(eventId);
        continue;
      }
      throw error;
    }
  }
  return {
    events: updated,
    diagnostics: { fullSync: false, changeLogChanges: changes.length, eventsRefreshed: trackedIds.length, gapReconciled: gap, changeLogWindow: { from: windowFrom, to: windowTo } },
    lastPollAt: Date.now(),
    lastChangeLogTo: windowTo,
    verifiedAt
  };
}

export async function fetchSportradarV2({ daysAhead = config.sportradarDaysAhead } = {}) {
  if (!config.sportradarEnabled) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_ENABLED=false'] };
  if (!config.sportradarApiKey) throw new Error('SPORTRADAR_API_KEY is required by the Sportradar worker.');
  await ensureRedis();
  const lease = await acquireLease();
  try {
    const coverage = await discoverCoverage();
    const rawState = await redisClient.get(STATE_KEY);
    let stored = rawState ? JSON.parse(rawState) : null;
    const state = stored && Array.isArray(stored.events)
      ? { ...stored, events: new Map(stored.events) }
      : { events: new Map(), lastPollAt: 0, lastFullSyncAt: 0, lastChangeLogTo: 0 };
    const fullSyncDue = !state.events.size || !state.lastFullSyncAt || Date.now() - state.lastFullSyncAt >= 24 * 60 * 60 * 1000;
    let diagnostics;
    if (fullSyncDue) {
      const full = await fullDailySync(coverage, daysAhead);
      state.events = full.events;
      state.lastFullSyncAt = Date.now();
      diagnostics = full.diagnostics;
    } else {
      const delta = await pollChanges(coverage, state);
      state.events = delta.events;
      state.lastPollAt = delta.lastPollAt;
      state.lastChangeLogTo = delta.lastChangeLogTo;
      diagnostics = delta.diagnostics;
    }
    const events = [...state.events.values()];
    if (!events.length) throw new Error('Sportradar state has no events after sync; previous snapshot remains untouched.');
    const generatedAt = new Date().toISOString();
    await redisClient.set(STATE_KEY, JSON.stringify({
      events: [...state.events.entries()],
      lastPollAt: state.lastPollAt || Date.now(),
      lastFullSyncAt: state.lastFullSyncAt,
      lastChangeLogTo: state.lastChangeLogTo || 0,
      generatedAt
    }), { EX: STATE_TTL_SECONDS });
    logger.info('Sportradar v2 sync completed', {
      events: events.length, sports: coverage.sports.length,
      books: coverage.books.length, accessTier: coverage.accessTier,
      fullSync: diagnostics.fullSync, eventsRefreshed: diagnostics.eventsRefreshed || 0
    });
    return {
      provider: PROVIDER, enabled: true, events, errors: [], transportOk: true,
      diagnostics: { apiVersion: 'oddscomparison-prematch-v2', ...diagnostics, booksDiscovered: coverage.books.length, accessTier: coverage.accessTier }
    };
  } finally {
    await releaseLease(lease).catch(error => logger.error('Sportradar lease release failed', { error: error.message }));
  }
}

export const __sportradarV2 = {
  utcDates, responseItems, safePayloadShape, buildEvent, baseUrl, pollChanges,
  setRedisClientForTests(client) { redisClient = client; discoveryCache.value = null; discoveryCache.expiresAt = 0; }
};
