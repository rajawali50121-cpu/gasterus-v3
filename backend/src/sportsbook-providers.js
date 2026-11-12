import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureBoundedCacheCapacity, pruneExpiredCacheEntries, setBoundedCacheEntry } from './bounded-cache.js';
import { readBoundedResponseText } from './bounded-response.js';

const MAX_PROVIDER_EVENTS = 5000;
const MAX_PROVIDER_MARKETS_PER_EVENT = 120;
const MAX_PROVIDER_SELECTIONS_PER_MARKET = 250;
const MAX_ODDS_API_DETAIL_CACHE_ENTRIES = 100;
const ODDS_API_DETAIL_CACHE_TTL_MULTIPLIER = 2;
const ODDS_API_DETAIL_FETCH_CONCURRENCY = 4;
const ODDS_API_SPORT_FETCH_CONCURRENCY = 4;
const MOVIODDS_GROUPS = Object.freeze({
  '40': Object.freeze({ type: '1X2', period: 'FT', label: '1X2', kind: 'result' }),
  '938': Object.freeze({ type: 'HANDICAP', period: 'FT', label: 'Asian Handicap', kind: 'handicap' }),
  '981': Object.freeze({ type: 'TOTALS', period: 'FT', label: 'Goals Over/Under', kind: 'totals' }),
  '10202': Object.freeze({ type: 'TOTALS', period: 'FT', label: 'Alternative Total Goals', kind: 'totals' }),
  '10143': Object.freeze({ type: 'TOTALS', period: 'FT', label: 'Alternative Goals Over/Under', kind: 'totals' }),
  '50139': Object.freeze({ type: 'TOTALS', period: 'FT', label: 'Alternative Goals Over/Under', kind: 'totals' }),
  '50136': Object.freeze({ type: 'TOTALS', period: '1H', label: '1st Half Goal Line', kind: 'totals' }),
  '10538': Object.freeze({ type: 'TOTALS', period: '1H', label: '1st Half Goals', kind: 'totals' }),
  '50137': Object.freeze({ type: 'HANDICAP', period: '1H', label: '1st Half Asian Handicap', kind: 'handicap' }),
  '50138': Object.freeze({ type: 'HANDICAP', period: 'FT', label: 'Alternative Asian Handicap', kind: 'handicap' }),
  '178002': Object.freeze({ type: 'HANDICAP', period: 'FT', label: '2-Way Handicap', kind: 'handicap' }),
  '178004': Object.freeze({ type: 'HANDICAP', period: '1H', label: '1st Half 2-Way Handicap', kind: 'handicap' })
});
const MOVIODDS_FORBIDDEN_GROUPS = new Set(['1777', '4001']);
const TRUSTED_RESULT_PROVIDERS = new Set(['sportmonks', 'api-sports', 'public-market', 'footballdata-io']);
const TRUSTED_HALF_TIME_RESULT_PROVIDERS = new Set(['sportmonks', 'api-sports', 'public-market']);
const SETTLEABLE_MARKET_TYPES = new Set([
  '1X2', 'HANDICAP', 'TOTALS', 'DRAW_NO_BET', 'TEAM_TOTAL',
  'HT_FT', 'BTTS', 'DOUBLE_CHANCE', 'ODD_EVEN', 'CORRECT_SCORE'
]);
const movioddsTotalsGroupPriority = new Map(config.movioddsTotalsGroupPriority.map((groupId, index) => [groupId, index]));
const movioddsVirtualLeaguePattern = new RegExp(config.movioddsVirtualLeaguePattern, 'i');
const movioddsVirtualTeamPattern = new RegExp(config.movioddsVirtualTeamPattern, 'i');
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
function leagueKey(value) {
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

async function requestJson(url, { headers = {}, label = 'sports provider', maxBytes = config.sportsProviderCacheMaxEntryBytes, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => abortCause('provider-timeout'), config.sportsFeedRequestTimeoutMs);
  let firstCause = null;

  const abortCause = (reason) => {
    if (firstCause === null) {
      firstCause = reason;
    }
    controller.abort();
  };

  const onExternalAbort = () => abortCause('shutdown');
  if (signal) {
    if (signal.aborted) abortCause('shutdown');
    else signal.addEventListener('abort', onExternalAbort, { once: true });
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
      error.cause = firstCause;
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        const retryAfterSeconds = Number(retryAfter);
        const retryAfterDate = Date.parse(retryAfter || '');
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
          error.retryAfterAt = Date.now() + retryAfterSeconds * 1000;
        } else if (Number.isFinite(retryAfterDate)) {
          error.retryAfterAt = Math.max(Date.now(), retryAfterDate);
        } else {
          const resetHeader = response.headers?.get?.('x-ratelimit-reset');
          const resetSeconds = Number(resetHeader);
          if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
            const resetAt = resetSeconds * 1000;
            if (resetAt > Date.now()) {
              error.retryAfterAt = Math.min(resetAt, Date.now() + 3600000);
            }
          }
        }
      }
      throw error;
    }
    const text = await readBoundedResponseText(response, label, maxBytes);
    return JSON.parse(text);
  } catch (error) {
    if (!error.cause) error.cause = firstCause;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

const providerRequestCache = new Map();
const providerRequestGeneration = new Map();
function nextGeneration(key) {
  const current = providerRequestGeneration.get(key) || 0;
  const next = current + 1;
  providerRequestGeneration.set(key, next);
  return next;
}
async function cachedRequest(key, ttlMs, fetcher, { signal, generation } = {}) {
  const now = Date.now();
  pruneExpiredCacheEntries(providerRequestCache, now);
  const cached = providerRequestCache.get(key);

  const requestGeneration = generation !== null ? generation : nextGeneration(key);

  if (cached?.value !== undefined) {
    if (now - cached.fetchedAt < ttlMs) return cached.value;
    providerRequestCache.delete(key);
  }

  if (cached?.inFlight && cached.generation === requestGeneration) {
    return wrapConsumerPromise(cached.inFlight, signal);
  }

  ensureBoundedCacheCapacity(providerRequestCache, key, config.sportsProviderCacheMaxEntries);

  let sharedSettled = false;
  const sharedPromise = Promise.resolve().then(fetcher).then(value => {
    sharedSettled = true;
    setBoundedCacheEntry(providerRequestCache, key, value, {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      maxEntryBytes: config.sportsProviderCacheMaxEntryBytes,
      maxTotalBytes: config.sportsProviderCacheMaxTotalBytes,
      maxEntries: config.sportsProviderCacheMaxEntries,
      generation: requestGeneration
    });
    return value;
  }).catch(error => {
    sharedSettled = true;
    const current = providerRequestCache.get(key);
    if (current?.generation === requestGeneration) {
      providerRequestCache.delete(key);
    } else if (cached?.value !== undefined) {
      providerRequestCache.set(key, cached);
    }
    throw error;
  });

  const consumerPromise = wrapConsumerPromise(sharedPromise, signal);

  providerRequestCache.set(key, {
    value: cached?.value,
    fetchedAt: cached?.fetchedAt || 0,
    sizeBytes: cached?.sizeBytes || 0,
    inFlight: sharedPromise,
    generation: requestGeneration
  });

  return consumerPromise;
}

function wrapConsumerPromise(sharedPromise, signal) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };

    const fail = (error) => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    };

    const onAbort = () => {
      fail(Object.assign(new Error('Aborted'), { cause: 'shutdown' }));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    sharedPromise.then(finish, fail);
  });
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
  if (type === 'HANDICAP') {
    const side = clean(row.selection_type || row.team_side, 40).toLowerCase();
    return side === 'away' ? -value : value;
  }
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
    const first = eventRows[0];
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
    const byBook = new Map();
    for (const row of eventRows) {
      const book = clean(row.sportsbook, 120) || 'unknown';
      const group = byBook.get(book) || [];
      group.push(row);
      byBook.set(book, group);
    }
    for (const [chosenBook, selectedRows] of byBook) {
      if (!selectedRows.length) continue;
      const marketRows = new Map();
      for (const row of selectedRows) {
        const key = sharpMarketGroupKey(row);
        const current = marketRows.get(key) || [];
        current.push(row);
        marketRows.set(key, current);
      }
      const bookMarkets = [...marketRows.values()].map(group => {
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
        )).filter(Boolean).slice(0, MAX_PROVIDER_SELECTIONS_PER_MARKET);
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
      }).filter(Boolean).slice(0, MAX_PROVIDER_MARKETS_PER_EVENT);
      event.markets.push(...bookMarkets);
    }
    event._refs.sharpapiSportsbook = [...byBook.keys()].join(',');
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
export async function fetchSharpApi({ signal } = {}) {
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
  }, { signal });
  return { provider: 'sharpapi', enabled: true, events: normalizeSharpApiRows(payload), errors: [] };
}

