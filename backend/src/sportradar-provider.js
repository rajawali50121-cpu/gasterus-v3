import { config } from './config.js';
import { logger } from './logger.js';
import { normalizedEvent, normalizedMarket, normalizedSelection, safeOdds, number, clean, iso, hash } from './sportsbook-providers.js';

const PROVIDER = 'sportradar';
const DEFAULT_BASE_URL = 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en';
const SOCCER_SPORT_ID = 'sr:sport:1';
const ACCEPTED_MARKET_TYPES = new Set(['1x2', 'total', 'handicap']);
const SKIPPED_STATUSES = new Set(['cancelled', 'postponed']);

function isProviderEnabled() {
  return Boolean(config.sportradarEnabled);
}

function apiKey() {
  return config.sportradarApiKey || '';
}

function baseUrl() {
  return (config.sportradarBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function headers() {
  const key = apiKey();
  if (!key) return {};
  return { 'x-api-key': key, accept: 'application/json' };
}

const callState = {
  lastCallAt: 0,
  hourStart: 0,
  callsThisHour: 0,
};

function resetHourIfNeeded() {
  const now = Date.now();
  if (now - callState.hourStart >= 3600000) {
    callState.hourStart = now;
    callState.callsThisHour = 0;
  }
}

function callsRemaining() {
  resetHourIfNeeded();
  return Math.max(0, Number(config.sportradarMaxCallsPerHour || 500) - callState.callsThisHour);
}

async function throttle() {
  const minInterval = Number(config.sportradarMinIntervalMs || 1100);
  const now = Date.now();
  const elapsed = now - callState.lastCallAt;
  if (elapsed < minInterval) {
    await new Promise(resolve => setTimeout(resolve, minInterval - elapsed));
  }
  callState.lastCallAt = Date.now();
  callState.callsThisHour += 1;
}

async function fetchWithRetry(url, maxRetries = 3) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sportradarRequestTimeoutMs || 30000);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await throttle();
      resetHourIfNeeded();
      if (callsRemaining() <= 0 && attempt === 0) {
        throw new Error('Sportradar hourly call budget exhausted');
      }
      const response = await fetch(url, { headers: headers(), signal: controller.signal });
      clearTimeout(timeout);
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 5000 * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        lastError = new Error(`Sportradar rate limited (429), retry after ${waitMs}ms`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Sportradar responded ${response.status}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('Sportradar fetch failed');
}

function parseDateUTC(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00Z'));
  return Number.isFinite(d.getTime()) ? d : null;
}

function wibBounds(daysAhead) {
  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const start = new Date(wibNow.getFullYear(), wibNow.getMonth(), wibNow.getDate());
  const end = new Date(start.getTime() + Math.max(daysAhead || 7, 1) * 24 * 3600 * 1000 - 1);
  return { start, end };
}

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function extractCompetitorName(competitor) {
  if (!competitor || typeof competitor !== 'object') return null;
  return clean(String(competitor.name || competitor.display_name || ''), 120) || null;
}

function competitorRole(competitor) {
  if (!competitor || typeof competitor !== 'object') return null;
  return String(competitor.qualifier || '').toLowerCase();
}

function extractCompetitorId(competitor) {
  if (!competitor || typeof competitor !== 'object') return null;
  return String(competitor.id || competitor.sport_event_competitor_id || '').trim() || null;
}

function normalizeScheduleEvent(raw, now) {
  if (!raw || !raw.id) return null;
  if (raw.replaced_by) return null;

  const competitors = Array.isArray(raw.competitors) ? raw.competitors : [];
  let home = null;
  let away = null;
  for (const competitor of competitors) {
    const role = competitorRole(competitor);
    const name = extractCompetitorName(competitor);
    if (!name) continue;
    if (role === 'home') home = name;
    else if (role === 'away') away = name;
  }
  if (!home || !away) return null;

  const start = parseDateUTC(raw.start_time || raw.start_date || raw.scheduled);
  if (!start) return null;
  if (SKIPPED_STATUSES.has(String(raw.status || '').toLowerCase())) return null;

  const eventId = String(raw.id).replace(/^sr:sport_event:/, '');
  return {
    provider: PROVIDER,
    providerId: eventId,
    sport: 'soccer',
    league: clean(String(raw.sport_name || raw.tournament_name || ''), 120) || null,
    country: null,
    startTime: iso(start),
    state: 'SCHEDULED',
    providerStatus: clean(String(raw.status || 'SCHEDULED'), 40) || null,
    clock: null,
    home,
    away,
    homeScore: null,
    awayScore: null,
    markets: [],
    _refs: { [PROVIDER]: eventId },
  };
}

function americanOddsToDecimal(oddsDecimal) {
  if (oddsDecimal === null || oddsDecimal === undefined) return null;
  const v = Number(oddsDecimal);
  if (!Number.isFinite(v) || v <= 1) return null;
  return v;
}

function buildOneX2Selections(market, sourceSelectionPrefix) {
  const selections = [];
  for (const outcome of (market.outcomes || [])) {
    if (!outcome || outcome.removed === true || !outcome.type) continue;
    const type = String(outcome.type).toLowerCase();
    let label = null;
    if (type === 'home') label = 'HOME';
    else if (type === 'draw') label = 'DRAW';
    else if (type === 'away') label = 'AWAY';
    if (!label) continue;
    const odds = americanOddsToDecimal(outcome.odds_decimal);
    if (!odds) continue;
    selections.push({
      key: hash('selection', PROVIDER, '1x2', label, null),
      label,
      odds,
      line: null,
      suspended: Boolean(outcome.closed),
      source: PROVIDER,
      sourceSelectionId: String(outcome.id || `${sourceSelectionPrefix}-${label}`),
      updatedAt: iso(outcome.updated_at || new Date()),
      priceVersion: hash('price', PROVIDER, '1x2', label, odds),
    });
  }
  if (selections.length !== 3) return null;
  return selections;
}

function buildTotalsSelections(market, sourceSelectionPrefix) {
  const selections = [];
  for (const outcome of (market.outcomes || [])) {
    if (!outcome || outcome.removed === true || !outcome.type) continue;
    const type = String(outcome.type).toLowerCase();
    let label = null;
    if (type === 'over') label = 'Over';
    else if (type === 'under') label = 'Under';
    if (!label) continue;
    const odds = americanOddsToDecimal(outcome.odds_decimal);
    if (!odds) continue;
    const line = number(outcome.total ?? null);
    if (line === null) continue;
    selections.push({
      key: hash('selection', PROVIDER, 'totals', label, line),
      label,
      odds,
      line,
      suspended: Boolean(outcome.closed),
      source: PROVIDER,
      sourceSelectionId: String(outcome.id || `${sourceSelectionPrefix}-${label}`),
      updatedAt: iso(outcome.updated_at || new Date()),
      priceVersion: hash('price', PROVIDER, 'totals', label, line, odds),
    });
  }
  if (selections.length !== 2) return null;
  return selections;
}

function buildHandicapSelections(market, sourceSelectionPrefix) {
  const selections = [];
  for (const outcome of (market.outcomes || [])) {
    if (!outcome || outcome.removed === true || !outcome.type) continue;
    const type = String(outcome.type).toLowerCase();
    let label = null;
    if (type === 'home') label = 'Home';
    else if (type === 'away') label = 'Away';
    if (!label) continue;
    const odds = americanOddsToDecimal(outcome.odds_decimal);
    if (!odds) continue;
    const line = number(outcome.handicap ?? null);
    if (line === null) continue;
    selections.push({
      key: hash('selection', PROVIDER, 'handicap', label, line),
      label,
      odds,
      line,
      suspended: Boolean(outcome.closed),
      source: PROVIDER,
      sourceSelectionId: String(outcome.id || `${sourceSelectionPrefix}-${label}`),
      updatedAt: iso(outcome.updated_at || new Date()),
      priceVersion: hash('price', PROVIDER, 'handicap', label, line, odds),
    });
  }
  if (selections.length !== 2) return null;
  return selections;
}

function selectBookmaker(marketsForType) {
  if (!Array.isArray(marketsForType) || marketsForType.length === 0) return null;
  const valid = marketsForType.filter(m => m.removed !== true);
  if (valid.length === 0) return null;
  const consensus = valid.find(m => String(m.bookmaker || '').toLowerCase() === 'consensus');
  if (consensus) return consensus;
  return valid[0];
}

function normalizeOddsEvent(raw) {
  if (!raw || !raw.sport_event || !Array.isArray(raw.markets)) return null;
  const eventId = String(raw.sport_event.id).replace(/^sr:sport_event:/, '');

  // Collect all books per market type, skipping removed books and is_live markets.
  const booksByType = new Map();
  for (const market of raw.markets) {
    if (!market || !market.name || market.is_live === true) continue;
    const type = String(market.name).toLowerCase().trim();
    if (!ACCEPTED_MARKET_TYPES.has(type)) continue;
    if (!booksByType.has(type)) booksByType.set(type, []);
    for (const book of (market.books || [])) {
      if (!book || book.removed === true) continue;
      booksByType.get(type).push(book);
    }
  }

  const normalizedMarkets = [];
  for (const [type, books] of booksByType.entries()) {
    const chosen = selectBookmaker(books);
    if (!chosen) continue;
    const sourceSelectionPrefix = `${eventId}-${type}`;
    let selections;
    if (type === '1x2') selections = buildOneX2Selections(chosen, sourceSelectionPrefix);
    else if (type === 'total') selections = buildTotalsSelections(chosen, sourceSelectionPrefix);
    else if (type === 'handicap') selections = buildHandicapSelections(chosen, sourceSelectionPrefix);
    else continue;
    if (!selections || selections.length === 0) continue;

    normalizedMarkets.push(normalizedMarket(String(eventId), {
      key: `${type}`,
      name: type.charAt(0).toUpperCase() + type.slice(1),
      type: type === '1x2' ? '1X2' : type === 'handicap' ? 'HANDICAP' : type === 'total' ? 'TOTALS' : type.charAt(0).toUpperCase() + type.slice(1),
      period: 'FT',
      line: selections[0].line ?? null,
      selections,
      source: PROVIDER,
      sourceMarketId: String(chosen.id || `${type}-${chosen.name || ''}`),
      bookmaker: chosen.bookmaker || 'consensus',
      suspended: false,
      updatedAt: iso(chosen.updated_at || new Date()),
      mainLine: null,
    }));
  }

  return { eventId, markets: normalizedMarkets };
}

export async function fetchSportradar({
  maxEvents = config.sportradarMaxEvents,
  maxPages = config.sportradarMaxPages,
  daysAhead = config.sportradarDaysAhead,
} = {}) {
  if (!isProviderEnabled()) {
    return { provider: PROVIDER, enabled: false, events: [], errors: ['Provider disabled: SPORTRADAR_ENABLED=false'] };
  }
  if (!apiKey()) {
    return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_API_KEY not configured'] };
  }

  const bounds = wibBounds(daysAhead);
  const maxPagesResolved = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : Infinity;
  const eventLimit = maxEvents !== 0 ? maxEvents : Infinity;
  const now = new Date();

  const allEvents = [];
  const seenIds = new Set();
  const errors = [];
  let calls = 0;
  let replacedBySkipped = 0;

  const dates = [];
  const d0 = new Date(bounds.start);
  for (let i = 0; i <= Math.max(daysAhead || 7, 1); i += 1) {
    const x = new Date(d0.getTime() + i * 24 * 3600 * 1000);
    dates.push(formatDateUTC(x));
  }

  for (const date of dates) {
    if (allEvents.length >= eventLimit) break;
    if (calls >= maxPagesResolved) break;
    if (callsRemaining() <= 0) {
      errors.push(`schedule ${date}: hourly call budget exhausted`);
      break;
    }
    let start = 0;
    let hasMore = true;
    while (hasMore) {
      if (allEvents.length >= eventLimit) break;
      if (calls >= maxPagesResolved) break;
      if (callsRemaining() <= 0) {
        errors.push(`schedule ${date}: hourly call budget exhausted`);
        break;
      }
      const url = new URL(`${baseUrl()}/sports/${SOCCER_SPORT_ID}/schedules/${date}/sport_event_markets.json`, baseUrl());
      url.searchParams.set('limit', '50');
      url.searchParams.set('start', String(start));
      let data;
      try {
        const response = await fetchWithRetry(url.toString());
        calls += 1;
        const xMax = response.headers.get('x-max-results');
        data = await response.json();
        if (xMax) {
          const maxResults = Number(xMax);
          if (start + 50 >= maxResults) hasMore = false;
        } else {
          hasMore = false;
        }
        start += 50;
      } catch (error) {
        errors.push(`schedule ${date} start=${start}: ${error.message}`);
        break;
      }
      const items = Array.isArray(data?.sport_schedule_sport_event_markets) ? data.sport_schedule_sport_event_markets : [];
      for (const item of items) {
        if (allEvents.length >= eventLimit) break;
        if (!item || !item.sport_event) continue;
        if (item.sport_event.replaced_by) {
          replacedBySkipped += 1;
          continue;
        }
        const parsed = normalizeScheduleEvent(item.sport_event, now);
        if (!parsed) continue;
        if (seenIds.has(parsed.providerId)) continue;
        seenIds.add(parsed.providerId);
        const kickoff = new Date(parsed.startTime);
        if (kickoff < bounds.start || kickoff > bounds.end) continue;
        const normalized = normalizeOddsEvent(item);
        if (normalized) parsed.markets = normalized.markets;
        allEvents.push(parsed);
      }
    }
  }

  logger.info('Sportradar Odds Comparison Prematch v2 fetch completed', {
    provider: PROVIDER,
    events: allEvents.length,
    dates: dates.length,
    calls,
    replacedBySkipped,
    errors: errors.length,
  });

  return {
    provider: PROVIDER,
    enabled: true,
    events: allEvents,
    errors,
    transportOk: errors.length === 0,
    calls,
  };
}
