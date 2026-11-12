import { createHmac } from 'node:crypto';

export function createSportsbookIngestRequest(snapshot, secret, {
  timestamp = Math.floor(Date.now() / 1000),
  ownerToken,
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
  const signedPayload = [timestampHeader, ownerToken || '', rawBody];
  const signature = createHmac('sha256', secret)
    .update(signedPayload.join('.'))
    .digest('hex');
  const headers = {
    'content-type': 'application/json',
    'content-length': String(rawBody.length),
    'x-sportsbook-timestamp': timestampHeader,
    'x-sportsbook-signature': signature
  };
  if (ownerToken !== undefined && ownerToken !== null && ownerToken !== '') {
    headers['x-sportsbook-owner-token'] = ownerToken;
  }
  return {
    body: rawBody,
    headers
  };
}

export async function postSportsbookSnapshot(endpoint, snapshot, {
  secret,
  fetchImpl = fetch,
  timeoutMs = 15000,
  maxPayloadBytes = 6_291_456,
  revision,
  ownerToken,
  signal
} = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Sportsbook ingestion endpoint must use HTTPS.');
  const request = createSportsbookIngestRequest(snapshot, secret, { maxPayloadBytes, ownerToken });
  const headers = {
    ...request.headers
  };
  if (revision !== undefined) {
    headers['x-sportsbook-revision'] = String(revision);
  }
  const fetchOptions = {
    method: 'POST',
    headers,
    body: request.body,
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(timeoutMs)
  };
  const response = await fetchImpl(url, fetchOptions);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Sportsbook ingestion returned HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}
