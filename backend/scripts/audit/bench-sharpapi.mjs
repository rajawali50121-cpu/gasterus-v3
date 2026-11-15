import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  try { process.loadEnvFile(envPath); } catch { /* ignore */ }
}

const SHARP_API_KEY = process.env.SHARP_API_KEY;
const SHARP_API_BASE_URL = process.env.SHARP_API_BASE_URL || 'https://api.sharpapi.io';
const SHARP_API_SPORT = process.env.SHARP_API_SPORT || 'soccer';
const SHARP_API_MARKETS = process.env.SHARP_API_MARKETS || '';
const SHARP_API_SPORTSBOOK = process.env.SHARP_API_SPORTSBOOK || '';
const SHARP_API_PAGE_SIZE = parseInt(process.env.SHARP_API_PAGE_SIZE || '200', 10);
const TIMEOUT_MS = 15000;

// Hard limit (not overridable by env)
const MAX_REQUESTS = 50;
const MAX_PAGES = Math.min(parseInt(process.env.SHARP_API_MAX_PAGES || '5', 10), MAX_REQUESTS);

if (!SHARP_API_KEY) {
  console.error('ERROR: SHARP_API_KEY not set');
  process.exit(1);
}

// Pre-flight estimate
const estimatedRequests = MAX_PAGES;
console.log(`SHARPAPI_BENCHMARK_CONFIG sport=${SHARP_API_SPORT} markets=${SHARP_API_MARKETS || '*'} sportsbook=${SHARP_API_SPORTSBOOK || '*'} page_size=${SHARP_API_PAGE_SIZE} max_pages=${MAX_PAGES} (no date window; provider returns upcoming)`);
console.log(`SHARPAPI_PREFILIGHT estimated_requests=${estimatedRequests} max_requests=${MAX_REQUESTS}`);

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
  console.log(`SHARPAPI_RESP_BYTES ${bytes} url=${url}`);
  
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

function buildOddsUrl(baseUrl, offset) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v1/odds`);
  url.searchParams.set('sport', SHARP_API_SPORT);
  if (SHARP_API_MARKETS) url.searchParams.set('market', SHARP_API_MARKETS);
  if (SHARP_API_SPORTSBOOK) url.searchParams.set('sportsbook', SHARP_API_SPORTSBOOK);
  url.searchParams.set('limit', String(SHARP_API_PAGE_SIZE));
  if (offset > 0) url.searchParams.set('offset', String(offset));
  return url.toString();
}

async function run() {
  const funnel = {
    provider: 'sharpapi',
    requests: 0,
    rawRows: 0,
    normalizedEvents: 0,
    normalizedMarkets: 0,
    normalizedOdds: 0,
    errors: []
  };

  console.log(`SHARPAPI_BENCHMARK_START`);

  let offset = 0;
  for (let page = 0; page < MAX_PAGES && funnel.requests < MAX_REQUESTS; page++) {
    const url = buildOddsUrl(SHARP_API_BASE_URL, offset);
    funnel.requests++;
    try {
      const payload = await requestJson(url, `SharpAPI page ${page + 1}`);
      const pageRows = Array.isArray(payload?.data) ? payload.data : [];
      const resultCount = pageRows.length;
      console.log(`SHARPAPI_RESULT page=${page + 1} rows=${resultCount} has_more=${payload?.pagination?.has_more ?? false} next_offset=${payload?.pagination?.next_offset ?? 'none'}`);
      funnel.rawRows += resultCount;

      const pagination = payload?.pagination || {};
      const nextOffset = pagination?.next_offset;
      if (!pagination?.has_more || nextOffset === null || nextOffset === undefined) break;
      const parsedOffset = Number(nextOffset);
      if (!Number.isFinite(parsedOffset) || parsedOffset <= offset) break;
      offset = parsedOffset;
    } catch (error) {
      funnel.errors.push(`page ${page + 1}: ${error.message}`);
      console.error(`SHARPAPI_ERROR page ${page + 1}: ${error.message}`);
    }
  }

  const rawPath = `/tmp/sharpapi-benchmark-${Date.now()}.json`;
  await import('node:fs/promises').then(fs => fs.writeFile(rawPath, JSON.stringify(funnel, null, 2)));
  console.log(`SHARPAPI_RAW_SAVED ${rawPath}`);

  console.log(JSON.stringify({
    provider: 'sharpapi',
    requests: funnel.requests,
    input: {
      rawRows: funnel.rawRows
    },
    output: {
      normalizedEvents: funnel.normalizedEvents,
      normalizedMarkets: funnel.normalizedMarkets,
      normalizedOdds: funnel.normalizedOdds
    },
    errors: funnel.errors.length,
    errorDetails: funnel.errors
  }));
}

run().catch(err => {
  console.error('SHARPAPI_FATAL:', err.message);
  process.exit(1);
});