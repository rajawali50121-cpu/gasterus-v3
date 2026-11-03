import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBoundedResponseText } from './bounded-response.js';
import { config } from './config.js';
import { createPostgresOddsPapiStore } from './sportsbook-oddspapi-store.js';
import {
  marketLabel,
  normalizedEvent,
  normalizedMarket,
  normalizedSelection
} from './sportsbook-providers.js';

const PROVIDER = 'oddspapi';
const SOCCER_SPORT_ID = 10;
const MAX_TOURNAMENTS_PER_REQUEST = 3;
const MAX_TOURNAMENT_BATCHES = 5;
const MAX_TOURNAMENTS_PER_REFRESH = MAX_TOURNAMENTS_PER_REQUEST * MAX_TOURNAMENT_BATCHES;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const REQUEST_COOLDOWN_MS = 1000;
const FIXTURES_COOLDOWN_MS = 2000;
const STATUS_BACKOFF_MS = new Map([
  [401, 15 * 60_000],
  [402, 60 * 60_000],
  [403, 6 * 60 * 60_000],
  [429, 15 * 60_000]
]);
const DEFAULT_TOURNAMENT_IDS = '17';
const DEFAULT_BOOKMAKER = 'pinnacle';
const DEFAULT_REFRESH_SECONDS = 8 * 60 * 60;
const DEFAULT_CATALOG_REFRESH_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_DAILY_REQUEST_BUDGET = 8;
const DEFAULT_MONTHLY_REQUEST_BUDGET = 240;

function isEnabled(settings) {
  return settings.oddsPapiEnabled === true;
}

function arrayPayload(payload, name) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'results', 'fixtures', 'tournaments', 'markets']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  throw new Error(`OddsPapi returned an invalid ${name} response`);
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

function integerSetting(settings, name, fallback, min, max) {
  const value = Number(settings[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function createOddsPapiState({ store } = {}) {
  if (!store) throw new Error('An explicit OddsPapi state store is required');
  return {
    requestsToday: 0,
    requestsThisMonth: 0,
    retryAt: 0,
    tournaments: null,
    markets: null,
    board: null,
    store
  };
}

async function reserveRequest(state, now, settings, cooldownMs, sleepImpl, reservationId) {
  const dailyLimit = integerSetting(settings, 'oddsPapiDailyRequestBudget', DEFAULT_DAILY_REQUEST_BUDGET, 1, 8);
  const monthlyLimit = integerSetting(settings, 'oddsPapiMonthlyRequestBudget', DEFAULT_MONTHLY_REQUEST_BUDGET, 1, DEFAULT_MONTHLY_REQUEST_BUDGET);
  const reservation = await state.store.reserveRequest({
    now,
    dailyLimit,
    monthlyLimit,
    cooldownMs,
    reservationId
  });
  state.requestsToday = reservation.requestsToday;
  state.requestsThisMonth = reservation.requestsThisMonth;
  if (reservation.status === 'exhausted') throw new Error('OddsPapi request budget exhausted');
  if (reservation.status === 'backoff') throw new Error('OddsPapi provider is in backoff');
  if (reservation.status === 'duplicate') throw new Error('OddsPapi request reservation was already used');
  if (reservation.waitMs > 0) {
    await sleepImpl(reservation.waitMs);
    if (await state.store.checkBackoff(nowValue(now))) {
      throw new Error('OddsPapi provider is in backoff');
    }
  }
}

function validBaseUrl(value) {
  const url = new URL(value || 'https://api.oddspapi.io');
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('OddsPapi base URL must use HTTPS and cannot contain credentials');
  }
  return url;
}

async function requestJson(path, params, {
  settings,
  state,
  fetchImpl,
  now,
  sleepImpl,
  timeoutMs
}) {
  const current = nowValue(now);
  if (current < state.retryAt) throw new Error('OddsPapi provider is in backoff');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const requestTime = nowValue(now);
    const cooldownMs = path === 'fixtures' ? FIXTURES_COOLDOWN_MS : REQUEST_COOLDOWN_MS;
    await reserveRequest(state, requestTime, settings, cooldownMs, sleepImpl, randomUUID());

    const url = validBaseUrl(settings.oddsPapiBaseUrl);
    const basePath = url.pathname.replace(/\/v4\/?$/, '').replace(/\/+$/, '');
    url.pathname = `${basePath}/v4/${path}`;
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && String(value) !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('apiKey', settings.oddsPapiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (attempt + 1 < MAX_ATTEMPTS) {
        await sleepImpl(REQUEST_COOLDOWN_MS);
        continue;
      }
      if (error?.name === 'AbortError') throw new Error('OddsPapi request timed out');
      throw new Error('OddsPapi network request failed');
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const status = Number(response.status) || 0;
      const backoffMs = STATUS_BACKOFF_MS.get(status);
      if (backoffMs) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const requestedBackoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs;
        state.retryAt = nowValue(now) + Math.max(backoffMs, Math.min(6 * 60 * 60_000, requestedBackoff));
        await state.store.setBackoff(state.retryAt, nowValue(now));
      }
      if (status >= 500 && attempt + 1 < MAX_ATTEMPTS) {
        await sleepImpl(REQUEST_COOLDOWN_MS);
        continue;
      }
      throw new Error(`OddsPapi returned HTTP ${status}`);
    }

    try {
      const text = await readBoundedResponseText(response, 'OddsPapi', MAX_RESPONSE_BYTES);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('OddsPapi returned invalid JSON');
      throw error;
    }
  }
  throw new Error('OddsPapi request failed after bounded retries');
}