function normalizedMovioddsLabel(value) {
  return clean(value, 120).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
}

function movioddsLine(quote) {
  const parsed = number(quote?.handicap ?? quote?.line);
  return parsed === null ? null : parsed;
}

function movioddsIsVirtual(match) {
  return movioddsVirtualLeaguePattern.test(clean(match?.league, 120))
    || movioddsVirtualTeamPattern.test(clean(match?.home, 120))
    || movioddsVirtualTeamPattern.test(clean(match?.away, 120));
}

function movioddsQuoteSide(quote, match, kind) {
  const side = normalizedMovioddsLabel(quote?.side);
  if (kind === 'totals') {
    if (side === 'over') return 'Over';
    if (side === 'under') return 'Under';
    return null;
  }
  if (side === normalizedMovioddsLabel(match.home)) return 'Home';
  if (side === normalizedMovioddsLabel(match.away)) return 'Away';
  if (kind === 'handicap3' && ['draw', 'tie'].includes(side)) return 'Draw';
  return null;
}

function movioddsMarketsForGroup(match, groupId, quotes, polledAt) {
  const definition = MOVIODDS_GROUPS[groupId];
  if (!definition) return null;
  const validQuotes = quotes.filter(quote => quote && quote?.suspended !== true && safeOdds(quote?.odds_dec) !== null);
  if (!validQuotes.length) return null;

  if (definition.kind === 'result') {
    const outcomeLabels = new Set();
    const selections = [];
    for (const quote of validQuotes) {
      const sourceLabel = normalizedMovioddsLabel(quote?.label);
      const label = sourceLabel === normalizedMovioddsLabel(match.home)
        ? 'Home'
        : sourceLabel === normalizedMovioddsLabel(match.away)
          ? 'Away'
          : sourceLabel === 'draw'
            ? 'Draw'
            : null;
      if (!label || outcomeLabels.has(label)) continue;
      outcomeLabels.add(label);
      const selection = normalizedSelection(match.id, `moviodds:${groupId}`, label, quote.odds_dec, {
        source: 'moviodds',
        sourceSelectionId: quote.sel_id,
        updatedAt: polledAt
      });
      if (!selection) continue;
      selections.push(selection);
    }
    if (!selections.length) return null;
    const impliedProbability = selections.reduce((total, selection) => total + 1 / selection.odds, 0);
    const probabilityValid = impliedProbability >= config.movioddsMin1X2ImpliedProbability
      && impliedProbability <= config.movioddsMax1X2ImpliedProbability;
    return [normalizedMarket(match.id, {
      key: `moviodds:${groupId}`,
      name: definition.label,
      type: definition.type,
      period: definition.period,
      selections,
      source: 'moviodds',
      sourceMarketId: groupId,
      updatedAt: polledAt,
      mainLine: true,
      suspended: selections.length < 3 || !probabilityValid
    })].filter(Boolean);
  }

  const selectionsByLine = new Map();
  for (const quote of validQuotes) {
    const quoteLine = movioddsLine(quote);
    const side = movioddsQuoteSide(quote, match, definition.kind);
    if (quoteLine === null || !side) continue;
    const marketLine = definition.kind === 'handicap'
      ? (side === 'Home' ? quoteLine : -quoteLine)
      : quoteLine;
    const key = String(marketLine);
    const current = selectionsByLine.get(key) || {
      line: marketLine,
      selections: [],
      outcomes: new Set(),
      marketIds: new Set()
    };
    if (current.outcomes.has(side)) continue;
    current.outcomes.add(side);
    const sourceMarketId = clean(quote.market_id, 80);
    if (sourceMarketId) current.marketIds.add(sourceMarketId);
    const selection = normalizedSelection(match.id, `moviodds:${groupId}:${key}`, side, quote.odds_dec, {
      line: definition.kind === 'handicap' ? quoteLine : marketLine,
      source: 'moviodds',
      sourceSelectionId: quote.sel_id,
      updatedAt: polledAt
    });
    if (!selection) continue;
    current.selections.push(selection);
    selectionsByLine.set(key, current);
  }

  const expectedOutcomes = definition.kind === 'totals'
    ? ['Over', 'Under']
    : ['Home', 'Away'];
  const markets = [];
  for (const current of selectionsByLine.values()) {
    if (current.selections.length > MAX_PROVIDER_SELECTIONS_PER_MARKET) continue;
    const hasAllOutcomes = expectedOutcomes.every(outcome => current.outcomes.has(outcome));
    markets.push(normalizedMarket(match.id, {
      key: `moviodds:${groupId}:${current.line}`,
      name: definition.label,
      type: definition.type,
      period: definition.period,
      line: current.line,
      selections: current.selections,
      source: 'moviodds',
      sourceMarketId: [...current.marketIds].join(',') || groupId,
      updatedAt: polledAt,
      mainLine: groupId !== '10202',
      suspended: !hasAllOutcomes
    }));
  }
  if (!markets.length) return null;
  return markets.filter(Boolean);
}

export function createMovioddsCycleDiagnostics() {
  return {
    receivedFixtures: 0,
    acceptedFixtures: 0,
    discardedFixtures: {
      invalidLeagueOrTeams: 0,
      virtual: 0,
      inPlay: 0,
      kickoffPast: 0,
      invalidKickoff: 0
    },
    discardedGroups: {
      staleFlag: 0,
      polledAtStale: 0,
      quoteSuspended: 0,
      unknown1X2Label: 0,
      oddsAtOrBelowOne: 0,
      impliedProbabilityOutOfRange: 0,
      otherValidation: 0
    },
    fixtureMatching: {
      matched: 0,
      ambiguous: 0,
      unmatched: 0
    },
    markets: {
      filledEmptyIdentity: 0,
      skippedExistingIdentity: 0
    }
  };
}

function incrementMovioddsDiagnostic(diagnostics, category) {
  if (diagnostics && Object.hasOwn(diagnostics.discardedGroups, category)) {
    diagnostics.discardedGroups[category] += 1;
  }
}

function movioddsGroupFailure(match, groupId, quotes) {
  if (quotes.some(quote => quote?.suspended === true)) return 'quoteSuspended';
  if (quotes.some(quote => {
    const odds = Number(quote?.odds_dec);
    return Number.isFinite(odds) && odds <= 1;
  })) return 'oddsAtOrBelowOne';
  if (MOVIODDS_GROUPS[groupId]?.kind === 'result') {
    const labels = quotes.map(quote => normalizedMovioddsLabel(quote?.label));
    if (labels.some(label => ![
      normalizedMovioddsLabel(match.home),
      normalizedMovioddsLabel(match.away),
      'draw'
    ].includes(label))) return 'unknown1X2Label';
    const selections = quotes.map(quote => safeOdds(quote?.odds_dec));
    if (selections.every(odds => odds !== null)) {
      const impliedProbability = selections.reduce((total, odds) => total + 1 / odds, 0);
      if (impliedProbability < config.movioddsMin1X2ImpliedProbability
        || impliedProbability > config.movioddsMax1X2ImpliedProbability) {
        return 'impliedProbabilityOutOfRange';
      }
    }
  }
  return 'otherValidation';
}

