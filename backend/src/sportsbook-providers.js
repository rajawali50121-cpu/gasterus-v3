import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureBoundedCacheCapacity, pruneExpiredCacheEntries, setBoundedCacheEntry } from './bounded-cache.js';
import { readBoundedResponseText } from './bounded-response.js';
import { eventSettlementAuthority } from './sportsbook-settlement-authority.js';
import { fetchRapidApiOdds, normalizeRapidApiRow, mapRapidApiStatus, mapRapidApiMarket, mapRapidApiSelection } from './tipsters-provider.js';

// Shared date helper used by multiple providers (Sportmonks, etc.)
function utcDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// No artificial event cap: API quota is the only real ceiling.
const SPORTMONKS_PAGE_SIZE = 50;
const SPORTMONKS_FIXTURE_INCLUDES = 'state;participants;league.country;odds;odds.market;odds.bookmaker;scores;statistics.type;events.type';
const SPORTMONKS_LIVE_INCLUDES = 'state;participants;league.country;inplayOdds;inplayOdds.market;inplayOdds.bookmaker;scores';
const DEFAULT_SPORTMONKS_PRIORITY_LEAGUES = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'UEFA Champions League', 'UEFA Europa League', 'UEFA Europa Conference League', 'Eredivisie', 'Primeira Liga', 'Major League Soccer'];
const MARKET_TYPES = Object.freeze({
  h2h: '1X2',
  moneyline: '1X2',
  h2h_3_way: '1X2',
  moneyline_3way: '1X2',
  three_way_moneyline: '1X2',
  fulltime_result: '1X2',
  full_time_result: '1X2',
  match_winner: '1X2',
  match_result: '1X2',
  spreads: 'HANDICAP',
  point_spread: 'HANDICAP',
  asian_handicap: 'HANDICAP',
  totals: 'TOTALS',
  total_points: 'TOTALS',
  goals_over_under: 'TOTALS',
  btts: 'BTTS',
  both_teams_score: 'BTTS',
  both_teams_to_score: 'BTTS',
  double_chance: 'DOUBLE_CHANCE',
  draw_no_bet: 'DRAW_NO_BET',
  dnb: 'DRAW_NO_BET',
  halftime_fulltime: 'HT_FT',
  half_time_full_time: 'HT_FT',
  correct_score: 'CORRECT_SCORE',
  odd_even: 'ODD_EVEN',
  team_total: 'TEAM_TOTAL',
  team_totals: 'TEAM_TOTAL',
  player_prop: 'PLAYER_PROP',
  player_props: 'PLAYER_PROP',
  anytime_goalscorer: 'PLAYER_PROP',
  shots_on_target: 'PLAYER_PROP',
  player_assists: 'PLAYER_PROP',
  first_goalscorer: 'PLAYER_PROP',
  corners: 'CORNERS',
  corner_handicap: 'CORNERS',
  total_corners: 'CORNERS',
  team_corners: 'CORNERS',
  cards: 'CARDS',
  total_cards: 'CARDS',
  team_cards: 'CARDS',
  first_goal: 'FIRST_TO_SCORE',
  first_to_score: 'FIRST_TO_SCORE',
  next_goal: 'NEXT_TO_SCORE',
  winning_margin: 'WINNING_MARGIN',
  win_margin: 'WINNING_MARGIN',
  clean_sheet: 'CLEAN_SHEET',
  team_total_goals: 'TEAM_TOTAL',
  bet_builder: 'BET_BUILDER',
  same_game_parlay: 'BET_BUILDER',
  same_game_multi: 'BET_BUILDER'
});

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function sportmonksText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function hash(...parts) {
  return crypto.createHash('sha256').update(parts.map(value => clean(value, 500)).join('|')).digest('hex').slice(0, 28);
}
function slug(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
}
function teamKey(value) {
  return slug(value).replace(/\b(fc|cf|sc|afc|club|the)\b/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
export function leagueKey(value) {
  const key = slug(value);
  const aliases = {
    epl: 'premier-league',
    'english-premier-league': 'premier-league',
    laliga: 'la-liga',
    'spanish-la-liga': 'la-liga',
    'italian-serie-a': 'serie-a',
    'german-bundesliga': 'bundesliga',
    'french-ligue-1': 'ligue-1',
    'ligue-one': 'ligue-1',
    ucl: 'champions-league',
    'uefa-champions-league': 'champions-league'
  };
  return aliases[key] || key;
}
function iso(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function status(value) {
  const raw = clean(value).toUpperCase();
  if (/^(1H|2H|HT|ET|BT|P|Q[1-4]|IN\d+|LIVE|INT|BREAK)$/.test(raw) || /LIVE|PLAY|HALF|QUARTER|PERIOD/.test(raw)) return 'LIVE';
  if (/FT|AET|PEN|FINISH|ENDED|FINAL/.test(raw)) return 'FINISHED';
  if (/CANC|PST|SUSP|ABD|INTERRUPT/.test(raw)) return 'SUSPENDED';
  return 'SCHEDULED';
}
function sportFromKey(key, fallback = 'Football') {
  const raw = clean(key).toLowerCase();
  if (raw.includes('basket')) return 'Basketball';
  if (raw.includes('tennis')) return 'Tennis';
  if (raw.includes('esport')) return 'Esports';
  if (raw.includes('hockey')) return 'Ice Hockey';
  if (raw.includes('baseball')) return 'Baseball';
  if (raw.includes('americanfootball')) return 'American Football';
  return /soccer|football/.test(raw) ? 'Football' : fallback;
}
function marketType(name, key = '') {
  const normalized = `${clean(key)} ${clean(name)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  for (const [needle, type] of Object.entries(MARKET_TYPES)) if (normalized.includes(needle)) return type;
  if (/both_teams.*score|btts/.test(normalized)) return 'BTTS';
  if (/double.*chance/.test(normalized)) return 'DOUBLE_CHANCE';
  if (/draw.*no.*bet/.test(normalized)) return 'DRAW_NO_BET';
  if (/half.*time.*full.*time|halftime.*fulltime/.test(normalized)) return 'HT_FT';
  if (/correct.*score/.test(normalized)) return 'CORRECT_SCORE';
  if (/over.*under|total/.test(normalized)) return 'TOTALS';
  if (/handicap|spread/.test(normalized)) return 'HANDICAP';
  if (/winner|result|1x2|moneyline/.test(normalized)) return '1X2';
  return 'OTHER';
}
function periodFromName(name, key = '') {
  const raw = `${clean(key)} ${clean(name)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (/half_time_full|halftime_full|ht_ft|halftimefull/.test(raw)) return 'FT';
  if (/(?:^|_)(?:h1|1h|ht)(?:_|$)|first_half|1st_half|firsthalf|half_time(?!_full)|halftime(?!_full)/.test(raw)) return '1H';
  if (/(?:^|_)h2(?:_|$)|second_half|2nd_half|secondhalf/.test(raw)) return '2H';
  if (/(?:^|_)q1(?:_|$)|first_quarter|1st_quarter/.test(raw)) return 'Q1';
  if (/(?:^|_)q2(?:_|$)|second_quarter|2nd_quarter/.test(raw)) return 'Q2';
  if (/(?:^|_)q3(?:_|$)|third_quarter|3rd_quarter/.test(raw)) return 'Q3';
  if (/(?:^|_)q4(?:_|$)|fourth_quarter|4th_quarter/.test(raw)) return 'Q4';
  return 'FT';
}
function marketLabel(type, rawName, key = '') {
  if (type === '1X2') return '1X2';
  if (type === 'HANDICAP') return 'Asian Handicap';
  if (type === 'TOTALS') return 'Over / Under';
  if (type === 'BTTS') return 'Both Teams To Score';
  if (type === 'DOUBLE_CHANCE') return 'Double Chance';
  if (type === 'HT_FT') return 'Half Time / Full Time';
  if (type === 'DRAW_NO_BET') return 'Draw No Bet';
  if (type === 'TEAM_TOTAL') return 'Team Total';
  if (type === 'PLAYER_PROP') return 'Player Props';
  if (type === 'CORRECT_SCORE') return 'Correct Score';
  if (type === 'ODD_EVEN') return 'Odd / Even';
  if (type === 'CORNERS') return 'Corners';
  if (type === 'CARDS') return 'Cards';
  if (type === 'FIRST_TO_SCORE') return 'First to Score';
  if (type === 'CLEAN_SHEET') return 'Clean Sheet';
  if (type === 'TEAM_TOTAL') return 'Team Total';
  return clean(rawName || key || type, 120);
}
function eventId(sport, home, away, startTime) {
  return hash('event', sportFromKey(sport), teamKey(home), teamKey(away), iso(startTime) ?? clean(startTime));
}
function selectionId(event, marketKey, label, line) {
  return hash('selection', event, marketKey, slug(label), line ?? '');
}
function marketId(event, type, period, line, name) {
  return hash('market', event, type, period, line ?? '', slug(name));
}
function safeOdds(value) {
  const parsed = number(value);
  return parsed !== null && parsed > 1 && parsed <= 10000 ? Math.round(parsed * 10000) / 10000 : null;
}
function normalizedSelection(event, marketKey, label, odds, { line = null, source, sourceSelectionId = '', suspended = false, updatedAt = null } = {}) {
  const price = safeOdds(odds);
  if (price === null) return null;
  const cleanLabel = clean(label, 120) || 'Selection';
  const resolvedLine = line === null || line === '' ? null : number(line) ?? clean(line, 40);
  const resolvedUpdatedAt = iso(updatedAt);
  const resolvedSourceSelectionId = clean(sourceSelectionId, 160) || null;
  return {
    key: selectionId(event, marketKey, cleanLabel, resolvedLine),
    label: cleanLabel,
    odds: price,
    line: resolvedLine,
    suspended: Boolean(suspended),
    source,
    sourceSelectionId: resolvedSourceSelectionId,
    updatedAt: resolvedUpdatedAt,
    priceVersion: hash('price', event, marketKey, resolvedSourceSelectionId || cleanLabel, resolvedLine ?? '', price)
  };
}
function normalizedMarket(event, { key, name, type, period = 'FT', line = null, selections = [], source, sourceMarketId = null, bookmaker = null, suspended = false, updatedAt = null, mainLine = null }) {
  const valid = selections.filter(Boolean);
  if (!valid.length && !(source === 'sportmonks' && config.sportmonksPassthrough)) return null;
  const resolvedType = type || marketType(name, key);
  const resolvedPeriod = period || periodFromName(name);
  const resolvedLine = line === null || line === '' ? null : number(line) ?? clean(line, 40);
  return {
    id: marketId(event, resolvedType, resolvedPeriod, resolvedLine, key || name),
    key: clean(key || slug(name), 120),
    type: resolvedType,
    label: source === 'sportmonks' && config.sportmonksPassthrough
      ? sportmonksText(name || resolvedType)
      : clean(name || resolvedType, 120),
    period: resolvedPeriod,
    line: resolvedLine,
    suspended: Boolean(suspended),
    updatedAt: iso(updatedAt),
    source,
    sourceMarketId: clean(sourceMarketId, 180) || null,
    bookmaker: source === 'sportmonks' && config.sportmonksPassthrough
      ? sportmonksText(bookmaker) || null
      : clean(bookmaker, 120) || null,
    mainLine: mainLine === null ? null : Boolean(mainLine),
    selections: valid
  };
}
function normalizedEvent({ provider, providerId, sport, league, country = '', startTime, state = 'SCHEDULED', providerStatus = null, clock = null, home, away, homeScore = null, awayScore = null, homeLogo = null, awayLogo = null, leagueLogo = null, venue = null, periodScores = {}, markets = [] }) {
  const resolvedSport = sportFromKey(sport);
  const id = eventId(resolvedSport, home, away, startTime);
  const resolvedStatus = status(state);
  const providerText = provider === 'sportmonks' && config.sportmonksPassthrough ? sportmonksText : clean;
  const providerClean = (value, max) => provider === 'sportmonks' && config.sportmonksPassthrough
    ? providerText(value)
    : clean(value, max);
  return {
    id,
    sport: resolvedSport,
    league: providerClean(league || 'Other', 120),
    country: providerClean(country, 80) || null,
    startTime: iso(startTime),
    status: resolvedStatus,
    providerStatus: providerClean(providerStatus || state, 40) || null,
    live: resolvedStatus === 'LIVE',
    clock: clean(clock, 40) || null,
    home: { name: providerClean(home, 120), score: number(homeScore), logo: homeLogo || null },
    away: { name: providerClean(away, 120), score: number(awayScore), logo: awayLogo || null },
    leagueLogo: leagueLogo || null,
    venue: providerClean(venue, 160) || null,
    periodScores: periodScores && typeof periodScores === 'object' ? periodScores : {},
    markets: markets.filter(Boolean),
    _refs: { [provider]: clean(providerId, 160) },
    _sources: [provider],
    _settlementReadySources: [provider]
  };
}

async function requestJson(url, { headers = {}, label = 'sports provider', maxBytes = 0 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sportsFeedRequestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'ASEAN777-Sports-Aggregator/2.0', ...headers },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) {
      const error = new Error(`${label} returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfter = response.headers?.get?.('retry-after') || null;
      throw error;
    }
    const text = await readBoundedResponseText(response, label, maxBytes);
    const payload = JSON.parse(text);
    if (hasPayloadErrors(payload)) {
      const detail = extractErrorDetail(payload);
      const error = new Error(`${label} response contains error${detail ? `: ${detail}` : ''}`);
      error.status = 200;
      error.payloadErrors = true;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
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

  // message field: hanya error jika TIDAK ada data usable (data, response, fixtures, events)
  const hasUsableData = (Array.isArray(payload.data) && payload.data.length > 0)
    || (Array.isArray(payload.response) && payload.response.length > 0)
    || (Array.isArray(payload.fixtures) && payload.fixtures.length > 0)
    || (Array.isArray(payload.events) && payload.events.length > 0)
    || (payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length > 0)
    || (payload.response && typeof payload.response === 'object' && Object.keys(payload.response).length > 0)
    || (payload.fixtures && typeof payload.fixtures === 'object' && Object.keys(payload.fixtures).length > 0)
    || (payload.events && typeof payload.events === 'object' && Object.keys(payload.events).length > 0);
  if (payload.message && typeof payload.message === 'string') {
    const msg = payload.message.toLowerCase();
    // pesan Sportmonks no-access → peringatan, bukan error fatal
    if (/no result|don't have access|subscription/i.test(msg)) return false;
    // jika ada data usable, message info bukan error
    if (hasUsableData) return false;
    // message error keyword tanpa data usable
    if (/error|invalid|unauthorized|forbidden|rate.limit|quota|exceeded/i.test(msg)) return true;
  }

  // success: false → error
  if (payload.success === false) return true;

  // status field error
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
    // no-access message → return as warning detail
    if (/no result|don't have access|subscription/i.test(msg)) return `warning: ${payload.message}`;
    // other messages without usable data
const hasUsableData = (Array.isArray(payload.data) && payload.data.length > 0)
    || (Array.isArray(payload.response) && payload.response.length > 0)
    || (Array.isArray(payload.fixtures) && payload.fixtures.length > 0)
    || (Array.isArray(payload.events) && payload.events.length > 0)
    || (payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length > 0)
    || (payload.response && typeof payload.response === 'object' && Object.keys(payload.response).length > 0)
    || (payload.fixtures && typeof payload.fixtures === 'object' && Object.keys(payload.fixtures).length > 0)
    || (payload.events && typeof payload.events === 'object' && Object.keys(payload.events).length > 0);
    if (!hasUsableData) return payload.message;
  }
  return null;
}

const providerRequestCache = new Map();
async function cachedRequest(key, ttlMs, fetcher) {
  const now = Date.now();
  pruneExpiredCacheEntries(providerRequestCache, now);
  const cached = providerRequestCache.get(key);
  if (cached?.value !== undefined) {
    if (now - cached.fetchedAt < ttlMs) return cached.value;
    providerRequestCache.delete(key);
  }
  if (cached?.inFlight) return cached.inFlight;
  ensureBoundedCacheCapacity(providerRequestCache, key, config.sportsProviderCacheMaxEntries);
  const inFlight = Promise.resolve().then(fetcher).then(value => {
    setBoundedCacheEntry(providerRequestCache, key, value, {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      maxEntryBytes: config.sportsProviderCacheMaxEntryBytes,
      maxTotalBytes: config.sportsProviderCacheMaxTotalBytes,
      maxEntries: config.sportsProviderCacheMaxEntries
    });
    return value;
  }).catch(error => {
    if (cached?.value !== undefined) providerRequestCache.set(key, cached);
    else providerRequestCache.delete(key);
    throw error;
  });
  providerRequestCache.set(key, { value: cached?.value, fetchedAt: cached?.fetchedAt || 0, sizeBytes: cached?.sizeBytes || 0, inFlight });
  return inFlight;
}
function commaList(value) {
  return clean(value, 4000).split(',').map(item => item.trim()).filter(Boolean);
}
async function allSettledWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

function sharpSelectionLabel(row, type) {
  const side = clean(row.selection_type || row.team_side).toLowerCase();
  if (type === '1X2' || type === 'DRAW_NO_BET') {
    if (side === 'home') return 'Home';
    if (side === 'away') return 'Away';
    if (side === 'draw') return 'Draw';
  }
  if (type === 'DOUBLE_CHANCE') {
    if (/home.*draw|1x/.test(side)) return 'Home / Draw';
    if (/away.*draw|x2/.test(side)) return 'Draw / Away';
    if (/home.*away|12/.test(side)) return 'Home / Away';
  }
  if (type === 'BTTS') {
    if (/yes|y$/.test(side)) return 'Yes';
    if (/no|n$/.test(side)) return 'No';
  }
  if (type === 'TOTALS' || type === 'TEAM_TOTAL' || type === 'PLAYER_PROP') {
    if (side.includes('over')) return clean(row.selection || row.player_name || 'Over', 120);
    if (side.includes('under')) return clean(row.selection || row.player_name || 'Under', 120);
  }
  if (type === 'HANDICAP') {
    if (side === 'home') return 'Home';
    if (side === 'away') return 'Away';
  }
  return clean(row.selection || row.player_name || row.selection_type || 'Selection', 120);
}
// SharpAPI can reuse the same event_id/event_uuid for different fixtures in the
// observed feed. A provider ID alone is therefore not a safe event identity.
// Include normalized participants, kickoff, and league so distinct matches are
// never merged just because their provider IDs collide.
function sharpEventKey(row) {
  const providerId = clean(row?.event_uuid || row?.event_id, 180);
  if (!providerId) return '';
  const home = teamKey(row?.home_team);
  const away = teamKey(row?.away_team);
  // Provider timestamps can differ by a few minutes for the same fixture, and
  // sportsbooks may report slightly different kickoff times. Bucket by date so
  // those rows still merge, while distinct fixtures on different days remain
  // separate. Provider IDs are usually date-scoped; if an ID is reused across
  // days, the date bucket prevents an incorrect cross-day merge.
  const kickoffDate = iso(row?.event_start_time)?.slice(0, 10) || clean(row?.event_start_time, 80).slice(0, 10);
  const league = leagueKey(row?.league_ref?.label || row?.league || '');
  return `${providerId}|${home}|${away}|${kickoffDate}|${league}`;
}
function sharpDerivedMarketType(row) {
  const rawType = clean(row.market_type, 120).toLowerCase();
  const rawLabel = clean(row.market_ref?.label || row.market_name || row.market_type, 120);
  if (rawType === '1st_half' || rawType === 'first_half') {
    const side = clean(row.selection_type || row.team_side, 40).toLowerCase();
    const line = number(row.line);
    if (side.includes('over') || side.includes('under')) return 'TOTALS';
    if (line !== null && (side === 'home' || side === 'away')) return 'HANDICAP';
    if (['home', 'away', 'draw'].includes(side)) return '1X2';
  }
  return marketType(rawLabel, rawType);
}
function sharpCanonicalLine(row, type) {
  const value = number(row.line);
  if (value === null) return null;
  if (type === 'HANDICAP') return Math.abs(value);
  if (type === 'TOTALS' || type === 'TEAM_TOTAL') return value;
  return null;
}
function sharpMarketGroupKey(row) {
  const rawType = clean(row.market_type, 120).toLowerCase();
  const period = periodFromName(row.market_segment || rawType, rawType);
  const type = sharpDerivedMarketType(row);
  const line = sharpCanonicalLine(row, type);
  const teamTarget = type === 'TEAM_TOTAL' ? clean(row.team_side || row.team || row.selection_team || '', 80).toLowerCase() : '';
  return `${rawType}|${type}|${period}|${line ?? ''}|${teamTarget}`;
}
function chooseSharpSportsbook(rows) {
  const requested = clean(config.sharpApiSportsbook, 120).toLowerCase();
  if (requested) return rows.some(row => clean(row.sportsbook).toLowerCase() === requested) ? requested : null;
  const scores = new Map();
  for (const row of rows) {
    const book = clean(row.sportsbook, 120).toLowerCase();
    if (!book) continue;
    const current = scores.get(book) || { active: 0, groups: new Set(), rows: 0 };
    current.rows += 1;
    if (row.is_active !== false && row.is_stale_pregame_price !== true) current.active += 1;
    current.groups.add(sharpMarketGroupKey(row));
    scores.set(book, current);
  }
  // Prefer Asian books when they are actually present, with SBOBET first. Coverage still
  // wins if a preferred book is absent; no provider is fabricated.
  for (const preferred of commaList(config.sharpApiPreferredSportsbooks)) {
    const key = preferred.toLowerCase();
    const direct = [...scores.keys()].find(book => book === key || book.replace(/[^a-z0-9]/g, '').includes(key.replace(/[^a-z0-9]/g, '')));
    if (direct && scores.get(direct)?.groups?.size >= 1) return direct;
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].groups.size - a[1].groups.size || b[1].active - a[1].active || b[1].rows - a[1].rows || a[0].localeCompare(b[0]))
    [0]?.[0] || null;
}
function normalizeSharpApiRows(rows = []) {
  const diagnostics = {
    inputRows: Array.isArray(rows) ? rows.length : 0,
    droppedBySport: 0,
    droppedByAlternateLine: 0,
    droppedByRequiredFields: 0,
    groupedEventKeys: 0,
    eventsDroppedNoSportsbook: 0,
    eventsDroppedNoSelectedRows: 0,
    eventsDroppedNoValidMarkets: 0,
    marketGroupsTotal: 0,
    marketGroupsDroppedInsufficientSelections: 0,
    marketGroupsDroppedIncomplete1x2: 0,
    invalidSelections: 0,
    marketGroupsAccepted: 0
  };
  const byEvent = new Map();
  for (const row of rows) {
    if (!row || clean(row.sport).toLowerCase() !== clean(config.sharpApiSport).toLowerCase()) {
      if (row) diagnostics.droppedBySport += 1;
      else diagnostics.droppedByRequiredFields += 1;
      continue;
    }
    if (config.sharpApiMainLinesOnly && row.is_main_line === false && row.is_alternate_line === true) {
      diagnostics.droppedByAlternateLine += 1;
      continue;
    }
    const key = sharpEventKey(row);
    if (!key || !row.home_team || !row.away_team || !row.event_start_time) {
      diagnostics.droppedByRequiredFields += 1;
      continue;
    }
    const current = byEvent.get(key) || [];
    current.push(row);
    byEvent.set(key, current);
  }
  diagnostics.groupedEventKeys = byEvent.size;
  const identitySampleLimit = 15;
  const identityVariantLimit = 3;
  const identityKeys = [...byEvent.keys()].sort();
  const eventIdentitySample = [];
  for (const key of identityKeys.slice(0, identitySampleLimit)) {
    const rowsForKey = byEvent.get(key) || [];
    const identityVariants = new Set();
    for (const row of rowsForKey) {
      identityVariants.add(JSON.stringify({
        homeTeamHash: hash('sharp-home-team', clean(row?.home_team, 120)),
        awayTeamHash: hash('sharp-away-team', clean(row?.away_team, 120)),
        kickoff: clean(row?.event_start_time, 80),
        leagueHash: hash('sharp-league', clean(row?.league_ref?.label || row?.league || '', 120))
      }));
    }
    const variants = [...identityVariants]
      .slice(0, identityVariantLimit)
      .map(value => {
        try { return JSON.parse(value); } catch { return { parseError: true }; }
      });
    eventIdentitySample.push({
      keyHash: hash('sharp-event-key', key),
      rowCount: rowsForKey.length,
      sportsbookCount: new Set(rowsForKey.map(row => clean(row?.sportsbook, 120).toLowerCase()).filter(Boolean)).size,
      identityVariantCount: identityVariants.size,
      identityConflict: identityVariants.size > 1,
      identityVariantsTruncated: identityVariants.size > identityVariantLimit,
      identityVariants: variants
    });
  }
  logger.info('SharpAPI event identity sample', {
    provider: 'sharpapi',
    distinctEventKeyCount: identityKeys.length,
    sampleLimited: identityKeys.length > identitySampleLimit,
    sampledKeys: eventIdentitySample.length,
    eventIdentitySample
  });
  const events = [];
  for (const [providerId, eventRows] of byEvent) {
    const chosenBook = chooseSharpSportsbook(eventRows);
    if (!chosenBook) {
      diagnostics.eventsDroppedNoSportsbook += 1;
      continue;
    }
    const selectedRows = eventRows.filter(row => clean(row.sportsbook).toLowerCase() === chosenBook);
    if (!selectedRows.length) {
      diagnostics.eventsDroppedNoSelectedRows += 1;
      continue;
    }
    const first = selectedRows[0];
    const event = normalizedEvent({
      provider: 'sharpapi',
      providerId,
      sport: first.sport || 'soccer',
      league: first.league_ref?.label || first.league || 'Soccer',
      country: first.country_ref?.label || first.country || first.league_ref?.country || '',
      startTime: first.event_start_time,
      state: first.is_live ? 'LIVE' : 'SCHEDULED',
      home: first.home_team,
      away: first.away_team,
      homeLogo: first.home_team_logo || first.home_team_ref?.logo || first.home_team_ref?.badge || null,
      awayLogo: first.away_team_logo || first.away_team_ref?.logo || first.away_team_ref?.badge || null,
      leagueLogo: first.league_logo || first.league_ref?.logo || null
    });
    const marketRows = new Map();
    for (const row of selectedRows) {
      const key = sharpMarketGroupKey(row);
      const current = marketRows.get(key) || [];
      current.push(row);
      marketRows.set(key, current);
    }
    event.markets = [...marketRows.values()].map(group => {
      diagnostics.marketGroupsTotal += 1;
      const sample = group[0];
      const rawName = clean(sample.market_ref?.label || sample.market_name || sample.market_type, 120);
      const type = sharpDerivedMarketType(sample);
      const period = periodFromName(sample.market_segment || sample.market_type, sample.market_type);
      const line = sharpCanonicalLine(sample, type);
      const marketKey = `${sample.market_type}:${type}:${period}:${line ?? ''}:${chosenBook}`;
      const rawSelections = group.map(row => normalizedSelection(
        event.id,
        marketKey,
        sharpSelectionLabel(row, type),
        row.odds_decimal,
        {
          line: row.line ?? line,
          source: 'sharpapi',
          sourceSelectionId: row.selection_id || row.id || row.selection,
          suspended: row.is_active === false || row.is_stale_pregame_price === true,
          updatedAt: row.timestamp
        }
      ));
      const invalidSelectionCount = rawSelections.filter(selection => !selection).length;
      diagnostics.invalidSelections += invalidSelectionCount;
      const selections = rawSelections.filter(Boolean);
      const sideSet = new Set(group.map(row => clean(row.selection_type || row.team_side, 40).toLowerCase()));
      const minimumSelections = ['1X2', 'DOUBLE_CHANCE'].includes(type) ? 3 : ['HANDICAP', 'TOTALS', 'TEAM_TOTAL', 'BTTS', 'DRAW_NO_BET', 'ODD_EVEN', 'PLAYER_PROP'].includes(type) ? 2 : 1;
      if (selections.length < minimumSelections) {
        diagnostics.marketGroupsDroppedInsufficientSelections += 1;
        return null;
      }
      if (type === '1X2' && !['home', 'draw', 'away'].every(side => sideSet.has(side))) {
        diagnostics.marketGroupsDroppedIncomplete1x2 += 1;
        return null;
      }
      diagnostics.marketGroupsAccepted += 1;
      const latest = group.map(row => iso(row.timestamp)).filter(Boolean).sort().at(-1) || null;
      return normalizedMarket(event.id, {
        key: marketKey,
        name: marketLabel(type, rawName || sample.market_type, sample.market_type),
        type,
        period,
        line,
        selections,
        source: 'sharpapi',
        sourceMarketId: sample.market_id || sample.market_ref?.id || null,
        bookmaker: chosenBook,
        suspended: selections.some(selection => selection.suspended),
        updatedAt: latest,
        mainLine: group.some(row => row.is_main_line !== false && row.is_alternate_line !== true)
      });
    }).filter(Boolean);
    event._refs.sharpapiSportsbook = chosenBook;
    if (event.markets.length) events.push(event);
    else diagnostics.eventsDroppedNoValidMarkets += 1;
  }
  const returnedEvents = events.length;
  diagnostics.returnedEvents = returnedEvents;
  logger.info('SharpAPI normalization completed', {
    provider: 'sharpapi',
    inputRows: diagnostics.inputRows,
    droppedBySport: diagnostics.droppedBySport,
    droppedByAlternateLine: diagnostics.droppedByAlternateLine,
    droppedByRequiredFields: diagnostics.droppedByRequiredFields,
    groupedEventKeys: diagnostics.groupedEventKeys,
    eventsDroppedNoSportsbook: diagnostics.eventsDroppedNoSportsbook,
    eventsDroppedNoSelectedRows: diagnostics.eventsDroppedNoSelectedRows,
    eventsDroppedNoValidMarkets: diagnostics.eventsDroppedNoValidMarkets,
    marketGroupsTotal: diagnostics.marketGroupsTotal,
    marketGroupsDroppedInsufficientSelections: diagnostics.marketGroupsDroppedInsufficientSelections,
    marketGroupsDroppedIncomplete1x2: diagnostics.marketGroupsDroppedIncomplete1x2,
    invalidSelections: diagnostics.invalidSelections,
    marketGroupsAccepted: diagnostics.marketGroupsAccepted,
    returnedEvents: diagnostics.returnedEvents
  });
  return events;
}
async function sharpApiOddsPage(offset = 0) {
  const url = new URL(`${config.sharpApiBaseUrl.replace(/\/$/, '')}/api/v1/odds`);
  url.searchParams.set('sport', config.sharpApiSport);
  if (config.sharpApiMarkets) url.searchParams.set('market', config.sharpApiMarkets);
  if (config.sharpApiSportsbook) url.searchParams.set('sportsbook', config.sharpApiSportsbook);
  url.searchParams.set('limit', String(config.sharpApiPageSize));
  if (Number.isFinite(offset) && offset > 0) url.searchParams.set('offset', String(offset));
  return requestJson(url, { headers: { 'X-API-Key': config.sharpApiKey }, label: 'SharpAPI' });
}
export async function fetchSharpApi() {
  if (!config.sharpApiEnabled || !config.sharpApiKey) return { provider: 'sharpapi', enabled: false, events: [] };
  const cacheKey = `sharpapi:${config.sharpApiSport}:${config.sharpApiMarkets}:${config.sharpApiSportsbook || '*'}:${config.sharpApiMainLinesOnly}`;
  const payload = await cachedRequest(cacheKey, config.sharpApiRefreshSeconds * 1000, async () => {
    const rows = [];
    let offset = 0;
    let pagesFetched = 0;
    const maxPages = Number.isFinite(config.sharpApiMaxPages) && config.sharpApiMaxPages > 0
      ? config.sharpApiMaxPages
      : Infinity;
    for (let page = 0; page < maxPages; page += 1) {
      const current = await sharpApiOddsPage(offset);
      pagesFetched += 1;
      const pageRows = Array.isArray(current?.data) ? current.data : [];
      rows.push(...pageRows);
      const pagination = current?.pagination || {};
      const nextOffset = pagination?.next_offset;
      if (!pagination?.has_more || nextOffset === null || nextOffset === undefined) break;
      const parsedOffset = Number(nextOffset);
      if (!Number.isFinite(parsedOffset) || parsedOffset <= offset) break;
      offset = parsedOffset;
    }
    return rows;
  });
  const events = normalizeSharpApiRows(payload);
  logger.info('SharpAPI fetch completed', {
    provider: 'sharpapi',
    rawRows: Array.isArray(payload) ? payload.length : 0,
    returnedEvents: events.length
  });
  return { provider: 'sharpapi', enabled: true, events, errors: [] };
}

function isHandicapOddsValid(selections, line) {
  // Untuk handicap 0 (pick'em), odds kedua tim harus seimbang (sekitar 1.70-2.10)
  // Jika terlalu tidak seimbang, return false (market akan dihapus)
  if (line === 0 || line === null || line === '') {
    const odds = selections.map(s => s.odds).filter(o => o > 1);
    if (odds.length >= 2) {
      const minOdds = Math.min(...odds);
      const maxOdds = Math.max(...odds);
      // Jika odds terendah < 1.50 atau ratio > 3x, data tidak valid (1X2 tercampur)
      if (minOdds < 1.50 || (maxOdds / minOdds) > 3) {
        return false;
      }
    }
  }
  return true;
}

const TOP_LEAGUE_TOKENS = [
  'premier league', 'epl', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
  'champions league', 'europa league', 'eredivisie', 'primeira liga',
  'major league soccer', ' mls', 'nba', 'wnba', 'nhl', 'nfl', 'mlb',
  'atp', 'wta', 'us open', 'wimbledon', 'roland garros', 'australian open'
];

function sportmonksStartTime(raw) {
  const timestamp = Number(raw?.starting_at_timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp * 1000).toISOString();
  return iso(raw?.starting_at);
}
function sportmonksRows(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== 'object') return [];
    current = current.data;
  }
  return Array.isArray(current) ? current : [];
}
function sportmonksRelation(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current)) return current[0] || null;
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, 'data')) return current;
    current = current.data;
  }
  return Array.isArray(current) ? current[0] || null : current;
}
function sportmonksBookmakerIdentity(row, rowIndex) {
  const relation = sportmonksRelation(row?.bookmaker);
  const id = clean(row?.bookmaker_id ?? relation?.id);
  const name = sportmonksText(relation?.name || row?.bookmaker_name);
  if (id) return { key: `id-${hash('sportmonks-bookmaker-id', id)}`, missing: false };
  if (name) return { key: `name-${hash('sportmonks-bookmaker-name', name)}`, missing: false };
  return { key: `row-${rowIndex}`, missing: true };
}
function sportmonksMarketType(description) {
  // 'Goal Line' is an over/under market in Sportmonks terms but the generic
  // classifier has no goal-line needle, so resolve it before falling through.
  if (/goal[_\s-]*line/.test(clean(description).toLowerCase())) return 'TOTALS';
  return marketType(description);
}
function sportmonksLine(type, row) {
  const handicap = row?.handicap === null || row?.handicap === undefined ? '' : String(row.handicap).trim();
  const total = row?.total === null || row?.total === undefined ? '' : String(row.total).trim();
  if (type === 'HANDICAP') return handicap || total || null;
  if (type === 'TOTALS') return total || null;
  if (type === 'CORNERS') {
    if (total) return total;
    const name = clean(row?.name, 20);
    return /^\d+(\.\d+)?$/.test(name) ? name : null;
  }
  return total || handicap || null;
}
function sportmonksLabel(type, row) {
  // Correct Score rows carry the readable scoreline in `name` while `label`
  // is only a home/draw/away index, so prefer the scoreline for that market.
  if (config.sportmonksPassthrough) return sportmonksText(row?.label ?? row?.name ?? '');
  if (type === 'CORRECT_SCORE') return sportmonksText(row?.name || row?.label || 'Selection');
  const raw = sportmonksText(row?.label || row?.name || 'Selection');
  if (type === '1X2' || type === 'HANDICAP' || type === 'CORNERS') {
    const lower = raw.toLowerCase();
    if (raw === '1' || lower === 'home') return 'Home';
    if (raw === '2' || lower === 'away') return 'Away';
    if (raw === 'X' || lower === 'draw' || lower === 'tie') return 'Draw';
  }
  return raw;
}
function sportmonksPeriodScores(scores) {
  const out = {};
  for (const entry of sportmonksRows(scores)) {
    const description = clean(entry?.description).toUpperCase();
    const score = entry?.score || {};
    if (!description) continue;
    if (description === 'CURRENT') out.CURRENT = { home: number(score.home), away: number(score.away) };
    else if (description === '1ST HALF') out['1H'] = { home: number(score.home), away: number(score.away) };
    else if (description === '2ND HALF') out['2H'] = { home: number(score.home), away: number(score.away) };
  }
  return out;
}

function recordSportmonksUnknownMarket(diagnostics, marketId, marketName) {
  if (!diagnostics) return;
  if (!(diagnostics.unknownMarkets instanceof Map)) diagnostics.unknownMarkets = new Map();
  const key = `${marketId || 'unknown'}|${marketName}`;
  const existing = diagnostics.unknownMarkets.get(key);
  if (existing) existing.count += 1;
  else diagnostics.unknownMarkets.set(key, {
    marketId: marketId || null,
    marketName,
    count: 1
  });
}

function sportmonksDiagnosticsSummary(diagnostics) {
  const unknownMarkets = [...(diagnostics.unknownMarkets?.values?.() || [])];
  return {
    fixturesFetched: diagnostics.rawFixtures || 0,
    fixturesAdvertiseOdds: diagnostics.fixturesAdvertiseOdds || 0,
    fixturesWithOddsRows: diagnostics.fixturesWithOddsRows || 0,
    oddsRowsFetched: diagnostics.oddsRowsFetched || 0,
    unparseableOddsRows: diagnostics.unparseableOddsRows || 0,
    bookmakerIdentityMissingRows: diagnostics.bookmakerIdentityMissingRows || 0,
    fixturesWithMarkets: diagnostics.fixturesWithMarkets || 0,
    normalizedEvents: diagnostics.normalizedEvents || 0,
    pagesFetched: diagnostics.pagesFetched || 0,
    skippedEvents: diagnostics.normalizedRejected + diagnostics.eventFailures,
    filteredFixtures: diagnostics.stateFiltered + diagnostics.pastKickoffFiltered,
    eventErrors: diagnostics.eventFailures,
    failedPages: diagnostics.pageFailures,
    pageBudgetExhausted: Boolean(diagnostics.pageBudgetExhausted),
    eventLimitOmittedEvents: diagnostics.eventLimitOmittedEvents || 0,
    responseByteLimitFailures: diagnostics.responseByteLimitFailures || 0,
    unknownMarketCount: unknownMarkets.length,
    ...(diagnostics.eventLimitOmittedEvents > 0
      ? { dataTruncated: true, envToIncrease: 'SPORTMONKS_MAX_TOTAL_EVENTS' }
      : {}),
    unknownMarkets
  };
}

function logSportmonksUnknownMarkets(diagnostics) {
  const unknownMarkets = [...(diagnostics.unknownMarkets?.values?.() || [])];
  if (unknownMarkets.length) {
    logger.warn('Sportmonks unknown markets retained as OTHER', {
      provider: 'sportmonks',
      unknownMarketCount: unknownMarkets.length,
      unknownMarkets
    });
  }
}

function sportmonksState(raw) {
  const value = typeof raw === 'string' ? raw : raw?.short_name || raw?.name || '';
  const lower = String(value).toLowerCase();
  if (lower.includes('2nd') || lower.includes('second') || lower === '2h') return 'LIVE';
  if (lower.includes('1st') || lower.includes('first') || lower === '1h') return 'LIVE';
  if (lower.includes('live') || lower.includes('inplay') || lower.includes('ht') || lower.includes('half')) return 'LIVE';
  if (lower.includes('finished') || lower.includes('ft') || lower.includes('ended') || lower.includes('after')) return 'FINISHED';
  if (lower.includes('postpon') || lower.includes('suspend') || lower.includes('cancel') || lower.includes('abandon') || lower.includes('void')) return 'SUSPENDED';
  if (lower.includes('not') || lower.includes('ns') || lower.includes('sched')) return 'SCHEDULED';
  if (lower === 'in progress' || lower === 'inprogress') return 'LIVE';
  return 'SCHEDULED';
}
function normalizeSportmonksFixture(raw, oddsRows = raw?.odds, diagnostics = null) {
  const participants = sportmonksRows(raw?.participants);
  const home = participants.find(participant => participant?.meta?.location === 'home') || participants[0];
  const away = participants.find(participant => participant?.meta?.location === 'away') || participants[1];
  if (!home?.name || !away?.name) return null;
  const byMarket = new Map();
  for (const [rowIndex, row] of sportmonksRows(oddsRows).entries()) {
    const marketId = clean(row?.market_id);
    const market = sportmonksRelation(row?.market);
    const marketName = sportmonksText(row?.market_description || market?.name || market?.label || row?.name);
    const bookmakerIdentity = sportmonksBookmakerIdentity(row, rowIndex);
    if (bookmakerIdentity.missing && diagnostics) {
      diagnostics.bookmakerIdentityMissingRows = (diagnostics.bookmakerIdentityMissingRows || 0) + 1;
    }
    const identity = marketId
      ? `id:${marketId}:bookmaker:${bookmakerIdentity.key}`
      : marketName
        ? `name:${slug(marketName)}:${hash('sportmonks-market-name', marketName)}:bookmaker:${bookmakerIdentity.key}`
        : '';
    if (!identity) continue;
    const group = byMarket.get(identity) || { rows: [], bookmakerKey: bookmakerIdentity.key };
    group.rows.push(row);
    byMarket.set(identity, group);
  }
  const state = sportmonksRelation(raw?.state);
  const league = sportmonksRelation(raw?.league);
  const country = sportmonksRelation(league?.country);
  const current = sportmonksRows(raw?.scores).find(entry => clean(entry?.description).toUpperCase() === 'CURRENT')?.score || {};
  const event = normalizedEvent({
    provider: 'sportmonks',
    providerId: String(raw?.id ?? ''),
    sport: 'Football',
    league: league?.name,
    country: country?.name,
    startTime: sportmonksStartTime(raw),
    state: sportmonksState(state),
    providerStatus: state?.name || state?.short_name || null,
    home: home.name,
    away: away.name,
    homeScore: current.home,
    awayScore: current.away,
    homeLogo: home.image_path || null,
    awayLogo: away.image_path || null,
    leagueLogo: raw?.league?.image_path || null,
    venue: sportmonksRelation(raw?.venue)?.name || null,
    periodScores: sportmonksPeriodScores(raw?.scores)
  });
  event.markets = [...byMarket.values()]
    .map(({ rows, bookmakerKey }) => sportmonksMarket(event, rows, diagnostics, bookmakerKey))
    .filter(Boolean);
  event.statistics = sportmonksRows(raw?.statistics);
  event.events = sportmonksRows(raw?.events);
  if (!Array.isArray(event._settlementReadySources) || event._settlementReadySources.length === 0) {
    event._settlementReadySources = [event.provider];
  }
  if (!Array.isArray(event._sources)) event._sources = [event.provider];

  return event;
}
function sportmonksMarket(event, rows, diagnostics = null, bookmakerIdentityKey = null) {
  const sample = rows[0] || {};
  const providerMarketId = clean(sample.market_id);
  const marketRelation = sportmonksRelation(sample.market);
  const bookmakerRelation = sportmonksRelation(sample.bookmaker);
  const rawDescription = sportmonksText(sample.market_description || marketRelation?.name || marketRelation?.label || sample.name || (providerMarketId ? `Market ${providerMarketId}` : ''));
  const description = config.sportmonksPassthrough ? rawDescription : clean(rawDescription, 120);
  if (!description) return null;
  const type = sportmonksMarketType(description);
  const bookmakerId = clean(sample.bookmaker_id ?? bookmakerRelation?.id);
  const rawBookmaker = sportmonksText(bookmakerRelation?.name || sample.bookmaker_name || bookmakerId);
  const bookmaker = (config.sportmonksPassthrough ? rawBookmaker : clean(rawBookmaker, 120)) || null;
  if (type === 'OTHER') recordSportmonksUnknownMarket(diagnostics, providerMarketId, description);
  const period = periodFromName(description, `m${sample.market_id ?? ''}`);
  const bookmakerKey = bookmakerIdentityKey
    || (bookmakerId ? `id-${hash('sportmonks-bookmaker-id', bookmakerId)}` : `name-${hash('sportmonks-bookmaker-name', bookmaker || '')}`);
  const marketKey = providerMarketId
    ? `m${providerMarketId}:b${bookmakerKey}`
    : `name:${slug(description)}:b${bookmakerKey}`;
  const grouped = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    const line = sportmonksLine(type, row);
    const label = config.sportmonksPassthrough
      ? sportmonksText(sportmonksLabel(type, row))
      : clean(sportmonksLabel(type, row), 120);
    if (!config.sportmonksPassthrough) {
      const selection = normalizedSelection(event.id, `${marketKey}:${line ?? ''}`, label, row?.value, {
        line,
        source: 'sportmonks',
        sourceSelectionId: String(row?.id ?? `${providerMarketId || marketKey}:${label}`),
        suspended: Boolean(row?.stopped || row?.suspended || row?.active === false || /suspend|closed|inactive/i.test(clean(row?.status))),
        updatedAt: row?.latest_bookmaker_update || null
      });
      if (!selection) continue;
      const key = `${slug(label)}|${line ?? ''}`;
      const previous = grouped.get(key);
      if (!previous || selection.odds < previous.odds) grouped.set(key, selection);
      continue;
    }
    const odds = number(row?.value);
    if (odds === null) {
      if (diagnostics) diagnostics.unparseableOddsRows = (diagnostics.unparseableOddsRows || 0) + 1;
      continue;
    }
    const sourceSelectionId = String(row?.id ?? `${providerMarketId || marketKey}:${rowIndex}`);
    const resolvedLine = line === null || line === '' ? null : number(line) ?? sportmonksText(line);
    grouped.set(`${sourceSelectionId}:${rowIndex}`, {
      key: selectionId(event.id, `${marketKey}:${rowIndex}`, label, resolvedLine),
      label,
      odds,
      line: resolvedLine,
      suspended: Boolean(row?.stopped || row?.suspended || row?.active === false || /suspend|closed|inactive/i.test(clean(row?.status))),
      source: 'sportmonks',
      sourceSelectionId,
      updatedAt: iso(row?.latest_bookmaker_update),
      priceVersion: hash('price', event.id, marketKey, sourceSelectionId, resolvedLine ?? '', odds)
    });
  }
  const selections = [...grouped.values()];
  if (!selections.length && !config.sportmonksPassthrough) return null;
  const updatedAt = rows.reduce((latest, row) => {
    const at = iso(row?.latest_bookmaker_update);
    return at && (!latest || at > latest) ? at : latest;
  }, null);
  return normalizedMarket(event.id, {
    key: marketKey,
    name: type === 'OTHER' ? description : marketLabel(type, description, `m${sample.market_id}`),
    type,
    period,
    selections,
    source: 'sportmonks',
    sourceMarketId: providerMarketId ? `m${providerMarketId}` : null,
    bookmaker,
    suspended: selections.every(selection => selection.suspended),
    updatedAt
  });
}

// Cache Sportmonks odds for the provider-configured refresh interval.
const sportmonksCache = new Map();
const sportmonksRetryState = new Map();
const sportmonksLiveCache = new Map();
const sportmonksLiveRetryState = new Map();
let sportmonksLiveInFlight = null;
let sportmonksNextRequestAt = 0;
function sportmonksCacheTtlMs() {
  const configuredRefreshSeconds = [
    Number(config.sportmonksRefreshSeconds) || 300,
    Number(config.sportmonksOddsRefreshSeconds) || 180
  ];
  return Math.max(60, Math.min(...configuredRefreshSeconds)) * 1000;
}
async function waitForSportmonksRequestSlot() {
  const configuredDelayMs = Number(config.sportmonksRequestDelayMs || 0);
  const delayMs = configuredDelayMs > 0 ? configuredDelayMs : 250;
  if (delayMs <= 0) return;
  const now = Date.now();
  const scheduledAt = Math.max(now, sportmonksNextRequestAt);
  sportmonksNextRequestAt = scheduledAt + delayMs;
  if (scheduledAt > now) await new Promise(resolve => setTimeout(resolve, scheduledAt - now));
}

function sportmonksRetryAfterMs(error) {
  const retryAfter = error?.retryAfter;
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

// Read one small page at a time so raw odds payloads are not retained across pages.
async function fetchSportmonksPage(base, date, page) {
  const url = new URL(`${base}/football/fixtures/date/${date}`);
  url.searchParams.set('api_token', config.sportmonksKey);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(SPORTMONKS_PAGE_SIZE));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('include', SPORTMONKS_FIXTURE_INCLUDES);

  const maxAttempts = 4;
  let attempt = 0;
  while (true) {
    await waitForSportmonksRequestSlot();
    try {
      const payload = await requestJson(url, {
        label: config.sportmonksPassthrough
          ? `Sportmonks ${date} page ${page} (increase SPORTMONKS_MAX_RESPONSE_BYTES if needed)`
          : `Sportmonks ${date} page ${page}`,
        maxBytes: config.sportmonksMaxResponseBytes
      });
      if (!Array.isArray(payload?.data)) {
        const detail = clean(payload?.message || payload?.error?.message, 200);
        const error = new Error(`Sportmonks fixtures response for ${date} page ${page} is invalid${detail ? `: ${detail}` : '.'}`);
        error.status = 400;
        throw error;
      }
      const data = payload.data;
      const hasMore = typeof payload?.pagination?.has_more === 'boolean'
        ? payload.pagination.has_more
        : data.length >= SPORTMONKS_PAGE_SIZE;
      // Detect Sportmonks no-access warning message
      let warning = null;
      if (payload.message && typeof payload.message === 'string' && /no result|don't have access|subscription/i.test(payload.message)) {
        warning = payload.message;
      }
      return { data, hasMore, warning };
    } catch (error) {
      attempt += 1;
      const status = Number(error?.status);
      const retryable = status === 429 || status >= 500 || !Number.isFinite(status);
      if (!retryable || attempt >= maxAttempts) throw error;
      let retryAfterMs = 0;
      const retryAfter = error?.retryAfter;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
        else {
          const dateMs = Date.parse(retryAfter);
          if (Number.isFinite(dateMs)) retryAfterMs = Math.max(0, dateMs - Date.now());
        }
      }
      const backoffMs = retryAfterMs > 0 ? retryAfterMs : Math.min(8000, 1000 * Math.pow(2, attempt - 1));
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

async function fetchSportmonksLiveWindow(base) {
  const cacheKey = `sportmonks:live-window:${base}`;
  const now = Date.now();
  const ttlMs = Math.max(15, Number(config.sportmonksLiveRefreshSeconds) || 30) * 1000;
  const cached = sportmonksLiveCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < ttlMs) return { ...cached, failed: false, errors: [] };
  const retryState = sportmonksLiveRetryState.get(cacheKey);
  if (retryState && now < retryState.retryAt) {
    return { events: [], fetchedAt: cached?.fetchedAt || null, failed: true, errors: [retryState.message] };
  }
  if (sportmonksLiveInFlight) return sportmonksLiveInFlight;

  sportmonksLiveInFlight = (async () => {
    const url = new URL(`${base}/football/livescores`);
    url.searchParams.set('api_token', config.sportmonksKey);
    url.searchParams.set('include', SPORTMONKS_LIVE_INCLUDES);
    let responseError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitForSportmonksRequestSlot();
      try {
        const payload = await requestJson(url, {
          label: config.sportmonksPassthrough
            ? 'Sportmonks livescores (increase SPORTMONKS_MAX_RESPONSE_BYTES if needed)'
            : 'Sportmonks livescores',
          maxBytes: config.sportmonksMaxResponseBytes
        });
        if (!Array.isArray(payload?.data)) {
          throw new Error('Sportmonks livescores returned an invalid data array.');
        }
        const diagnostics = { unknownMarkets: new Map(), eventFailures: 0 };
        const events = [];
        const errors = [];
        for (const fixture of payload.data) {
          try {
            const event = normalizeSportmonksFixture(fixture, fixture?.inplayOdds || [], diagnostics);
            if (event) events.push(event);
            else diagnostics.eventFailures += 1;
          } catch (error) {
            diagnostics.eventFailures += 1;
            errors.push(`Fixture ${fixture?.id ?? 'unknown'}: ${error.message}`);
          }
        }
        logSportmonksUnknownMarkets(diagnostics);
        const fetchedAt = Date.now();
        const result = { events, fetchedAt };
        sportmonksLiveCache.set(cacheKey, result);
        sportmonksLiveRetryState.delete(cacheKey);
        logger.info('Sportmonks live window refreshed', {
          provider: 'sportmonks',
          fixtures: payload.data.length,
          normalizedEvents: events.length,
          bookmakerIdentityMissingRows: diagnostics.bookmakerIdentityMissingRows || 0,
          skippedEvents: diagnostics.eventFailures,
          eventErrors: errors.length,
          inplayMarkets: events.reduce((total, event) => total + event.markets.length, 0),
          durationMs: fetchedAt - now
        });
        return { ...result, failed: false, errors };
      } catch (error) {
        responseError = error;
        const status = Number(error?.status);
        const retryable = status === 408 || status === 429 || status >= 500 || !Number.isFinite(status);
        if (!retryable || attempt >= 3) break;
        const retryDelayMs = Math.max(
          sportmonksRetryAfterMs(error),
          Math.min(8000, 1000 * (2 ** (attempt - 1)))
        );
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    const failures = (retryState?.attempts || 0) + 1;
    const status = Number(responseError?.status);
    const permanentClientError = Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const backoffMs = permanentClientError
      ? 15 * 60_000
      : Math.min(15 * 60_000, 30_000 * (2 ** Math.min(failures - 1, 5)));
    const retryAt = Date.now() + Math.max(backoffMs, sportmonksRetryAfterMs(responseError));
    const message = responseError?.message || 'Sportmonks livescores request failed.';
    sportmonksLiveRetryState.set(cacheKey, { attempts: failures, retryAt, message });
    logger.warn('Sportmonks live window unavailable; live markets will fail closed', {
      provider: 'sportmonks',
      status: Number.isFinite(status) ? status : null,
      retryInMs: retryAt - Date.now(),
      cachedWindowAgeMs: cached ? Date.now() - cached.fetchedAt : null
    });
    return { events: [], fetchedAt: cached?.fetchedAt || null, failed: true, errors: [message] };
  })();

  try {
    return await sportmonksLiveInFlight;
  } finally {
    sportmonksLiveInFlight = null;
  }
}

function suspendSportmonksLiveMarkets(events) {
  return events.map(event => {
    if (!event.live || !event.markets?.length) return event;
    return {
      ...event,
      markets: event.markets.map(market => ({
        ...market,
        suspended: true,
        selections: market.selections.map(selection => ({ ...selection, suspended: true }))
      }))
    };
  });
}

function mergeSportmonksLiveWindow(events, liveEvents, priorityLeagues) {
  const identity = event => String(event?._refs?.sportmonks || event?.id || '');
  const updates = new Map(liveEvents.map(event => [identity(event), event]));
  const merged = [];
  for (const event of events) {
    const key = identity(event);
    const update = updates.get(key);
    if (event.live && !update) continue;
    if (!update) {
      merged.push(event);
      continue;
    }
    updates.delete(key);
    const keepPrematchMarkets = update.status === 'SCHEDULED' && !update.markets.length;
    merged.push({
      ...event,
      ...update,
      id: event.id,
      markets: keepPrematchMarkets ? event.markets : update.markets,
      _refs: { ...event._refs, ...update._refs },
      _sources: [...new Set([...(event._sources || []), ...(update._sources || [])])]
    });
  }
  merged.push(...updates.values());
  return merged
    .map(event => ({
      event,
      leaguePriority: sportmonksLeaguePriority(event, priorityLeagues),
      startTime: Date.parse(event.startTime) || Number.MAX_SAFE_INTEGER
    }))
    .sort(compareSportmonksEvents)
    .map(candidate => candidate.event);
}

async function applySportmonksLiveWindow(events, base, priorityLeagues) {
  const liveWindow = await fetchSportmonksLiveWindow(base);
  const updatedEvents = liveWindow.failed
    ? suspendSportmonksLiveMarkets(events)
    : mergeSportmonksLiveWindow(events, liveWindow.events, priorityLeagues);
  return { events: updatedEvents, liveWindow };
}

function sportmonksLeaguePriority(event, configuredLeagues) {
  const league = clean(event?.league, 120).toLowerCase();
  const index = configuredLeagues.findIndex(name => league === name || league.includes(name));
  return index < 0 ? configuredLeagues.length : index;
}

function compareSportmonksEvents(a, b) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  // When an operator configures a finite event budget, prioritize fixtures
  // with markets while retaining display-only fixtures when capacity allows.
  const aPriced = a.event.markets?.length ? 1 : 0;
  const bPriced = b.event.markets?.length ? 1 : 0;
  if (aPriced !== bPriced) return bPriced - aPriced;
  if (a.leaguePriority !== b.leaguePriority) return a.leaguePriority - b.leaguePriority;
  return a.startTime - b.startTime || a.event.id.localeCompare(b.event.id);
}

export async function fetchSportmonks({
  maxEvents = 0,
  maxPages = 0
} = {}) {
  if (!config.sportmonksEnabled || !config.sportmonksKey) {
    logger.warn('Sportmonks disabled or missing API key');
    return { provider: 'sportmonks', enabled: false, events: [] };
  }
  
  const base = config.sportmonksBaseUrl.replace(/\/$/, '');
  const now = Date.now();
  const cacheKey = `sportmonks:all-events:${utcDate(0)}:${config.sportmonksDaysAhead}`;
  const priorityLeagues = String(config.sportmonksPriorityLeagues || '')
    .split(',')
    .map(name => clean(name, 120).toLowerCase())
    .filter(Boolean);
  const configuredPriorityLeagues = priorityLeagues.length ? priorityLeagues : DEFAULT_SPORTMONKS_PRIORITY_LEAGUES;

  // Cek cache terlebih dahulu
  const cached = sportmonksCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < sportmonksCacheTtlMs()) {
    const { events, liveWindow } = await applySportmonksLiveWindow(
      cached?.events || [],
      base,
      configuredPriorityLeagues
    );
    logger.info('Sportmonks: returning cached fixture catalog', {
      age: Math.round((now - cached.fetchedAt) / 1000) + 's',
      events: events.length,
      liveWindowFailed: liveWindow.failed
    });
    return { provider: 'sportmonks', enabled: true, events, transportOk: true, errors: liveWindow.errors, warnings: undefined, diagnostics: { pagesFetched: 0, pageFailures: 0, responseByteLimitFailures: 0, dataTruncated: false, envToIncrease: null, rawFixtures: events.length, returnedEvents: events.length } };
  }

  // Check retry state cooldown
  const retryState = sportmonksRetryState.get(cacheKey);
  if (retryState && now < retryState.retryAt) {
    const { events, liveWindow } = await applySportmonksLiveWindow(
      cached?.events || [],
      base,
      configuredPriorityLeagues
    );
    return {
      provider: 'sportmonks',
      enabled: true,
      events,
      stale: true,
      transportOk: false,
      errors: [retryState.message, ...liveWindow.errors],
      warnings: undefined,
      diagnostics: { pagesFetched: 0, pageFailures: 0, responseByteLimitFailures: 0, dataTruncated: false, envToIncrease: null, rawFixtures: events.length, returnedEvents: events.length }
    };
  }
  
  const daysAhead = Math.max(0, Number(config.sportmonksDaysAhead) || 0);
  const dates = [];
  for (let offset = 0; offset <= daysAhead; offset += 1) dates.push(utcDate(offset));
  
  const errors = [];
  const warnings = [];
  let hadPayloadError = false;
  let firstPageWarningLogged = false;
  const rankedEvents = [];
  const seen = new Set();
  const diagnostics = {
    rawFixtures: 0,
    duplicateFixtures: 0,
    stateFiltered: 0,
    pastKickoffFiltered: 0,
    normalizedRejected: 0,
    normalizedEvents: 0,
    fixturesAdvertiseOdds: 0,
    fixturesWithOddsRows: 0,
    oddsRowsFetched: 0,
    unparseableOddsRows: 0,
    bookmakerIdentityMissingRows: 0,
    fixturesWithMarkets: 0,
    candidateDiscarded: 0,
    eventLimitOmittedEvents: 0,
    pageFailures: 0,
    responseByteLimitFailures: 0,
    eventFailures: 0,
    unknownMarkets: new Map(),
    pageBudgetExhausted: false
  };
  let providerRetryAfterMs = 0;
  const cursors = dates.map(date => ({ date, page: 1, exhausted: false }));
  let pagesFetched = 0;
  let permanentPageFailure = false;
  while (
    cursors.some(cursor => !cursor.exhausted)
  ) {
    for (const cursor of cursors) {
      if (cursor.exhausted) continue;
      try {
        const { data, hasMore, warning } = await fetchSportmonksPage(base, cursor.date, cursor.page);
        if (warning && !firstPageWarningLogged) {
          warnings.push(warning);
          firstPageWarningLogged = true;
        }
        pagesFetched += 1;
        cursor.page += 1;
        cursor.exhausted = !hasMore;
        for (const fixture of data) {
          diagnostics.rawFixtures += 1;
          const id = String(fixture?.id ?? '');
          if (!id || seen.has(id)) {
            if (id) diagnostics.duplicateFixtures += 1;
            continue;
          }
          seen.add(id);

          const oddsRows = sportmonksRows(fixture?.odds);
          if (fixture?.has_odds === true) diagnostics.fixturesAdvertiseOdds += 1;
          if (oddsRows.length) diagnostics.fixturesWithOddsRows += 1;
          diagnostics.oddsRowsFetched += oddsRows.length;
          const state = sportmonksState(fixture.state);
          if (!config.sportmonksPassthrough && state !== 'SCHEDULED' && state !== 'LIVE') {
            diagnostics.stateFiltered += 1;
            continue;
          }

          const start = Number(fixture.starting_at_timestamp) * 1000 || Date.parse(fixture.starting_at || '') || 0;
          if (!config.sportmonksPassthrough && start && start < now - 3 * 60 * 60 * 1000) {
            diagnostics.pastKickoffFiltered += 1;
            continue;
          }
          try {
            const event = normalizeSportmonksFixture(fixture, oddsRows, diagnostics);
            // Pertandingan aktif TANPA odds tetap ikut feed (display-only).
            // Filter lama (menandai fixture tanpa odds / tanpa pasar inti sebagai
            // skip) menyembunyikan ratusan pertandingan aktif dan menutup cakupan
            // di ~18 match; sekarang hanya fixture tanpa nama tim yang dibuang.
            // Event tanpa markets tetap valid di schema ingest (markets boleh
            // kosong) dan frontend menampilkan kartu "odds belum tersedia" —
            // taruhan tetap mustahil tanpa seleksi berharga.
            if (!event) {
              diagnostics.normalizedRejected += 1;
              continue;
            }
            const candidate = {
              event,
              leaguePriority: sportmonksLeaguePriority(event, configuredPriorityLeagues),
              startTime: start || Number.MAX_SAFE_INTEGER
            };
            diagnostics.normalizedEvents += 1;
            if (event.markets.length) diagnostics.fixturesWithMarkets += 1;
            rankedEvents.push(candidate);
            rankedEvents.sort(compareSportmonksEvents);
          } catch (error) {
            diagnostics.eventFailures += 1;
            errors.push(`Fixture ${fixture.id}: ${error.message}`);
          }
        }
      } catch (error) {
        // Kegagalan satu tanggal diisolasi: tanggal lain tetap discan.
        cursor.exhausted = true;
        diagnostics.pageFailures += 1;
        if (/SPORTMONKS_MAX_RESPONSE_BYTES/i.test(error?.message || '')) {
          diagnostics.responseByteLimitFailures += 1;
        }
        const status = Number(error?.status);
        if (error?.payloadErrors) {
          hadPayloadError = true;
          permanentPageFailure = true;
        } else if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          permanentPageFailure = true;
        }
        providerRetryAfterMs = Math.max(providerRetryAfterMs, sportmonksRetryAfterMs(error));
        errors.push(`Date ${cursor.date}: ${error.message}`);
      }
    }
  }
  diagnostics.pagesFetched = pagesFetched;
  const fixtureEvents = rankedEvents.map(candidate => candidate.event);
  
if (diagnostics.pageFailures > 0) {
    const attempts = (retryState?.attempts || 0) + 1;
    const backoffMs = permanentPageFailure
      ? 15 * 60_000
      : Math.min(15 * 60_000, 30_000 * (2 ** Math.min(attempts - 1, 5)));
    const retryAt = now + Math.max(backoffMs, providerRetryAfterMs);
    const message = errors[0] || 'Sportmonks pagination was incomplete.';
    sportmonksRetryState.set(cacheKey, { attempts, retryAt, message });
    logger.warn(config.sportmonksPassthrough
      ? 'Sportmonks partial refresh; retaining fetched and cached provider data'
      : 'Sportmonks partial refresh rejected; preserving last complete provider cache', {
      provider: 'sportmonks',
      pageFailures: diagnostics.pageFailures,
      pageBudgetExhausted: diagnostics.pageBudgetExhausted,
      bookmakerIdentityMissingRows: diagnostics.bookmakerIdentityMissingRows,
      skippedEvents: diagnostics.normalizedRejected + diagnostics.eventFailures,
      filteredFixtures: diagnostics.stateFiltered + diagnostics.pastKickoffFiltered,
      retryInMs: retryAt - now,
      retainedEvents: cached?.events.length || 0,
      partialEvents: fixtureEvents.length
    });
    logSportmonksUnknownMarkets(diagnostics);
    if (config.sportmonksPassthrough) {
      const byProviderId = new Map((cached?.events || []).map(event => [
        String(event?._refs?.sportmonks || event.id),
        event
      ]));
      for (const event of fixtureEvents) {
        byProviderId.set(String(event?._refs?.sportmonks || event.id), event);
      }
      const partialEvents = [...byProviderId.values()];
      const hasNewlyFetchedEvents = fixtureEvents.length > 0;
      const partialDiagnostics = {
        ...sportmonksDiagnosticsSummary(diagnostics),
        dataTruncated: true,
        unfetchedDateCursors: cursors.filter(cursor => !cursor.exhausted).length,
        responseByteLimitFailures: diagnostics.responseByteLimitFailures,
        unknownOmittedEventCount: diagnostics.responseByteLimitFailures > 0,
        envToIncrease: diagnostics.pageBudgetExhausted
          ? 'SPORTMONKS_MAX_PAGES'
          : diagnostics.responseByteLimitFailures > 0
            ? 'SPORTMONKS_MAX_RESPONSE_BYTES'
            : null
      };
      logger.warn('Sportmonks partial catalog retained in passthrough mode', {
        provider: 'sportmonks',
        ...partialDiagnostics
      });
      sportmonksCache.set(cacheKey, { fetchedAt: now, events: partialEvents });
      const { events, liveWindow } = await applySportmonksLiveWindow(
        partialEvents,
        base,
        configuredPriorityLeagues
      );
      return {
        provider: 'sportmonks',
        enabled: true,
        events,
        partial: true,
        ...(hasNewlyFetchedEvents
          ? { transportOk: true }
          : { stale: partialEvents.length > 0, transportOk: false }),
        errors: [...errors, ...liveWindow.errors],
        warnings: warnings.length ? warnings : undefined,
        diagnostics: { ...partialDiagnostics, liveWindowFailed: liveWindow.failed }
      };
    }
    const { events: currentEvents, liveWindow } = await applySportmonksLiveWindow(
      cached?.events || fixtureEvents,
      base,
      configuredPriorityLeagues
    );
    return {
      provider: 'sportmonks',
      enabled: true,
      events: currentEvents,
      stale: true,
      transportOk: false,
      errors: [...errors, ...liveWindow.errors],
      warnings: warnings.length ? warnings : undefined,
      diagnostics: sportmonksDiagnosticsSummary(diagnostics)
    };
  }

  // Replace provider cache with latest fetched data.
  sportmonksCache.set(cacheKey, { fetchedAt: now, events: fixtureEvents });
  sportmonksRetryState.delete(cacheKey);
  
  // Bounded cache: hapus entri lama jika terlalu banyak
  if (sportmonksCache.size > 1) {
    const oldest = [...sportmonksCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, sportmonksCache.size - 1)) {
      sportmonksCache.delete(key);
    }
  }
  for (const key of sportmonksRetryState.keys()) {
    if (key !== cacheKey) sportmonksRetryState.delete(key);
  }

  const { events, liveWindow } = await applySportmonksLiveWindow(
    fixtureEvents,
    base,
    configuredPriorityLeagues
  );
  logSportmonksUnknownMarkets(diagnostics);
  
  logger.info('Sportmonks fetch completed', {
    provider: 'sportmonks',
    rawFixtures: diagnostics.rawFixtures,
    fixturesAdvertiseOdds: diagnostics.fixturesAdvertiseOdds,
    fixturesWithOddsRows: diagnostics.fixturesWithOddsRows,
    oddsRowsFetched: diagnostics.oddsRowsFetched,
    unparseableOddsRows: diagnostics.unparseableOddsRows,
    bookmakerIdentityMissingRows: diagnostics.bookmakerIdentityMissingRows,
    fixturesWithMarkets: diagnostics.fixturesWithMarkets,
    duplicateFixtures: diagnostics.duplicateFixtures,
    stateFiltered: diagnostics.stateFiltered,
    pastKickoffFiltered: diagnostics.pastKickoffFiltered,
    normalizedRejected: diagnostics.normalizedRejected,
    eventFailures: diagnostics.eventFailures,
    normalizedEvents: diagnostics.normalizedEvents,
    candidateDiscarded: diagnostics.candidateDiscarded,
    rankedCandidates: rankedEvents.length,
    returnedEvents: events.length,
    liveWindowEvents: liveWindow.events.length,
    liveWindowFailed: liveWindow.failed,
    pagesFetched,
    dates: dates.length,
    paginationComplete: diagnostics.pageFailures === 0 && cursors.every(cursor => cursor.exhausted),
    pageFailures: diagnostics.pageFailures,
    responseByteLimitFailures: diagnostics.responseByteLimitFailures,
    dataTruncated: diagnostics.pageFailures > 0,
    envToIncrease: diagnostics.responseByteLimitFailures > 0
      ? 'SPORTMONKS_MAX_RESPONSE_BYTES'
      : null,
    skippedEvents: diagnostics.normalizedRejected + diagnostics.eventFailures,
    filteredFixtures: diagnostics.stateFiltered + diagnostics.pastKickoffFiltered,
    unknownMarketCount: diagnostics.unknownMarkets.size,
    retryCooldownActive: false,
    errors: errors.length,
    errorSample: errors.slice(0, 3)
  });
  return {
      provider: 'sportmonks',
      enabled: true,
      events,
      transportOk: !hadPayloadError,
      errors: [...errors, ...liveWindow.errors],
      warnings: warnings.length ? warnings : undefined,
      diagnostics: sportmonksDiagnosticsSummary(diagnostics)
    };
}

export async function fetchSportmonksFixtureById(fixtureId) {
  const id = String(fixtureId ?? '').trim();
  if (!id) throw new Error('Sportmonks fixture id is required.');
  if (!config.sportmonksEnabled || !config.sportmonksKey) {
    throw new Error('Sportmonks disabled or missing API key');
  }
  const base = config.sportmonksBaseUrl.replace(/\/$/, '');
  const url = new URL(`${base}/football/fixtures/${encodeURIComponent(id)}`);
  url.searchParams.set('api_token', config.sportmonksKey);
  url.searchParams.set('include', SPORTMONKS_FIXTURE_INCLUDES);
  const payload = await requestJson(url, {
    label: config.sportmonksPassthrough
      ? `Sportmonks fixture ${id} (increase SPORTMONKS_MAX_RESPONSE_BYTES if needed)`
      : `Sportmonks fixture ${id}`,
    maxBytes: config.sportmonksMaxResponseBytes
  });
  const raw = payload?.data || payload;
  if (!raw || !raw.id) throw new Error(`Sportmonks fixture ${id} not found.`);
  const diagnostics = { unknownMarkets: new Map() };
  const event = normalizeSportmonksFixture(raw, raw.odds || [], diagnostics);
  if (!event) throw new Error(`Sportmonks fixture ${id} could not be normalized.`);
  logSportmonksUnknownMarkets(diagnostics);
  return { provider: 'sportmonks', enabled: true, event, raw };
}

function normalizeSportsDbEvent(raw) {
  const score = clean(raw.intHomeScore) || clean(raw.intAwayScore) ? [raw.intHomeScore, raw.intAwayScore] : [null, null];
  const start = raw.strTimestamp || `${raw.dateEvent || ''}T${raw.strTime || '00:00:00'}Z`;
  return normalizedEvent({
    provider: 'thesportsdb',
    providerId: raw.idEvent,
    sport: raw.strSport,
    league: raw.strLeague,
    country: raw.strCountry,
    startTime: start,
    state: raw.strStatus || raw.strProgress || (raw.intHomeScore !== null && raw.intHomeScore !== '' ? 'FINISHED' : 'SCHEDULED'),
    clock: raw.strProgress,
    home: raw.strHomeTeam,
    away: raw.strAwayTeam,
    homeScore: score[0],
    awayScore: score[1],
    homeLogo: raw.strHomeTeamBadge,
    awayLogo: raw.strAwayTeamBadge,
    leagueLogo: raw.strLeagueBadge,
    venue: raw.strVenue
  });
}
export async function fetchTheSportsDb() {
  if (!config.theSportsDbEnabled || !config.theSportsDbKey) return { provider: 'thesportsdb', enabled: false, events: [] };
  const leagueIds = commaList(config.theSportsDbLeagueIds);
  const base = config.theSportsDbBaseUrl.replace(/\/$/, '');
  const settled = await Promise.allSettled(leagueIds.map(async leagueId => {
    const url = new URL(`${base}/v1/json/${encodeURIComponent(config.theSportsDbKey)}/eventsnextleague.php`);
    url.searchParams.set('id', leagueId);
    const payload = await requestJson(url, { label: 'TheSportsDB' });
    return (payload.events || []).map(normalizeSportsDbEvent);
  }));
  const events = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const errors = settled.filter(result => result.status === 'rejected').map(result => clean(result.reason?.message || 'request failed'));
  return { provider: 'thesportsdb', enabled: true, events, errors };
}

function kickoffDistance(a, b) {
  const first = Date.parse(a || '');
  const second = Date.parse(b || '');
  return Number.isFinite(first) && Number.isFinite(second) ? Math.abs(first - second) : Number.POSITIVE_INFINITY;
}
function sameFixture(a, b) {
  if (a.sport !== b.sport) return false;
  if (a.country && b.country && slug(a.country) !== slug(b.country)) return false;
  const firstLeague = leagueKey(a.league);
  const secondLeague = leagueKey(b.league);
  if (!firstLeague || firstLeague !== secondLeague) return false;
  const direct = teamKey(a.home.name) === teamKey(b.home.name) && teamKey(a.away.name) === teamKey(b.away.name);
  return direct && (kickoffDistance(a.startTime, b.startTime) <= 3 * 60 * 60 * 1000 || !a.startTime || !b.startTime);
}
function marketIdentity(market) {
  return `${market.type}|${market.period}|${market.line ?? ''}|${slug(market.label)}`;
}
function sourcePriority(source, live) {
  if (live) {
    if (source === 'sportmonks') return 10;
    return 0;
  }

  if (source === 'footballdata-io') return 55;
  if (source === 'sharpapi') return 50;
  if (source === 'public-market') return 40;
  if (source === 'oddspapi') return 5;

  return 10;
}

function marketBettingAvailable(market) {
  return Boolean(market && !market.suspended && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1));
}
// Fail-closed LIVE: market pada event live hanya boleh ditawarkan selama harga
// provider benar-benar segar (<= SPORTSBOOK_MAX_LIVE_PRICE_AGE_SECONDS). Market
// tanpa timestamp sama sekali dianggap basi — unknown = tidak aman. Tanpa kunci
// ini, provider free-tier yang refresh tiap puluhan menit akan menawarkan odds
// basi saat skor di lapangan sudah berubah (celah rugi untuk rumah). Prematch
// TIDAK disentuh: jendela usia prematch (SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS)
// berlaku seperti biasa lewat assertSelectionFresh.
export function suspendStaleLiveMarkets(events = [], now = Date.now()) {
  const maxAgeMs = Number(config.sportsbookMaxLivePriceAgeSeconds || 0) * 1000;
  return events.map(event => {
    if (config.sportmonksPassthrough && (event?._sources || []).includes('sportmonks')) return event;
    const status = String(event?.status || '').toUpperCase();
    const live = Boolean(event?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status);
    if (!live) return event;
    let changed = false;
    const markets = (event.markets || []).map(market => {
      const updatedMs = Date.parse(market?.updatedAt || '');
      if (Number.isFinite(updatedMs) && now - updatedMs <= maxAgeMs) return market;
      changed = true;
      return {
        ...market,
        suspended: true,
        selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
      };
    });
    return changed ? { ...event, markets } : event;
  });
}
function mergeSelectionsLowestOdds(a = [], b = []) {
  const map = new Map();
  for (const s of [...a, ...b]) {
    const k = String(s.label || '') + '|' + String(s.line ?? '');
    const cur = map.get(k);
    if (!cur || (Number.isFinite(s.odds) && s.odds < cur.odds)) map.set(k, s);
  }
  return [...map.values()];
}
function mergeMarkets(target, incoming, live) {
  const map = new Map(target.map(item => [marketIdentity(item), item]));
  for (const candidate of incoming) {
    const key = marketIdentity(candidate);
    const current = map.get(key);
    const candidateAvailable = marketBettingAvailable(candidate);
    const currentAvailable = marketBettingAvailable(current);
    if (!current) {
      map.set(key, candidate);
      continue;
    }
    const takeCandidate = (candidateAvailable && !currentAvailable)
      || (candidateAvailable === currentAvailable && sourcePriority(candidate.source, live) > sourcePriority(current.source, live));
    const base = takeCandidate ? candidate : current;
    const other = takeCandidate ? current : candidate;
    map.set(key, {
      ...base,
      selections: mergeSelectionsLowestOdds(base.selections, other.selections)
    });
  }
  return [...map.values()].sort((a, b) => {
    const order = { '1X2': 1, HANDICAP: 2, TOTALS: 3, BTTS: 4, DOUBLE_CHANCE: 5, DRAW_NO_BET: 6, TEAM_TOTAL: 7, HT_FT: 8, ODD_EVEN: 9, CORRECT_SCORE: 10, CORNERS: 11, CARDS: 12, PLAYER_PROP: 13, BET_BUILDER: 14, OTHER: 99 };
    return (order[a.type] || 50) - (order[b.type] || 50);
  });
}
function mergeEvent(target, incoming) {
  const scoreAuthorities = new Set(['sportmonks', 'public-market', 'footballdata-io']);
  const targetPriority = target._sources.some(s => scoreAuthorities.has(s)) ? 4 : target._sources.includes('sharpapi') ? 3 : 1;
  const incomingPriority = incoming._sources.some(s => scoreAuthorities.has(s)) ? 4 : incoming._sources.includes('sharpapi') ? 3 : 1;
  if (incomingPriority >= targetPriority) {
    target.status = incoming.status;
    target.providerStatus = incoming.providerStatus || target.providerStatus || null;
    target.live = incoming.live;
    target.clock = incoming.clock || target.clock;
    target.home.score = incoming.home.score ?? target.home.score;
    target.away.score = incoming.away.score ?? target.away.score;
  }
  target.home.logo ||= incoming.home.logo;
  target.away.logo ||= incoming.away.logo;
  target.leagueLogo ||= incoming.leagueLogo;
  target.venue ||= incoming.venue;
  target.country ||= incoming.country;
  target.periodScores = { ...(target.periodScores || {}), ...(incoming.periodScores || {}) };
  target.availableMarketCount = Math.max(Number(target.availableMarketCount || 0), Number(incoming.availableMarketCount || 0)) || null;
  target.detailFetchedAt = incoming.detailFetchedAt || target.detailFetchedAt || null;
  target._refs = { ...target._refs, ...incoming._refs };
  target._sources = [...new Set([...target._sources, ...incoming._sources])];
  if (Array.isArray(target._settlementReadySources) || Array.isArray(incoming._settlementReadySources)) {
    target._settlementReadySources = [...new Set([...(target._settlementReadySources || []), ...(incoming._settlementReadySources || [])])];
  }
  target.markets = mergeMarkets(target.markets, incoming.markets, target.live || incoming.live);
  return target;
}
function applyManualFtSettlementFallback(event, { enabled = config.sportsbookManualFtSettlementFallbackEnabled } = {}) {
  if (!enabled || !event || event.live || event.status !== 'SCHEDULED') return event;
  const eventSources = new Set(Array.isArray(event._sources) ? event._sources : []);
  const readySources = new Set(Array.isArray(event._settlementReadySources) ? event._settlementReadySources : []);
  // Automatic authority always wins. The fallback is only a settlement guarantee for
  // healthy prematch SharpAPI pricing; it is not a score/result source.
  if (readySources.has('public-market') || readySources.has('footballdata-io')) return event;
  const fallbackPricingSource = eventSources.has('sharpapi') && readySources.has('sharpapi')
    ? 'sharpapi'
    : eventSources.has('public-market') && readySources.has('public-market')
      ? 'public-market'
      : eventSources.has('footballdata-io') && readySources.has('footballdata-io')
        ? 'footballdata-io'
        : null;
  if (!fallbackPricingSource) return event;
  const hasHealthySharpFt = (event.markets || []).some(market =>
    (market.period || 'FT') === 'FT'
    && market.source === fallbackPricingSource
    && !market.suspended
    && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1)
  );
  if (!hasHealthySharpFt) return event;
  event._settlementReadySources = [...new Set([...readySources, 'manual-ops'])];
  event._settlementMode = 'MANUAL_FT_FALLBACK';
  return event;
}
function applySettlementSafety(event) {
  const authority = eventSettlementAuthority(event);
  event.markets = (event.markets || []).map(market => {
    if (config.sportmonksPassthrough && market.source === 'sportmonks') return market;
    const period = market.period || 'FT';
    const mustSuspend = period === '1H' ? !authority.ht : !authority.ft;
    return mustSuspend
      ? { ...market, suspended: true, selections: market.selections.map(selection => ({ ...selection, suspended: true })) }
      : market;
  });
  return event;
}
export function mergeProviderEvents(providerResults, options = {}) {
  logger.info('mergeProviderEvents input', { providers: (providerResults||[]).map(r=>r?.provider), counts: (providerResults||[]).map(r=>r?.events?.length||0) });
  for (const result of providerResults || []) {
    const events = Array.isArray(result?.events) ? result.events : [];
    let markets = 0;
    let odds = 0;
    let validOdds = 0;
    let missingOddsMarkets = 0;
    const bookmakers = new Set();
    const marketTypes = {};
    for (const event of events) {
      for (const market of Array.isArray(event?.markets) ? event.markets : []) {
        markets += 1;
        const selections = Array.isArray(market?.selections) ? market.selections : [];
        if (!selections.some(s => Number(s?.odds) > 1)) missingOddsMarkets += 1;
        for (const selection of selections) {
          odds += 1;
          if (Number(selection?.odds) > 1) validOdds += 1;
          if (selection?.source) bookmakers.add(String(selection.source));
        }
        const type = String(market?.type || market?.marketType || 'unknown').toLowerCase();
        marketTypes[type] = (marketTypes[type] || 0) + 1;
      }
    }
    logger.info('mergeProviderEvents provider aggregate', {
      provider: result?.provider,
      events: events.length,
      markets,
      bookmakers: bookmakers.size,
      odds,
      validOdds,
      missingOddsMarkets,
      marketTypes
    });
  }
  const events = [];
  const fixturesByTeams = new Map();
  const now = Date.now();
  const pricedCount = event => {
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    return markets.filter(m => {
      const selections = Array.isArray(m?.selections) ? m.selections : [];
      return selections.some(s => s && !s.suspended && Number(s.odds) > 1);
    }).length;
  };
  const eventPriority = event => {
    const status = String(event?.status || '').toUpperCase();
    const kickoff = Date.parse(event?.startTime || '');
    const live = Boolean(event?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status);
    const inNextDay = Number.isFinite(kickoff) && kickoff >= now && kickoff < now + 86400000;
    const topLeague = TOP_LEAGUE_TOKENS.some(token => `${event?.country || ''} ${event?.league || ''}`.toLowerCase().includes(token));
    if (live) return 0;
    if (inNextDay) return 1;
    if (topLeague) return 2;
    if (status === 'FINISHED' || status === 'CANCELLED' || status === 'POSTPONED') return 4;
    return 3;
  };
  const ordered = providerResults.flatMap(result => result.events || []).sort((a, b) =>
    eventPriority(a) - eventPriority(b)
      || pricedCount(b) - pricedCount(a)
      || (Date.parse(a.startTime || '') || Number.MAX_SAFE_INTEGER)
        - (Date.parse(b.startTime || '') || Number.MAX_SAFE_INTEGER)
  );
  let nonSportmonksEventsCount = 0;
  for (const candidate of ordered) {
    const fixtureKey = `${candidate.sport}|${teamKey(candidate.home.name)}|${teamKey(candidate.away.name)}`;
    const candidates = fixturesByTeams.get(fixtureKey) || [];
    const existing = candidates.find(event => sameFixture(event, candidate));
    if (existing) {
      mergeEvent(existing, candidate);
    }
    else {
      const event = structuredClone(candidate);
      events.push(event);
      candidates.push(event);
      fixturesByTeams.set(fixtureKey, candidates);
    }
  }
  return events.map(event => applySettlementSafety(applyManualFtSettlementFallback(event, options)));
}
export function publicEvent(event) {
  return {
    id: event.id,
    sport: event.sport,
    league: event.league,
    country: event.country,
    startTime: event.startTime,
    status: event.status,
    providerStatus: event.providerStatus || null,
    live: event.live,
    clock: event.clock,
    home: { name: event.home.name, score: event.home.score, logo: event.home.logo || null },
    away: { name: event.away.name, score: event.away.score, logo: event.away.logo || null },
    leagueLogo: event.leagueLogo || null,
    venue: event.venue,
    periodScores: event.periodScores || {},
    statistics: Array.isArray(event.statistics) ? event.statistics : [],
    events: Array.isArray(event.events) ? event.events : [],
    availableMarketCount: Number(event.availableMarketCount || event.markets?.length || 0),
    ...(config.sportmonksPassthrough && (event._sources || []).includes('sportmonks')
      ? { validationWarnings: Array.isArray(event.validationWarnings) ? event.validationWarnings : [] }
      : {}),
    detailLoaded: Boolean(event.detailFetchedAt),
    detailFetchedAt: event.detailFetchedAt || null,
    markets: (event.markets || []).map(market => ({
      id: market.id,
      key: market.key,
      type: market.type,
      label: market.label,
      period: market.period,
      line: market.line,
      suspended: market.suspended,
      updatedAt: market.updatedAt,
      source: market.source || null,
      sourceMarketId: market.sourceMarketId || null,
      bookmaker: market.bookmaker || null,
      mainLine: market.mainLine ?? null,
      ...(config.sportmonksPassthrough && market.source === 'sportmonks'
        ? { validationWarnings: Array.isArray(market.validationWarnings) ? market.validationWarnings : [] }
        : {}),
      lifecycleState: market.lifecycleState || null,
      lifecycleReason: market.lifecycleReason || null,
      reopenSuccessStreak: Number(market.reopenSuccessStreak || 0),
      selections: market.selections.map(selection => ({
        key: selection.key,
        label: selection.label,
        odds: selection.odds,
        line: selection.line,
        suspended: selection.suspended,
        source: selection.source || market.source || null,
        sourceSelectionId: selection.sourceSelectionId || null,
        updatedAt: selection.updatedAt || market.updatedAt || null,
        priceVersion: selection.priceVersion || null
      }))
    }))
  };
}

export const __sportsbookProviders = {
  normalizeSharpApiRows,
  sharpDerivedMarketType,
  sharpMarketGroupKey,
  normalizeSportsDbEvent,
  normalizeSportmonksFixture,
  mergeProviderEvents,
  applyManualFtSettlementFallback,
  marketBettingAvailable,
  marketType,
  eventId,
  selectionId,
  periodFromName,
  suspendStaleLiveMarkets,
  providerRequestCache,
  sportmonksCache,
  sportmonksCacheTtlMs,
  sportmonksRetryState,
  sportmonksLiveCache,
  sportmonksLiveRetryState,
  hasPayloadErrors,
  extractErrorDetail,
};

// Builder helpers shared by provider adapters so every provider emits the exact
// normalized event/market/selection shape that mergeProviderEvents consumes.
export {
  normalizedEvent,
  normalizedMarket,
  normalizedSelection,
  eventId,
  selectionId,
  marketId,
  marketType,
  periodFromName,
  marketLabel,
  clean,
  number,
  safeOdds,
  status,
  iso,
  slug,
  teamKey,
  hash,
  fetchRapidApiOdds,
  normalizeRapidApiRow,
  mapRapidApiStatus,
  mapRapidApiMarket,
  mapRapidApiSelection,
};
