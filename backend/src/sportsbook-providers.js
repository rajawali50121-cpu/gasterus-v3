import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureBoundedCacheCapacity, pruneExpiredCacheEntries, setBoundedCacheEntry } from './bounded-cache.js';
import { readBoundedResponseText } from './bounded-response.js';
import { eventSettlementAuthority } from './sportsbook-settlement-authority.js';

const MAX_PROVIDER_EVENTS = 500;
const SPORTMONKS_MAX_PAGES_PER_REFRESH = 120;
const SPORTMONKS_MAX_PAGES_PER_WORKER_REFRESH = 120;
const SPORTMONKS_PAGE_SIZE = 50; // fixtures/between supports per_page max 50 (docs)
const SPORTMONKS_PAGE_MAX_BYTES = 2_621_440;
const SPORTMONKS_CANDIDATE_MULTIPLIER = 1.2;
const SPORTMONKS_DEFAULT_INCLUDE = 'state;participants;league.country;odds;scores;statistics.type;events.type';
const DEFAULT_SPORTMONKS_PRIORITY_LEAGUES = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'UEFA Champions League', 'UEFA Europa League', 'UEFA Europa Conference League', 'Eredivisie', 'Primeira Liga', 'Major League Soccer'];
const MARKET_TYPES = Object.freeze({
  h2h: '1X2',
  moneyline: '1X2',
  h2h_3_way: '1X2',
  moneyline_3way: '1X2',
  three_way_moneyline: '1X2',
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
  if (!valid.length) return null;
  const resolvedType = type || marketType(name, key);
  const resolvedPeriod = period || periodFromName(name);
  const resolvedLine = line === null || line === '' ? null : number(line) ?? clean(line, 40);
  return {
    id: marketId(event, resolvedType, resolvedPeriod, resolvedLine, key || name),
    key: clean(key || slug(name), 120),
    type: resolvedType,
    label: clean(name || resolvedType, 120),
    period: resolvedPeriod,
    line: resolvedLine,
    suspended: Boolean(suspended),
    updatedAt: iso(updatedAt),
    source,
    sourceMarketId: clean(sourceMarketId, 180) || null,
    bookmaker: clean(bookmaker, 120) || null,
    mainLine: mainLine === null ? null : Boolean(mainLine),
    selections: valid
  };
}
function normalizedEvent({ provider, providerId, sport, league, country = '', startTime, state = 'SCHEDULED', providerStatus = null, clock = null, home, away, homeScore = null, awayScore = null, homeLogo = null, awayLogo = null, leagueLogo = null, venue = null, periodScores = {}, markets = [] }) {
  const resolvedSport = sportFromKey(sport);
  const id = eventId(resolvedSport, home, away, startTime);
  const resolvedStatus = status(state);
  return {
    id,
    sport: resolvedSport,
    league: clean(league || 'Other', 120),
    country: clean(country, 80) || null,
    startTime: iso(startTime),
    status: resolvedStatus,
    providerStatus: clean(providerStatus || state, 40) || null,
    live: resolvedStatus === 'LIVE',
    clock: clean(clock, 40) || null,
    home: { name: clean(home, 120), score: number(homeScore), logo: homeLogo || null },
    away: { name: clean(away, 120), score: number(awayScore), logo: awayLogo || null },
    leagueLogo: leagueLogo || null,
    venue: clean(venue, 160) || null,
    periodScores: periodScores && typeof periodScores === 'object' ? periodScores : {},
    markets: markets.filter(Boolean),
    _refs: { [provider]: clean(providerId, 160) },
    _sources: [provider],
    _settlementReadySources: [provider]
  };
}

async function requestJson(url, { headers = {}, label = 'sports provider', maxBytes = config.sportsProviderCacheMaxEntryBytes, signal: outerSignal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${config.sportsFeedRequestTimeoutMs}ms`)), config.sportsFeedRequestTimeoutMs);
  const onAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
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
      // attach parsed body for rate_limit handling (best-effort, bounded)
      try { error.body = JSON.parse(await readBoundedResponseText(response, label, 65536)); } catch {}
      throw error;
    }
    const text = await readBoundedResponseText(response, label, maxBytes);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener?.('abort', onAbort);
  }
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
// ---------------------------------------------------------------------------
// API-Sports daily quota guard (free plan: 100 req/hari, divalidasi via
// GET /status -> {"requests":{"limit_day":100}}). Cache hit gratis; yang harus
// dijaga hanya seberapa sering HTTP benar-benar dikirim ke provider.
//
// Tiap bucket (live/prematch) diberi jatah harian dari API_SPORTS_DAILY_QUOTA,
// lalu jatah itu diubah menjadi jeda minimum per endpoint:
//     floorDetik = 86400 * jumlahEndpointBucket / jatahHarian
// TTL efektif = max(TTL konfigurasi, floor), sehingga walaupun loop refresh
// berjalan tiap 30 detik, provider tidak pernah dipanggil lebih cepat dari
// jatahnya. Dua bucket terpisah supaya prematch (banyak endpoint) tidak pernah
// melahap jatah live. Upgrade ke Pro? cukup naikkan API_SPORTS_DAILY_QUOTA
// (7500) — floor jatuh di bawah TTL konfigurasi dan guard jadi transparan.
//
// Jika provider tetap membalas 429 (race lintas proses/restart), payload cache
// terakhir disajikan tanpa dihitung sebagai gangguan transport, dan retry tidak
// dipaksa tiap 30 detik.
const API_SPORTS_LIVE_ENDPOINTS = 2; // fixtures?live=all + odds/live

function apiSportsEndpointCount(bucket) {
  return bucket === 'live' ? API_SPORTS_LIVE_ENDPOINTS : 1 + Math.max(1, Number(config.apiSportsOddsPages) || 1);
}

export function apiSportsQuotaFloorSeconds(bucket) {
  const budget = Math.max(10, Number(config.apiSportsDailyQuota) || 100);
  const prematchShare = Math.min(Math.max(10, Math.round(budget * 0.25)), budget - 10);
  const share = bucket === 'live' ? budget - prematchShare : prematchShare;
  return Math.ceil(86400 * apiSportsEndpointCount(bucket) / share);
}

function cachedApiSports(path, params, ttlSeconds, bucket = 'prematch', quotaStore = null) {
  const entries = Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b));
  const key = `api-sports:${path}:${JSON.stringify(entries)}`;
  const floorSeconds = apiSportsQuotaFloorSeconds(bucket);
  const ttl = Math.max(ttlSeconds, floorSeconds);
  return cachedRequest(key, ttl * 1000, async () => {
    try {
      return await apiSports(path, params, quotaStore);
    } catch (error) {
      if (!String(error?.message || '').includes('HTTP 429')) throw error;
      const cached = providerRequestCache.get(key);
      logger.warn('API-Sports daily quota reached; serving cached payload', { endpoint: path, bucket, floorSeconds });
      if (cached?.value !== undefined) return cached.value;
      // Belum ada data tersimpan: kembalikan payload kosong berbentuk sah supaya
      // feed tetap hidup dan siklus SETELAH floor berikutnya mencoba lagi,
      // bukan membanjiri provider dengan retry 429 tiap 30 detik.
      return { response: [] };
    }
  });
}
function utcDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
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
  const returnedEvents = events.slice(0, MAX_PROVIDER_EVENTS).length;
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
  return events.slice(0, MAX_PROVIDER_EVENTS);
}
async function sharpApiOddsPage({ offset = 0, cursor = null, cfg = config } = {}) {
  const url = new URL(`${cfg.sharpApiBaseUrl.replace(/\/$/, '')}/api/v1/odds`);
  url.searchParams.set('sport', cfg.sharpApiSport);
  if (cfg.sharpApiMarkets) url.searchParams.set('market', cfg.sharpApiMarkets);
  if (cfg.sharpApiSportsbook) url.searchParams.set('sportsbook', cfg.sharpApiSportsbook);
  url.searchParams.set('limit', String(cfg.sharpApiPageSize));
  // cursor didahulukan oleh API bila ada (filter harus sama); offset dipertahankan untuk kompatibilitas.
  if (cursor) url.searchParams.set('cursor', String(cursor));
  else if (Number.isFinite(offset) && offset > 0) url.searchParams.set('offset', String(offset));
  return requestJson(url, { headers: { 'X-API-Key': cfg.sharpApiKey }, label: 'SharpAPI' });
}
function sharpCfg(){ return (globalThis.__sharpApiTestConfig && typeof globalThis.__sharpApiTestConfig === 'object') ? globalThis.__sharpApiTestConfig : config; }
export async function fetchSharpApi() {
  const cfg = sharpCfg();
  if (!cfg.sharpApiEnabled || !cfg.sharpApiKey) return { provider: 'sharpapi', enabled: false, events: [] };
  const cacheKey = `sharpapi:${cfg.sharpApiSport}:${cfg.sharpApiMarkets}:${cfg.sharpApiSportsbook || '*'}:${cfg.sharpApiMainLinesOnly}`;
  const payload = await cachedRequest(cacheKey, (cfg.sharpApiRefreshSeconds || 45) * 1000, async () => {
    const rows = [];
    let offset = 0;
    let cursor = null;
    let pagesFetched = 0;
    let stoppedBy = 'no_more';
    let hasMore = false;
    const startedAt = Date.now();
    const maxPages = Math.max(1, Number(cfg.sharpApiMaxPages) || 1);
    const maxRequests = Math.max(1, Math.min(Number(cfg.sharpApiMaxRequestsPerCycle) || maxPages, maxPages));
    const timeBudgetMs = Math.max(0, Number(cfg.sharpApiTimeBudgetMs) || 15000);
    for (let page = 0; page < maxRequests; page += 1) {
      if (timeBudgetMs > 0 && (Date.now() - startedAt) >= timeBudgetMs) { stoppedBy = 'time_budget'; break; }
      let current;
      try {
        current = await sharpApiOddsPage({ offset, cursor, cfg });
      } catch (error) {
        if (pagesFetched === 0) throw error;
        stoppedBy = 'error';
        logger.warn('SharpAPI page fetch failed after partial rows; returning collected data', {
          provider: 'sharpapi', pagesFetched, rows: rows.length, error: error?.message
        });
        break;
      }
      pagesFetched += 1;
      const pageRows = Array.isArray(current?.data) ? current.data : [];
      rows.push(...pageRows);
      const pagination = current?.pagination || {};
      hasMore = Boolean(pagination?.has_more);
      if (!hasMore) { stoppedBy = 'no_more'; break; }
      const nextCursor = pagination?.next_cursor;
      const nextOffset = pagination?.next_offset;
      if (nextCursor && (nextOffset === null || nextOffset === undefined || nextOffset === '')) {
        cursor = String(nextCursor);
        continue;
      }
      if (nextOffset !== null && nextOffset !== undefined && nextOffset !== '') {
        const parsedOffset = Number(nextOffset);
        if (!Number.isFinite(parsedOffset) || parsedOffset <= offset) { stoppedBy = 'no_more'; break; }
        offset = parsedOffset;
        cursor = null;
        continue;
      }
      stoppedBy = 'no_more';
      break;
    }
    if (stoppedBy === 'no_more' && hasMore && pagesFetched >= maxRequests) stoppedBy = 'max_pages';
    logger.info('SharpAPI fetch page loop completed', {
      provider: 'sharpapi', pagesFetched, rows: rows.length, hasMore, stoppedBy, durationMs: Date.now() - startedAt
    });
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
  if (type === 'CORRECT_SCORE') return clean(row?.name || row?.label || 'Selection', 120);
  const raw = clean(row?.label || row?.name || 'Selection', 120);
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
  for (const entry of Array.isArray(scores) ? scores : []) {
    const description = clean(entry?.description).toUpperCase();
    const score = entry?.score || {};
    if (!description) continue;
    if (description === 'CURRENT') out.CURRENT = { home: number(score.home), away: number(score.away) };
    else if (description === '1ST HALF') out['1H'] = { home: number(score.home), away: number(score.away) };
    else if (description === '2ND HALF') out['2H'] = { home: number(score.home), away: number(score.away) };
  }
  return out;
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
function normalizeSportmonksFixture(raw, oddsRows = []) {
  const participants = Array.isArray(raw?.participants) ? raw.participants : [];
  const home = participants.find(participant => participant?.meta?.location === 'home') || participants[0];
  const away = participants.find(participant => participant?.meta?.location === 'away') || participants[1];
  if (!home?.name || !away?.name) return null;
  const byMarket = new Map();
  for (const row of Array.isArray(oddsRows) ? oddsRows : []) {
    const marketId = clean(row?.market_id);
    const marketName = clean(row?.market_description || row?.name);
    const identity = marketId ? `id:${marketId}` : marketName ? `name:${slug(marketName)}` : '';
    if (!identity) continue;
    const list = byMarket.get(identity) || [];
    list.push(row);
    byMarket.set(identity, list);
  }
  const current = (Array.isArray(raw?.scores) ? raw.scores : []).find(entry => clean(entry?.description).toUpperCase() === 'CURRENT')?.score || {};
  const event = normalizedEvent({
    provider: 'sportmonks',
    providerId: String(raw?.id ?? ''),
    sport: 'Football',
    league: raw?.league?.name,
    country: raw?.league?.country?.name,
    startTime: sportmonksStartTime(raw),
    state: sportmonksState(raw?.state),
    providerStatus: raw?.state?.name || raw?.state?.short_name || null,
    home: home.name,
    away: away.name,
    homeScore: current.home,
    awayScore: current.away,
    homeLogo: home.image_path || null,
    awayLogo: away.image_path || null,
    leagueLogo: raw?.league?.image_path || null,
    venue: raw?.venue?.name || null,
    periodScores: sportmonksPeriodScores(raw?.scores)
  });
    event.markets = [...byMarket.values()].map(rows => sportmonksMarket(event, rows)).filter(Boolean);
  event.statistics = Array.isArray(raw?.statistics) ? raw.statistics : [];
  event.events = Array.isArray(raw?.events) ? raw.events : [];
  if (!Array.isArray(event._settlementReadySources) || event._settlementReadySources.length === 0) {
    event._settlementReadySources = [event.provider];
  }
  if (!Array.isArray(event._sources)) event._sources = [event.provider];

  return event;
}
function sportmonksMarket(event, rows) {
  const sample = rows[0] || {};
  const providerMarketId = clean(sample.market_id);
  const description = clean(sample.market_description || sample.name || (providerMarketId ? `Market ${providerMarketId}` : ''), 120);
  if (!description) return null;
  const type = sportmonksMarketType(description);
  const period = periodFromName(description, `m${sample.market_id ?? ''}`);
  const marketKey = providerMarketId ? `m${providerMarketId}` : `name:${slug(description)}`;
  const grouped = new Map();
  for (const row of rows) {
    const line = sportmonksLine(type, row);
    const label = sportmonksLabel(type, row);
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
    if (!previous || selection.odds > previous.odds) grouped.set(key, selection);
  }
  const selections = [...grouped.values()];
  if (!selections.length) return null;
  const updatedAt = rows.reduce((latest, row) => {
    const at = iso(row?.latest_bookmaker_update);
    return at && (!latest || at > latest) ? at : latest;
  }, null);
  return normalizedMarket(event.id, {
    key: marketKey,
    name: marketLabel(type, description, `m${sample.market_id}`),
    type,
    period,
    selections,
    source: 'sportmonks',
    sourceMarketId: providerMarketId ? `m${providerMarketId}` : null,
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

// In-memory hourly Sportmonks request budget (no Redis/DB). Resets on process restart.
let sportmonksHourWindowStart = 0;
let sportmonksRequestsThisHour = 0;
let sportmonksRateLimitPauseUntil = 0;
function sportmonksHourBudget() {
  const now = Date.now();
  if (now - sportmonksHourWindowStart >= 3_600_000) {
    sportmonksHourWindowStart = now;
    sportmonksRequestsThisHour = 0;
  }
  const max = Math.max(1, Number(config.sportmonksMaxRequestsPerHour) || 150);
  return { now, max, used: sportmonksRequestsThisHour, remaining: Math.max(0, max - sportmonksRequestsThisHour) };
}
function noteSportmonksRequest() {
  sportmonksHourBudget();
  sportmonksRequestsThisHour += 1;
}
function noteSportmonksRateLimit(payload) {
  const rl = payload?.rate_limit;
  if (!rl || typeof rl !== 'object') return;
  const remaining = Number(rl.remaining);
  const resets = Number(rl.resets_in_seconds);
  if (Number.isFinite(remaining) && remaining <= 10 && Number.isFinite(resets) && resets > 0) {
    sportmonksRateLimitPauseUntil = Math.max(sportmonksRateLimitPauseUntil, Date.now() + Math.min(resets, 3600) * 1000);
  }
}
async function sportmonksBudgetGate(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Sportmonks aborted');
  const now = Date.now();
  if (sportmonksRateLimitPauseUntil > now) {
    const err = new Error(`Sportmonks rate_limit pause until ${new Date(sportmonksRateLimitPauseUntil).toISOString()}`);
    err.code = 'SPORTMONKS_RATE_LIMIT_PAUSE';
    throw err;
  }
  const b = sportmonksHourBudget();
  if (b.remaining <= 0) {
    const err = new Error(`Sportmonks hourly request budget exhausted (${b.used}/${b.max})`);
    err.code = 'SPORTMONKS_HOURLY_BUDGET';
    throw err;
  }
}

function sportmonksFiltersParam() {
  const bookmakers = clean(config.sportmonksBookmakerIds, 120).replace(/\s+/g, '');
  const markets = clean(config.sportmonksMarketIds, 120).replace(/\s+/g, '');
  const parts = [];
  if (bookmakers) parts.push(`bookmakers:${bookmakers}`);
  if (markets) parts.push(`markets:${markets}`);
  return parts.join(';');
}
function sportmonksOddsUrlParams(url) {
  url.searchParams.set('include', SPORTMONKS_DEFAULT_INCLUDE);
  const filters = sportmonksFiltersParam();
  if (filters) url.searchParams.set('filters', filters);
}

// Read one page at a time so raw odds payloads are not retained across pages.
// Uses fixtures/between (docs: max 100 days range, per_page max 50, has_more pagination).
async function fetchSportmonksBetweenPage(base, startDate, endDate, page, { signal } = {}) {
  const url = new URL(`${base}/football/fixtures/between/${startDate}/${endDate}`);
  url.searchParams.set('api_token', config.sportmonksKey);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(SPORTMONKS_PAGE_SIZE));
  sportmonksOddsUrlParams(url);

  const maxAttempts = 4;
  let attempt = 0;
  while (true) {
    await sportmonksBudgetGate(signal);
    await waitForSportmonksRequestSlot();
    noteSportmonksRequest();
    try {
      const payload = await requestJson(url, {
        label: `Sportmonks between ${startDate}/${endDate} page ${page}`,
        maxBytes: SPORTMONKS_PAGE_MAX_BYTES,
        signal
      });
      noteSportmonksRateLimit(payload);
      const data = payload?.data || [];
      const hasMore = data.length > 0 && (
        typeof payload?.pagination?.has_more === 'boolean'
          ? payload.pagination.has_more
          : data.length >= SPORTMONKS_PAGE_SIZE
      );
      return { data, hasMore };
    } catch (error) {
      if (signal?.aborted) throw error;
      noteSportmonksRateLimit(error?.body);
      attempt += 1;
      const status = Number(error?.status);
      const retryable = status === 429 || status >= 500 || !Number.isFinite(status);
      if (!retryable || attempt >= maxAttempts) throw error;
      const backoffMs = Math.max(sportmonksRetryAfterMs(error), Math.min(8000, 1000 * Math.pow(2, attempt - 1)));
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, backoffMs);
        signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(signal.reason || error); }, { once: true });
      });
    }
  }
}
// Back-compat name used by older tests/mocks only; routes to between-style single-date behavior is not assumed.
async function fetchSportmonksPage(base, date, page, opts = {}) {
  return fetchSportmonksBetweenPage(base, date, date, page, opts);
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
    url.searchParams.set('include', 'state;participants;league.country;scores;inplayOdds');
    let responseError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitForSportmonksRequestSlot();
      try {
        const payload = await requestJson(url, {
          label: 'Sportmonks livescores',
          maxBytes: SPORTMONKS_PAGE_MAX_BYTES
        });
        if (!Array.isArray(payload?.data)) {
          throw new Error('Sportmonks livescores returned an invalid data array.');
        }
        const events = payload.data
          .map(fixture => normalizeSportmonksFixture(fixture, fixture?.inplayOdds || []))
          .filter(Boolean);
        const fetchedAt = Date.now();
        const result = { events, fetchedAt };
        sportmonksLiveCache.set(cacheKey, result);
        sportmonksLiveRetryState.delete(cacheKey);
        logger.info('Sportmonks live window refreshed', {
          provider: 'sportmonks',
          fixtures: payload.data.length,
          normalizedEvents: events.length,
          inplayMarkets: events.reduce((total, event) => total + event.markets.length, 0),
          durationMs: fetchedAt - now
        });
        return { ...result, failed: false, errors: [] };
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

function mergeSportmonksLiveWindow(events, liveEvents, maxEvents, priorityLeagues) {
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
    .slice(0, maxEvents)
    .map(candidate => candidate.event);
}

async function applySportmonksLiveWindow(events, base, maxEvents, priorityLeagues) {
  const liveWindow = await fetchSportmonksLiveWindow(base);
  const updatedEvents = liveWindow.failed
    ? suspendSportmonksLiveMarkets(events)
    : mergeSportmonksLiveWindow(events, liveWindow.events, maxEvents, priorityLeagues);
  return { events: updatedEvents, liveWindow };
}

function sportmonksLeaguePriority(event, configuredLeagues) {
  const league = clean(event?.league, 120).toLowerCase();
  const index = configuredLeagues.findIndex(name => league === name || league.includes(name));
  return index < 0 ? configuredLeagues.length : index;
}

function compareSportmonksEvents(a, b) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  // Retention ranking: fixture berharga (punya pasar) menang atas fixture
  // display-only pada slot yang sama sehingga anggaran 500 event selalu
  // diprioritaskan untuk pertandingan yang bisa ditampilkan odds-nya.
  const aPriced = a.event.markets?.length ? 1 : 0;
  const bPriced = b.event.markets?.length ? 1 : 0;
  if (aPriced !== bPriced) return bPriced - aPriced;
  if (a.leaguePriority !== b.leaguePriority) return a.leaguePriority - b.leaguePriority;
  return a.startTime - b.startTime || a.event.id.localeCompare(b.event.id);
}

export async function fetchSportmonks({
  maxEvents = config.sportmonksMaxTotalEvents,
  maxPages = SPORTMONKS_MAX_PAGES_PER_REFRESH,
  signal
} = {}) {
  if (!config.sportmonksEnabled || !config.sportmonksKey) {
    logger.warn('Sportmonks disabled or missing API key');
    return { provider: 'sportmonks', enabled: false, events: [] };
  }

  const base = config.sportmonksBaseUrl.replace(/\/$/, '');
  const now = Date.now();
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > MAX_PROVIDER_EVENTS) {
    throw new Error(`Sportmonks maxEvents must be an integer between 0 and ${MAX_PROVIDER_EVENTS}.`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > SPORTMONKS_MAX_PAGES_PER_WORKER_REFRESH) {
    throw new Error(`Sportmonks maxPages must be an integer between 1 and ${SPORTMONKS_MAX_PAGES_PER_WORKER_REFRESH}.`);
  }
  if (maxEvents === 0) return { provider: 'sportmonks', enabled: true, events: [], errors: [] };
  const daysAhead = Math.min(Math.max(0, Number(config.sportmonksDaysAhead) || 0), 100);
  const startDate = utcDate(0);
  const endDate = utcDate(daysAhead);
  // Cache key unchanged in shape fields that matter to callers/limits (maxEvents,maxPages preserved).
  const cacheKey = `sportmonks:all-events:${startDate}:${config.sportmonksDaysAhead}:${maxEvents}:${maxPages}`;
  const priorityLeagues = String(config.sportmonksPriorityLeagues || '')
    .split(',')
    .map(name => clean(name, 120).toLowerCase())
    .filter(Boolean);
  const configuredPriorityLeagues = priorityLeagues.length ? priorityLeagues : DEFAULT_SPORTMONKS_PRIORITY_LEAGUES;

  // Cek cache terlebih dahulu
  const cached = sportmonksCache.get(cacheKey);
  if (sportmonksRateLimitPauseUntil > now) {
    const retryAt = sportmonksRateLimitPauseUntil;
    const message = `Sportmonks rate_limit pause until ${new Date(retryAt).toISOString()}`;
    const prev = sportmonksRetryState.get(cacheKey);
    sportmonksRetryState.set(cacheKey, { attempts: (prev?.attempts || 0) + 1, retryAt, message });
    const { events, liveWindow } = await applySportmonksLiveWindow(cached?.events || [], base, maxEvents, configuredPriorityLeagues);
    logger.warn('Sportmonks rate_limit pause active: returning stale cache', { retryInMs: retryAt - now, retainedEvents: events.length });
    return { provider: 'sportmonks', enabled: true, events, stale: true, transportOk: false, errors: [message, ...liveWindow.errors] };
  }
  if (cached && now - cached.fetchedAt < sportmonksCacheTtlMs()) {
    const { events, liveWindow } = await applySportmonksLiveWindow(cached.events, base, maxEvents, configuredPriorityLeagues);
    logger.info('Sportmonks: returning cached fixture catalog', { age: Math.round((now - cached.fetchedAt) / 1000) + 's', events: events.length, liveWindowFailed: liveWindow.failed });
    return { provider: 'sportmonks', enabled: true, events, errors: liveWindow.errors };
  }
  const retryState = sportmonksRetryState.get(cacheKey);
  const budget = sportmonksHourBudget();
  const budgetPaused = retryState && now < retryState.retryAt && /budget|rate_limit/i.test(String(retryState.message || ''));
  const budgetExhausted = budget.remaining <= 0 || (sportmonksRateLimitPauseUntil > now);
  if (retryState && now < retryState.retryAt) {
    const { events, liveWindow } = await applySportmonksLiveWindow(cached?.events || [], base, maxEvents, configuredPriorityLeagues);
    return { provider: 'sportmonks', enabled: true, events, stale: true, transportOk: false, errors: [retryState.message, ...liveWindow.errors] };
  }
  if (budgetExhausted) {
    const retryAt = Math.max(sportmonksRateLimitPauseUntil, now + 60_000);
    const message = sportmonksRateLimitPauseUntil > now
      ? `Sportmonks rate_limit pause until ${new Date(sportmonksRateLimitPauseUntil).toISOString()}`
      : `Sportmonks hourly request budget exhausted (${budget.used}/${budget.max})`;
    sportmonksRetryState.set(cacheKey, { attempts: (retryState?.attempts || 0) + 1, retryAt, message });
    const { events, liveWindow } = await applySportmonksLiveWindow(cached?.events || [], base, maxEvents, configuredPriorityLeagues);
    logger.warn('Sportmonks hourly/rate budget gate: returning stale cache', { remaining: budget.remaining, retryInMs: retryAt - now, retainedEvents: events.length });
    return { provider: 'sportmonks', enabled: true, events, stale: true, transportOk: false, errors: [message, ...liveWindow.errors] };
  }
  void budgetPaused;

  const errors = [];
  const candidateLimit = Math.min(Math.ceil(maxEvents * SPORTMONKS_CANDIDATE_MULTIPLIER), maxPages * SPORTMONKS_PAGE_SIZE);
  const rankedEvents = [];
  const seen = new Set();
  const diagnostics = { rawFixtures: 0, duplicateFixtures: 0, stateFiltered: 0, pastKickoffFiltered: 0, normalizedRejected: 0, normalizedEvents: 0, candidateDiscarded: 0, pageFailures: 0 };
  let providerRetryAfterMs = 0;
  let pagesFetched = 0;
  let permanentPageFailure = false;
  let page = 1;
  let hasMore = true;
  // fixtures/between: single date-range request stream (docs max 100 days), per_page max 50, follow has_more.
  while (pagesFetched < maxPages && hasMore) {
    if (signal?.aborted) throw signal.reason || new Error('Sportmonks aborted');
    try {
      const result = await fetchSportmonksBetweenPage(base, startDate, endDate, page, { signal });
      pagesFetched += 1;
      page += 1;
      hasMore = result.hasMore;
      for (const fixture of result.data) {
        diagnostics.rawFixtures += 1;
        const id = String(fixture?.id ?? '');
        if (!id || seen.has(id)) { if (id) diagnostics.duplicateFixtures += 1; continue; }
        seen.add(id);
        const state = sportmonksState(fixture.state);
        if (state !== 'SCHEDULED' && state !== 'LIVE') { diagnostics.stateFiltered += 1; continue; }
        const start = Number(fixture.starting_at_timestamp) * 1000 || Date.parse(fixture.starting_at || '') || 0;
        if (start && start < now - 3 * 60 * 60 * 1000) { diagnostics.pastKickoffFiltered += 1; continue; }
        try {
          const event = normalizeSportmonksFixture(fixture, fixture.odds || []);
          if (!event) { diagnostics.normalizedRejected += 1; continue; }
          const candidate = { event, leaguePriority: sportmonksLeaguePriority(event, configuredPriorityLeagues), startTime: start || Number.MAX_SAFE_INTEGER };
          diagnostics.normalizedEvents += 1;
          rankedEvents.push(candidate);
          rankedEvents.sort(compareSportmonksEvents);
          if (rankedEvents.length > candidateLimit) { rankedEvents.pop(); diagnostics.candidateDiscarded += 1; }
        } catch (error) { errors.push(`Fixture ${fixture.id}: ${error.message}`); }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === 'SPORTMONKS_HOURLY_BUDGET' || error?.code === 'SPORTMONKS_RATE_LIMIT_PAUSE') {
        diagnostics.pageFailures += 1;
        providerRetryAfterMs = Math.max(providerRetryAfterMs, Math.max(0, sportmonksRateLimitPauseUntil - now), 60_000);
        errors.push(error.message);
        break;
      }
      diagnostics.pageFailures += 1;
      const status = Number(error?.status);
      if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) permanentPageFailure = true;
      providerRetryAfterMs = Math.max(providerRetryAfterMs, sportmonksRetryAfterMs(error));
      errors.push(`Between ${startDate}/${endDate} page ${page - 1}: ${error.message}`);
      break; // single stream: fail/partial -> preserve cache via existing partial-refresh path
    }
  }
  const fixtureEvents = rankedEvents.slice(0, Math.min(MAX_PROVIDER_EVENTS, maxEvents)).map(candidate => candidate.event);

  if (diagnostics.pageFailures > 0) {
    const attempts = (retryState?.attempts || 0) + 1;
    const backoffMs = permanentPageFailure ? 15 * 60_000 : Math.min(15 * 60_000, 30_000 * (2 ** Math.min(attempts - 1, 5)));
    const retryAt = now + Math.max(backoffMs, providerRetryAfterMs);
    const message = errors[0] || 'Sportmonks pagination was incomplete.';
    sportmonksRetryState.set(cacheKey, { attempts, retryAt, message });
    logger.warn('Sportmonks partial refresh rejected; preserving last complete provider cache', { provider: 'sportmonks', pageFailures: diagnostics.pageFailures, retryInMs: retryAt - now, retainedEvents: cached?.events.length || 0, partialEvents: fixtureEvents.length });
    const { events: currentEvents, liveWindow } = await applySportmonksLiveWindow(cached?.events || fixtureEvents, base, maxEvents, configuredPriorityLeagues);
    return { provider: 'sportmonks', enabled: true, events: currentEvents, stale: true, transportOk: false, errors: [...errors, ...liveWindow.errors] };
  }

  // Only fully successful page requests replace the provider cache.
  sportmonksCache.set(cacheKey, { fetchedAt: now, events: fixtureEvents });
  sportmonksRetryState.delete(cacheKey);
  if (sportmonksCache.size > 1) {
    const oldest = [...sportmonksCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, sportmonksCache.size - 1)) sportmonksCache.delete(key);
  }
  for (const key of sportmonksRetryState.keys()) if (key !== cacheKey) sportmonksRetryState.delete(key);

  const { events, liveWindow } = await applySportmonksLiveWindow(fixtureEvents, base, maxEvents, configuredPriorityLeagues);
  logger.info('Sportmonks fetch completed', {
    provider: 'sportmonks', endpoint: 'fixtures/between', startDate, endDate, daysAhead,
    rawFixtures: diagnostics.rawFixtures, duplicateFixtures: diagnostics.duplicateFixtures,
    stateFiltered: diagnostics.stateFiltered, pastKickoffFiltered: diagnostics.pastKickoffFiltered,
    normalizedRejected: diagnostics.normalizedRejected, normalizedEvents: diagnostics.normalizedEvents,
    candidateDiscarded: diagnostics.candidateDiscarded, rankedCandidates: rankedEvents.length,
    returnedEvents: events.length, liveWindowEvents: liveWindow.events.length, liveWindowFailed: liveWindow.failed,
    pagesFetched, candidateLimit, paginationComplete: diagnostics.pageFailures === 0 && !hasMore,
    pageBudgetExhausted: pagesFetched >= maxPages && hasMore, pageFailures: diagnostics.pageFailures,
    retryCooldownActive: false, maxEvents, hourlyBudgetUsed: sportmonksHourBudget().used,
    errors: errors.length, errorSample: errors.slice(0, 3)
  });
  return { provider: 'sportmonks', enabled: true, events: events.slice(0, Math.min(MAX_PROVIDER_EVENTS, maxEvents)), errors };
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
  url.searchParams.set('include', 'state;participants;league.country;odds;scores;statistics.type;events.type');
  const payload = await requestJson(url, { label: `Sportmonks fixture ${id}`, maxBytes: SPORTMONKS_PAGE_MAX_BYTES });
  const raw = payload?.data || payload;
  if (!raw || !raw.id) throw new Error(`Sportmonks fixture ${id} not found.`);
  const event = normalizeSportmonksFixture(raw, raw.odds || []);
  if (!event) throw new Error(`Sportmonks fixture ${id} could not be normalized.`);
  return { provider: 'sportmonks', enabled: true, event, raw };
}

function apiSportsMarket(event, bet, source = 'api-sports') {
  const name = clean(bet.name || bet.label || bet.market || 'Market');
  const type = marketType(name, bet.id);
  const period = periodFromName(name, bet.key || bet.id || '');
  const bookmaker = clean(bet.bookmaker || bet.bookmaker_name || bet.bookmaker_id, 120) || null;
  const grouped = new Map();
  for (const value of bet.values || bet.outcomes || []) {
    const rawLabel = clean(value.value || value.name || value.label || 'Selection');
    const lineMatch = rawLabel.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
    const line = value.handicap ?? value.points ?? (lineMatch ? Number(lineMatch[1]) : null);
    const label = rawLabel;
    const selection = normalizedSelection(event.id, `${bet.id || name}:${line ?? ''}`, label, value.odd ?? value.odds ?? value.price, {
      line,
      source,
      sourceSelectionId: `${bookmaker || source}:${value.id || rawLabel}`,
      suspended: value.suspended || value.status === 'SUSPENDED'
    });
    if (!selection) continue;
    const key = `${slug(label)}|${line ?? ''}`;
    const previous = grouped.get(key);
    if (!previous || selection.odds > previous.odds) grouped.set(key, selection);
  }
  return normalizedMarket(event.id, {
    key: String(bet.id || slug(name)),
    name,
    type,
    period,
    selections: [...grouped.values()],
    source,
    bookmaker,
    updatedAt: bet.update
  });
}
function extractApiSportsOdds(payload) {
  const byFixture = new Map();
  for (const record of payload?.response || []) {
    const fixtureId = String(record.fixture?.id ?? record.id ?? record.fixture_id ?? '');
    if (!fixtureId) continue;
    const bets = [];
    if (Array.isArray(record.bets)) bets.push(...record.bets);
    if (Array.isArray(record.markets)) bets.push(...record.markets);
    for (const bookmaker of record.bookmakers || record.odds || []) {
      const bookmakerName = clean(bookmaker.name || bookmaker.title || bookmaker.id, 120);
      if (Array.isArray(bookmaker.bets)) bets.push(...bookmaker.bets.map(bet => ({ ...bet, bookmaker: bookmakerName })));
      else if (Array.isArray(bookmaker.markets)) bets.push(...bookmaker.markets.map(market => ({ ...market, bookmaker: bookmakerName })));
      else if (Array.isArray(bookmaker.values) || Array.isArray(bookmaker.outcomes)) bets.push(bookmaker);
    }
    const current = byFixture.get(fixtureId) || [];
    current.push(...bets);
    byFixture.set(fixtureId, current);
  }
  return byFixture;
}
function normalizeApiSportsFixture(raw, bets = []) {
  const fixtureId = String(raw.fixture?.id ?? raw.id ?? '');
  const event = normalizedEvent({
    provider: 'api-sports',
    providerId: fixtureId,
    sport: 'Football',
    league: raw.league?.name,
    country: raw.league?.country,
    startTime: raw.fixture?.date,
    state: raw.fixture?.status?.short || raw.fixture?.status?.long,
    providerStatus: raw.fixture?.status?.short || raw.fixture?.status?.long,
    clock: raw.fixture?.status?.elapsed ? `${raw.fixture.status.elapsed}'` : null,
    home: raw.teams?.home?.name,
    away: raw.teams?.away?.name,
    homeScore: raw.goals?.home,
    awayScore: raw.goals?.away,
    homeLogo: raw.teams?.home?.logo,
    awayLogo: raw.teams?.away?.logo,
    leagueLogo: raw.league?.logo,
    venue: raw.fixture?.venue?.name,
    periodScores: {
      '1H': { home: number(raw.score?.halftime?.home), away: number(raw.score?.halftime?.away) },
      'FT': { home: number(raw.score?.fulltime?.home ?? raw.goals?.home), away: number(raw.score?.fulltime?.away ?? raw.goals?.away) }
    }
  });
  const candidates = new Map();
  for (const bet of bets) {
    const market = apiSportsMarket(event, bet);
    if (!market) continue;
    const key = marketIdentity(market);
    const impliedTotal = market.selections.reduce((sum, selection) => sum + 1 / selection.odds, 0);
    const current = candidates.get(key);
    if (!current || impliedTotal < current.impliedTotal) candidates.set(key, { market, impliedTotal });
  }
  event.markets = [...candidates.values()].map(item => item.market);
  if (!Array.isArray(event._settlementReadySources) || event._settlementReadySources.length === 0) {
    event._settlementReadySources = [event.provider];
  }
  if (!Array.isArray(event._sources)) event._sources = [event.provider];
  return event;
}
async function apiSports(path, params = {}, quotaStore = null) {
  if (quotaStore) {
    let reservation;
    try {
      reservation = await quotaStore.reserveRequest({
        now: Date.now(),
        dailyLimit: config.apiSportsDailyQuota,
        monthlyLimit: config.apiSportsMonthlyQuota,
        cooldownMs: 1000,
        reservationId: crypto.randomUUID()
      });
    } catch {
      throw new Error('API-Sports quota storage is unavailable; outbound request blocked.');
    }
    if (reservation.status !== 'reserved') {
      throw new Error(`API-Sports quota ${reservation.status}; outbound request blocked.`);
    }
    if (reservation.waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, reservation.waitMs));
    }
  } else if (config.nodeEnv === 'production') {
    throw new Error('API-Sports quota storage is unavailable; outbound request blocked.');
  }
  const url = new URL(`${config.apiSportsBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value)); });
  return requestJson(url, { headers: { 'x-apisports-key': config.apiSportsKey }, label: 'API-Sports' });
}
function apiSportsPayloadErrors(payload, endpoint) {
  const errors = payload?.errors;
  if (!errors || typeof errors !== 'object') return [];
  const fields = Array.isArray(errors)
    ? errors.map((_, index) => String(index))
    : Object.keys(errors).filter(key => errors[key] !== null && errors[key] !== undefined && errors[key] !== '' && errors[key] !== false);
  return fields.map(field => `API-Sports ${endpoint} response reported ${clean(field, 40)} error.`);
}
export async function fetchApiSports({ quotaStore = null } = {}) {
  if (!config.apiSportsEnabled || !config.apiSportsKey) return { provider: 'api-sports', enabled: false, events: [] };
  if (config.nodeEnv === 'production' && !quotaStore) {
    return {
      provider: 'api-sports',
      enabled: true,
      transportOk: false,
      events: [],
      errors: ['API-Sports quota storage is unavailable; requests were blocked.']
    };
  }
  const requestNames = ['fixtures (live)', 'fixtures (prematch)', 'odds/live'];
  const requests = [
    cachedApiSports('fixtures', { live: 'all' }, config.apiSportsLiveRefreshSeconds, 'live', quotaStore),
    cachedApiSports('fixtures', { from: utcDate(0), to: utcDate(config.apiSportsDaysAhead) }, config.apiSportsPrematchRefreshSeconds, 'prematch', quotaStore),
    cachedApiSports('odds/live', {}, config.apiSportsLiveRefreshSeconds, 'live', quotaStore)
  ];
  for (let page = 1; page <= config.apiSportsOddsPages; page += 1) {
    requests.push(cachedApiSports('odds', { date: utcDate(0), page }, config.apiSportsPrematchRefreshSeconds, 'prematch', quotaStore));
    requestNames.push(`odds (page ${page})`);
  }
  const settled = await Promise.allSettled(requests);
  const fixturePayloads = settled.slice(0, 2).filter(item => item.status === 'fulfilled').map(item => item.value);
  const oddsPayloads = settled.slice(2).filter(item => item.status === 'fulfilled').map(item => item.value);
  const oddsByFixture = new Map();
  for (const payload of oddsPayloads) {
    for (const [fixtureId, bets] of extractApiSportsOdds(payload)) {
      const existing = oddsByFixture.get(fixtureId) || [];
      existing.push(...bets);
      oddsByFixture.set(fixtureId, existing);
    }
  }
  const rawFixtures = fixturePayloads.flatMap(payload => payload?.response || []);
  const seen = new Set();
  const events = [];
  for (const fixture of rawFixtures) {
    const id = String(fixture.fixture?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    events.push(normalizeApiSportsFixture(fixture, oddsByFixture.get(id) || []));
  }
  // Stempel harga LIVE dari fetchedAt cache odds/live yang ASLI — bukan Date.now():
  // siklus refresh menormalisasi ulang payload cache tiap 30 detik, jadi stempel
  // harus menua bersama cache dan hanya kembali segar saat fetch provider benar-
  // benar terjadi. suspendStaleLiveMarkets() memakai angka ini untuk menutup
  // market live yang harganya basi; tanpa stempel = dianggap basi (fail-closed).
  const oddsLiveFetchedAt = providerRequestCache.get('api-sports:odds/live:[]')?.fetchedAt;
  if (Number.isFinite(oddsLiveFetchedAt)) {
    const stamp = new Date(oddsLiveFetchedAt).toISOString();
    for (const event of events) {
      if (!event.live) continue;
      for (const market of event.markets || []) {
        if (!market.updatedAt) market.updatedAt = stamp;
      }
    }
  }
  const prematchOddsFetchedAt = [...providerRequestCache.entries()]
    .filter(([key, entry]) => key.startsWith('api-sports:odds:') && key !== 'api-sports:odds/live:[]' && entry?.value !== undefined)
    .reduce((latest, [, entry]) => Math.max(latest, Number(entry.fetchedAt) || 0), 0);
  if (prematchOddsFetchedAt > 0) {
    const stamp = new Date(prematchOddsFetchedAt).toISOString();
    for (const event of events) {
      if (event.live) continue;
      for (const market of event.markets || []) {
        if (!market.updatedAt) market.updatedAt = stamp;
        for (const selection of market.selections || []) {
          if (!selection.updatedAt) selection.updatedAt = market.updatedAt;
        }
      }
    }
  }
  const errors = settled.flatMap((result, index) => result.status === 'fulfilled'
    ? apiSportsPayloadErrors(result.value, requestNames[index])
    : [clean(result.reason?.message || 'request failed')]);
  return { provider: 'api-sports', enabled: true, transportOk: errors.length === 0, events: events.slice(0, MAX_PROVIDER_EVENTS), errors };
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
  const events = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, MAX_PROVIDER_EVENTS);
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
    if (source === 'api-sports') return 30;
    if (source === 'sportmonks') return 10;
    return 0;
  }

  if (source === 'footballdata-io') return 55;
  if (source === 'sharpapi') return 50;
  if (source === 'public-market') return 40;
  if (source === 'oddspapi') return 5;

  return source === 'api-sports' ? 20 : 10;
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
function mergeMarkets(target, incoming, live) {
  const map = new Map(target.map(item => [marketIdentity(item), item]));
  for (const candidate of incoming) {
    const key = marketIdentity(candidate);
    const current = map.get(key);
    const candidateAvailable = marketBettingAvailable(candidate);
    const currentAvailable = marketBettingAvailable(current);
    if (!current
      || (candidateAvailable && !currentAvailable)
      || (candidateAvailable === currentAvailable && sourcePriority(candidate.source, live) > sourcePriority(current.source, live))
      || (candidateAvailable === currentAvailable && candidate.source === current.source && candidate.selections.length > current.selections.length)) {
      map.set(key, candidate);
    }
  }
  return [...map.values()].sort((a, b) => {
    const order = { '1X2': 1, HANDICAP: 2, TOTALS: 3, BTTS: 4, DOUBLE_CHANCE: 5, DRAW_NO_BET: 6, TEAM_TOTAL: 7, HT_FT: 8, ODD_EVEN: 9, CORRECT_SCORE: 10, CORNERS: 11, CARDS: 12, PLAYER_PROP: 13, BET_BUILDER: 14, OTHER: 99 };
    return (order[a.type] || 50) - (order[b.type] || 50);
  });
}
function mergeEvent(target, incoming) {
  const targetPriority = target._sources.includes('api-sports') ? 4 : target._sources.includes('sharpapi') ? 3 : 1;
  const incomingPriority = incoming._sources.includes('api-sports') ? 4 : incoming._sources.includes('sharpapi') ? 3 : 1;
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
  if (readySources.has('api-sports') || readySources.has('public-market') || readySources.has('footballdata-io')) return event;
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
  for (const candidate of ordered) {
    const fixtureKey = `${candidate.sport}|${teamKey(candidate.home.name)}|${teamKey(candidate.away.name)}`;
    const candidates = fixturesByTeams.get(fixtureKey) || [];
    const existing = candidates.find(event => sameFixture(event, candidate));
    if (existing) mergeEvent(existing, candidate);
    else {
      if (events.length >= MAX_PROVIDER_EVENTS) continue;
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
  normalizeApiSportsFixture,
  normalizeSportsDbEvent,
  normalizeSportmonksFixture,
  mergeProviderEvents,
  applyManualFtSettlementFallback,
  marketBettingAvailable,
  marketType,
  eventId,
  selectionId,
  periodFromName,
  extractApiSportsOdds,
  apiSportsQuotaFloorSeconds,
  suspendStaleLiveMarkets,
  providerRequestCache,
  sportmonksCache,
  sportmonksCacheTtlMs,
  sportmonksRetryState,
  sportmonksLiveCache,
  sportmonksLiveRetryState,
  // B4 test hooks (mock fetch only)
  sportmonksFiltersParam,
  noteSportmonksRateLimit,
  sportmonksHourBudget,
  _resetSportmonksBudgetForTest() { sportmonksHourWindowStart = 0; sportmonksRequestsThisHour = 0; sportmonksRateLimitPauseUntil = 0; sportmonksCache.clear(); sportmonksRetryState.clear(); }
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
  hash
};
