import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  try { process.loadEnvFile(envPath); } catch { /* ignore */ }
}

const ODDSPAPI_API_KEY = process.env.ODDSPAPI_API_KEY;
const ODDSPAPI_BASE_URL = process.env.ODDSPAPI_BASE_URL || 'https://api.oddspapi.io';
const ODDSPAPI_TOURNAMENT_IDS = (process.env.ODDSPAPI_TOURNAMENT_IDS || '17').split(',').map(s => s.trim()).filter(Boolean);
const ODDSPAPI_BOOKMAKER = process.env.ODDSPAPI_BOOKMAKER || 'pinnacle';

// Hard limits (not overridable by env)
const MAX_REQUESTS = 3;
const BENCH_DAYS_AHEAD = 3; // today + 3 days = 4 days total
const TIMEOUT_MS = 15000;

// OddsPapi free plan: 8 requests/day, 240/month
// We limit to 3 requests for benchmark

if (!ODDSPAPI_API_KEY) {
  console.error('ERROR: ODDSPAPI_API_KEY not set');
  process.exit(1);
}

function wibDate(offsetDays = 0) {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  wib.setUTCDate(wib.getUTCDate() + offsetDays);
  return wib.toISOString().slice(0, 10);
}

const TODAY_WIB = wibDate(0);
const END_WIB = wibDate(BENCH_DAYS_AHEAD);

// Pre-flight estimate
// Need: 1 tournaments + 1 markets + 1 fixtures = 3 requests minimum
const estimatedRequests = 3;
console.log(`ODDSPAPI_BENCHMARK_CONFIG max_requests=${MAX_REQUESTS} window=${TODAY_WIB}..${END_WIB} (WIB) tournaments=${ODDSPAPI_TOURNAMENT_IDS.join(',')} bookmaker=${ODDSPAPI_BOOKMAKER} free_plan=8 req/day, 240/month`);
console.log(`ODDSPAPI_PREFILIGHT estimated_requests=${estimatedRequests} max_requests=${MAX_REQUESTS} (tournaments + markets + fixtures; odds-by-tournaments skipped due to limit)`);

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
  console.log(`ODDSPAPI_RESP_BYTES ${bytes} url=${url}`);
  
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
  
  return payload;
}

function buildUrl(baseUrl, path, params) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/v4/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set('apiKey', ODDSPAPI_API_KEY);
  return url.toString();
}

function parseResponse(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'results', 'fixtures', 'tournaments', 'markets']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function run() {
  const now = Date.now();
  const from = new Date(now).toISOString();
  const to = new Date(now + (BENCH_DAYS_AHEAD + 1) * 24 * 60 * 60 * 1000).toISOString(); // +1 to include end date

  const funnel = {
    provider: 'oddspapi',
    requests: 0,
    tournaments: 0,
    markets: 0,
    rawFixtures: 0,
    rawOddsFixtures: 0,
    events: 0,
    marketsOut: 0,
    oddsOut: 0,
    errors: [],
    endpointsSkipped: []
  };

  console.log(`ODDSPAPI_BENCHMARK_START from=${from} to=${to}`);

  // 1. Tournaments
  if (funnel.requests < MAX_REQUESTS) {
    const tournamentsUrl = buildUrl(ODDSPAPI_BASE_URL, 'tournaments', { sportId: 10, language: 'en' });
    funnel.requests++;
    try {
      const payload = await requestJson(tournamentsUrl, 'OddsPapi tournaments');
      const tournaments = parseResponse(payload);
      funnel.tournaments = tournaments.length;
      console.log(`ODDSPAPI_RESULT endpoint=tournaments count=${tournaments.length}`);
    } catch (error) {
      funnel.errors.push(`tournaments: ${error.message}`);
      console.error(`ODDSPAPI_ERROR tournaments: ${error.message}`);
    }
  } else {
    funnel.endpointsSkipped.push('tournaments');
  }

  // 2. Markets
  if (funnel.requests < MAX_REQUESTS) {
    const marketsUrl = buildUrl(ODDSPAPI_BASE_URL, 'markets', { sportId: 10, language: 'en' });
    funnel.requests++;
    try {
      const payload = await requestJson(marketsUrl, 'OddsPapi markets');
      const markets = parseResponse(payload);
      funnel.markets = markets.length;
      console.log(`ODDSPAPI_RESULT endpoint=markets count=${markets.length}`);
    } catch (error) {
      funnel.errors.push(`markets: ${error.message}`);
      console.error(`ODDSPAPI_ERROR markets: ${error.message}`);
    }
  } else {
    funnel.endpointsSkipped.push('markets');
  }

  // 3. Fixtures (for the 4-day window)
  if (funnel.requests < MAX_REQUESTS) {
    const fixturesUrl = buildUrl(ODDSPAPI_BASE_URL, 'fixtures', {
      sportId: 10,
      from,
      to,
      statusId: 0,
      hasOdds: true,
      bookmakers: ODDSPAPI_BOOKMAKER
    });
    funnel.requests++;
    let fixtures = [];
    try {
      const payload = await requestJson(fixturesUrl, 'OddsPapi fixtures');
      fixtures = parseResponse(payload);
      funnel.rawFixtures = fixtures.length;
      console.log(`ODDSPAPI_RESULT endpoint=fixtures count=${fixtures.length}`);
    } catch (error) {
      funnel.errors.push(`fixtures: ${error.message}`);
      console.error(`ODDSPAPI_ERROR fixtures: ${error.message}`);
    }
  } else {
    funnel.endpointsSkipped.push('fixtures');
  }

  // Odds-by-tournaments skipped due to MAX_REQUESTS=3 limit
  funnel.endpointsSkipped.push('odds-by-tournaments (requires additional requests)');

  const rawPath = `/tmp/oddspapi-benchmark-${Date.now()}.json`;
  await import('node:fs/promises').then(fs => fs.writeFile(rawPath, JSON.stringify(funnel, null, 2)));
  console.log(`ODDSPAPI_RAW_SAVED ${rawPath}`);

  console.log(JSON.stringify({
    provider: 'oddspapi',
    requests: funnel.requests,
    input: {
      tournaments: funnel.tournaments,
      markets: funnel.markets,
      rawFixtures: funnel.rawFixtures,
      rawOddsFixtures: funnel.rawOddsFixtures
    },
    output: {
      events: funnel.events,
      markets: funnel.marketsOut,
      odds: funnel.oddsOut
    },
    errors: funnel.errors.length,
    errorDetails: funnel.errors,
    endpointsSkipped: funnel.endpointsSkipped
  }));
}

run().catch(err => {
  console.error('ODDSPAPI_FATAL:', err.message);
  process.exit(1);
});