function cachedValue(entry, now, ttlMs) {
  return entry && now >= entry.fetchedAt && now - entry.fetchedAt < ttlMs
    ? entry.value
    : null;
}

async function loadCached(state, field, now, ttlMs, cacheKey, fetcher) {
  const cached = cachedValue(state[field], now, ttlMs);
  if (cached !== null) return cached;
  const sharedCached = await state.store.getCache(cacheKey);
  const sharedValue = cachedValue(sharedCached, now, ttlMs);
  if (sharedValue !== null) {
    state[field] = sharedCached;
    return sharedValue;
  }
  const result = await state.store.withCacheLock(cacheKey, async () => {
    const refreshedCache = await state.store.getCache(cacheKey);
    const refreshedValue = cachedValue(refreshedCache, nowValue(now), ttlMs);
    if (refreshedValue !== null) {
      state[field] = refreshedCache;
      return refreshedValue;
    }
    const value = await fetcher();
    const entry = { value, fetchedAt: nowValue(now) };
    await state.store.setCache(cacheKey, entry, ttlMs);
    state[field] = entry;
    return value;
  });
  if (result && result.cacheLockHit === true) {
    const entry = result.value;
    const value = cachedValue(entry, nowValue(now), ttlMs);
    if (value !== null) {
      state[field] = entry;
      return value;
    }
    throw new Error('OddsPapi shared cache refresh returned stale data');
  }
  return result;
}

function tournamentIds(settings) {
  const configured = String(settings.oddsPapiTournamentIds || DEFAULT_TOURNAMENT_IDS)
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d+$/.test(value));
  const unique = [...new Set(configured)];
  if (!unique.length || unique.length > MAX_TOURNAMENTS_PER_REFRESH) {
    throw new Error('OddsPapi tournament ID configuration is invalid');
  }
  return unique;
}

