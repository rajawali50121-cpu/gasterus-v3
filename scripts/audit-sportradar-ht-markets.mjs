#!/usr/bin/env node
/**
 * Read-only Sportradar prematch market audit.
 * GET-only: no database, Redis, cache, or sportsbook API writes.
 *
 * Required: SPORTRADAR_API_KEY
 * Optional: SPORTRADAR_BASE_URL, SPORTRADAR_MIN_INTERVAL_MS
 * Default base URL matches the configured Sportradar trial product.
 */
const API_KEY = String(process.env.SPORTRADAR_API_KEY || '').trim();
const BASE_URL = String(
  process.env.SPORTRADAR_BASE_URL ||
  'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en'
).replace(/\/+$/, '');
const SPORT_ID = 'sr:sport:1';
const PAGE_SIZE = 50;
const TARGET_EVENTS = 20;
const MAX_DAYS_AHEAD = 21;
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.SPORTRADAR_MIN_INTERVAL_MS || 1100));

if (!API_KEY) {
  console.error('Missing SPORTRADAR_API_KEY. Set it in the terminal environment; the key is never printed.');
  process.exit(1);
}

let lastRequestAt = 0;
async function getJson(url) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Sportradar HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  return { data: await response.json(), headers: response.headers };
}

function wibDate(offsetDays) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offsetDays));
  return date.toISOString().slice(0, 10);
}
function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function asNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function marketType(name) {
  const value = clean(name).toLowerCase();
  if (/\bhalf.?time.*full.?time|first.?half.*full.?time|1st.?half.*full.?time|\bht\s*[/-]?\s*ft\b/.test(value)) return 'HT_FT';
  if (/1x2|money.?line|match.?winner|match.?result|three.?way|first.?half.*result|1st.?half.*result|half.?time.*result/.test(value)) return '1X2';
  if (/handicap|spread/.test(value)) return 'HANDICAP';
  if (/team.?total/.test(value)) return 'TEAM_TOTAL';
  if (/total|over.?under|goals/.test(value)) return 'TOTALS';
  return 'OTHER';
}
function periodFromMarket(name, market = {}) {
  const value = clean(name).toLowerCase();
  const candidates = [
    market.period, market.period_name, market.periodName,
    market.match_period, market.matchPeriod, market.period_id,
    market.specifiers?.period, market.specifiers?.match_period
  ].map(item => clean(item).toLowerCase()).filter(Boolean);
  const classify = candidate => {
    if (/second.?half|2nd.?half|\b2h\b|period.?2/.test(candidate)) return '2H';
    if (/first.?half|1st.?half|half.?time|\b1h\b|period.?1/.test(candidate)) return '1H';
    if (/full.?time|\bft\b|match.?time|regular.?time/.test(candidate)) return 'FT';
    return null;
  };
  for (const candidate of candidates) {
    const period = classify(candidate);
    if (period) return period;
  }
  return classify(value) || 'FT';
}
function validOddsCount(market) {
  let count = 0;
  for (const book of Array.isArray(market.books) ? market.books : []) {
    if (book?.removed === true || String(book?.removed).toLowerCase() === 'true') continue;
    for (const outcome of Array.isArray(book?.outcomes) ? book.outcomes : []) {
      const odds = asNumber(outcome?.odds_decimal);
      const removed = outcome?.removed === true || String(outcome?.removed).toLowerCase() === 'true';
      if (!removed && !market.is_live && Number.isFinite(odds) && odds > 1) count += 1;
    }
  }
  return count;
}
function eventName(event) {
  const competitors = Array.isArray(event?.competitors) ? event.competitors : [];
  const home = competitors.find(item => String(item?.qualifier).toLowerCase() === 'home')?.name;
  const away = competitors.find(item => String(item?.qualifier).toLowerCase() === 'away')?.name;
  return `${home || competitors[0]?.name || 'TBD'} vs ${away || competitors[1]?.name || 'TBD'}`;
}

async function main() {
  const now = Date.now();
  const byId = new Map();
  let pagesFetched = 0;
  for (let day = 0; day <= MAX_DAYS_AHEAD && byId.size < TARGET_EVENTS; day += 1) {
    let start = 0;
    while (byId.size < TARGET_EVENTS) {
      const url = new URL(`${BASE_URL}/sports/${encodeURIComponent(SPORT_ID)}/schedules/${wibDate(day)}/sport_event_markets.json`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('start', String(start));
      const result = await getJson(url.toString());
      pagesFetched += 1;
      const rows = Array.isArray(result.data?.sport_schedule_sport_event_markets)
        ? result.data.sport_schedule_sport_event_markets : [];
      if (!rows.length) break;
      for (const row of rows) {
        const event = row?.sport_event;
        const id = String(event?.id || '');
        const startTime = Date.parse(event?.start_time || '');
        if (!id || !Number.isFinite(startTime) || startTime < now) continue;
        if (!byId.has(id)) byId.set(id, { event, row });
      }
      start += rows.length;
      const maxResultsHeader = result.headers.get('x-max-results');
      const maxResults = maxResultsHeader === null ? null : Number(maxResultsHeader);
      if ((Number.isFinite(maxResults) && start >= maxResults) || rows.length < PAGE_SIZE) break;
    }
  }

  const events = [...byId.values()]
    .sort((a, b) => Date.parse(a.event.start_time) - Date.parse(b.event.start_time))
    .slice(0, TARGET_EVENTS)
    .map(({ event, row }) => {
      const groups = { FT: [], '1H': [] };
      const counts = { FT: 0, '1H': 0 };
      for (const market of Array.isArray(row.markets) ? row.markets : []) {
        const type = marketType(market?.name || market?.id);
        const period = periodFromMarket(market?.name || market?.id, market);
        if (!['1X2', 'HANDICAP', 'TOTALS'].includes(type) || !['FT', '1H'].includes(period)) continue;
        const validOdds = validOddsCount(market);
        groups[period].push({
          type,
          name: clean(market.name || market.id || 'Unlabelled market'),
          validOdds
        });
        counts[period] += validOdds;
      }
      return {
        id: event.id,
        kickoff: event.start_time,
        match: eventName(event),
        FT: groups.FT,
        HT_1H: groups['1H'],
        validOddsSelections: { FT: counts.FT, HT_1H: counts['1H'] },
        validPricedCoreMarkets: {
          FT: groups.FT.filter(item => item.validOdds > 0).length,
          HT_1H: groups['1H'].filter(item => item.validOdds > 0).length
        }
      };
    });

  console.log(JSON.stringify({
    mode: 'READ_ONLY_GET_ONLY',
    provider: 'Sportradar Odds Comparison prematch',
    sportId: SPORT_ID,
    baseUrl: BASE_URL,
    pagesFetched,
    requestedMatches: TARGET_EVENTS,
    returnedMatches: events.length,
    note: 'Counts are raw decimal-priced selections > 1, excluding removed books/outcomes and live markets. No odds are generated or inferred.',
    matches: events
  }, null, 2));
  if (events.length < TARGET_EVENTS) {
    console.error(`Only ${events.length}/${TARGET_EVENTS} upcoming matches were returned in the ${MAX_DAYS_AHEAD}-day search window.`);
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(`Sportradar read-only audit failed: ${error.message}`);
  process.exitCode = 1;
});
