import { config } from './config.js';
import { logger } from './logger.js';
import {
  normalizedEvent,
  normalizedMarket,
  normalizedSelection,
  safeOdds,
  number,
  clean,
  iso,
  hash,
} from './sportsbook-providers.js';

const PROVIDER = 'tipsters';

const MARKET_MAP = {
  '1X2': '1X2',
  ASIAN_HANDICAP: 'HANDICAP',
  OVER_UNDER: 'TOTALS',
  TOTALS: 'TOTALS',
  HANDICAP: 'HANDICAP',
};

const DEFAULT_TIMEOUT_MS = 15000;

function isProviderEnabled() {
  return Boolean(config.rapidApiOddsEnabled);
}

function cacheUrl() {
  return config.rapidApiOddsCacheUrl || '';
}

function cacheToken() {
  return config.rapidApiOddsCacheToken || null;
}

function cacheHeaders() {
  const headers = { Accept: 'application/json' };
  const token = cacheToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchCacheJson(path) {
  const base = cacheUrl();
  if (!base) throw new Error('RAPIDAPI_ODDS_CACHE_URL not configured');
  const token = cacheToken();
  if (!token) throw new Error('RAPIDAPI_ODDS_CACHE_TOKEN not configured');
  const url = new URL(path, base);
  url.searchParams.set('token', token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.rapidApiOddsRequestTimeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: cacheHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`Cache worker responded ${response.status}`);
    }
    const payload = await response.json();
    if (hasPayloadErrors(payload)) {
      const detail = extractErrorDetail(payload);
      const error = new Error(`RapidAPI cache response contains error${detail ? `: ${detail}` : ''}`);
      error.status = 200;
      error.payloadErrors = true;
      throw error;
    }
    return payload;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function hasPayloadErrors(payload) {
  if (!payload || typeof payload !== 'object') return false;

  // errors array: hanya error jika tidak kosong
  if (Array.isArray(payload.errors)) {
    if (payload.errors.length === 0) return false;
    return payload.errors.some(e => e !== null && e !== undefined && e !== '');
  }

  // errors object: hanya error jika punya key
  if (payload.errors && typeof payload.errors === 'object') {
    return Object.keys(payload.errors).length > 0;
  }

  // error field: null, "", {} bukan error
  if (payload.error !== undefined) {
    if (payload.error === null || payload.error === '') return false;
    if (typeof payload.error === 'object') return Object.keys(payload.error).length > 0;
    if (typeof payload.error === 'string' && payload.error.trim()) return true;
    return false;
  }

  // message field: hanya error jika TIDAK ada data usable
  const hasUsableData = (Array.isArray(payload.data) && payload.data.length > 0)
    || (Array.isArray(payload.response) && payload.response.length > 0)
    || (Array.isArray(payload.fixtures) && payload.fixtures.length > 0)
    || (Array.isArray(payload.events) && payload.events.length > 0)
    || (Array.isArray(payload.games) && payload.games.length > 0)
    || (payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length > 0)
    || (payload.response && typeof payload.response === 'object' && Object.keys(payload.response).length > 0)
    || (payload.fixtures && typeof payload.fixtures === 'object' && Object.keys(payload.fixtures).length > 0)
    || (payload.events && typeof payload.events === 'object' && Object.keys(payload.events).length > 0)
    || (payload.games && typeof payload.games === 'object' && Object.keys(payload.games).length > 0);
  if (payload.message && typeof payload.message === 'string') {
    const msg = payload.message.toLowerCase();
    if (/no result|don't have access|subscription/i.test(msg)) return false;
    if (hasUsableData) return false;
    if (/error|invalid|unauthorized|forbidden|rate.limit|quota|exceeded/i.test(msg)) return true;
  }

  if (payload.success === false) return true;
  if (payload.status && typeof payload.status === 'string' && /error|fail|invalid/i.test(payload.status)) return true;

  return false;
}

function extractErrorDetail(payload) {
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).filter(Boolean).join('; ');
  }
  if (payload.errors && typeof payload.errors === 'object' && Object.keys(payload.errors).length > 0) {
    return JSON.stringify(payload.errors);
  }
  if (payload.error !== null && payload.error !== undefined && payload.error !== '') {
    if (typeof payload.error === 'object' && Object.keys(payload.error).length > 0) return JSON.stringify(payload.error);
    if (typeof payload.error === 'string') return payload.error;
  }
  if (payload.message && typeof payload.message === 'string') {
    const msg = payload.message.toLowerCase();
    if (/no result|don't have access|subscription/i.test(msg)) return `warning: ${payload.message}`;
    const hasUsableData = (Array.isArray(payload.data) && payload.data.length > 0)
      || (Array.isArray(payload.response) && payload.response.length > 0)
      || (Array.isArray(payload.fixtures) && payload.fixtures.length > 0)
      || (Array.isArray(payload.events) && payload.events.length > 0)
      || (Array.isArray(payload.games) && payload.games.length > 0)
      || (payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length > 0)
      || (payload.response && typeof payload.response === 'object' && Object.keys(payload.response).length > 0)
      || (payload.fixtures && typeof payload.fixtures === 'object' && Object.keys(payload.fixtures).length > 0)
      || (payload.events && typeof payload.events === 'object' && Object.keys(payload.events).length > 0)
      || (payload.games && typeof payload.games === 'object' && Object.keys(payload.games).length > 0);
    if (!hasUsableData) return payload.message;
  }
  return null;
}

function mapRapidApiStatus(raw) {
  if (!raw) return 'SCHEDULED';
  const value = String(raw).toUpperCase();
  if (/LIVE|IN.PLAY|INPLAY|1H|2H|HT|ET/.test(value)) return 'LIVE';
  if (/FINISH|FT|AET|PEN|ENDED|FINAL/.test(value)) return 'FINISHED';
  if (/POSTP|SUSP|CANCEL|ABAND|VOID|INTERRUPT/.test(value)) return 'SUSPENDED';
  if (/NS|SCHED|NOT STARTED/.test(value)) return 'SCHEDULED';
  return 'SCHEDULED';
}

function mapRapidApiMarket(marketName) {
  if (!marketName) return 'OTHER';
  const key = String(marketName).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return MARKET_MAP[key] || 'OTHER';
}

function mapRapidApiSelection(marketType, label, odds, line, sourceSelectionId, suspended) {
  const price = safeOdds(odds);
  if (price === null) return null;
  const resolvedLabel = clean(label || 'Selection', 120);
  const resolvedLine = line === null || line === '' ? null : number(line) ?? clean(String(line), 40);
  return {
    key: hash('selection', PROVIDER, marketType, resolvedLabel, resolvedLine ?? ''),
    label: resolvedLabel,
    odds: price,
    line: resolvedLine,
    suspended: Boolean(suspended),
    source: PROVIDER,
    sourceSelectionId: clean(sourceSelectionId, 160) || null,
    updatedAt: iso(new Date().toISOString()),
    priceVersion: hash('price', PROVIDER, marketType, resolvedLabel, resolvedLine ?? '', price),
  };
}

function normalizeRapidApiRow(raw) {
  if (!raw || !raw.team_home || !raw.team_away) return null;
  const home = clean(raw.team_home?.name || '', 120);
  const away = clean(raw.team_away?.name || '', 120);
  if (!home || !away) return null;

  const sport = raw.sport?.name || 'Football';
  const league = clean(raw.tournament?.name || '', 120) || 'Other';
  const country = clean(raw.category?.name || '', 80) || null;
  const startTime = iso(raw.start_at) || null;
  const state = mapRapidApiStatus(raw.status);
  const clock = raw.status_details ? clean(raw.status_details, 40) : null;
  const homeScore = number(raw.score_home);
  const awayScore = number(raw.score_away);
  const homeLogo = raw.team_home?.logo || null;
  const awayLogo = raw.team_away?.logo || null;

  const markets = [];

  // 1X2 dari main_outcome_0/1/2 pada event list
  const hOdds = safeOdds(raw.main_outcome_0);
  const dOdds = safeOdds(raw.main_outcome_1);
  const aOdds = safeOdds(raw.main_outcome_2);
  if (hOdds || dOdds || aOdds) {
    const selections = [];
    if (hOdds) selections.push(mapRapidApiSelection('1X2', 'HOME', hOdds, null, 'home', false));
    if (dOdds) selections.push(mapRapidApiSelection('1X2', 'DRAW', dOdds, null, 'draw', false));
    if (aOdds) selections.push(mapRapidApiSelection('1X2', 'AWAY', aOdds, null, 'away', false));
    if (selections.length) {
      markets.push(normalizedMarket(String(raw.id), {
        key: '1x2',
        name: '1X2',
        type: '1X2',
        period: 'FT',
        selections,
        source: PROVIDER,
        sourceMarketId: `1x2-${raw.id}`,
        bookmaker: 'tipsters',
        suspended: false,
        updatedAt: iso(new Date().toISOString()),
        mainLine: null,
      }));
    }
  }

  return {
    provider: PROVIDER,
    providerId: String(raw.id),
    sport,
    league,
    country,
    startTime,
    state,
    providerStatus: clean(raw.status || state, 40) || null,
    clock,
    home: { name: home, score: homeScore, logo: homeLogo },
    away: { name: away, score: awayScore, logo: awayLogo },
    leagueLogo: null,
    venue: null,
    periodScores: {},
    markets,
    _ref: String(raw.id),
  };
}

async function fetchRapidApiMarkets(eventId) {
  let data;
  try {
    data = await fetchCacheJson(`/markets?event_id=${encodeURIComponent(String(eventId))}`);
  } catch (error) {
    logger.warn('Tipsters markets fetch failed', { eventId, error: error.message });
    return [];
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const markets = [];
  const seenMarket = new Set();

  for (const row of rows) {
    if (!row || !row.market_name) continue;
    const marketType = mapRapidApiMarket(row.market_name);
    const line = number(row.value);
    const isOpen = Boolean(row.is_open ?? row.market_books?.[0]?.is_open ?? true);
    const book = row.market_books?.[0]?.book || 'tipsters';
    const sourceSelectionId = `mb-${row.market_book_id || row.id}`;

    // Skip 1X2 di sini: sudah tersedia dari main_outcome_0/1/2 pada event list.
    if (marketType === '1X2') continue;

    const marketKey = `${marketType}|${line}|${book}`;
    if (seenMarket.has(marketKey)) continue;
    seenMarket.add(marketKey);

    const selections = [];
    if (marketType === 'HANDICAP') {
      // Asian Handicap: outcome_0 = home, outcome_1 = away, line = value
      const hOdds = safeOdds(row.market_books?.[0]?.outcome_0);
      const aOdds = safeOdds(row.market_books?.[0]?.outcome_1);
      if (hOdds) selections.push(mapRapidApiSelection('HANDICAP', 'Home', hOdds, line, `${sourceSelectionId}-h`, !isOpen));
      if (aOdds) selections.push(mapRapidApiSelection('HANDICAP', 'Away', aOdds, line, `${sourceSelectionId}-a`, !isOpen));
    } else if (marketType === 'TOTALS') {
      // Over/Under: outcome_0 = over, outcome_1 = under, line = value
      const oOdds = safeOdds(row.market_books?.[0]?.outcome_0);
      const uOdds = safeOdds(row.market_books?.[0]?.outcome_1);
      if (oOdds) selections.push(mapRapidApiSelection('TOTALS', 'Over', oOdds, line, `${sourceSelectionId}-o`, !isOpen));
      if (uOdds) selections.push(mapRapidApiSelection('TOTALS', 'Under', uOdds, line, `${sourceSelectionId}-u`, !isOpen));
    } else {
      // Lainnya: gunakan outcome_0/outcome_1 sebagai pilihan generik
      const o0 = safeOdds(row.market_books?.[0]?.outcome_0);
      const o1 = safeOdds(row.market_books?.[0]?.outcome_1);
      if (o0) selections.push(mapRapidApiSelection(marketType, row.market_name, o0, null, `${sourceSelectionId}-0`, !isOpen));
      if (o1) selections.push(mapRapidApiSelection(marketType, row.market_name, o1, null, `${sourceSelectionId}-1`, !isOpen));
    }

    if (selections.length) {
      markets.push(normalizedMarket(String(eventId), {
        key: `${marketType}-${line}-${book}`,
        name: row.market_name,
        type: marketType,
        period: row.period || 'FT',
        line,
        selections,
        source: PROVIDER,
        sourceMarketId: String(row.id),
        bookmaker: book,
        suspended: !isOpen,
        updatedAt: iso(row.market_books?.[0]?.refresh_at || new Date().toISOString()),
        mainLine: null,
      }));
    }
  }

  return markets;
}

export async function fetchRapidApiOdds({
  maxEvents = config.rapidApiOddsMaxEvents || 500,
  maxPages = config.rapidApiOddsMaxPages || 5,
  placing = 'PREMATCH',
} = {}) {
  if (!isProviderEnabled()) {
    return { provider: PROVIDER, enabled: false, events: [], errors: ['Provider disabled: RAPIDAPI_ODDS_ENABLED=false'] };
  }

  let eventsData;
  try {
    eventsData = await fetchCacheJson('/events');
  } catch (error) {
    logger.warn('Tipsters events fetch failed', { error: error.message });
    return {
      provider: PROVIDER,
      enabled: false,
      events: [],
      errors: [error.message],
      transportOk: false,
    };
  }

  const fetchedAt = new Date().toISOString();
  const allEvents = [];
  const seen = new Set();
  const errors = [];

  const rows = Array.isArray(eventsData?.data) ? eventsData.data : [];
  for (const raw of rows) {
    if (allEvents.length >= maxEvents) break;
    const normalized = normalizeRapidApiRow(raw);
    if (!normalized) continue;
    const dedupeKey = `${normalized.home.name}|${normalized.away.name}|${normalized.startTime}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Ambil market AH/O/U dari cache worker (1X2 sudah ada dari main_outcome).
    let ahOuMarkets = [];
    try {
      ahOuMarkets = await fetchRapidApiMarkets(String(raw.id));
    } catch (error) {
      logger.warn('Tipsters markets fetch failed for event', { eventId: raw.id, error: error.message });
    }
    normalized.markets = [...normalized.markets, ...ahOuMarkets];

    const event = normalizedEvent({
      provider: PROVIDER,
      providerId: normalized.providerId,
      sport: normalized.sport,
      league: normalized.league,
      country: normalized.country,
      startTime: normalized.startTime,
      state: normalized.state,
      providerStatus: normalized.providerStatus,
      clock: normalized.clock,
      home: normalized.home.name,
      away: normalized.away.name,
      homeScore: normalized.home.score,
      awayScore: normalized.away.score,
      homeLogo: normalized.home.logo,
      awayLogo: normalized.away.logo,
      leagueLogo: normalized.leagueLogo,
      venue: normalized.venue,
      periodScores: normalized.periodScores,
      markets: normalized.markets,
    });
    if (event) {
      event.fetchedAt = fetchedAt;
      allEvents.push(event);
    }
  }

  logger.info('Tipsters odds (cache worker) fetch complete', {
    provider: PROVIDER,
    events: allEvents.length,
    errors: errors.length,
  });

  return {
    provider: PROVIDER,
    enabled: true,
    events: allEvents,
    errors,
    transportOk: errors.length === 0,
  };
}

export { normalizeRapidApiRow, mapRapidApiStatus, mapRapidApiMarket, mapRapidApiSelection, fetchRapidApiMarkets, hasPayloadErrors, extractErrorDetail };