function normalizeMovioddsMatches(payload, {
  now = Date.now(),
  maxStaleSeconds = config.movioddsMaxStaleSeconds,
  groupIds = config.movioddsGroupIds,
  maxEvents = MAX_PROVIDER_EVENTS,
  diagnostics
} = {}) {
  if (!Array.isArray(payload?.matches)) throw new Error('MoviOdds response is missing its matches array.');
  if (diagnostics) diagnostics.receivedFixtures += payload.matches.length;
  const allowedGroups = new Set(groupIds
    .map(String)
    .filter(groupId => MOVIODDS_GROUPS[groupId] && !MOVIODDS_FORBIDDEN_GROUPS.has(groupId)));
  if (!allowedGroups.size) return [];

  const events = [];
  for (const match of payload.matches) {
    if (!match || typeof match.id !== 'string' || !match.home || !match.away
      || !match.league) {
      if (diagnostics) diagnostics.discardedFixtures.invalidLeagueOrTeams += 1;
      continue;
    }
    if (movioddsIsVirtual(match)) {
      if (diagnostics) diagnostics.discardedFixtures.virtual += 1;
      continue;
    }
    if (match.in_play) {
      if (diagnostics) diagnostics.discardedFixtures.inPlay += 1;
      continue;
    }
    if (!iso(match.kickoff_utc)) {
      if (diagnostics) diagnostics.discardedFixtures.invalidKickoff += 1;
      continue;
    }
    const kickoff = Date.parse(match.kickoff_utc);
    if (!Number.isFinite(kickoff)) {
      if (diagnostics) diagnostics.discardedFixtures.invalidKickoff += 1;
      continue;
    }
    if (kickoff <= now) {
      if (diagnostics) diagnostics.discardedFixtures.kickoffPast += 1;
      continue;
    }
    const groups = new Map();
    for (const quote of Array.isArray(match.quotes) ? match.quotes : []) {
      const groupId = String(quote?.group_id ?? '');
      if (!allowedGroups.has(groupId) || normalizedMovioddsLabel(quote?.phase) !== 'prematch') continue;
      const groupQuotes = groups.get(groupId) || [];
      groupQuotes.push(quote);
      groups.set(groupId, groupQuotes);
    }

    const markets = [];
    const orderedGroups = [...groups].sort(([firstId], [secondId]) => {
      const firstIsTotals = MOVIODDS_GROUPS[firstId].type === 'TOTALS';
      const secondIsTotals = MOVIODDS_GROUPS[secondId].type === 'TOTALS';
      if (firstIsTotals !== secondIsTotals) return Number(firstIsTotals) - Number(secondIsTotals);
      if (!firstIsTotals) return Number(firstId) - Number(secondId);
      const firstPriority = movioddsTotalsGroupPriority.get(firstId) ?? Number.MAX_SAFE_INTEGER;
      const secondPriority = movioddsTotalsGroupPriority.get(secondId) ?? Number.MAX_SAFE_INTEGER;
      return firstPriority - secondPriority || Number(firstId) - Number(secondId);
    });
    const selectedTotalsPeriods = new Set();
    for (const [groupId, quotes] of orderedGroups) {
      const definition = MOVIODDS_GROUPS[groupId];
      if (definition.type === 'TOTALS' && selectedTotalsPeriods.has(definition.period)) continue;
      const groupStatus = match.group_status?.[groupId];
      const polledAt = Date.parse(groupStatus?.polled_at || '');
      const ageMs = now - polledAt;
      if (groupStatus?.stale === true) {
        incrementMovioddsDiagnostic(diagnostics, 'staleFlag');
        continue;
      }
      if (!groupStatus || !Number.isFinite(polledAt) || ageMs < 0 || ageMs > maxStaleSeconds * 1000) {
        incrementMovioddsDiagnostic(diagnostics, 'polledAtStale');
        continue;
      }
      const groupMarkets = movioddsMarketsForGroup(match, groupId, quotes, new Date(polledAt).toISOString());
      if (!groupMarkets) {
        incrementMovioddsDiagnostic(diagnostics, movioddsGroupFailure(match, groupId, quotes));
        continue;
      }
      if (markets.length + groupMarkets.length > MAX_PROVIDER_MARKETS_PER_EVENT) {
        incrementMovioddsDiagnostic(diagnostics, 'otherValidation');
        continue;
      }
      markets.push(...groupMarkets);
      if (definition.type === 'TOTALS') selectedTotalsPeriods.add(definition.period);
    }
    if (!markets.length) continue;

    const score = String(match.score || '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    events.push(normalizedEvent({
      provider: 'moviodds',
      providerId: match.id,
      sport: 'soccer',
      league: match.league,
      startTime: match.kickoff_utc,
      state: match.in_play ? 'LIVE' : 'SCHEDULED',
      providerStatus: match.in_play ? 'IN_PLAY' : 'SCHEDULED',
      clock: typeof match.clock === 'string' ? match.clock : match.clock?.display || match.clock?.minute || null,
      home: match.home,
      away: match.away,
      homeScore: score?.[1] ?? null,
      awayScore: score?.[2] ?? null,
      markets
    }));
  }

  const normalized = events
    .sort((a, b) => Number(b.live) - Number(a.live)
      || (Date.parse(a.startTime) || Number.MAX_SAFE_INTEGER) - (Date.parse(b.startTime) || Number.MAX_SAFE_INTEGER)
      || a.id.localeCompare(b.id))
    .slice(0, Math.min(MAX_PROVIDER_EVENTS, maxEvents));
  if (diagnostics) diagnostics.acceptedFixtures += normalized.length;
  return normalized;
}

let movioddsFetchedAt = 0;
let movioddsEvents = [];
let movioddsDiagnostics = createMovioddsCycleDiagnostics();
let movioddsInFlight = null;
export async function fetchMoviOdds({ maxEvents = MAX_PROVIDER_EVENTS, signal } = {}) {
  if (!config.movioddsEnabled) return { provider: 'moviodds', enabled: false, events: [], diagnostics: createMovioddsCycleDiagnostics() };
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > MAX_PROVIDER_EVENTS) {
    throw new Error(`MoviOdds maxEvents must be an integer between 0 and ${MAX_PROVIDER_EVENTS}.`);
  }
  if (maxEvents === 0) return { provider: 'moviodds', enabled: true, events: [], errors: [], diagnostics: createMovioddsCycleDiagnostics() };

  const allowedGroupIds = new Set(config.movioddsGroupIds.map(String)
    .filter(groupId => MOVIODDS_GROUPS[groupId] && !MOVIODDS_FORBIDDEN_GROUPS.has(groupId)));
  const groupIds = [...new Set(config.movioddsRequestedGroupIds.map(String))]
    .filter(groupId => allowedGroupIds.has(groupId) && !MOVIODDS_FORBIDDEN_GROUPS.has(groupId));
  if (!groupIds.length) {
    throw new Error('MoviOdds request groups must include a configured, supported group_id.');
  }
  const now = Date.now();
  if (movioddsFetchedAt && now - movioddsFetchedAt < config.movioddsRefreshSeconds * 1000) {
    return {
      provider: 'moviodds',
      enabled: true,
      events: movioddsEvents.slice(0, maxEvents),
      errors: [],
      diagnostics: { ...createMovioddsCycleDiagnostics(), cachedFixtures: Math.min(movioddsEvents.length, maxEvents), cacheHit: true }
    };
  }
  if (movioddsInFlight) {
    await movioddsInFlight;
    return { provider: 'moviodds', enabled: true, events: movioddsEvents.slice(0, maxEvents), errors: [], diagnostics: { ...movioddsDiagnostics, cacheHit: false } };
  }

  const request = async () => {
    const url = new URL(config.movioddsBaseUrl);
    url.searchParams.set('sport', 'soccer');
    url.searchParams.set('groups', groupIds.join(','));
    const payload = await requestJson(url, {
      label: 'MoviOdds',
      maxBytes: config.movioddsMaxResponseBytes,
      headers: { 'accept-encoding': 'gzip' },
      signal
    });
    const diagnostics = createMovioddsCycleDiagnostics();
    const events = normalizeMovioddsMatches(payload, { now: Date.now(), groupIds, diagnostics });
    return { events, diagnostics };
  };
  movioddsInFlight = request();
  try {
    const result = await movioddsInFlight;
    movioddsEvents = result.events;
    movioddsDiagnostics = result.diagnostics;
    movioddsFetchedAt = Date.now();
    return { provider: 'moviodds', enabled: true, events: movioddsEvents.slice(0, maxEvents), errors: [], diagnostics: { ...movioddsDiagnostics, cacheHit: false } };
  } finally {
    movioddsInFlight = null;
  }
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
  const homeOutcome = type === 'HANDICAP'
    ? market.outcomes?.find(outcome => clean(outcome.name) === event.home.name)
    : null;
  const marketLine = homeOutcome?.point ?? market.outcomes?.[0]?.point ?? null;
  const selections = [];
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
    if (selection) selections.push(selection);
  }
  if (!selections.length) return null;
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

