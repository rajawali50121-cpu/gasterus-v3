import { createHmac } from 'node:crypto';

const INGEST_MAX_ATTEMPTS = 3;
const INGEST_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const INGEST_MAX_RETRY_AFTER_MS = 10_000;

function ingestRetryDelayMs(response, attempt) {
  const value = response?.headers?.get?.('retry-after');
  const seconds = Number(value);
  const retryAt = Number.isFinite(seconds) && seconds >= 0
    ? Date.now() + seconds * 1000
    : Date.parse(String(value || ''));
  const requestedDelay = Number.isFinite(retryAt) ? retryAt - Date.now() : 250 * attempt;
  return Math.min(INGEST_MAX_RETRY_AFTER_MS, Math.max(0, requestedDelay));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createSportsbookIngestRequest(snapshot, secret, {
  timestamp = Math.floor(Date.now() / 1000),
  maxPayloadBytes = 6_291_456
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
  }
  const rawBody = Buffer.from(JSON.stringify(snapshot));
  if (rawBody.length > maxPayloadBytes) {
    throw new Error(`Sportsbook snapshot exceeds the ${maxPayloadBytes}-byte payload limit.`);
  }
  const timestampHeader = String(timestamp);
  const signature = createHmac('sha256', secret)
    .update(timestampHeader)
    .update('.')
    .update(rawBody)
    .digest('hex');
  return {
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'content-length': String(rawBody.length),
      'x-sportsbook-timestamp': timestampHeader,
      'x-sportsbook-signature': signature
    }
  };
}

export async function postSportsbookSnapshot(endpoint, snapshot, {
  secret,
  fetchImpl = fetch,
  timeoutMs = 15000,
  maxPayloadBytes = 6_291_456
} = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Sportsbook ingestion endpoint must use HTTPS.');
  const request = createSportsbookIngestRequest(snapshot, secret, { maxPayloadBytes });
  for (let attempt = 1; attempt <= INGEST_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt === INGEST_MAX_ATTEMPTS) throw error;
      await wait(250 * attempt);
      continue;
    }
    if (!response.ok) {
      const error = new Error(`Sportsbook ingestion returned HTTP ${response.status}.`);
      if (!INGEST_RETRYABLE_STATUSES.has(response.status) || attempt === INGEST_MAX_ATTEMPTS) throw error;
      await wait(ingestRetryDelayMs(response, attempt));
      continue;
    }
    return response.json();
  }
  throw new Error('Sportsbook ingestion failed after retries.');
}
