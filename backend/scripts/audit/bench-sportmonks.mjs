import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  try { process.loadEnvFile(envPath); } catch { /* ignore */ }
}

const SPORTMONKS_API_KEY = process.env.SPORTMONKS_API_KEY;
const SPORTMONKS_BASE_URL = process.env.SPORTMONKS_BASE_URL || 'https://api.sportmonks.com/v3';

if (!SPORTMONKS_API_KEY) {
  console.error('ERROR: SPORTMONKS_API_KEY not set');
  process.exit(1);
}

// Hard limits (not overridable by env)
const MAX_REQUESTS = 50;
const BENCH_DAYS_AHEAD = 3; // today + 3 days = 4 days total
const PAGE_SIZE = 50;
const INCLUDES = 'state;participants;league.country;odds;odds.market;odds.bookmaker;scores;statistics.type;events.type';
const MAX_PAGES_PER_DATE = 5;
const TIMEOUT_MS = 15000;

function wibDate(offsetDays = 0) {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  wib.setUTCDate(wib.getUTCDate() + offsetDays);
  return wib.toISOString().slice(0, 10);
}

const TODAY_WIB = wibDate(0);
const END_WIB = wibDate(BENCH_DAYS_AHEAD);

// Pre-flight estimate: nearest dates first, up to MAX_REQUESTS
const dates = [];
for (let d = 0; d <= BENCH_DAYS_AHEAD; d++) dates.push(wibDate(d));
let estimatedRequests = 0;
const datesToFetch = [];
for (const date of dates) {
  const needed = MAX_PAGES_PER_DATE; // assume all pages have data
  if (estimatedRequests + needed > MAX_REQUESTS) break;
  estimatedRequests += needed;
  datesToFetch.push(date);
}
const skippedDates = dates.slice(datesToFetch.length);
console.log(`SPORTMONKS_BENCHMARK_CONFIG max_requests=${MAX_REQUESTS} window=${TODAY_WIB}..${END_WIB} (WIB) max_pages_per_date=${MAX_PAGES_PER_DATE} page_size=${PAGE_SIZE}`);
console.log(`SPORTMONKS_PREFILIGHT dates_to_fetch=${datesToFetch.length} (${datesToFetch.join(', ')}) estimated_requests=${estimatedRequests} skipped=${skippedDates.length} (${skippedDates.join(', ') || 'none'})`);

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': 'ASEAN777-Benchmark/1.0',
        ...options.headers
      }
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function hasPayloadErrors(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (Array.isArray(payload.errors)) {
    if (payload.errors.length === 0) return false;
    return payload.errors.some(e => e !== null && e !== undefined && e !== '');
  }

  if (payload.errors && typeof payload.errors === 'object') {
    return Object.keys(payload.errors).length > 0;
  }

  if (payload.error !== undefined) {
    if (payload.error === null || payload.error === '') return false;
    if (typeof payload.error === 'object') return Object.keys(payload.error).length > 0;
    if (typeof payload.error === 'string' && payload.error.trim()) return true;
    return false;
  }

  const hasUsableData = payload.data || payload.response || payload.fixtures || payload.events;
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
    const hasUsableData = payload.data || payload.response || payload.fixtures || payload.events;
    if (!hasUsableData) return payload.message;
  }
  return null;
}