const TOP_LEAGUE_TOKENS = [
  'premier league', 'epl', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
  'champions league', 'europa league', 'eredivisie', 'primeira liga',
  'major league soccer', ' mls', 'nba', 'wnba', 'nhl', 'nfl', 'mlb',
  'atp', 'wta', 'us open', 'wimbledon', 'roland garros', 'australian open'
];

function isLiveOddsApiEvent(event, now = Date.now()) {
  if (event?.completed) return false;
  const kickoff = Date.parse(event?.commence_time || '');
  return Number.isFinite(kickoff) && kickoff <= now && now - kickoff <= 8 * 60 * 60 * 1000;
}

function isTopOddsApiEvent(sportKey, event) {
  const label = String(event?.sport_title || sportKey).toLowerCase();
  return TOP_LEAGUE_TOKENS.some(token => label.includes(token));
}

function selectOddsApiEnrichmentEvents(sportKey, events, limit, now = Date.now()) {
  return events
    .filter(event => event?.id && !event.completed
      && (isLiveOddsApiEvent(event, now) || isTopOddsApiEvent(sportKey, event))
      && Number.isFinite(Date.parse(event.commence_time || ''))
      && Date.parse(event.commence_time) >= now - 8 * 60 * 60 * 1000
      && Date.parse(event.commence_time) <= now + 30 * 86400000)
    .sort((a, b) => {
      const aLive = isLiveOddsApiEvent(a, now), bLive = isLiveOddsApiEvent(b, now);
      if (aLive !== bLive) return Number(bLive) - Number(aLive);
      const aTop = isTopOddsApiEvent(sportKey, a), bTop = isTopOddsApiEvent(sportKey, b);
      if (aTop !== bTop) return Number(bTop) - Number(aTop);
      return (Date.parse(a.commence_time || '') || Number.MAX_SAFE_INTEGER)
        - (Date.parse(b.commence_time || '') || Number.MAX_SAFE_INTEGER);
    })
    .slice(0, limit);
}

function pruneOddsApiEventDetailCache(now, ttlMs) {
  for (const [key, entry] of oddsApiEventDetailCache) {
    const kickoff = Date.parse(entry?.commenceTime || '');
    if (!entry || !Number.isFinite(Number(entry.fetchedAt))
      || now - entry.fetchedAt >= ttlMs
      || entry.completed
      || (Number.isFinite(kickoff) && kickoff < now - 8 * 60 * 60 * 1000)) {
      oddsApiEventDetailCache.delete(key);
    }
  }
  if (oddsApiEventDetailCache.size <= MAX_ODDS_API_DETAIL_CACHE_ENTRIES) return;
  const oldestFirst = [...oddsApiEventDetailCache.entries()]
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  for (const [key] of oldestFirst.slice(0, oddsApiEventDetailCache.size - MAX_ODDS_API_DETAIL_CACHE_ENTRIES)) {
    oddsApiEventDetailCache.delete(key);
  }
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

async function fetchOddsApiEventMarkets(sportKey, rawEvents, maxEvents = config.theOddsApiEventMaxEventsPerSport, errors = []) {
  const markets = commaList(config.theOddsApiEventMarkets);
  if (!config.theOddsApiEventMarketsEnabled || !markets.length || !rawEvents.length || !maxEvents) return rawEvents;
  const eventLimit = Math.max(0, Math.min(Number(maxEvents) || 0, config.theOddsApiEventMaxEventsPerSport));
  const refreshMs = config.theOddsApiEventRefreshSeconds * 1000;
  const now = Date.now();
  pruneOddsApiEventDetailCache(now, refreshMs * ODDS_API_DETAIL_CACHE_TTL_MULTIPLIER);
  const selected = selectOddsApiEnrichmentEvents(sportKey, rawEvents, eventLimit, now);
  const extras = new Map();
  let nextIndex = 0;
  const fetchEventMarkets = async () => {
    while (nextIndex < selected.length) {
      const event = selected[nextIndex++];
      const cacheKey = `${sportKey}:${event.id}:${markets.join(',')}:${config.theOddsApiRegions}:${config.theOddsApiBookmakers || ''}`;
      const cached = oddsApiEventDetailCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < refreshMs) {
        extras.set(event.id, cached.payload);
        continue;
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
          oddsApiEventDetailCache.set(cacheKey, {
            fetchedAt: Date.now(),
            commenceTime: event.commence_time || null,
            completed: Boolean(event.completed),
            payload
          });
          pruneOddsApiEventDetailCache(Date.now(), refreshMs * ODDS_API_DETAIL_CACHE_TTL_MULTIPLIER);
          extras.set(event.id, payload);
        }
      } catch (error) {
        const failure = String(error?.message || '').match(/HTTP \d{3}/)?.[0] || 'network request failed';
        errors.push(`The Odds API event-market enrichment failed for ${event.id}: ${failure}`);
      }
    }
  };
  const concurrency = Math.min(ODDS_API_DETAIL_FETCH_CONCURRENCY, selected.length);
  await Promise.all(Array.from({ length: concurrency }, () => fetchEventMarkets()));
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
  const markets = [];
  for (const bookmaker of raw.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      const bookmakerName = clean(bookmaker.title || bookmaker.name || bookmaker.key, 120);
      const normalized = oddsApiMarket(event, market, 'the-odds-api', bookmakerName);
      if (normalized) markets.push(normalized);
    }
  }
  event.markets = markets;
  return event;
}
// --- The Odds API daily quota guard ---
// Kuota harian dihitung per kredit (sports x siklus x markets x regions).
// Saat provider membalas 429 feed TIDAK boleh mati: payload terakhir per
// sport disajikan kembali, guard floor menahan retry supaya tidak membanjiri
// provider, dan normalisasi tetap berjalan sehingga snapshot ke Railway tetap
// hidup. Harga yang menua tetap ditutup fail-closed oleh jendela
// SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS / LIVE di feed — ini murni
// ketersediaan feed, bukan perpanjangan usia harga.
const ODDS_API_QUOTA_BACKOFF_SECONDS = 1800;
const oddsApiStalePayloads = new Map();
const theOddsApiQuotaGuard = {
  floorUntil: 0,
  backoffSeconds: ODDS_API_QUOTA_BACKOFF_SECONDS,
  stalePayloads: oddsApiStalePayloads,
  reset() {
    theOddsApiQuotaGuard.floorUntil = 0;
    oddsApiStalePayloads.clear();
  }
};

function rememberOddsApiStalePayload(sportKey, payload) {
  if (!Array.isArray(payload)) return;
  ensureBoundedCacheCapacity(oddsApiStalePayloads, sportKey, config.sportsProviderCacheMaxEntries);
  setBoundedCacheEntry(oddsApiStalePayloads, sportKey, payload, {
    fetchedAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    maxEntryBytes: config.sportsProviderCacheMaxEntryBytes,
    maxTotalBytes: config.sportsProviderCacheMaxTotalBytes,
    maxEntries: config.sportsProviderCacheMaxEntries
  });
}

// setBoundedCacheEntry menyimpan entri berbentuk { value, fetchedAt, ... };
// payload mentah yang dibutuhkan normalisasi ada di .value.
function oddsApiStalePayload(sportKey) {
  const entry = oddsApiStalePayloads.get(sportKey);
  if (Array.isArray(entry)) return entry;
  return Array.isArray(entry?.value) ? entry.value : [];
}

async function cachedOddsApiRequest(sportKey, cacheKey, url, { signal, generation } = {}) {
  if (Date.now() < theOddsApiQuotaGuard.floorUntil) {
    // Kuota harian habis: sajikan payload terakhir tanpa menyentuh provider.
    return oddsApiStalePayload(sportKey);
  }
  try {
    const payload = await cachedRequest(cacheKey, config.theOddsApiRefreshSeconds * 1000, () => requestJson(url, { label: 'The Odds API', signal }), { signal, generation });
    rememberOddsApiStalePayload(sportKey, payload);
    return payload;
  } catch (error) {
    if (!String(error?.message || '').includes('HTTP 429')) throw error;
    theOddsApiQuotaGuard.floorUntil = Date.now() + ODDS_API_QUOTA_BACKOFF_SECONDS * 1000;
    logger.warn('The Odds API daily quota reached; serving cached payload', {
      sportKey,
      backoffSeconds: ODDS_API_QUOTA_BACKOFF_SECONDS,
      stale: oddsApiStalePayloads.has(sportKey)
    });
    return oddsApiStalePayload(sportKey);
  }
}