function selectTournamentIds(configuredIds, fixtureRows, tournamentCatalog, now) {
  const counts = new Map();
  for (const fixture of fixtureRows) {
    const id = String(fixture?.tournamentId ?? '');
    const kickoff = Date.parse(fixture?.startTime || '');
    if (!id || !tournamentCatalog.has(id)
      || Number(fixture?.sportId) !== SOCCER_SPORT_ID
      || Number(fixture?.statusId) !== 0
      || fixture?.hasOdds !== true
      || !Number.isFinite(kickoff)
      || kickoff <= now
      || kickoff > now + 7 * 24 * 60 * 60_000) continue;
    const value = counts.get(id) || { fixtures: 0, firstKickoff: kickoff };
    value.fixtures += 1;
    value.firstKickoff = Math.min(value.firstKickoff, kickoff);
    counts.set(id, value);
  }

  const prioritized = configuredIds.filter(id => counts.has(id));
  const discovered = [...counts.keys()]
    .filter(id => !prioritized.includes(id))
    .sort((left, right) => {
      const difference = counts.get(right).fixtures - counts.get(left).fixtures;
      if (difference) return difference;
      const kickoffDifference = counts.get(left).firstKickoff - counts.get(right).firstKickoff;
      return kickoffDifference || left.localeCompare(right, undefined, { numeric: true });
    });
  return [...prioritized, ...discovered].slice(0, MAX_TOURNAMENTS_PER_REFRESH);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function periodFor(market) {
  const period = String(market?.period || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['ft', 'fulltime', 'match'].includes(period)) return 'FT';
  if (['1h', 'ht', 'firsthalf', 'half1'].includes(period)) return '1H';
  if (period === 'p1' && /\b(?:first|1st)\s+half\b/i.test(String(market?.marketName || ''))) return '1H';
  return null;
}

function outcomeSide(type, rawName) {
  const name = String(rawName || '').trim().toLowerCase();
  if (type === '1X2') {
    if (['1', 'home', 'participant1'].includes(name)) return 'home';
    if (['x', 'draw', 'tie'].includes(name)) return 'draw';
    if (['2', 'away', 'participant2'].includes(name)) return 'away';
  } else if (type === 'TOTALS') {
    if (name === 'over') return 'over';
    if (name === 'under') return 'under';
  } else if (type === 'HANDICAP') {
    if (['1', 'home', 'participant1'].includes(name)) return 'home';
    if (['2', 'away', 'participant2'].includes(name)) return 'away';
  }
  return null;
}

export function marketDefinition(raw) {
  if (Number(raw?.sportId) !== SOCCER_SPORT_ID || raw?.playerProp === true) return null;
  const period = periodFor(raw);
  if (!period) return null;
  const marketType = String(raw?.marketType || '').toLowerCase().replace(/[\s_-]+/g, '');
  const name = String(raw?.marketName || '').trim().toLowerCase();
  const asianHandicapName = /^asian handicap(?:\s+(?:first|1st) half)?$/.test(name);
  let type = null;
  if (marketType === '1x2' && Number(raw.marketLength) === 3) type = '1X2';
  if (marketType === 'totals' && /over\s*under/.test(name) && !/both teams|btts/.test(name)
    && Number(raw.marketLength) === 2) type = 'TOTALS';
  if ((marketType === 'asianhandicap' || marketType === 'handicap' || marketType === 'spreads')
    && asianHandicapName && Number(raw.marketLength) === 2) type = 'HANDICAP';
  if (!type) return null;

  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  const mapped = outcomes.map(outcome => ({
    id: String(outcome.outcomeId ?? ''),
    side: outcomeSide(type, outcome.outcomeName)
  }));
  const expected = type === '1X2' ? ['home', 'draw', 'away'] : type === 'TOTALS' ? ['over', 'under'] : ['home', 'away'];
  if (mapped.length !== expected.length || expected.some(side => mapped.filter(item => item.side === side && item.id).length !== 1)) return null;

  const rawLine = raw.handicap;
  const line = type === '1X2'
    ? null
    : typeof rawLine === 'number' || (typeof rawLine === 'string' && rawLine.trim() !== '')
      ? Number(rawLine)
      : null;
  if (type !== '1X2' && (line === null || !Number.isFinite(line) || Math.abs(line) > 20)) return null;
  return {
    id: String(raw.marketId ?? ''),
    type,
    period,
    line,
    name: marketLabel(type, raw.marketName),
    outcomes: mapped
  };
}

function priceTimestamp(price) {
  for (const value of [price?.changedAt, price?.bookmakerChangedAt]) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function normalizeOddsPapiEvent(fixture, oddsFixture, marketCatalog, tournamentCatalog, {
  now = Date.now(),
  maxPriceAgeSeconds = config.sportsbookMaxPrematchPriceAgeSeconds,
  bookmaker = DEFAULT_BOOKMAKER
} = {}) {
  const startTime = fixture?.startTime;
  const kickoff = Date.parse(startTime || '');
  if (!fixture?.fixtureId || Number(fixture.sportId) !== SOCCER_SPORT_ID
    || Number(fixture.statusId) !== 0 || fixture.hasOdds !== true
    || !Number.isFinite(kickoff) || kickoff <= now || kickoff > now + 7 * 24 * 60 * 60_000) return null;

  const home = fixture.participant1Name || fixture.participant1ShortName;
  const away = fixture.participant2Name || fixture.participant2ShortName;
  if (!home || !away) return null;
  const tournament = tournamentCatalog.get(String(fixture.tournamentId));
  const event = normalizedEvent({
    provider: PROVIDER,
    providerId: fixture.fixtureId,
    sport: 'soccer',
    league: fixture.tournamentName || tournament?.tournamentName,
    country: fixture.categoryName || tournament?.categoryName || '',
    startTime,
    state: 'SCHEDULED',
    providerStatus: fixture.statusName || 'Pre-Game',
    home,
    away
  });

  const bookmakerData = oddsFixture?.bookmakerOdds?.[bookmaker];
  if (!bookmakerData || bookmakerData.bookmakerIsActive === false || bookmakerData.suspended === true) return event;
  const rawMarkets = bookmakerData.markets;
  if (!rawMarkets || typeof rawMarkets !== 'object' || Array.isArray(rawMarkets)) return event;

  const maxAgeMs = Number(maxPriceAgeSeconds) * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('OddsPapi freshness limit is invalid');
  for (const [marketId, rawMarket] of Object.entries(rawMarkets)) {
    if (rawMarket?.marketActive === false) continue;
    const definition = marketCatalog.get(String(marketId));
    if (!definition || !rawMarket?.outcomes || typeof rawMarket.outcomes !== 'object') continue;
    const selections = [];
    let suspended = false;
    let latestUpdate = Number.POSITIVE_INFINITY;
    for (const outcome of definition.outcomes) {
      const rawOutcome = rawMarket.outcomes[outcome.id];
      const price = rawOutcome?.players?.['0'] || rawOutcome?.players?.[Object.keys(rawOutcome?.players || {})[0]];
      const odds = Number(price?.price);
      const updatedMs = priceTimestamp(price);
      if (!price || price.active === false || !Number.isFinite(odds) || odds <= 1 || odds > 10000
        || updatedMs === null || updatedMs > now) {
        suspended = true;
        continue;
      }
      const stale = now - updatedMs > maxAgeMs;
      suspended ||= stale;
      if (stale) continue;
      const label = outcome.side === 'home' ? 'Home'
        : outcome.side === 'away' ? 'Away'
          : outcome.side === 'draw' ? 'Draw'
            : outcome.side === 'over' ? 'Over'
              : 'Under';
      const line = definition.type === '1X2' ? null
        : definition.type === 'HANDICAP' && outcome.side === 'away' ? -definition.line
          : definition.line;
      const selection = normalizedSelection(event.id, `${definition.type}:${definition.period}:${line ?? ''}`, label, odds, {
        line,
        source: PROVIDER,
        sourceSelectionId: price.bookmakerOutcomeId || outcome.id,
        updatedAt: new Date(updatedMs).toISOString(),
        suspended: stale
      });
      if (!selection) {
        suspended = true;
        continue;
      }
      selections.push(selection);
      latestUpdate = Math.min(latestUpdate, updatedMs);
    }
    if (selections.length !== definition.outcomes.length) suspended = true;
    if (!selections.length) continue;
    const normalizedSelections = suspended
      ? selections.map(selection => ({ ...selection, suspended: true }))
      : selections;
    const market = normalizedMarket(event.id, {
      key: `${definition.id}:${definition.period}:${definition.line ?? ''}`,
      name: definition.name,
      type: definition.type,
      period: definition.period,
      line: definition.line,
      selections: normalizedSelections,
      source: PROVIDER,
      sourceMarketId: rawMarket.bookmakerMarketId || definition.id,
      bookmaker,
      suspended,
      updatedAt: new Date(latestUpdate).toISOString(),
      mainLine: true
    });
    if (market) event.markets.push(market);
  }
  return event;
}

function metadataMap(rows, key) {
  return new Map(rows.map(row => [String(row?.[key] ?? ''), row]).filter(([id]) => id));
}

export async function fetchOddsPapi({
  settings = config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  state = defaultState,
  sleepImpl = sleep,
  timeoutMs = 10_000,
  log = () => {}
} = {}) {
  if (!isEnabled(settings)) return { provider: PROVIDER, enabled: false, events: [] };
  if (!settings.oddsPapiKey) throw new Error('ODDSPAPI_API_KEY is required when ODDSPAPI_ENABLED is true');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const current = nowValue(now);
  if (!state.store) throw new Error('OddsPapi shared request budget is unavailable');
  const refreshSeconds = integerSetting(settings, 'oddsPapiRefreshSeconds', DEFAULT_REFRESH_SECONDS, 3600, 86400);
  const catalogRefreshSeconds = integerSetting(settings, 'oddsPapiCatalogRefreshSeconds', DEFAULT_CATALOG_REFRESH_SECONDS, 3600, 30 * 24 * 60 * 60);
  const bookmaker = String(settings.oddsPapiBookmaker || DEFAULT_BOOKMAKER).trim();
  if (!bookmaker || bookmaker.length > 80) throw new Error('ODDSPAPI_BOOKMAKER is invalid');

  const configuredIds = tournamentIds(settings);
  const boardKey = `board:${configuredIds.join(',')}:discovered-${MAX_TOURNAMENTS_PER_REFRESH}:${bookmaker}`;
  const board = await loadCached(state, 'board', current, refreshSeconds * 1000, boardKey, async () => {
    const tournamentRows = await loadCached(state, 'tournaments', current, catalogRefreshSeconds * 1000, 'tournaments:soccer', async () =>
      arrayPayload(await requestJson('tournaments', { sportId: SOCCER_SPORT_ID, language: 'en' }, {
        settings, state, fetchImpl, now, sleepImpl, timeoutMs
      }), 'tournaments'));
    const marketRows = await loadCached(state, 'markets', current, catalogRefreshSeconds * 1000, 'markets:soccer', async () =>
      arrayPayload(await requestJson('markets', { sportId: SOCCER_SPORT_ID, language: 'en' }, {
        settings, state, fetchImpl, now, sleepImpl, timeoutMs
      }), 'markets'));
    const tournamentCatalog = metadataMap(tournamentRows, 'tournamentId');
    const from = new Date(current).toISOString();
    const to = new Date(current + 7 * 24 * 60 * 60_000).toISOString();
    const fixtureRows = arrayPayload(await requestJson('fixtures', {
      sportId: SOCCER_SPORT_ID,
      from,
      to,
      statusId: 0,
      hasOdds: true,
      bookmakers: bookmaker
    }, { settings, state, fetchImpl, now, sleepImpl, timeoutMs }), 'fixtures');
    const selectedIds = selectTournamentIds(configuredIds, fixtureRows, tournamentCatalog, current);
    if (!selectedIds.length) throw new Error('No OddsPapi soccer tournaments with upcoming fixtures are available');
    const selectedTournamentIds = new Set(selectedIds);
    const fixtures = fixtureRows.filter(row => selectedTournamentIds.has(String(row?.tournamentId)));
    const oddsFixtures = [];
    for (const batch of chunks(selectedIds, MAX_TOURNAMENTS_PER_REQUEST)) {
      const responseRows = arrayPayload(await requestJson('odds-by-tournaments', {
        tournamentIds: batch.join(','),
        bookmaker,
        language: 'en',
        verbosity: 3
      }, { settings, state, fetchImpl, now, sleepImpl, timeoutMs       }), 'odds');
      oddsFixtures.push(...responseRows);
    }
    return { fixtures, oddsFixtures, tournamentRows, marketRows, tournamentCount: selectedIds.length };
  });
  const { fixtures, oddsFixtures, tournamentRows, marketRows, tournamentCount } = board;
  const tournaments = metadataMap(tournamentRows, 'tournamentId');
  const markets = metadataMap(marketRows.map(row => ({ ...row, _normalized: marketDefinition(row) }))
    .filter(row => row._normalized).map(row => ({ ...row._normalized })), 'id');

  const fixtureById = new Map(fixtures.map(row => [String(row.fixtureId), row]));
  const oddsById = new Map();
  for (const row of oddsFixtures) {
    const id = String(row?.fixtureId || '');
    if (id && !oddsById.has(id)) oddsById.set(id, row);
  }
  const events = [];
  const seen = new Set();
  for (const [id, fixture] of fixtureById) {
    if (seen.has(id)) continue;
    seen.add(id);
    const event = normalizeOddsPapiEvent(fixture, oddsById.get(id), markets, tournaments, {
      now: nowValue(now),
      maxPriceAgeSeconds: settings.sportsbookMaxPrematchPriceAgeSeconds,
      bookmaker
    });
    if (event) events.push(event);
  }
  const requestCounts = await state.store.getRequestCounts(nowValue(now));
  log({
    event: 'provider-quota',
    provider: PROVIDER,
    tournaments: tournamentCount,
    requestsToday: requestCounts.requestsToday,
    requestsThisMonth: requestCounts.requestsThisMonth,
    events: events.length,
    markets: events.reduce((total, event) => total + event.markets.length, 0)
  });
  return { provider: PROVIDER, enabled: true, events, errors: [] };
}

const defaultState = createOddsPapiState({ store: createPostgresOddsPapiStore() });

export { normalizeOddsPapiEvent };
