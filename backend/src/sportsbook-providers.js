import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const MAX_PROVIDER_EVENTS = 1200;
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
  cards: 'CARDS',
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
  if (/(?:^|_)h1(?:_|$)|first_half|1st_half|firsthalf|half_time(?!_full)|halftime(?!_full)/.test(raw)) return '1H';
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
    _sources: [provider]
  };
}

async function requestJson(url, { headers = {}, label = 'sports provider' } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sportsFeedRequestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'ASEAN777-Sports-Aggregator/2.0', ...headers },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 12 * 1024 * 1024) throw new Error(`${label} response exceeds size limit`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

const providerRequestCache = new Map();
async function cachedRequest(key, ttlMs, fetcher) {
  const now = Date.now();
  const cached = providerRequestCache.get(key);
  if (cached?.value !== undefined && now - cached.fetchedAt < ttlMs) return cached.value;
  if (cached?.inFlight) return cached.inFlight;
  const inFlight = Promise.resolve().then(fetcher).then(value => {
    if (providerRequestCache.size > 300) {
      const oldest = [...providerRequestCache.entries()].sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0));
      for (const [k] of oldest.slice(0, 50)) providerRequestCache.delete(k);
    }
    providerRequestCache.set(key, { value, fetchedAt: Date.now(), inFlight: null });
    return value;
  }).catch(error => {
    if (cached?.value !== undefined) providerRequestCache.set(key, cached);
    else providerRequestCache.delete(key);
    throw error;
  });
  providerRequestCache.set(key, { value: cached?.value, fetchedAt: cached?.fetchedAt || 0, inFlight });
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