export async function fetchTheOddsApi({ maxEvents = config.theOddsApiMaxTotalEvents, signal } = {}) {
  if (!config.theOddsApiEnabled || !config.theOddsApiKey) return { provider: 'the-odds-api', enabled: false, events: [] };
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > MAX_PROVIDER_EVENTS) {
    throw new Error(`The Odds API maxEvents must be an integer between 0 and ${MAX_PROVIDER_EVENTS}.`);
  }
  if (maxEvents === 0) return { provider: 'the-odds-api', enabled: true, events: [], errors: [] };
  const sports = commaList(config.theOddsApiSportKeys);
  const eventMarketAllocations = allocateOddsApiEventMarkets(sports);
  const eventMarketErrors = [];
  const settled = await allSettledWithConcurrency(sports, ODDS_API_SPORT_FETCH_CONCURRENCY, async sportKey => {
    const url = new URL(`${config.theOddsApiBaseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(sportKey)}/odds`);
    url.searchParams.set('apiKey', config.theOddsApiKey);
    url.searchParams.set('regions', config.theOddsApiRegions);
    url.searchParams.set('markets', config.theOddsApiMarkets);
    url.searchParams.set('oddsFormat', 'decimal');
    url.searchParams.set('dateFormat', 'iso');
    if (config.theOddsApiBookmakers) url.searchParams.set('bookmakers', config.theOddsApiBookmakers);
    const cacheKey = `the-odds-api:${sportKey}:${config.theOddsApiRegions}:${config.theOddsApiMarkets}:${config.theOddsApiBookmakers || ''}`;
    const payload = await cachedOddsApiRequest(sportKey, cacheKey, url, { signal });
    const rawEvents = Array.isArray(payload) ? payload : [];
    const enriched = await fetchOddsApiEventMarkets(sportKey, rawEvents, eventMarketAllocations.get(sportKey) || 0, eventMarketErrors);
    return enriched.map(normalizeOddsApiEvent);
  });
  const events = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, Math.min(MAX_PROVIDER_EVENTS, maxEvents));
  const errors = [
    ...settled.filter(result => result.status === 'rejected').map(result => clean(result.reason?.message || 'request failed')),
    ...eventMarketErrors
  ];
  return { provider: 'the-odds-api', enabled: true, events, errors };
}

// --- Sportmonks (v3 football) ---
// Fixture includes contain full odds payloads, so keep pages small and cap the
// total page count while retaining only the best normalized events in memory.
let sportmonksNextRequestAt = 0;
const SPORTMONKS_HOUR_MS = 60 * 60 * 1000;
let sportmonksRequestTimestamps = [];
let sportmonksRetryAfterAt = 0;
const SPORTMONKS_PAGE_SIZE = 20;
const SPORTMONKS_MAX_PAGES_PER_REFRESH = 120;
const SPORTMONKS_MAX_PAGES_PER_WORKER_REFRESH = 120;
const SPORTMONKS_CANDIDATE_MULTIPLIER = 1.2;
const SPORTMONKS_LIVE_STATES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'INPLAY']);
const SPORTMONKS_FINISHED_STATES = new Set(['FT', 'AET', 'PEN', 'FINISHED', 'ENDED']);
const SPORTMONKS_SUSPENDED_STATES = new Set(['CANCL', 'POSTP', 'SUSP', 'SU', 'ABAND', 'DELAYED', 'CANCELED', 'CANCELLED', 'POSTPONED', 'SUSPENDED', 'ABANDONED']);
const DEFAULT_SPORTMONKS_PRIORITY_LEAGUES = [
  'premier league',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'uefa champions league',
  'uefa europa league',
  'uefa europa conference league',
  'eredivisie',
  'primeira liga',
  'major league soccer'
];

// Core football betting markets only — keeps the render-worker heap bounded by
// dropping high-cardinality families (player props, bet builders, cards, corners,
// correct score, odd/even, team totals…) while retaining the highest-volume odds.
const CORE_SPORTMONKS_MARKET_TYPES = new Set([
  '1X2',
  'HANDICAP',
  'TOTALS',
  'BTTS',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET'
]);
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
  // Only core football betting markets are retained — non-core families
  // (player props, bet builders, cards, corners, correct score, odd/even…)
  // are dropped by sportmonksMarket(); the per-event market cap keeps memory bounded.
  event.markets = [...byMarket.values()].map(rows => sportmonksMarket(event, rows)).filter(Boolean).slice(0, 120);
  return event;
}
function sportmonksMarket(event, rows) {
  const sample = rows[0] || {};
  const description = clean(sample.market_description || sample.name || `Market ${sample.market_id ?? ''}`, 120);
  const type = sportmonksMarketType(description);
  const period = periodFromName(description, `m${sample.market_id ?? ''}`);
  const selections = [];
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
    if (selection) selections.push(selection);
  }
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

// Cache Sportmonks odds for the provider-configured refresh interval.
const sportmonksCache = new Map();
function sportmonksCacheTtlMs() {
  return Math.max(
    60,
    Number(config.sportmonksRefreshSeconds || 300),
    Number(config.sportmonksOddsRefreshSeconds || 180)
  ) * 1000;
}
function sportmonksRequestsUsed(now = Date.now()) {
  sportmonksRequestTimestamps = sportmonksRequestTimestamps.filter(timestamp => now - timestamp < SPORTMONKS_HOUR_MS);
  return sportmonksRequestTimestamps.length;
}
function reserveSportmonksRequest(now = Date.now()) {
  if (sportmonksRetryAfterAt > now) {
    const error = new Error(`Sportmonks Retry-After cooldown active for ${Math.ceil((sportmonksRetryAfterAt - now) / 1000)}s.`);
    error.code = 'SPORTMONKS_RETRY_AFTER';
    throw error;
  }
  const used = sportmonksRequestsUsed(now);
  if (used >= config.sportmonksRequestBudgetPerHour) {
    const error = new Error(`Sportmonks hourly request budget exhausted (${used}/${config.sportmonksRequestBudgetPerHour}); serving cached data.`);
    error.code = 'SPORTMONKS_HOURLY_BUDGET_EXHAUSTED';
    throw error;
  }
  sportmonksRequestTimestamps.push(now);
}
function latestSportmonksCache(cacheKey) {
  const exact = sportmonksCache.get(cacheKey);
  if (exact) return exact;
  return [...sportmonksCache.values()].sort((a, b) => b.fetchedAt - a.fetchedAt)[0] || null;
}
function sportmonksPartialResult(cached, error, now = Date.now()) {
  const errors = [...(cached?.errors || [])];
  if (error && !errors.includes(error)) errors.push(error);
  return {
    provider: 'sportmonks',
    enabled: true,
    events: cached?.events || [],
    errors,
    partial: true,
    transportOk: false,
    stale: Boolean(cached && now - cached.fetchedAt >= sportmonksCacheTtlMs())
  };
}
async function waitForSportmonksRequestSlot(signal, overrideDelayMs = config.sportmonksRequestDelayMs) {
  const delayMs = Number(overrideDelayMs || 0);
  if (delayMs <= 0) return;
  const now = Date.now();
  const scheduledAt = Math.max(now, sportmonksNextRequestAt);
  sportmonksNextRequestAt = scheduledAt + delayMs;
  if (scheduledAt > now) await sleep(scheduledAt - now, undefined, { signal });
}

