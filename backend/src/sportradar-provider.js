import { createHash } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const PROVIDER = 'sportradar';
const DEFAULT_BASE_URL = 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en';
const SOCCER_SPORT_ID = 'sr:sport:1';
const PAGE_SIZE = 50;
const PREMATCH_STATUSES = new Set(['not_started']);

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function iso(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function hash(...parts) {
  return createHash('sha256').update(parts.map(value => clean(value, 500)).join('|')).digest('hex').slice(0, 28);
}
function apiKey() { return config.sportradarApiKey || ''; }
function baseUrl() { return (config.sportradarBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function headers() { return { 'x-api-key': apiKey(), accept: 'application/json' }; }

const callState = { lastCallAt: 0, hourStart: 0, callsThisHour: 0 };
function resetHourIfNeeded(now = Date.now()) {
  if (!callState.hourStart || now - callState.hourStart >= 3600000) {
    callState.hourStart = now;
    callState.callsThisHour = 0;
  }
}
function callsRemaining() {
  resetHourIfNeeded();
  const configured = Number(config.sportradarMaxCallsPerHour || 0);
  return configured > 0 ? Math.max(0, configured - callState.callsThisHour) : Infinity;
}
async function throttle() {
  const minInterval = Math.max(0, Number(config.sportradarMinIntervalMs || 1100));
  const wait = minInterval - (Date.now() - callState.lastCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
function retryDelay(response, attempt) {
  const value = response.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }
  return Math.min(30000, 2000 * (attempt + 1));
}
async function fetchJson(url, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (callsRemaining() <= 0) {
      throw new Error('Sportradar configured hourly API-call budget exhausted; current cycle is incomplete and was not published.');
    }
    await throttle();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.sportradarRequestTimeoutMs || 30000);
    try {
      callState.lastCallAt = Date.now();
      callState.callsThisHour += 1;
      const response = await fetch(url, { headers: headers(), signal: controller.signal });
      if (response.status === 429) {
        lastError = new Error('Sportradar rate limited (HTTP 429).');
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Sportradar responded HTTP ${response.status}: ${body.slice(0, 240)}`);
      }
      return { data: await response.json(), headers: response.headers };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && error?.message !== 'Sportradar rate limited (HTTP 429).') {
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, 1000 * (attempt + 1))));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Sportradar request failed.');
}

function wibDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}
function dateKeyFromUtc(date) { return date.toISOString().slice(0, 10); }
function dateBounds(daysAhead, now = new Date()) {
  const { year, month, day } = wibDateParts(now);
  const start = Date.parse(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+07:00`);
  const end = start + (Math.max(1, daysAhead) + 1) * 86400000 - 1;
  return { start, end };
}
function requestedDates(daysAhead, now = new Date()) {
  const bounds = dateBounds(daysAhead, now);
  const firstUtcDay = Math.floor(bounds.start / 86400000) * 86400000;
  const lastUtcDay = Math.floor(bounds.end / 86400000) * 86400000;
  const dates = [];
  for (let day = firstUtcDay; day <= lastUtcDay; day += 86400000) {
    dates.push(dateKeyFromUtc(new Date(day)));
  }
  return dates;
}
function competitorName(competitor) {
  return competitor && typeof competitor === 'object'
    ? clean(competitor.name || competitor.display_name, 120) || null
    : null;
}
function leagueName(raw, item = null) {
  const context = raw?.sport_event_context || item?.sport_event_context || {};
  return clean(
    context.competition?.name
      || context.tournament?.name
      || context.stage?.name
      || context.category?.name
      || 'Unclassified competition',
    120
  );
}
function normalizeScheduleEvent(raw, item = null) {
  if (!raw || typeof raw !== 'object' || !raw.id) return { event: null, reason: 'missing-event-id' };
  if (raw.replaced_by) return { event: null, reason: 'replaced-event' };
  const status = String(raw.status || '').toLowerCase();
  if (!PREMATCH_STATUSES.has(status)) return { event: null, reason: status || 'missing-status' };

  let home = null;
  let away = null;
  let country = null;
  for (const competitor of (Array.isArray(raw.competitors) ? raw.competitors : [])) {
    const name = competitorName(competitor);
    if (!name) continue;
    if (!country && competitor.country) country = clean(competitor.country, 80) || null;
    const qualifier = String(competitor.qualifier || '').toLowerCase();
    if (qualifier === 'home') home = name;
    if (qualifier === 'away') away = name;
  }
  if (!home || !away) return { event: null, reason: 'missing-home-or-away' };
  const startTime = iso(raw.start_time || raw.start_date || raw.scheduled);
  if (!startTime) return { event: null, reason: 'invalid-start-time' };

  const id = String(raw.id).replace(/^sr:sport_event:/, '');
  const context = raw.sport_event_context || item?.sport_event_context || {};
  country = country || clean(context.category?.country || context.competition?.country, 80) || null;
  return {
    reason: null,
    event: {
      provider: PROVIDER, providerId: id, id, sport: 'soccer',
      league: leagueName(raw, item), country, startTime,
      state: 'SCHEDULED', status: 'SCHEDULED', live: false,
      providerStatus: clean(status, 40), clock: null,
      home: { name: home, score: null, logo: null },
      away: { name: away, score: null, logo: null },
      homeScore: null, awayScore: null, markets: [],
      _refs: { [PROVIDER]: id }, _sources: [PROVIDER]
    }
  };
}
function marketType(name) {
  const value = clean(name, 120).toLowerCase();
  if (/1x2|money.?line|match.?winner|match.?result|three.?way/.test(value)) return '1X2';
  if (/handicap|spread/.test(value)) return 'HANDICAP';
  if (/team.?total/.test(value)) return 'TEAM_TOTAL';
  if (/total|over.?under|goals/.test(value)) return 'TOTALS';
  if (/both.?teams|btts/.test(value)) return 'BTTS';
  if (/double.?chance/.test(value)) return 'DOUBLE_CHANCE';
  if (/draw.?no.?bet/.test(value)) return 'DRAW_NO_BET';
  if (/correct.?score/.test(value)) return 'CORRECT_SCORE';
  if (/corner/.test(value)) return 'CORNERS';
  if (/card/.test(value)) return 'CARDS';
  if (/player|scorer|assist|shots/.test(value)) return 'PLAYER_PROP';
  return 'OTHER';
}
function periodFromMarket(name) {
  const value = clean(name, 120).toLowerCase();
  if (/first.?half|1st.?half|half.?time|1h/.test(value)) return '1H';
  if (/second.?half|2nd.?half|2h/.test(value)) return '2H';
  return 'FT';
}
function selectionLabel(outcome, event, type) {
  const raw = clean(outcome?.name || outcome?.label, 120);
  if (raw) return raw;
  const value = String(outcome?.type || '').toLowerCase();
  if (type === '1X2') {
    if (value === 'home') return 'HOME';
    if (value === 'draw') return 'DRAW';
    if (value === 'away') return 'AWAY';
  }
  if (value === 'home') return event.home.name;
  if (value === 'away') return event.away.name;
  if (value === 'draw') return 'Draw';
  if (value === 'over') return 'Over';
  if (value === 'under') return 'Under';
  if (value) return clean(value.replace(/[_-]+/g, ' '), 120);
  return null;
}
function normalizeOdds(event, raw) {
  const diagnostics = { marketsSeen: 0, marketsSkippedLive: 0, marketsSkippedRemoved: 0, booksSeen: 0, booksSkippedRemoved: 0, outcomesSeen: 0, outcomesSkippedRemoved: 0, outcomesSkippedInvalidOdds: 0, marketsWithoutUsableOutcomes: 0 };
  const markets = [];
  for (const market of (Array.isArray(raw?.markets) ? raw.markets : [])) {
    diagnostics.marketsSeen += 1;
    if (!market || market.removed === true) { diagnostics.marketsSkippedRemoved += 1; continue; }
    if (market.is_live === true) { diagnostics.marketsSkippedLive += 1; continue; }
    const marketName = clean(market.name || market.type || market.id, 120);
    if (!marketName) { diagnostics.marketsWithoutUsableOutcomes += 1; continue; }
    const type = marketType(marketName);
    const period = periodFromMarket(marketName);
    const books = Array.isArray(market.books) ? market.books : [];
    if (!books.length) { diagnostics.marketsWithoutUsableOutcomes += 1; continue; }

    for (const book of books) {
      diagnostics.booksSeen += 1;
      if (!book || book.removed === true) { diagnostics.booksSkippedRemoved += 1; continue; }
      const selections = [];
      for (const outcome of (Array.isArray(book.outcomes) ? book.outcomes : [])) {
        diagnostics.outcomesSeen += 1;
        if (!outcome || outcome.removed === true) { diagnostics.outcomesSkippedRemoved += 1; continue; }
        const odds = number(outcome.odds_decimal ?? outcome.odds);
        if (odds === null || odds <= 1 || odds > 10000) { diagnostics.outcomesSkippedInvalidOdds += 1; continue; }
        const label = selectionLabel(outcome, event, type);
        if (!label) { diagnostics.outcomesSkippedInvalidOdds += 1; continue; }
        const line = number(outcome.total ?? outcome.handicap ?? outcome.points ?? outcome.line);
        const sourceSelectionId = String(outcome.id || `${market.id || marketName}-${book.id || book.name || 'book'}-${label}-${line ?? ''}`);
        selections.push({
          key: hash('selection', event.id, market.id || marketName, book.id || book.name || '', sourceSelectionId, line ?? ''),
          label, odds, line, suspended: Boolean(outcome.suspended || book.suspended || market.suspended), source: PROVIDER, sourceSelectionId,
          updatedAt: iso(outcome.updated_at || book.updated_at || market.updated_at),
          priceVersion: hash('price', event.id, market.id || marketName, book.id || book.name || '', sourceSelectionId, odds)
        });
      }
      if (!selections.length) { diagnostics.marketsWithoutUsableOutcomes += 1; continue; }
      const bookmaker = clean(book.name || book.bookmaker || book.id || 'unknown', 120);
      markets.push({
        id: hash('market', event.id, market.id || marketName, bookmaker, period),
        key: clean(market.id || marketName, 120), type, label: marketName, period,
        line: selections[0].line ?? null,
        suspended: Boolean(market.suspended || book.suspended),
        updatedAt: iso(book.updated_at || market.updated_at),
        source: PROVIDER, sourceMarketId: String(market.id || marketName),
        bookmaker, mainLine: market.main_line === true, selections
      });
    }
  }
  return { markets, diagnostics };
}

export async function fetchSportradar({
  maxEvents = config.sportradarMaxEvents,
  maxPages = config.sportradarMaxPages,
  daysAhead = config.sportradarDaysAhead
} = {}) {
  if (!config.sportradarEnabled) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_ENABLED=false'] };
  if (!apiKey()) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_API_KEY is not configured'] };

  const eventLimit = Number(maxEvents) > 0 ? Number(maxEvents) : Infinity;
  const pageLimit = Number(maxPages) > 0 ? Number(maxPages) : Infinity;
  const days = Math.max(1, Number(daysAhead) || 3);
  const dates = requestedDates(days);
  const bounds = dateBounds(days);
  const allEvents = [];
  const seenIds = new Set();
  const diagnostics = {
    datesRequested: dates.length, pagesFetched: 0, eventsSeen: 0, eventsAccepted: 0,
    eventsSkipped: {}, odds: { marketsSeen: 0, marketsSkippedLive: 0, marketsSkippedRemoved: 0, booksSeen: 0, booksSkippedRemoved: 0, outcomesSeen: 0, outcomesSkippedRemoved: 0, outcomesSkippedInvalidOdds: 0, marketsWithoutUsableOutcomes: 0 }
  };

  for (const date of dates) {
    let start = 0;
    while (true) {
      if (diagnostics.pagesFetched >= pageLimit) {
        throw new Error(`Sportradar pagination stopped at configured page limit ${pageLimit}; partial data is not published.`);
      }
      const url = new URL(`${baseUrl()}/sports/${SOCCER_SPORT_ID}/schedules/${date}/sport_event_markets.json`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('start', String(start));
      const { data, headers: responseHeaders } = await fetchJson(url.toString());
      diagnostics.pagesFetched += 1;
      const items = Array.isArray(data?.sport_schedule_sport_event_markets) ? data.sport_schedule_sport_event_markets : [];
      const maxResultsHeader = responseHeaders?.get?.('x-max-results');
      const maxResults = maxResultsHeader === null || maxResultsHeader === undefined ? null : Number(maxResultsHeader);
      if (!items.length) {
        if (Number.isFinite(maxResults) && start < maxResults) {
          throw new Error(`Sportradar returned an empty page at offset ${start} while x-max-results reports ${maxResults}; partial data is not published.`);
        }
        break;
      }
      diagnostics.eventsSeen += items.length;

      for (const item of items) {
        const normalized = normalizeScheduleEvent(item?.sport_event, item);
        if (!normalized.event) {
          const reason = normalized.reason || 'invalid-event';
          diagnostics.eventsSkipped[reason] = (diagnostics.eventsSkipped[reason] || 0) + 1;
          continue;
        }
        const event = normalized.event;
        const kickoff = Date.parse(event.startTime);
        if (kickoff < bounds.start || kickoff > bounds.end) {
          diagnostics.eventsSkipped.outside_requested_window = (diagnostics.eventsSkipped.outside_requested_window || 0) + 1;
          continue;
        }
        if (seenIds.has(event.id)) {
          diagnostics.eventsSkipped.duplicate_provider_id = (diagnostics.eventsSkipped.duplicate_provider_id || 0) + 1;
          continue;
        }
        seenIds.add(event.id);
        const odds = normalizeOdds(event, item);
        event.markets = odds.markets;
        for (const key of Object.keys(diagnostics.odds)) diagnostics.odds[key] += odds.diagnostics[key] || 0;
        allEvents.push(event);
        diagnostics.eventsAccepted += 1;
        if (allEvents.length >= eventLimit) {
          throw new Error(`Sportradar event limit ${eventLimit} reached before pagination completed; partial data is not published.`);
        }
      }

      start += items.length;
      if (Number.isFinite(maxResults)) {
        if (start >= maxResults) break;
      } else if (items.length < PAGE_SIZE) {
        break;
      }
    }
  }

  const result = {
    provider: PROVIDER, enabled: true, events: allEvents, errors: [], transportOk: true,
    diagnostics: { ...diagnostics, calls: diagnostics.pagesFetched }
  };
  logger.info('Sportradar prematch ingestion completed', { events: diagnostics.eventsAccepted, pages: diagnostics.pagesFetched, diagnostics });
  return result;
}