function cachedApiSports(path, params, ttlSeconds, bucket = 'prematch') {
  const entries = Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b));
  const key = `api-sports:${path}:${JSON.stringify(entries)}`;
  const floorSeconds = apiSportsQuotaFloorSeconds(bucket);
  const ttl = Math.max(ttlSeconds, floorSeconds);
  return cachedRequest(key, ttl * 1000, async () => {
    try {
      return await apiSports(path, params);
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
function sharpEventKey(row) {
  return clean(row.event_uuid || row.event_id, 180);
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
  const byEvent = new Map();
  for (const row of rows) {
    if (!row || clean(row.sport).toLowerCase() !== clean(config.sharpApiSport).toLowerCase()) continue;
    if (config.sharpApiMainLinesOnly && row.is_main_line === false && row.is_alternate_line === true) continue;
    const key = sharpEventKey(row);
    if (!key || !row.home_team || !row.away_team || !row.event_start_time) continue;
    const current = byEvent.get(key) || [];
    current.push(row);
    byEvent.set(key, current);
  }
  const events = [];
  for (const [providerId, eventRows] of byEvent) {
    const chosenBook = chooseSharpSportsbook(eventRows);
    if (!chosenBook) continue;
    const selectedRows = eventRows.filter(row => clean(row.sportsbook).toLowerCase() === chosenBook);
    if (!selectedRows.length) continue;
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
      const sample = group[0];
      const rawName = clean(sample.market_ref?.label || sample.market_name || sample.market_type, 120);
      const type = sharpDerivedMarketType(sample);
      const period = periodFromName(sample.market_segment || sample.market_type, sample.market_type);
      const line = sharpCanonicalLine(sample, type);
      const marketKey = `${sample.market_type}:${type}:${period}:${line ?? ''}:${chosenBook}`;
      const selections = group.map(row => normalizedSelection(
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
      )).filter(Boolean);
      const sideSet = new Set(group.map(row => clean(row.selection_type || row.team_side, 40).toLowerCase()));
      const minimumSelections = ['1X2', 'DOUBLE_CHANCE'].includes(type) ? 3 : ['HANDICAP', 'TOTALS', 'TEAM_TOTAL', 'BTTS', 'DRAW_NO_BET', 'ODD_EVEN', 'PLAYER_PROP'].includes(type) ? 2 : 1;
      if (selections.length < minimumSelections) return null;
      if (type === '1X2' && !['home', 'draw', 'away'].every(side => sideSet.has(side))) return null;
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
    event.markets = event.markets.slice(0, 160);
    if (event.markets.length) events.push(event);
  }
  return events.slice(0, MAX_PROVIDER_EVENTS);
}
async function sharpApiOddsPage(cursor = null) {
  const url = new URL(`${config.sharpApiBaseUrl.replace(/\/$/, '')}/api/v1/odds`);
  url.searchParams.set('sport', config.sharpApiSport);
  if (config.sharpApiMarkets) url.searchParams.set('market', config.sharpApiMarkets);
  if (config.sharpApiSportsbook) url.searchParams.set('sportsbook', config.sharpApiSportsbook);
  url.searchParams.set('limit', String(config.sharpApiPageSize));
  if (cursor) url.searchParams.set('cursor', cursor);
  return requestJson(url, { headers: { 'X-API-Key': config.sharpApiKey }, label: 'SharpAPI' });
}
export async function fetchSharpApi() {
  if (!config.sharpApiEnabled || !config.sharpApiKey) return { provider: 'sharpapi', enabled: false, events: [] };
  const cacheKey = `sharpapi:${config.sharpApiSport}:${config.sharpApiMarkets}:${config.sharpApiSportsbook || '*'}:${config.sharpApiMainLinesOnly}`;
  const payload = await cachedRequest(cacheKey, config.sharpApiRefreshSeconds * 1000, async () => {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < config.sharpApiMaxPages; page += 1) {
      const current = await sharpApiOddsPage(cursor);
      rows.push(...(Array.isArray(current?.data) ? current.data : []));
      const pagination = current?.pagination || {};
      if (!pagination.has_more || !pagination.next_cursor) break;
      cursor = pagination.next_cursor;
    }
    return rows;
  });
  return { provider: 'sharpapi', enabled: true, events: normalizeSharpApiRows(payload), errors: [] };
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

function oddsApiMarket(event, market, source = 'the-odds-api', bookmaker = null) {
  const type = marketType(market.key, market.key);
  const period = periodFromName(market.name || market.key, market.key);
  const marketLine = market.outcomes?.[0]?.point ?? null;
  const grouped = new Map();
  for (const outcome of market.outcomes || []) {
    const line = outcome.point ?? null;
    const label = type === '1X2'
      ? outcome.name === event.home.name ? 'Home' : outcome.name === event.away.name ? 'Away' : /draw/i.test(outcome.name) ? 'Draw' : outcome.name
      : `${outcome.name}${line !== null ? ` ${line > 0 ? '+' : ''}${line}` : ''}`;
    const selection = normalizedSelection(event.id, `${market.key}:${line ?? ''}`, label, outcome.price, {
      line,
      source,
      sourceSelectionId: `${bookmaker || source}:${outcome.name}:${line ?? ''}`
    });
    if (!selection) continue;
    const key = `${slug(label)}|${line ?? ''}`;
    const previous = grouped.get(key);
    if (!previous || selection.odds > previous.odds) grouped.set(key, selection);
  }
  let selections = [...grouped.values()];
  
  // Validasi odds handicap - jika tidak valid, return null (hapus market)
  // Ini mencegah odds 1X2 tercampur ke handicap 0
  if (type === 'HANDICAP' && (marketLine === 0 || marketLine === null)) {
    if (!isHandicapOddsValid(selections, marketLine)) {
      return null; // Hapus market ini - odds tidak valid
    }
  }
  
  return normalizedMarket(event.id, {
    key: market.key,
    name: marketLabel(type, market.name || market.key, market.key),
    type,
    period,
    line: marketLine,
    selections,
    source,
    bookmaker,
    updatedAt: market.last_update
  });
}
const oddsApiEventDetailCache = new Map();
let oddsApiEventSportCursor = 0;

function allocateOddsApiEventMarkets(sports) {
  const allocations = new Map(sports.map(sport => [sport, 0]));
  const perSportLimit = Math.max(0, Number(config.theOddsApiEventMaxEventsPerSport) || 0);
  let remaining = Math.min(
    Math.max(0, Number(config.theOddsApiEventMaxTotalEvents) || 0),
    sports.length * perSportLimit
  );
  if (!sports.length || !remaining || !perSportLimit) return allocations;

  const start = oddsApiEventSportCursor % sports.length;
  while (remaining > 0) {
    let allocated = false;
    for (let offset = 0; offset < sports.length && remaining > 0; offset += 1) {
      const sport = sports[(start + offset) % sports.length];
      if (allocations.get(sport) >= perSportLimit) continue;
      allocations.set(sport, allocations.get(sport) + 1);
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  oddsApiEventSportCursor = (start + 1) % sports.length;
  return allocations;
}

function mergeOddsApiBookmakers(base = [], extra = []) {
  const byBook = new Map();
  for (const bookmaker of [...base, ...extra]) {
    if (!bookmaker || typeof bookmaker !== 'object') continue;
    const key = clean(bookmaker.key || bookmaker.title || bookmaker.name || 'bookmaker');
    const current = byBook.get(key) || { ...bookmaker, markets: [] };
    const marketMap = new Map((current.markets || []).map(market => [market.key, market]));
    for (const market of bookmaker.markets || []) {
      const existing = marketMap.get(market.key);
      if (!existing || Date.parse(market.last_update || '') >= Date.parse(existing.last_update || '')) marketMap.set(market.key, market);
    }
    current.markets = [...marketMap.values()];
    byBook.set(key, current);
  }
  return [...byBook.values()];
}

async function fetchOddsApiEventMarkets(sportKey, rawEvents, maxEvents = config.theOddsApiEventMaxEventsPerSport) {
  const markets = commaList(config.theOddsApiEventMarkets);
  if (!config.theOddsApiEventMarketsEnabled || !markets.length || !rawEvents.length || !maxEvents) return rawEvents;
  const eventLimit = Math.max(0, Math.min(Number(maxEvents) || 0, config.theOddsApiEventMaxEventsPerSport));
  const refreshMs = config.theOddsApiEventRefreshSeconds * 1000;
  const selected = rawEvents
    .filter(event => event?.id && !event.completed)
    .sort((a, b) => Date.parse(a.commence_time || '') - Date.parse(b.commence_time || ''))
    .slice(0, eventLimit);
  const extras = new Map();
  await Promise.all(selected.map(async event => {
    const cacheKey = `${sportKey}:${event.id}:${markets.join(',')}:${config.theOddsApiRegions}:${config.theOddsApiBookmakers || ''}`;
    const cached = oddsApiEventDetailCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < refreshMs) {
      extras.set(event.id, cached.payload);
      return;
    }
    try {
      const url = new URL(`${config.theOddsApiBaseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(event.id)}/odds`);
      url.searchParams.set('apiKey', config.theOddsApiKey);
      url.searchParams.set('regions', config.theOddsApiRegions);
      url.searchParams.set('markets', markets.join(','));
      url.searchParams.set('oddsFormat', 'decimal');
      url.searchParams.set('dateFormat', 'iso');
      if (config.theOddsApiBookmakers) url.searchParams.set('bookmakers', config.theOddsApiBookmakers);
      const payload = await requestJson(url, { label: 'The Odds API event markets' });
      if (payload && typeof payload === 'object') {
        if (oddsApiEventDetailCache.size > 300) {
          const oldest = [...oddsApiEventDetailCache.entries()].sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0));
          for (const [k] of oldest.slice(0, 50)) oddsApiEventDetailCache.delete(k);
        }
        oddsApiEventDetailCache.set(cacheKey, { fetchedAt: Date.now(), payload });
        extras.set(event.id, payload);
      }
    } catch {}
  }));
  return rawEvents.map(event => {
    const extra = extras.get(event.id);
    if (!extra) return event;
    return { ...event, bookmakers: mergeOddsApiBookmakers(event.bookmakers || [], extra.bookmakers || []) };
  });
}

function normalizeOddsApiEvent(raw) {
  const event = normalizedEvent({
    provider: 'the-odds-api',
    providerId: raw.id,
    sport: raw.sport_key,
    league: raw.sport_title,
    startTime: raw.commence_time,
    state: raw.completed ? 'FINISHED' : Date.parse(raw.commence_time) <= Date.now() ? 'LIVE' : 'SCHEDULED',
    home: raw.home_team,
    away: raw.away_team
  });
  const sourceMarkets = new Map();
  const preferredBookmakers = commaList(config.theOddsApiBookmakers).map(value => value.toLowerCase());
  const bookmakerRank = bookmaker => {
    const index = preferredBookmakers.findIndex(value => bookmaker.toLowerCase() === value || bookmaker.toLowerCase().includes(value));
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  for (const bookmaker of raw.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      const bookmakerName = clean(bookmaker.title || bookmaker.name || bookmaker.key, 120);
      const normalized = oddsApiMarket(event, market, 'the-odds-api', bookmakerName);
      if (!normalized) continue;
      const key = marketIdentity(normalized);
      const impliedTotal = normalized.selections.reduce((sum, selection) => sum + 1 / selection.odds, 0);
      if (((normalized.type === 'HANDICAP' && normalized.selections.length === 2)
        || (normalized.type === '1X2' && normalized.selections.length === 3))
        && (impliedTotal < 1 || impliedTotal > 1.25)) continue;
      const current = sourceMarkets.get(key);
      if (!current || impliedTotal < current.impliedTotal ||
        (impliedTotal === current.impliedTotal && bookmakerRank(bookmaker.key || bookmakerName) < bookmakerRank(current.bookmakerKey))) {
        sourceMarkets.set(key, { market: normalized, impliedTotal, bookmakerKey: bookmaker.key || bookmakerName });
      }
    }
  }
  event.markets = [...sourceMarkets.values()].map(item => item.market);
  return event;
}
export async function fetchTheOddsApi() {
  if (!config.theOddsApiEnabled || !config.theOddsApiKey) return { provider: 'the-odds-api', enabled: false, events: [] };
  const sports = commaList(config.theOddsApiSportKeys);
  const eventMarketAllocations = allocateOddsApiEventMarkets(sports);
  const settled = await Promise.allSettled(sports.map(async sportKey => {
    const url = new URL(`${config.theOddsApiBaseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(sportKey)}/odds`);
    url.searchParams.set('apiKey', config.theOddsApiKey);
    url.searchParams.set('regions', config.theOddsApiRegions);
    url.searchParams.set('markets', config.theOddsApiMarkets);
    url.searchParams.set('oddsFormat', 'decimal');
    url.searchParams.set('dateFormat', 'iso');
    if (config.theOddsApiBookmakers) url.searchParams.set('bookmakers', config.theOddsApiBookmakers);
    const cacheKey = `the-odds-api:${sportKey}:${config.theOddsApiRegions}:${config.theOddsApiMarkets}:${config.theOddsApiBookmakers || ''}`;
    const payload = await cachedRequest(cacheKey, config.theOddsApiRefreshSeconds * 1000, () => requestJson(url, { label: 'The Odds API' }));
    const rawEvents = Array.isArray(payload) ? payload : [];
    const enriched = await fetchOddsApiEventMarkets(sportKey, rawEvents, eventMarketAllocations.get(sportKey) || 0);
    return enriched.map(normalizeOddsApiEvent);
  }));
  const events = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, Math.min(MAX_PROVIDER_EVENTS, Math.max(0, Number(config.theOddsApiMaxTotalEvents) || MAX_PROVIDER_EVENTS)));
  const errors = settled.filter(result => result.status === 'rejected').map(result => clean(result.reason?.message || 'request failed'));
  return { provider: 'the-odds-api', enabled: true, events, errors };
}

// --- Sportmonks (v3 football) ---
// The supplied Sportmonks plan does not expose the standalone /football/odds/*
// endpoints (HTTP 404) and the `markets` filter is ignored on fixture includes, so
// prematch prices are collected per fixture via `include=odds;scores` (~1.5 MB
// each, every market/bookmaker). Payloads are parsed and normalized once, cached
// as ready events, and the global event cap bounds both resident memory and the
// number of outbound odds requests per refresh cycle.
const sportmonksEventCache = new Map();
const SPORTMONKS_LIVE_STATES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'INPLAY']);
const SPORTMONKS_FINISHED_STATES = new Set(['FT', 'AET', 'PEN', 'FINISHED', 'ENDED']);
const SPORTMONKS_SUSPENDED_STATES = new Set(['CANCL', 'POSTP', 'SUSP', 'SU', 'ABAND', 'DELAYED', 'CANCELED', 'CANCELLED', 'POSTPONED', 'SUSPENDED', 'ABANDONED']);
function sportmonksState(raw) {
  const short = clean(raw?.short_name || raw?.name || raw?.state || '', 40).toUpperCase();
  if (SPORTMONKS_LIVE_STATES.has(short) || /HALF|LIVE/.test(short)) return 'LIVE';
  if (SPORTMONKS_FINISHED_STATES.has(short)) return 'FINISHED';
  if (SPORTMONKS_SUSPENDED_STATES.has(short)) return 'SUSPENDED';
  return 'SCHEDULED';
}
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
  return total || null;
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