// Read one small page at a time so raw odds payloads are not retained across pages.
async function fetchAllPages(base, endpoint, params, maxPages = 4, onPage = () => {}, { signal } = {}) {
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= maxPages) {
    if (signal?.aborted) {
      const error = new Error('Sportmonks fetch aborted: shutdown');
      error.cause = 'shutdown';
      throw error;
    }
    const url = new URL(`${base}${endpoint}`);
    url.searchParams.set('api_token', config.sportmonksKey);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(SPORTMONKS_PAGE_SIZE));
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    
    await waitForSportmonksRequestSlot(signal);
    reserveSportmonksRequest();
    const payload = await requestJson(url, {
      label: `Sportmonks page ${page}`,
      maxBytes: config.sportsFeedMaxCacheBytes,
      signal
    });
    const data = payload?.data || [];
    if (data.length === 0) {
      hasMore = false;
    } else {
      await onPage(data);
      hasMore = data.length >= SPORTMONKS_PAGE_SIZE && payload?.pagination?.has_more;
      page++;
    }
  }
}

function sportmonksLeaguePriority(event, configuredLeagues) {
  const league = clean(event?.league, 120).toLowerCase();
  const index = configuredLeagues.findIndex(name => league === name || league.includes(name));
  return index < 0 ? configuredLeagues.length : index;
}

function compareSportmonksEvents(a, b) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
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
  const cacheKey = `sportmonks:all-events:${utcDate(0)}:${config.sportmonksDaysAhead}:${maxEvents}:${maxPages}`;
  const cached = latestSportmonksCache(cacheKey);
  const cachedForRequest = sportmonksCache.get(cacheKey);
  const cacheTtlMs = sportmonksCacheTtlMs();

  if (sportmonksRetryAfterAt > now) {
    return sportmonksPartialResult(
      cached,
      `Sportmonks Retry-After cooldown active for ${Math.ceil((sportmonksRetryAfterAt - now) / 1000)}s.`,
      now
    );
  }
  const requestsUsed = sportmonksRequestsUsed(now);
  if (requestsUsed >= config.sportmonksRequestBudgetPerHour) {
    return sportmonksPartialResult(
      cached,
      `Sportmonks hourly request budget exhausted (${requestsUsed}/${config.sportmonksRequestBudgetPerHour}); serving cached data.`,
      now
    );
  }
  if (cachedForRequest && now - cachedForRequest.fetchedAt < cacheTtlMs) {
    logger.info('Sportmonks: returning cached data', { age: Math.round((now - cached.fetchedAt) / 1000) + 's' });
    return cachedForRequest.partial
      ? sportmonksPartialResult(cachedForRequest, null, now)
      : { provider: 'sportmonks', enabled: true, events: cachedForRequest.events, errors: [] };
  }
  
  const daysAhead = Math.max(0, Number(config.sportmonksDaysAhead) || 0);
  const dates = [];
  for (let offset = 0; offset <= daysAhead; offset += 1) dates.push(utcDate(offset));
  
  const errors = [];
  const priorityLeagues = String(config.sportmonksPriorityLeagues || '')
    .split(',')
    .map(name => clean(name, 120).toLowerCase())
    .filter(Boolean);
  const configuredPriorityLeagues = priorityLeagues.length ? priorityLeagues : DEFAULT_SPORTMONKS_PRIORITY_LEAGUES;
  const candidateLimit = Math.min(
    Math.ceil(maxEvents * SPORTMONKS_CANDIDATE_MULTIPLIER),
    maxPages * SPORTMONKS_PAGE_SIZE
  );
  const totalPages = Math.min(
    maxPages,
    Math.ceil(candidateLimit / SPORTMONKS_PAGE_SIZE)
  );
  const basePagesPerDate = Math.floor(totalPages / dates.length);
  let extraPages = totalPages % dates.length;
  const rankedEvents = [];
  const seen = new Set();
  let stopPaging = false;
  
  for (const date of dates) {
    const pagesForDate = basePagesPerDate + (extraPages > 0 ? 1 : 0);
    if (extraPages > 0) extraPages -= 1;
    if (pagesForDate === 0) continue;
    try {
      await fetchAllPages(base, `/football/fixtures/date/${date}`, {
        include: 'state;participants;league.country;odds;scores'
      }, pagesForDate, fixtures => {
        for (const fixture of fixtures) {
          const id = String(fixture?.id ?? '');
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const state = sportmonksState(fixture.state);
          if (state !== 'SCHEDULED' && state !== 'LIVE') continue;
          if (fixture.has_odds === false) continue;

          const start = Number(fixture.starting_at_timestamp) * 1000 || Date.parse(fixture.starting_at || '') || 0;
          if (start && start < now - 3 * 60 * 60 * 1000) continue;
          try {
            const event = normalizeSportmonksFixture(fixture, fixture.odds || []);
            if (!event || !event.markets.length) continue;
            const candidate = {
              event,
              leaguePriority: sportmonksLeaguePriority(event, configuredPriorityLeagues),
              startTime: start || Number.MAX_SAFE_INTEGER
            };
            rankedEvents.push(candidate);
            rankedEvents.sort(compareSportmonksEvents);
            if (rankedEvents.length > maxEvents) rankedEvents.pop();
          } catch (error) {
            errors.push(`Fixture ${fixture.id}: ${error.message}`);
          }
        }
      });
    } catch (error) {
      let detail = error.message;
      if (error.status === 429 && Number.isFinite(error.retryAfterAt)) {
        sportmonksRetryAfterAt = Math.max(sportmonksRetryAfterAt, error.retryAfterAt);
        const retryAfterSeconds = Math.ceil(Math.max(0, error.retryAfterAt - Date.now()) / 1000);
        detail += ` (Retry-After ${retryAfterSeconds}s)`;
      }
      errors.push(`Date ${date}: ${detail}`);
      if (error.status === 429 || error.code === 'SPORTMONKS_HOURLY_BUDGET_EXHAUSTED'
        || error.code === 'SPORTMONKS_RETRY_AFTER') {
        stopPaging = true;
      }
    }
    if (stopPaging) break;
  }
  const currentEvents = rankedEvents.map(candidate => candidate.event);
  const partial = stopPaging || errors.length > 0;
  const useCachedEvents = currentEvents.length === 0 && cached?.events?.length;
  const events = useCachedEvents ? cached.events : currentEvents;
  const fetchedAtStamp = new Date(now).toISOString();
  for (const event of currentEvents) {
    for (const market of event.markets) {
      market.updatedAt ||= fetchedAtStamp;
      for (const selection of market.selections) selection.updatedAt ||= market.updatedAt;
    }
  }
  
  if (!partial || !cached) {
    sportmonksCache.set(cacheKey, {
      fetchedAt: now,
      events,
      partial,
      errors: partial ? errors : []
    });
  }
  
  // Bounded cache: hapus entri lama jika terlalu banyak
  if (sportmonksCache.size > 1) {
    const oldest = [...sportmonksCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, sportmonksCache.size - 1)) {
      sportmonksCache.delete(key);
    }
  }
  
  return {
    provider: 'sportmonks',
    enabled: true,
    events: events.slice(0, Math.min(MAX_PROVIDER_EVENTS, maxEvents)),
    errors,
    ...(partial ? { partial: true, transportOk: false, stale: Boolean(useCachedEvents) } : {})
  };
}

