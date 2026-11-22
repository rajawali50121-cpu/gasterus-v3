import { config } from './config.js';
import { __sportradarNormalizer } from './sportradar-provider.js';
import { logger } from './logger.js';

const PROVIDER = 'sportradar';
const PAGE_SIZE = 50;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = { value: null, expiresAt: 0 };
const requestState = { hourStart: 0, calls: 0, lastCallAt: 0 };

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
function baseUrl() { return String(config.sportradarBaseUrl).replace(/\/+$/, ''); }
function resetHour(now = Date.now()) {
  if (!requestState.hourStart || now - requestState.hourStart >= 3600000) {
    requestState.hourStart = now;
    requestState.calls = 0;
  }
}
async function requestJson(path, params = {}) {
  resetHour();
  const maxCalls = Number(config.sportradarMaxCallsPerHour || 0);
  if (maxCalls > 0 && requestState.calls >= maxCalls) {
    throw new Error('Sportradar hourly request budget exhausted; incomplete sync rejected.');
  }
  const minInterval = Math.max(100, Number(config.sportradarMinIntervalMs || 1100));
  const wait = minInterval - (Date.now() - requestState.lastCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  const url = new URL(path, baseUrl() + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.sportradarRequestTimeoutMs || 30000));
  try {
    requestState.lastCallAt = Date.now();
    requestState.calls += 1;
    const response = await fetch(url, {
      headers: { 'x-api-key': config.sportradarApiKey, accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status === 429) {
      const retryAfter = response.headers?.get?.('retry-after');
      const body = clean(await response.text().catch(() => ''), 160);
      const error = new Error(`Sportradar HTTP 429; retry-after=${retryAfter || 'not-provided'}; ${body}`);
      error.code = 'SPORTRADAR_LIMIT_EXCEEDED';
      throw error;
    }
    if (!response.ok) {
      const body = clean(await response.text().catch(() => ''), 200);
      throw new Error(`Sportradar HTTP ${response.status} at ${url.pathname}: ${body}`);
    }
    return { data: await response.json(), headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}
function responseItems(data) {
  for (const key of ['sport_event_markets', 'sport_schedule_sport_event_markets', 'schedules']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}
async function discoverCoverage() {
  if (discoveryCache.value && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  const [sportsResponse, booksResponse] = await Promise.all([
    requestJson('sports.json'),
    requestJson('books.json')
  ]);
  const sports = Array.isArray(sportsResponse.data?.sports) ? sportsResponse.data.sports : [];
  const books = Array.isArray(booksResponse.data?.books) ? booksResponse.data.books : [];
  if (!sports.length) throw new Error('Sportradar sports discovery returned no sports.');
  if (!books.length) throw new Error('Sportradar books discovery returned no configured bookmakers.');
  const requested = String(config.sportradarSportIds || 'sr:sport:1').split(',').map(x => x.trim()).filter(Boolean);
  const selected = requested.includes('*') ? sports : sports.filter(s => requested.includes(String(s.id)));
  const missing = requested.filter(id => id !== '*' && !sports.some(s => String(s.id) === id));
  if (missing.length) throw new Error(`Configured Sportradar sport IDs not present in sports.json: ${missing.join(', ')}`);
  if (!selected.length) throw new Error('No configured Sportradar sports were discovered.');

  const covered = [];
  for (const sport of selected) {
    if (String(sport.type || '').toLowerCase() !== 'competition') {
      covered.push(sport);
      continue;
    }
    const competitionResponse = await requestJson(`sports/${encodeURIComponent(sport.id)}/competitions.json`);
    const competitions = Array.isArray(competitionResponse.data?.competitions) ? competitionResponse.data.competitions : [];
    if (competitions.some(competition => competition.markets === true)) covered.push(sport);
  }
  const result = { sports: covered, books, sportsGeneratedAt: sportsResponse.data?.generated_at || null, booksGeneratedAt: booksResponse.data?.generated_at || null };
  discoveryCache.value = result;
  discoveryCache.expiresAt = Date.now() + DISCOVERY_TTL_MS;
  return result;
}

export async function fetchSportradarV2({ daysAhead = config.sportradarDaysAhead } = {}) {
  if (!config.sportradarEnabled) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_ENABLED=false'] };
  if (!config.sportradarApiKey) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_API_KEY is not configured'] };

  const coverage = await discoverCoverage();
  const dates = utcDates(daysAhead);
  const eventsById = new Map();
  const diagnostics = {
    apiVersion: 'oddscomparison-prematch-v2',
    discovery: { sports: coverage.sports.length, configuredBooks: coverage.books.length },
    datesRequested: dates.length,
    pagesFetched: 0,
    eventsSeen: 0,
    eventsAccepted: 0,
    eventsSkipped: {},
    booksDiscovered: coverage.books.length,
    generatedAt: null,
    requestCount: 0
  };

  for (const sport of coverage.sports) {
    for (const date of dates) {
      let start = 0;
      while (true) {
        const { data, headers } = await requestJson(
          `sports/${encodeURIComponent(sport.id)}/schedules/${date}/sport_event_markets.json`,
          { start, limit: PAGE_SIZE }
        );
        diagnostics.pagesFetched += 1;
        diagnostics.generatedAt = data?.generated_at || diagnostics.generatedAt;
        const items = responseItems(data);
        if (!items) throw new Error('Sportradar Daily Sport Event Markets response has no documented event-market collection; sync rejected.');
        const maxHeader = headers?.get?.('x-max-results');
        const maxResults = maxHeader === null || maxHeader === undefined ? null : Number(maxHeader);
        if (!items.length) {
          if (Number.isFinite(maxResults) && start < maxResults) {
            throw new Error(`Sportradar pagination incomplete at offset ${start}; X-Max-Results=${maxResults}.`);
          }
          break;
        }
        diagnostics.eventsSeen += items.length;
        for (const item of items) {
          const rawEvent = item?.sport_event;
          const normalized = __sportradarNormalizer.normalizeOdds
            ? null
            : null;
          if (!rawEvent?.id) {
            diagnostics.eventsSkipped.missing_sport_event = (diagnostics.eventsSkipped.missing_sport_event || 0) + 1;
            continue;
          }
          const event = {
            id: String(rawEvent.id),
            provider: PROVIDER,
            providerId: String(rawEvent.id),
            sport: clean(sport.name || sport.id, 40),
            sportId: sport.id,
            league: clean(rawEvent.sport_event_context?.competition?.name || rawEvent.sport_event_context?.tournament?.name || 'Unclassified competition', 120),
            country: clean(rawEvent.sport_event_context?.category?.country || '', 80) || null,
            startTime: rawEvent.start_time,
            status: __sportradarNormalizer.normalizedEventStatus(rawEvent.status),
            state: __sportradarNormalizer.normalizedEventStatus(rawEvent.status),
            live: false,
            providerStatus: rawEvent.status || 'unknown',
            replacedBy: rawEvent.replaced_by || null,
            startTimeConfirmed: rawEvent.start_time_confirmed ?? null,
            resumeTime: rawEvent.resume_time || null,
            sourceData: { sportEvent: rawEvent, sportEventContext: rawEvent.sport_event_context || null, sport, generatedAt: data.generated_at || null },
            clock: null,
            home: { name: 'TBD', score: null, logo: null },
            away: { name: 'TBD', score: null, logo: null },
            homeScore: null,
            awayScore: null,
            markets: [],
            _refs: { [PROVIDER]: String(rawEvent.id) },
            _sources: [PROVIDER]
          };
          const competitors = Array.isArray(rawEvent.competitors) ? rawEvent.competitors : [];
          for (const competitor of competitors) {
            const name = clean(competitor?.name, 120);
            if (!name) continue;
            if (String(competitor.qualifier).toLowerCase() === 'home') event.home.name = name;
            if (String(competitor.qualifier).toLowerCase() === 'away') event.away.name = name;
          }
          const normalizedOdds = __sportradarNormalizer.normalizeOdds(event, item);
          event.markets = normalizedOdds.markets;
          const previous = eventsById.get(event.id);
          if (previous) {
            diagnostics.eventsSkipped.duplicate_event_id = (diagnostics.eventsSkipped.duplicate_event_id || 0) + 1;
            // Daily feed can overlap adjacent UTC dates. Merge distinct market instances, never duplicate by market ID alone.
            const keys = new Set(previous.markets.map(m => m.id));
            previous.markets.push(...event.markets.filter(m => !keys.has(m.id)));
          } else {
            eventsById.set(event.id, event);
          }
        }
        start += items.length;
        if (Number.isFinite(maxResults) && start >= maxResults) break;
        if (!Number.isFinite(maxResults) && items.length < PAGE_SIZE) break;
      }
    }
  }

  const events = [...eventsById.values()];
  diagnostics.eventsAccepted = events.length;
  diagnostics.requestCount = requestState.calls;
  if (events.length === 0) throw new Error('Sportradar Daily Sport Event Markets returned zero events across configured sports/dates; previous snapshot must remain untouched.');
  logger.info('Sportradar v2 daily markets sync completed', {
    events: events.length,
    sports: coverage.sports.length,
    dates: dates.length,
    pages: diagnostics.pagesFetched,
    booksDiscovered: coverage.books.length
  });
  return { provider: PROVIDER, enabled: true, events, errors: [], transportOk: true, diagnostics };
}

export const __sportradarV2 = { utcDates, responseItems };