function normalizeSportmonksFixture(raw, oddsRows = []) {
  const participants = Array.isArray(raw?.participants) ? raw.participants : [];
  const home = participants.find(participant => participant?.meta?.location === 'home') || participants[0];
  const away = participants.find(participant => participant?.meta?.location === 'away') || participants[1];
  if (!home?.name || !away?.name) return null;
  const byMarket = new Map();
  for (const row of Array.isArray(oddsRows) ? oddsRows : []) {
    const marketId = String(row?.market_id ?? '');
    if (!marketId) continue;
    const list = byMarket.get(marketId) || [];
    list.push(row);
    byMarket.set(marketId, list);
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
  // Unsupported market families (shots, winning margin, specials, player props…)
  // classify as OTHER and are dropped; the per-event market cap keeps memory bounded.
  event.markets = [...byMarket.values()].map(rows => sportmonksMarket(event, rows)).filter(Boolean).slice(0, 120);
  return event;
}
function sportmonksMarket(event, rows) {
  const sample = rows[0] || {};
  const description = clean(sample.market_description || sample.name || `Market ${sample.market_id ?? ''}`, 120);
  const type = sportmonksMarketType(description);
  if (type === 'OTHER') return null;
  const period = periodFromName(description, `m${sample.market_id ?? ''}`);
  const grouped = new Map();
  for (const row of rows) {
    const line = sportmonksLine(type, row);
    const label = sportmonksLabel(type, row);
    const selection = normalizedSelection(event.id, `m${sample.market_id}:${line ?? ''}`, label, row?.value, {
      line,
      source: 'sportmonks',
      sourceSelectionId: String(row?.id ?? `${sample.market_id}:${label}`),
      suspended: Boolean(row?.stopped),
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
    key: `m${sample.market_id}`,
    name: marketLabel(type, description, `m${sample.market_id}`),
    type,
    period,
    selections,
    source: 'sportmonks',
    sourceMarketId: sample.market_id ? `m${sample.market_id}` : null,
    suspended: selections.every(selection => selection.suspended),
    updatedAt
  });
}

// Cache untuk data Sportmonks dengan TTL 2 menit
const sportmonksCache = new Map();
const SPORTMONKS_CACHE_TTL = 2 * 60 * 1000; // 2 menit

// Fetch semua halaman data dari Sportmonks dengan pagination
async function fetchAllPages(base, endpoint, params, maxPages = 10) {
  const allData = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= maxPages) {
    const url = new URL(`${base}${endpoint}`);
    url.searchParams.set('api_token', config.sportmonksKey);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '50');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    
    try {
      const payload = await requestJson(url, { label: `Sportmonks page ${page}` });
      const data = payload?.data || [];
      if (data.length === 0) {
        hasMore = false;
      } else {
        allData.push(...data);
        // Cek apakah masih ada halaman berikutnya
        hasMore = data.length >= 50 && payload?.pagination?.has_more;
        page++;
      }
    } catch (error) {
      logger.warn(`Sportmonks pagination error page ${page}: ${error.message}`);
      hasMore = false;
    }
  }
  
  return allData;
}