function apiSportsMarkets(event, bet, source = 'api-sports') {
  const name = clean(bet.name || bet.label || bet.market || 'Market');
  const type = marketType(name, bet.id);
  const period = periodFromName(name, bet.key || bet.id || '');
  const bookmaker = clean(bet.bookmaker || bet.bookmaker_name || bet.bookmaker_id, 120) || null;
  const selections = [];
  for (const value of bet.values || bet.outcomes || []) {
    const rawLabel = clean(value.value || value.name || value.label || 'Selection');
    const lineMatch = rawLabel.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
    const line = value.handicap ?? value.points ?? (lineMatch ? Number(lineMatch[1]) : null);
    const label = rawLabel;
    const awayKey = slug(event.away.name);
    const awayLabel = slug(label) === '2'
      || slug(label) === 'away'
      || slug(label).startsWith('2-')
      || slug(label).startsWith('away-')
      || slug(label).startsWith(`${awayKey}-`)
      || slug(label) === awayKey;
    const marketLine = type === 'HANDICAP' && line !== null
      ? awayLabel ? -Number(line) : Number(line)
      : line;
    const selection = normalizedSelection(event.id, `${bet.id || name}:${marketLine ?? ''}`, label, value.odd ?? value.odds ?? value.price, {
      line,
      source,
      sourceSelectionId: `${bookmaker || source}:${value.id || rawLabel}`,
      suspended: value.suspended || value.status === 'SUSPENDED'
    });
    if (selection) selections.push(selection);
  }
  if (!selections.length) return [];
  if (type === 'HANDICAP') {
    const byLine = new Map();
    for (const selection of selections) {
      const awayKey = slug(event.away.name);
      const awayLabel = slug(selection.label) === '2'
        || slug(selection.label) === 'away'
        || slug(selection.label).startsWith('2-')
        || slug(selection.label).startsWith('away-')
        || slug(selection.label).startsWith(`${awayKey}-`)
        || slug(selection.label) === awayKey;
      const rawLine = selection.line ?? null;
      const marketLine = rawLine !== null ? (awayLabel ? -Number(rawLine) : Number(rawLine)) : null;
      const key = String(marketLine ?? 'null');
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(selection);
    }
    return [...byLine.entries()].map(([lineKey, lineSelections]) =>
      normalizedMarket(event.id, {
        key: `${bet.id || slug(name)}:${lineKey}`,
        name,
        type,
        period,
        line: lineKey === 'null' ? null : Number(lineKey),
        selections: lineSelections,
        source,
        bookmaker,
        updatedAt: bet.update
      })
    );
  }
  return [normalizedMarket(event.id, {
    key: `${bet.id || slug(name)}`,
    name,
    type,
    period,
    line: null,
    selections,
    source,
    bookmaker,
    updatedAt: bet.update
  })];
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
  const markets = [];
  for (const bet of bets) {
    markets.push(...apiSportsMarkets(event, bet));
  }
  event.markets = markets;
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
export function sportsbookEventsMatch(a, b, normalizeTeamKey = teamKey) {
  if (a.sport !== b.sport) return false;
  if (a.country && b.country && slug(a.country) !== slug(b.country)) return false;
  if (a.league && b.league && leagueKey(a.league) !== leagueKey(b.league)) return false;
  const direct = normalizeTeamKey(a.home.name) === normalizeTeamKey(b.home.name)
    && normalizeTeamKey(a.away.name) === normalizeTeamKey(b.away.name);
  return direct && (kickoffDistance(a.startTime, b.startTime) <= 3 * 60 * 60 * 1000 || !a.startTime || !b.startTime);
}
function sameFixture(a, b) {
  return sportsbookEventsMatch(a, b);
}
export function hasTrustedResultAuthority(provider) {
  return TRUSTED_RESULT_PROVIDERS.has(provider);
}
export function sportsbookProviderStartupSummary() {
  const providers = [
    ['sportmonks', Boolean(config.sportmonksEnabled && config.sportmonksKey)],
    ['moviodds', Boolean(config.movioddsEnabled)],
    ['sharpapi', Boolean(config.sharpApiEnabled && config.sharpApiKey)]
  ];
  return {
    activeProviders: providers.filter(([, enabled]) => enabled).map(([name]) => name),
    inactiveProviders: providers.filter(([, enabled]) => !enabled).map(([name]) => name)
  };
}
const PROVIDER_NAMED_MARKET_TYPES = new Set([
  'PLAYER_PROP', 'CORRECT_SCORE', 'CORNERS', 'CARDS', 'BET_BUILDER', 'OTHER'
]);
function marketIdentity(market) {
  const label = PROVIDER_NAMED_MARKET_TYPES.has(market.type) ? slug(market.label) : '';
  return `${market.source ?? 'unknown'}|${market.bookmaker ?? ''}|${market.type}|${market.period}|${market.line ?? ''}|${label}`;
}
function sourcePriority(source, live) {
  if (source === 'sportmonks') return 100;
  if (source === 'api-sports') return 80;
  if (source === 'sharpapi') return 65;
  if (source === 'the-odds-api') return 55;
  if (source === 'moviodds') return 40;
  if (source === 'footballdata-io') return 35;
  if (source === 'public-market') return 30;
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
  const incomingByIdentity = new Map();
  for (const market of incoming) {
    const key = marketIdentity(market);
    const existing = incomingByIdentity.get(key);
    if (!existing) {
      incomingByIdentity.set(key, market);
      continue;
    }
    const candidateAvailable = marketBettingAvailable(market);
    const currentAvailable = marketBettingAvailable(existing);
    const candidatePriority = sourcePriority(market.source, live);
    const currentPriority = sourcePriority(existing.source, live);
    if (candidatePriority > currentPriority
      || (candidatePriority === currentPriority && candidateAvailable && !currentAvailable)
      || (candidatePriority === currentPriority && candidateAvailable === currentAvailable && market.selections.length > existing.selections.length)) {
      incomingByIdentity.set(key, market);
    }
  }

  const targetByIdentity = new Map();
  for (const market of target) {
    targetByIdentity.set(marketIdentity(market), market);
  }

  const result = [...target];
  for (const [identity, candidate] of incomingByIdentity) {
    const current = targetByIdentity.get(identity);
    if (!current) {
      result.push(candidate);
      targetByIdentity.set(identity, candidate);
    } else {
      const candidateAvailable = marketBettingAvailable(candidate);
      const currentAvailable = marketBettingAvailable(current);
      const candidatePriority = sourcePriority(candidate.source, live);
      const currentPriority = sourcePriority(current.source, live);
      if (candidatePriority > currentPriority
        || (candidatePriority === currentPriority && candidateAvailable && !currentAvailable)
        || (candidatePriority === currentPriority && candidateAvailable === currentAvailable && candidate.selections.length > current.selections.length)) {
        const index = result.indexOf(current);
        if (index !== -1) result[index] = candidate;
        targetByIdentity.set(identity, candidate);
      }
    }
  }

  return result.sort((a, b) => {
    const aPriority = sourcePriority(a.source, live);
    const bPriority = sourcePriority(b.source, live);
    if (aPriority !== bPriority) return bPriority - aPriority;
    const order = { '1X2': 1, HANDICAP: 2, TOTALS: 3, BTTS: 4, DOUBLE_CHANCE: 5, DRAW_NO_BET: 6, TEAM_TOTAL: 7, HT_FT: 8, ODD_EVEN: 9, CORRECT_SCORE: 10, CORNERS: 11, CARDS: 12, PLAYER_PROP: 13, BET_BUILDER: 14, OTHER: 99 };
    return (order[a.type] || 50) - (order[b.type] || 50);
  });
}
function mergeEvent(target, incoming) {
  const eventPriority = sources => Math.max(...sources.map(source =>
    source === 'sportmonks' ? 100
      : source === 'api-sports' ? 80
        : source === 'public-market' || source === 'footballdata-io' ? 70
          : hasTrustedResultAuthority(source) ? 60
            : -1
  ), -1);
  const targetPriority = eventPriority(target._sources);
  const incomingPriority = eventPriority(incoming._sources);
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
  target.periodScores = incomingPriority >= targetPriority
    ? { ...(target.periodScores || {}), ...(incoming.periodScores || {}) }
    : { ...(incoming.periodScores || {}), ...(target.periodScores || {}) };
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
  const supportsFullTimeSettlement = [...TRUSTED_RESULT_PROVIDERS, 'manual-ops'].some(source => sources.has(source));
  const supportsHalfTimeSettlement = [...TRUSTED_HALF_TIME_RESULT_PROVIDERS].some(source => sources.has(source));
  const halfTimeScore = event.periodScores?.['1H'] || event.periodScores?.HT || event.score?.halftime || null;
  const hasHalfTimeScore = number(halfTimeScore?.home) !== null && number(halfTimeScore?.away) !== null;
  event.markets = (event.markets || []).map(market => {
    const period = market.period || 'FT';
    const supportedPeriod = period === 'FT' || period === '1H';
    const requiresHalfTimeResult = period === '1H' || market.type === 'HT_FT';
    const mustSuspend = !SETTLEABLE_MARKET_TYPES.has(market.type)
      || !supportedPeriod
      || !supportsFullTimeSettlement
      || (requiresHalfTimeResult && !supportsHalfTimeSettlement)
      || (event.status === 'FINISHED' && market.type === 'HT_FT' && !hasHalfTimeScore);
    return mustSuspend
      ? { ...market, suspended: true, selections: market.selections.map(selection => ({ ...selection, suspended: true })) }
      : market;
  });
  return event;
}
export function mergeProviderEvents(providerResults, options = {}) {
  const events = [];
  const fixturesByTeams = new Map();
  const providerEvents = providerResults.flatMap(result => (result.events || []).map(event => ({
    provider: result.provider || event._sources?.[0],
    event
  })));
  const ordered = providerEvents.map(candidate => candidate.event).sort((a, b) => {
    const aLive = Boolean(a?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(String(a?.status || '').toUpperCase());
    const bLive = Boolean(b?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(String(b?.status || '').toUpperCase());
    if (aLive !== bLive) return Number(bLive) - Number(aLive);
    const aStart = Date.parse(a?.startTime || '') || Number.MAX_SAFE_INTEGER;
    const bStart = Date.parse(b?.startTime || '') || Number.MAX_SAFE_INTEGER;
    return aStart - bStart || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  for (const candidate of ordered) {
    const fixtureKey = `${candidate.sport}|${teamKey(candidate.home.name)}|${teamKey(candidate.away.name)}`;
    const candidates = fixturesByTeams.get(fixtureKey) || [];
    const existing = candidates.find(event => sameFixture(event, candidate));
    if (existing) {
      mergeEvent(existing, candidate);
    } else {
      if (events.length >= MAX_PROVIDER_EVENTS) continue;
      const event = structuredClone(candidate);
      events.push(event);
      candidates.push(event);
      fixturesByTeams.set(fixtureKey, candidates);
    }
  }
  return events.map(event => applySettlementSafety(applyManualFtSettlementFallback(event, options)));
}
export function movioddsMergeDiagnostics(providerResults, mergedEvents = [], { includeDebugExamples = false } = {}) {
  const movioddsResult = providerResults.find(result => result.provider === 'moviodds');
  if (!movioddsResult) return null;
  const movioddsEvents = movioddsResult.events || [];
  const providerEvents = providerResults
    .filter(result => result.provider !== 'moviodds' && hasTrustedResultAuthority(result.provider))
    .flatMap(result => result.events || []);
  const fixtureMatching = {
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    usedAsSupplement: 0,
    ambiguousUsedAsSupplement: 0,
    ambiguousNotUsed: 0
  };
  const markets = {
    filledEmptyIdentity: 0,
    skippedExistingIdentity: 0
  };
  const debugExamples = [];

  for (const event of movioddsEvents) {
    const matches = providerEvents.filter(candidate => sameFixture(candidate, event));
    const merged = mergedEvents.find(candidate => sameFixture(candidate, event));
    const usedAsSupplement = Boolean(merged?._sources?.includes('moviodds'));
    if (matches.length === 0) {
      fixtureMatching.unmatched += 1;
      if (includeDebugExamples && debugExamples.length < 5) {
        debugExamples.push({ category: 'unmatched', home: event.home.name, away: event.away.name });
      }
      continue;
    }
    if (matches.length > 1) {
      fixtureMatching.ambiguous += 1;
      if (usedAsSupplement) fixtureMatching.ambiguousUsedAsSupplement += 1;
      else fixtureMatching.ambiguousNotUsed += 1;
      if (includeDebugExamples && debugExamples.length < 5) {
        debugExamples.push({ category: 'ambiguous', home: event.home.name, away: event.away.name });
      }
    } else {
      fixtureMatching.matched += 1;
    }

    if (usedAsSupplement) fixtureMatching.usedAsSupplement += 1;
    if (!usedAsSupplement) continue;
    for (const market of event.markets || []) {
      const mergedMarket = merged?.markets?.find(candidate => marketIdentity(candidate) === marketIdentity(market));
      if (mergedMarket?.source === 'moviodds') markets.filledEmptyIdentity += 1;
      else markets.skippedExistingIdentity += 1;
    }
  }

  return {
    ...(movioddsResult.diagnostics || {}),
    fixtureMatching,
    markets,
    ...(includeDebugExamples && debugExamples.length ? { debugExamples } : {})
  };
}
export function sportsbookProviderCycleDiagnostics(providerResults, mergedEvents = [], { includeDebugExamples = false } = {}) {
  const resultCandidates = providerResults
    .filter(result => hasTrustedResultAuthority(result.provider))
    .flatMap(result => (result.events || []).map(event => ({ provider: result.provider, event })));
  const debugExamples = [];
  const providers = Object.fromEntries(providerResults.map(result => {
    const provider = result.provider;
    const events = result.events || [];
    const fixtureMatching = { matched: 0, ambiguous: 0, unmatched: 0, usedAsSupplement: 0 };
    const markets = { filled: 0, skipped: 0 };
    for (const event of events) {
      if (!hasTrustedResultAuthority(provider)) {
        const matches = resultCandidates.filter(candidate => sportsbookEventsMatch(candidate.event, event));
        if (matches.length === 0) fixtureMatching.unmatched += 1;
        else if (matches.length === 1) fixtureMatching.matched += 1;
        else fixtureMatching.ambiguous += 1;
        if (includeDebugExamples && matches.length !== 1 && debugExamples.length < 5) {
          debugExamples.push({
            provider,
            category: matches.length ? 'ambiguous' : 'unmatched',
            home: event.home?.name || '',
            away: event.away?.name || ''
          });
        }
      }
      const merged = mergedEvents.find(candidate => sportsbookEventsMatch(candidate, event));
      const contributed = Boolean(merged?._sources?.includes(provider));
      if (contributed && !hasTrustedResultAuthority(provider)) fixtureMatching.usedAsSupplement += 1;
      if (!contributed) continue;
      for (const market of event.markets || []) {
        const retained = merged.markets.find(candidate => marketIdentity(candidate) === marketIdentity(market));
        if (retained?.source === provider) markets.filled += 1;
        else markets.skipped += 1;
      }
    }
    const adapterDiagnostics = result.diagnostics || {};
    const resolvedFixtureMatching = adapterDiagnostics.fixtureMatching || fixtureMatching;
    if (includeDebugExamples && Array.isArray(adapterDiagnostics.debugExamples) && debugExamples.length < 5) {
      debugExamples.push(...adapterDiagnostics.debugExamples.slice(0, 5 - debugExamples.length));
    }
    return [provider, {
      receivedFixtures: adapterDiagnostics.receivedFixtures ?? events.length,
      acceptedFixtures: adapterDiagnostics.acceptedFixtures ?? events.length,
      discardedFixtures: {
        ...(adapterDiagnostics.discardedFixtures || {}),
        ambiguous: resolvedFixtureMatching.ambiguous || 0,
        unmatched: resolvedFixtureMatching.unmatched || 0
      },
      discardedGroups: adapterDiagnostics.discardedGroups || {},
      fixtureMatching: resolvedFixtureMatching,
      markets,
      ...(includeDebugExamples && Array.isArray(adapterDiagnostics.debugExamples)
        ? { debugExamples: adapterDiagnostics.debugExamples.slice(0, 5) }
        : {}),
      partial: Boolean(result.partial),
      errorCount: Array.isArray(result.errors) ? result.errors.length : 0
    }];
  }));
  return { providers, debugExamples };
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
  normalizeMovioddsMatches,
  createMovioddsCycleDiagnostics,
  movioddsMergeDiagnostics,
  sportsbookProviderCycleDiagnostics,
  sportsbookEventsMatch,
  hasTrustedResultAuthority,
  normalizeSharpApiRows,
  sharpDerivedMarketType,
  sharpMarketGroupKey,
  normalizeOddsApiEvent,
  normalizeApiSportsFixture,
  normalizeSportsDbEvent,
  normalizeSportmonksFixture,
  mergeProviderEvents,
  marketIdentity,
  mergeMarkets,
  movioddsMarketsForGroup,
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
  providerRequestGeneration,
  allocateOddsApiEventMarkets,
  isLiveOddsApiEvent,
  isTopOddsApiEvent,
  selectOddsApiEnrichmentEvents,
  pruneOddsApiEventDetailCache,
  oddsApiEventDetailCache,
  theOddsApiQuotaGuard,
  cachedRequest,
  requestJson,
  nextGeneration,
  wrapConsumerPromise,
  waitForSportmonksRequestSlot,
  fetchAllPages
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

// Live binding for test access to module-level slot state
export { sportmonksNextRequestAt as _sportmonksNextRequestAt };
export function _testResetSportmonksNextRequestAt(v = 0) {
  sportmonksNextRequestAt = v;
}