async function requestJson(url, label) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  console.log(`SPORTMONKS_RESP_BYTES ${bytes} url=${url}`);
  
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON response (${bytes} bytes)`);
  }
  
  if (!response.ok) {
    const errText = text.slice(0, 300);
    throw new Error(`${label} HTTP ${response.status}: ${errText}`);
  }
  
  // Check for payload errors (account suspended, token invalid, etc.)
  if (hasPayloadErrors(payload)) {
    const detail = extractErrorDetail(payload);
    throw new Error(`${label} API error: ${detail}`);
  }
  
  // Check for Sportmonks no-access warning
  if (payload.message && typeof payload.message === 'string' && /no result|don't have access|subscription/i.test(payload.message)) {
    console.warn(`SPORTMONKS_WARNING ${label}: ${payload.message}`);
  }
  
  return payload;
}

function buildFixtureUrl(baseUrl, date, page) {
  const url = new URL(`${baseUrl}/football/fixtures/date/${date}`);
  url.searchParams.set('api_token', SPORTMONKS_API_KEY);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('include', INCLUDES);
  return url.toString();
}

function parseFixtures(payload) {
  let data = payload;
  for (let i = 0; i < 3; i++) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    data = data.data;
  }
  return Array.isArray(data) ? data : [];
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

function sportmonksStartTime(raw) {
  const timestamp = Number(raw?.starting_at_timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp * 1000).toISOString();
  const iso = raw?.starting_at;
  if (iso) return new Date(iso).toISOString();
  return null;
}

function sportmonksRows(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== 'object') return [];
    current = current.data;
  }
  return Array.isArray(current) ? current : [];
}

function sportmonksRelation(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(current)) return current[0] || null;
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, 'data')) return current;
    current = current.data;
  }
  return Array.isArray(current) ? current[0] || null : current;
}

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeOdds(value) {
  const parsed = number(value);
  return parsed !== null && parsed > 1 && parsed <= 10000 ? Math.round(parsed * 10000) / 10000 : null;
}

const MARKET_TYPES = Object.freeze({
  h2h: '1X2', moneyline: '1X2', h2h_3_way: '1X2', moneyline_3way: '1X2',
  three_way_moneyline: '1X2', fulltime_result: '1X2', full_time_result: '1X2',
  match_winner: '1X2', match_result: '1X2',
  spreads: 'HANDICAP', point_spread: 'HANDICAP', asian_handicap: 'HANDICAP',
  totals: 'TOTALS', total_points: 'TOTALS', goals_over_under: 'TOTALS',
  btts: 'BTTS', both_teams_score: 'BTTS', both_teams_to_score: 'BTTS',
  double_chance: 'DOUBLE_CHANCE',
  draw_no_bet: 'DRAW_NO_BET', dnb: 'DRAW_NO_BET',
  halftime_fulltime: 'HT_FT', half_time_full_time: 'HT_FT',
  correct_score: 'CORRECT_SCORE',
  odd_even: 'ODD_EVEN',
  team_total: 'TEAM_TOTAL', team_totals: 'TEAM_TOTAL',
  player_prop: 'PLAYER_PROP', player_props: 'PLAYER_PROP',
  anytime_goalscorer: 'PLAYER_PROP', shots_on_target: 'PLAYER_PROP',
  player_assists: 'PLAYER_PROP', first_goalscorer: 'PLAYER_PROP',
  corners: 'CORNERS', corner_handicap: 'CORNERS', total_corners: 'CORNERS', team_corners: 'CORNERS',
  cards: 'CARDS', total_cards: 'CARDS', team_cards: 'CARDS',
  first_goal: 'FIRST_TO_SCORE', first_to_score: 'FIRST_TO_SCORE',
  next_goal: 'NEXT_TO_SCORE',
  winning_margin: 'WINNING_MARGIN', win_margin: 'WINNING_MARGIN',
  clean_sheet: 'CLEAN_SHEET',
  team_total_goals: 'TEAM_TOTAL',
  bet_builder: 'BET_BUILDER', same_game_parlay: 'BET_BUILDER', same_game_multi: 'BET_BUILDER'
});

function marketType(name, key = '') {
  const normalized = `${clean(key)} ${clean(name)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  for (const [needle, type] of Object.entries(MARKET_TYPES)) {
    if (normalized.includes(needle)) return type;
  }
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
  return clean(rawName || key || type, 120);
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

function sportmonksBookmakerIdentity(row, rowIndex) {
  const relation = sportmonksRelation(row?.bookmaker);
  const id = clean(row?.bookmaker_id ?? relation?.id);
  const name = clean(relation?.name || row?.bookmaker_name, 120);
  if (id) return { key: `id-${id}`, missing: false };
  if (name) return { key: `name-${name}`, missing: false };
  return { key: `row-${rowIndex}`, missing: true };
}

function sportmonksMarketType(description) {
  if (/goal[_\s-]*line/.test(clean(description).toLowerCase())) return 'TOTALS';
  return marketType(description);
}

const crypto = await import('node:crypto');
function hash(...parts) {
  return crypto.createHash('sha256').update(parts.map(v => clean(v, 500)).join('|')).digest('hex').slice(0, 28);
}

function teamKey(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').replace(/\b(fc|cf|sc|afc|club|the)\b/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function leagueKey(value) {
  const key = teamKey(value);
  const aliases = {
    epl: 'premier-league', 'english-premier-league': 'premier-league',
    laliga: 'la-liga', 'spanish-la-liga': 'la-liga',
    'italian-serie-a': 'serie-a', 'german-bundesliga': 'bundesliga',
    'french-ligue-1': 'ligue-1', 'ligue-one': 'ligue-1',
    ucl: 'champions-league', 'uefa-champions-league': 'champions-league'
  };
  return aliases[key] || key;
}

function iso(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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

function eventId(sport, home, away, startTime) {
  return hash('event', sport, teamKey(home), teamKey(away), iso(startTime) ?? clean(startTime));
}

function selectionId(event, marketKey, label, line) {
  return hash('selection', event, marketKey, clean(label).toLowerCase(), line ?? '');
}

function marketId(event, type, period, line, name) {
  return hash('market', event, type, period, line ?? '', clean(name).toLowerCase());
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
    key: clean(key || clean(name).toLowerCase(), 120),
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
  const resolvedSport = sport;
  const id = eventId(resolvedSport, home, away, startTime);
  const resolvedStatus = state;
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
    home: { name: clean(home, 120), score: number(homeScore), logo: homeLogo },
    away: { name: clean(away, 120), score: number(awayScore), logo: awayLogo },
    leagueLogo,
    venue: clean(venue, 160) || null,
    periodScores: periodScores && typeof periodScores === 'object' ? periodScores : {},
    markets: markets.filter(Boolean),
    _refs: { [provider]: clean(providerId, 160) },
    _sources: [provider],
    _settlementReadySources: [provider]
  };
}

async function normalizeFixture(raw, oddsRows = raw?.odds) {
  const participants = sportmonksRows(raw?.participants);
  const home = participants.find(p => p?.meta?.location === 'home') || participants[0];
  const away = participants.find(p => p?.meta?.location === 'away') || participants[1];
  if (!home?.name || !away?.name) return null;

  const byMarket = new Map();
  for (const [rowIndex, row] of sportmonksRows(oddsRows).entries()) {
    const marketId = clean(row?.market_id);
    const market = sportmonksRelation(row?.market);
    const marketName = clean(row?.market_description || market?.name || market?.label || row?.name, 120);
    const bookmakerIdentity = sportmonksBookmakerIdentity(row, rowIndex);
    const identity = marketId
      ? `id:${marketId}:bookmaker:${bookmakerIdentity.key}`
      : marketName
        ? `name:${marketName.toLowerCase()}:bookmaker:${bookmakerIdentity.key}`
        : '';
    if (!identity) continue;
    const group = byMarket.get(identity) || { rows: [], bookmakerKey: bookmakerIdentity.key };
    group.rows.push(row);
    byMarket.set(identity, group);
  }

  const state = sportmonksRelation(raw?.state);
  const league = sportmonksRelation(raw?.league);
  const country = sportmonksRelation(league?.country);
  const current = sportmonksRows(raw?.scores).find(e => clean(e?.description).toUpperCase() === 'CURRENT')?.score || {};
  const startTime = sportmonksStartTime(raw);

  const event = normalizedEvent({
    provider: 'sportmonks',
    providerId: String(raw?.id ?? ''),
    sport: 'Football',
    league: league?.name,
    country: country?.name,
    startTime,
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
    .map(({ rows, bookmakerKey }) => {
      const sample = rows[0] || {};
      const providerMarketId = clean(sample.market_id);
      const marketRelation = sportmonksRelation(sample.market);
      const bookmakerRelation = sportmonksRelation(sample.bookmaker);
      const rawDescription = clean(sample.market_description || marketRelation?.name || marketRelation?.label || sample.name || (providerMarketId ? `Market ${providerMarketId}` : ''), 120);
      if (!rawDescription) return null;
      const type = sportmonksMarketType(rawDescription);
      const bookmakerId = clean(sample.bookmaker_id ?? bookmakerRelation?.id);
      const rawBookmaker = clean(bookmakerRelation?.name || sample.bookmaker_name || bookmakerId, 120);
      const bookmaker = rawBookmaker || null;
      const period = periodFromName(rawDescription, `m${sample.market_id ?? ''}`);
      const marketKey = providerMarketId
        ? `m${providerMarketId}:b${bookmakerKey}`
        : `name:${rawDescription.toLowerCase()}:b${bookmakerKey}`;
      const grouped = new Map();
      for (const [rowIndex, row] of rows.entries()) {
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
        const key = `${clean(label).toLowerCase()}|${line ?? ''}`;
        const previous = grouped.get(key);
        if (!previous || selection.odds < previous.odds) grouped.set(key, selection);
      }
      const selections = [...grouped.values()];
      if (!selections.length) return null;
      const updatedAt = rows.reduce((latest, row) => {
        const at = iso(row?.latest_bookmaker_update);
        return at && (!latest || at > latest) ? at : latest;
      }, null);
      return normalizedMarket(event.id, {
        key: marketKey,
        name: type === 'OTHER' ? rawDescription : marketLabel(type, rawDescription, `m${sample.market_id}`),
        type,
        period,
        selections,
        source: 'sportmonks',
        sourceMarketId: providerMarketId ? `m${providerMarketId}` : null,
        bookmaker,
        suspended: selections.every(s => s.suspended),
        updatedAt
      });
    })
    .filter(Boolean);

  return event;
}

async function run() {
  const funnel = {
    provider: 'sportmonks',
    requests: 0,
    rawFixtures: 0,
    fixturesWithOdds: 0,
    oddsRows: 0,
    normalizedEvents: 0,
    normalizedMarkets: 0,
    normalizedOdds: 0,
    errors: [],
    datesFetched: [],
    datesSkipped: skippedDates
  };

  console.log(`SPORTMONKS_BENCHMARK_START`);

  for (const date of datesToFetch) {
    if (funnel.requests >= MAX_REQUESTS) break;
    for (let page = 1; page <= MAX_PAGES_PER_DATE && funnel.requests < MAX_REQUESTS; page++) {
      const url = buildFixtureUrl(SPORTMONKS_BASE_URL, date, page);
      funnel.requests++;
      try {
        const payload = await requestJson(url, `Sportmonks ${date} page ${page}`);
        const fixtures = parseFixtures(payload);
        const resultCount = fixtures.length;
        console.log(`SPORTMONKS_RESULT date=${date} page=${page} fixtures=${resultCount}`);
        if (!resultCount) break;
        funnel.rawFixtures += resultCount;

        for (const fixture of fixtures) {
          const oddsRows = sportmonksRows(fixture?.odds);
          if (oddsRows.length) funnel.fixturesWithOdds++;
          funnel.oddsRows += oddsRows.length;

          const event = await normalizeFixture(fixture, fixture?.odds);
          if (event) {
            funnel.normalizedEvents++;
            funnel.normalizedMarkets += event.markets.length;
            funnel.normalizedOdds += event.markets.reduce((sum, m) => sum + m.selections.length, 0);
          }
        }

        const hasMore = payload?.pagination?.has_more ?? fixtures.length >= PAGE_SIZE;
        if (!hasMore) break;
      } catch (error) {
        funnel.errors.push(`${date} page ${page}: ${error.message}`);
        console.error(`SPORTMONKS_ERROR ${date} page ${page}: ${error.message}`);
      }
    }
    funnel.datesFetched.push(date);
  }

  const rawPath = `/tmp/sportmonks-benchmark-${Date.now()}.json`;
  await import('node:fs/promises').then(fs => fs.writeFile(rawPath, JSON.stringify(funnel, null, 2)));
  console.log(`SPORTMONKS_RAW_SAVED ${rawPath}`);

  console.log(JSON.stringify({
    provider: 'sportmonks',
    requests: funnel.requests,
    input: {
      rawFixtures: funnel.rawFixtures,
      fixturesWithOdds: funnel.fixturesWithOdds,
      oddsRows: funnel.oddsRows
    },
    output: {
      normalizedEvents: funnel.normalizedEvents,
      normalizedMarkets: funnel.normalizedMarkets,
      normalizedOdds: funnel.normalizedOdds
    },
    errors: funnel.errors.length,
    errorDetails: funnel.errors,
    datesFetched: funnel.datesFetched,
    datesSkipped: funnel.datesSkipped
  }));
}

run().catch(err => {
  console.error('SPORTMONKS_FATAL:', err.message);
  process.exit(1);
});