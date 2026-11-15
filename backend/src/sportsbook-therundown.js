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

const PROVIDER = 'therundown';

const DEFAULT_TIMEOUT_MS = 15000;

const MARKET_MAP = {
  1: '1X2',
  2: 'HANDICAP',
  3: 'TOTALS',
};

function isProviderEnabled() {
  return Boolean(config.thundownEnabled);
}

function apiKey() {
  return config.thundownApiKey || '';
}

function thHeaders() {
  return {
    'X-TheRundown-Key': apiKey(),
    accept: 'application/json',
  };
}

async function fetchThJson(path) {
  const key = apiKey();
  if (!key) throw new Error('THERUNDOWN_API_KEY not configured');
  const base = config.thundownBaseUrl || 'https://therundown.io/api/v2';
  const url = new URL(path, base);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.thundownRequestTimeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers: thHeaders(), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`TheRundown responded ${response.status}`);
    }
    return response.json();
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) return null;
  // 0.0001 is the off-the-board sentinel.
  if (p === 0.0001) return null;
  if (p > 0) return 1 + p / 100;
  return 1 + 100 / Math.abs(p);
}

function wibBounds(daysAhead) {
  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const start = new Date(wibNow.getFullYear(), wibNow.getMonth(), wibNow.getDate());
  const end = new Date(start.getTime() + daysAhead * 24 * 3600 * 1000 - 1);
  return { start, end };
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function isSoccerSportId(sportId) {
  const soccerIds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 33, 34];
  return soccerIds.includes(Number(sportId));
}

function parseEventDate(raw) {
  if (!raw) return null;
  const s = new Date(String(raw).replace(' ', 'T') + (String(raw).includes('T') ? '' : 'Z'));
  return Number.isFinite(s.getTime()) ? s : null;
}

function isPrematchInWindow(raw, bounds) {
  const start = parseEventDate(raw.event_date);
  if (!start) return false;
  return start >= bounds.start && start <= bounds.end;
}

function teamFromParticipants(participants) {
  const home = participants.find(p => p.is_home === true) || participants.find(p => p.is_home !== false && p.is_away !== true);
  const away = participants.find(p => p.is_away === true) || participants.find(p => p.is_home !== true && p.is_away !== false);
  return { home, away };
}

function mapMarketType(marketId) {
  return MARKET_MAP[marketId] || 'OTHER';
}

function buildMoneylineSelections(market, homeName, awayName) {
  const selections = [];
  for (const participant of (market.participants || [])) {
    const name = clean(participant.name || '', 120);
    const line = participant.lines?.[0];
    if (!line) continue;
    const price = americanToDecimal(line.prices ? Object.values(line.prices).map(p => p.price).find(p => p != null) : null);
    if (!price) continue;
    let label = name;
    const lower = name.toLowerCase();
    if (lower === 'draw' || lower === 'x' || participant.type === 'TYPE_RESULT') label = 'DRAW';
    else if (homeName && name === homeName) label = 'HOME';
    else if (awayName && name === awayName) label = 'AWAY';
    selections.push({
      key: hash('selection', PROVIDER, '1X2', label, null),
      label,
      odds: price,
      line: null,
      suspended: false,
      source: PROVIDER,
      sourceSelectionId: String(line.id || participant.id),
      updatedAt: iso(line.updated_at || new Date().toISOString()),
      priceVersion: hash('price', PROVIDER, '1X2', label, price),
    });
  }
  // Ensure canonical HOME/DRAW/AWAY order.
  const order = { HOME: 0, DRAW: 1, AWAY: 2 };
  return selections.sort((a, b) => (order[a.label] || 99) - (order[b.label] || 99));
}

function buildTwoWaySelections(market, marketType) {
  const selections = [];
  for (const participant of (market.participants || [])) {
    const name = clean(participant.name || '', 120);
    const line = participant.lines?.[0];
    if (!line) continue;
    const price = americanToDecimal(line.prices ? Object.values(line.prices).map(p => p.price).find(p => p != null) : null);
    if (!price) continue;
    const lineValue = number(line.value) ?? null;
    let label = name;
    if (marketType === 'TOTALS') {
      label = /over/i.test(name) ? 'Over' : /under/i.test(name) ? 'Under' : name;
    }
    selections.push({
      key: hash('selection', PROVIDER, marketType, label, lineValue ?? ''),
      label,
      odds: price,
      line: lineValue,
      suspended: false,
      source: PROVIDER,
      sourceSelectionId: String(line.id || participant.id),
      updatedAt: iso(line.updated_at || new Date().toISOString()),
      priceVersion: hash('price', PROVIDER, marketType, label, lineValue ?? '', price),
    });
  }
  return selections;
}