export async function fetchSportmonks() {
  if (!config.sportmonksEnabled || !config.sportmonksKey) {
    logger.warn('Sportmonks disabled or missing API key');
    return { provider: 'sportmonks', enabled: false, events: [] };
  }
  
  const base = config.sportmonksBaseUrl.replace(/\/$/, '');
  const now = Date.now();
  const cacheKey = `sportmonks:all-events:${utcDate(0)}`;
  
  // Cek cache terlebih dahulu (TTL 2 menit)
  const cached = sportmonksCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < SPORTMONKS_CACHE_TTL) {
    logger.info('Sportmonks: returning cached data', { age: Math.round((now - cached.fetchedAt) / 1000) + 's' });
    return { provider: 'sportmonks', enabled: true, events: cached.events, errors: [] };
  }
  
  const daysAhead = Math.max(0, Number(config.sportmonksDaysAhead) || 0);
  const dates = [];
  for (let offset = 0; offset <= daysAhead; offset += 1) dates.push(utcDate(offset));
  
  const errors = [];
  const allFixtures = [];
  const seen = new Set();
  
  // Fetch fixtures untuk setiap tanggal dengan pagination
  for (const date of dates) {
    try {
      // Gunakan include untuk mendapatkan semua data dalam satu request
      const fixtures = await fetchAllPages(base, `/football/fixtures/date/${date}`, {
        include: 'state;participants;league.country;odds;scores'
      });
      
      for (const fixture of fixtures) {
        const id = String(fixture?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        
        const state = sportmonksState(fixture.state);
        if (state !== 'SCHEDULED' && state !== 'LIVE') continue;
        if (fixture.has_odds === false) continue;
        
        allFixtures.push(fixture);
      }
    } catch (error) {
      errors.push(`Date ${date}: ${error.message}`);
    }
  }
  
  // Filter dan urutkan fixtures
  const maxEvents = Math.max(0, Number(config.sportmonksMaxTotalEvents) || 0);
  const selected = allFixtures
    .filter(f => {
      const start = Number(f.starting_at_timestamp) * 1000 || Date.parse(f.starting_at || '') || 0;
      return !start || start >= now - 3 * 60 * 60 * 1000;
    })
    .sort((a, b) => {
      const aStart = Number(a.starting_at_timestamp) * 1000 || Date.parse(a.starting_at || '') || 0;
      const bStart = Number(b.starting_at_timestamp) * 1000 || Date.parse(b.starting_at || '') || 0;
      return aStart - bStart;
    })
    .slice(0, maxEvents);
  
  // Normalize fixtures menjadi events
  const events = [];
  for (const fixture of selected) {
    try {
      const event = normalizeSportmonksFixture(fixture, fixture.odds || []);
      if (event && event.markets.length) {
        events.push(event);
      }
    } catch (error) {
      errors.push(`Fixture ${fixture.id}: ${error.message}`);
    }
  }
  
  // Simpan ke cache
  sportmonksCache.set(cacheKey, { fetchedAt: now, events });
  
  // Bounded cache: hapus entri lama jika terlalu banyak
  if (sportmonksCache.size > 10) {
    const oldest = [...sportmonksCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, sportmonksCache.size - 5)) {
      sportmonksCache.delete(key);
    }
  }
  
  return { provider: 'sportmonks', enabled: true, events: events.slice(0, MAX_PROVIDER_EVENTS), errors };
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
  return event;
}
async function apiSports(path, params = {}) {
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
export async function fetchApiSports() {
  if (!config.apiSportsEnabled || !config.apiSportsKey) return { provider: 'api-sports', enabled: false, events: [] };
  const requestNames = ['fixtures (live)', 'fixtures (prematch)', 'odds/live'];
  const requests = [
    cachedApiSports('fixtures', { live: 'all' }, config.apiSportsLiveRefreshSeconds, 'live'),
    cachedApiSports('fixtures', { from: utcDate(0), to: utcDate(config.apiSportsDaysAhead) }, config.apiSportsPrematchRefreshSeconds, 'prematch'),
    cachedApiSports('odds/live', {}, config.apiSportsLiveRefreshSeconds, 'live')
  ];
  for (let page = 1; page <= config.apiSportsOddsPages; page += 1) {
    requests.push(cachedApiSports('odds', { date: utcDate(0), page }, config.apiSportsPrematchRefreshSeconds, 'prematch'));
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
  const direct = teamKey(a.home.name) === teamKey(b.home.name) && teamKey(a.away.name) === teamKey(b.away.name);
  return direct && (kickoffDistance(a.startTime, b.startTime) <= 3 * 60 * 60 * 1000 || !a.startTime || !b.startTime);
}
function marketIdentity(market) {
  return `${market.type}|${market.period}|${market.line ?? ''}|${slug(market.label)}`;
}
function sourcePriority(source, live) {
  if (live) {
    if (source === 'api-sports') return 30;
    if (source === 'the-odds-api') return 20;
    if (source === 'sportmonks') return 10;
    return 0;
  }

  if (source === 'footballdata-io') return 55;
  if (source === 'sharpapi') return 50;
  if (source === 'the-odds-api') return 45;
  if (source === 'public-market') return 40;

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
  const targetPriority = target._sources.includes('api-sports') ? 4 : target._sources.includes('sharpapi') ? 3 : target._sources.includes('the-odds-api') ? 2 : 1;
  const incomingPriority = incoming._sources.includes('api-sports') ? 4 : incoming._sources.includes('sharpapi') ? 3 : incoming._sources.includes('the-odds-api') ? 2 : 1;
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
  const readySources = Array.isArray(event._settlementReadySources) ? event._settlementReadySources : event._sources || [];
  const sources = new Set(readySources);
  const supportsFullTimeSettlement = sources.has('api-sports') || sources.has('public-market') || sources.has('footballdata-io') || sources.has('sportmonks') || sources.has('manual-ops');
  const supportsHalfTimeSettlement = sources.has('api-sports') || sources.has('public-market');
  event.markets = (event.markets || []).map(market => {
    const period = market.period || 'FT';
    const mustSuspend = !supportsFullTimeSettlement || (period === '1H' && !supportsHalfTimeSettlement);
    return mustSuspend
      ? { ...market, suspended: true, selections: market.selections.map(selection => ({ ...selection, suspended: true })) }
      : market;
  });
  return event;
}
export function mergeProviderEvents(providerResults, options = {}) {
  const events = [];
  const ordered = providerResults.flatMap(result => result.events || []).sort((a, b) => Date.parse(a.startTime || '') - Date.parse(b.startTime || ''));
  for (const candidate of ordered) {
    const existing = events.find(event => sameFixture(event, candidate));
    if (existing) mergeEvent(existing, candidate);
    else events.push(structuredClone(candidate));
  }
  return events.slice(0, MAX_PROVIDER_EVENTS).map(event => applySettlementSafety(applyManualFtSettlementFallback(event, options)));
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
    availableMarketCount: Number(event.availableMarketCount || event.markets?.length || 0),
    detailLoaded: Boolean(event.detailFetchedAt),
    detailFetchedAt: event.detailFetchedAt || null,
    markets: event.markets.map(market => ({
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
  normalizeOddsApiEvent,
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
  allocateOddsApiEventMarkets
};

// Builder helpers shared by provider adapters (e.g. sportsbook-footballdataio.js)
// so every provider emits the exact normalized event/market/selection shape that
// mergeProviderEvents consumes.
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
