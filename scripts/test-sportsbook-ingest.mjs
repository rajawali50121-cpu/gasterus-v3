import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSportsbookIngestRequest } from '../backend/src/sportsbook-ingest-client.js';

const localEnvPath = new URL('../backend/.env', import.meta.url);
if (existsSync(localEnvPath)) {
  process.loadEnvFile(fileURLToPath(localEnvPath));
}

const INGEST_PATH = '/api/internal/sportsbook/ingest';
const endpoint = new URL(process.env.SPORTSBOOK_INGEST_URL || `http://127.0.0.1:8080${INGEST_PATH}`);
const secret = process.env.SPORTSBOOK_INGEST_HMAC_SECRET;
const verifyDatabase = process.argv.includes('--verify-db');
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

if (!localHosts.has(endpoint.hostname) || endpoint.pathname !== INGEST_PATH || endpoint.username || endpoint.password) {
  throw new Error(`Local ingest test only permits a loopback URL ending in ${INGEST_PATH}.`);
}
if (!['http:', 'https:'].includes(endpoint.protocol)) {
  throw new Error('SPORTSBOOK_INGEST_URL must use HTTP(S) on loopback for this local test.');
}
if (typeof secret !== 'string' || secret.length < 32) {
  throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
}

const now = Date.now();
const provider = 'sportmonks';
const eventId = `local-ingest-${randomUUID()}`;
const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  eventCount: 2,
  providerResults: [{
    provider,
    enabled: true,
    events: [
      {
        id: `${eventId}-upcoming`,
        sport: 'Football',
        league: 'Local Ingest Test League',
        country: 'Local Test',
        startTime: new Date(now + 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        live: false,
        providerStatus: 'NS',
        home: { name: 'Local Test Home', score: null },
        away: { name: 'Local Test Away', score: null },
        periodScores: {},
        markets: [{
          id: `${eventId}-market`,
          type: '1X2',
          period: 'FT',
          source: provider,
          suspended: false,
          selections: [{
            key: 'home',
            label: 'Home',
            odds: 2.1,
            suspended: false,
            source: provider,
            updatedAt: null
          }]
        }],
        _refs: { [provider]: `${eventId}-provider-upcoming` },
        _sources: [provider]
      },
      {
        id: `${eventId}-live`,
        sport: 'Football',
        league: 'Local Ingest Test League',
        country: 'Local Test',
        startTime: new Date(now - 20 * 60 * 1000).toISOString(),
        status: 'LIVE',
        live: true,
        providerStatus: '1H',
        home: { name: 'Local Live Home', score: 1 },
        away: { name: 'Local Live Away', score: 0 },
        periodScores: { '1H': { home: 1, away: 0 } },
        markets: [],
        _refs: { [provider]: `${eventId}-provider-live` },
        _sources: [provider]
      }
    ]
  }]
};

const signed = createSportsbookIngestRequest(snapshot, secret);
const tamperedBody = Buffer.from(signed.body.toString('utf8').replace(
  'Local Ingest Test League',
  'Local Ingest Test LeaguE'
));
if (tamperedBody.length !== signed.body.length) {
  throw new Error('Internal test error: tampered payload must preserve Content-Length.');
}

const tamperedResponse = await fetch(endpoint, {
  method: 'POST',
  headers: signed.headers,
  body: tamperedBody,
  redirect: 'error',
  signal: AbortSignal.timeout(10_000)
});
const tamperedResult = await tamperedResponse.json();
if (tamperedResponse.status !== 401 || tamperedResult?.error?.code !== 'SPORTSBOOK_INGEST_SIGNATURE_INVALID') {
  throw new Error(`Tampered body was not rejected as expected (HTTP ${tamperedResponse.status}).`);
}
console.log('PASS: tampered request body is rejected with HTTP 401.');

const acceptedResponse = await fetch(endpoint, {
  method: 'POST',
  headers: signed.headers,
  body: signed.body,
  redirect: 'error',
  signal: AbortSignal.timeout(10_000)
});
const acceptedResult = await acceptedResponse.json();
const acceptedData = acceptedResult?.data;
if (acceptedResponse.status !== 202
  || acceptedData?.accepted !== true
  || acceptedData?.eventCount !== 2
  || !acceptedData.providerResults?.includes(provider)) {
  throw new Error(`Valid snapshot was not accepted (HTTP ${acceptedResponse.status}).`);
}
console.log(`PASS: valid HMAC snapshot accepted by ${endpoint.pathname} (2 events).`);

if (verifyDatabase) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when --verify-db is used.');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!localHosts.has(databaseUrl.hostname)) {
    throw new Error('--verify-db only permits a loopback PostgreSQL DATABASE_URL.');
  }

  const [{ persistSportsbookEventStates }, { query, closeDatabase }] = await Promise.all([
    import('../backend/src/sportsbook-event-state.js'),
    import('../backend/src/db.js')
  ]);
  const events = snapshot.providerResults.flatMap(result => result.events);
  let persistedBatch = false;
  try {
    await persistSportsbookEventStates(events, {
      feedRevision: `local-test-${eventId}`,
      observedAt: new Date().toISOString()
    });
    persistedBatch = true;
    const persisted = await query(
      'SELECT event_id,status,is_live FROM sportsbook_event_states WHERE event_id = ANY($1::text[]) ORDER BY event_id',
      [events.map(event => event.id)]
    );
    if (persisted.rowCount !== 2
      || !persisted.rows.some(row => row.status === 'SCHEDULED' && row.is_live === false)
      || !persisted.rows.some(row => row.status === 'LIVE' && row.is_live === true)) {
      throw new Error('PostgreSQL event-state batch did not persist both scheduled and live records.');
    }
    console.log('PASS: PostgreSQL batch projection persisted scheduled and live event states.');
  } finally {
    try {
      if (persistedBatch) {
        await query('DELETE FROM sportsbook_event_states WHERE event_id = ANY($1::text[])', [events.map(event => event.id)]);
      }
    } finally {
      await closeDatabase();
    }
  }
}