function normalizeThEvent(raw, bounds) {
  if (!raw || !raw.teams || !Array.isArray(raw.teams) || raw.teams.length < 2) return null;
  const { home, away } = teamFromParticipants(raw.teams);
  if (!home || !away) return null;
  const homeName = clean(home.name || '', 120);
  const awayName = clean(away.name || '', 120);
  if (!homeName || !awayName) return null;
  const start = parseEventDate(raw.event_date);
  if (!start || !isPrematchInWindow(raw, bounds)) return null;
  const sportName = raw.sport?.name || 'Football';
  const league = clean(raw.conference?.name || (raw.teams?.[0]?.conference?.name) || '', 120) || 'Other';
  const country = null;

  const markets = [];
  for (const market of (raw.markets || [])) {
    const marketType = mapMarketType(market.market_id);
    if (marketType === '1X2') {
      const selections = buildMoneylineSelections(market, homeName, awayName);
      if (selections.length) {
        markets.push(normalizedMarket(String(raw.event_id), {
          key: '1x2',
          name: '1X2',
          type: '1X2',
          period: 'FT',
          selections,
          source: PROVIDER,
          sourceMarketId: `1x2-${raw.event_id}`,
          bookmaker: 'therundown',
          suspended: false,
          updatedAt: iso(raw.score?.updated_at || new Date().toISOString()),
          mainLine: null,
        }));
      }
    } else if (marketType === 'HANDICAP' || marketType === 'TOTALS') {
      const selections = buildTwoWaySelections(market, marketType);
      if (selections.length) {
        const line = selections[0].line;
        markets.push(normalizedMarket(String(raw.event_id), {
          key: `${marketType}-${line ?? ''}-therundown`,
          name: market.name || marketType,
          type: marketType,
          period: 'FT',
          line,
          selections,
          source: PROVIDER,
          sourceMarketId: String(market.id),
          bookmaker: 'therundown',
          suspended: false,
          updatedAt: iso(raw.score?.updated_at || new Date().toISOString()),
          mainLine: null,
        }));
      }
    }
  }

  return {
    provider: PROVIDER,
    providerId: String(raw.event_id),
    sport: sportName,
    league,
    country,
    startTime: iso(start),
    state: 'SCHEDULED',
    providerStatus: clean(raw.score?.event_status || 'SCHEDULED', 40) || null,
    clock: null,
    home: { name: homeName, score: number(raw.score?.score_home), logo: home.logo || null },
    away: { name: awayName, score: number(raw.score?.score_away), logo: away.logo || null },
    leagueLogo: null,
    venue: raw.score?.venue_name || null,
    periodScores: {},
    markets,
    _ref: String(raw.event_id),
  };
}

export async function fetchTheRundown({
  maxEvents = config.thundownMaxEvents,
  maxPages = config.thundownMaxPages,
  daysAhead = config.thundownDaysAhead,
} = {}) {
  if (!isProviderEnabled()) {
    return { provider: PROVIDER, enabled: false, events: [], errors: ['Provider disabled: THERUNDOWN_ENABLED=false'] };
  }

  const bounds = wibBounds(daysAhead !== undefined ? daysAhead : 3);
  const maxPagesResolved = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : Infinity;
  const eventLimit = maxEvents !== 0 ? maxEvents : Infinity;

  const sportIdsRaw = config.thundownSportIds || '10,11,12,13,14,15,16,17,18,19,33,34';
  const sportIds = String(sportIdsRaw).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  const dates = [];
  const d0 = new Date(bounds.start);
  for (let i = 0; i <= 3; i += 1) {
    const x = new Date(d0.getTime() + i * 24 * 3600 * 1000);
    dates.push(formatDate(x));
  }

  const allEvents = [];
  const seen = new Set();
  const errors = [];
  let requests = 0;

  for (const sportId of sportIds) {
    if (!isSoccerSportId(sportId)) continue;
    for (const date of dates) {
      if (allEvents.length >= eventLimit) break;
      if (requests >= maxPagesResolved) break;
      let data;
      try {
        data = await fetchThJson(`/sports/${sportId}/events/${date}?market_ids=1,2,3`);
        requests += 1;
      } catch (error) {
        errors.push(`${sportId}/${date}: ${error.message}`);
        continue;
      }
      const events = Array.isArray(data?.events) ? data.events : [];
      for (const raw of events) {
        if (allEvents.length >= eventLimit) break;
        if (!isPrematchInWindow(raw, bounds)) continue;
        const normalized = normalizeThEvent(raw, bounds);
        if (!normalized) continue;
        const dedupeKey = `${normalized.home.name}|${normalized.away.name}|${normalized.startTime}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
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
          event.fetchedAt = new Date().toISOString();
          allEvents.push(event);
        }
      }
      // TheRundown free tier: one request per second.
      await new Promise(res => setTimeout(res, 1100));
      if (allEvents.length >= eventLimit) break;
    }
    if (allEvents.length >= eventLimit) break;
  }

  logger.info('TheRundown fetch complete', {
    provider: PROVIDER,
    events: allEvents.length,
    requests,
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

export { isProviderEnabled as thundownIsProviderEnabled, americanToDecimal };
