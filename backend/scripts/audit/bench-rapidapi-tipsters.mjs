import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  try { process.loadEnvFile(envPath); } catch { /* ignore */ }
}

const RAPIDAPI_ODDS_CACHE_URL = process.env.RAPIDAPI_ODDS_CACHE_URL;
const RAPIDAPI_ODDS_CACHE_TOKEN = process.env.RAPIDAPI_ODDS_CACHE_TOKEN;

// Hard limits (not overridable by env)
const MAX_REQUESTS = 6; // 1 events + max 5 markets
const BENCH_DAYS_AHEAD = 3; // today + 3 days = 4 days total
const TIMEOUT_MS = 15000;

if (!RAPIDAPI_ODDS_CACHE_URL) {
  console.error('ERROR: RAPIDAPI_ODDS_CACHE_URL not set');
  process.exit(1);
}
if (!RAPIDAPI_ODDS_CACHE_TOKEN) {
  console.error('ERROR: RAPIDAPI_ODDS_CACHE_TOKEN not set');
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
const MAX_MARKETS_REQUESTS = MAX_REQUESTS - 1; // 1 for events, rest for markets
console.log(`RAPIDAPI_BENCHMARK_CONFIG max_requests=${MAX_REQUESTS} window=${TODAY_WIB}..${END_WIB} (WIB) cache_url=${RAPIDAPI_ODDS_CACHE_URL}`);
console.log(`RAPIDAPI_PREFILIGHT estimated_requests=${MAX_REQUESTS} (1 events + ${MAX_MARKETS_REQUESTS} markets) max_requests=${MAX_REQUESTS}`);

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
        'authorization': `Bearer ${RAPIDAPI_ODDS_CACHE_TOKEN}`,
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
  console.log(`RAPIDAPI_RESP_BYTES ${bytes} url=${url}`);
  
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

function buildCacheUrl(path, params = {}) {
  const url = new URL(path, RAPIDAPI_ODDS_CACHE_URL);
  url.searchParams.set('token', RAPIDAPI_ODDS_CACHE_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function parseResponse(payload) {
  return Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
}

async function run() {
  const funnel = {
    provider: 'rapidapi-tipsters',
    requests: 0,
    rawEvents: 0,
    rawMarkets: 0,
    normalizedEvents: 0,
    normalizedMarkets: 0,
    normalizedOdds: 0,
    errors: [],
    eventsSkipped: 0
  };

  console.log(`RAPIDAPI_BENCHMARK_START`);

  // 1. Events
  if (funnel.requests < MAX_REQUESTS) {
    const eventsUrl = buildCacheUrl('/events');
    funnel.requests++;
    let events = [];
    try {
      const payload = await requestJson(eventsUrl, 'RapidAPI Tipsters events');
      events = parseResponse(payload);
      funnel.rawEvents = events.length;
      console.log(`RAPIDAPI_RESULT endpoint=events count=${events.length}`);
    } catch (error) {
      funnel.errors.push(`events: ${error.message}`);
      console.error(`RAPIDAPI_ERROR events: ${error.message}`);
    }
  }

  // 2. Markets for first N events (sample, max MAX_MARKETS_REQUESTS)
  const sampleEvents = events.slice(0, MAX_MARKETS_REQUESTS);
  funnel.eventsSkipped = Math.max(0, events.length - MAX_MARKETS_REQUESTS);
  console.log(`RAPIDAPI_SAMPLING events=${sampleEvents.length} of ${events.length} for markets (limit ${MAX_MARKETS_REQUESTS})`);
  for (const event of sampleEvents) {
    if (funnel.requests >= MAX_REQUESTS) break;
    const eventId = event?.id;
    if (!eventId) continue;
    const marketsUrl = buildCacheUrl('/markets', { event_id: eventId });
    funnel.requests++;
    try {
      const payload = await requestJson(marketsUrl, `RapidAPI Tipsters markets event ${eventId}`);
      const markets = parseResponse(payload);
      funnel.rawMarkets += markets.length;
      console.log(`RAPIDAPI_RESULT endpoint=markets event_id=${eventId} count=${markets.length}`);
    } catch (error) {
      funnel.errors.push(`markets ${eventId}: ${error.message}`);
      console.error(`RAPIDAPI_ERROR markets ${eventId}: ${error.message}`);
    }
  }

  const rawPath = `/tmp/rapidapi-tipsters-benchmark-${Date.now()}.json`;
  await import('node:fs/promises').then(fs => fs.writeFile(rawPath, JSON.stringify(funnel, null, 2)));
  console.log(`RAPIDAPI_RAW_SAVED ${rawPath}`);

  console.log(JSON.stringify({
    provider: 'rapidapi-tipsters',
    requests: funnel.requests,
    input: {
      rawEvents: funnel.rawEvents,
      rawMarkets: funnel.rawMarkets
    },
    output: {
      normalizedEvents: funnel.normalizedEvents,
      normalizedMarkets: funnel.normalizedMarkets,
      normalizedOdds: funnel.normalizedOdds
    },
    errors: funnel.errors.length,
    errorDetails: funnel.errors,
    eventsSkipped: funnel.eventsSkipped
  }));
}

run().catch(err => {
  console.error('RAPIDAPI_FATAL:', err.message);
  process.exit(1);
});