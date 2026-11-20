import { createHmac } from 'node:crypto';

export function createSportsbookIngestRequest(snapshot, secret, {
  timestamp = Math.floor(Date.now() / 1000)
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
  }
  const rawBody = Buffer.from(JSON.stringify(snapshot));
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

export function validateSportsbookIngestEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new Error('Sportsbook ingestion endpoint must not contain URL credentials.');
  }
  if (url.protocol === 'https:') return url;
  // Railway private service-to-service traffic uses HTTP on the private network.
  // Permit that transport only for Railway's internal DNS suffix; public HTTP
  // endpoints remain rejected so the HMAC secret is never sent over plaintext.
  if (url.protocol === 'http:' && url.hostname.endsWith('.railway.internal')) return url;
  throw new Error('Sportsbook ingestion endpoint must use HTTPS, or HTTP on a Railway private .railway.internal hostname.');
}

export async function postSportsbookSnapshot(endpoint, snapshot, {
  secret,
  fetchImpl = fetch,
  timeoutMs = 15000
} = {}) {
  const url = validateSportsbookIngestEndpoint(endpoint);
  const request = createSportsbookIngestRequest(snapshot, secret);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Sportsbook ingestion returned HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}
