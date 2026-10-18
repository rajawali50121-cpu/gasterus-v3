import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.DATABASE_URL ||= 'postgres://localhost:5432/gasterus-test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.MEMBER_PROXY_SECRET ||= 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET ||= 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET ||= 'o'.repeat(48);
process.env.SESSION_HMAC_KEY ||= 's'.repeat(48);
process.env.API_KEY_PEPPER ||= 'p'.repeat(48);
process.env.MFA_ENCRYPTION_KEY_BASE64 ||= Buffer.alloc(32, 1).toString('base64');

const { acceptSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
const { createSportsbookIngestRequest } = await import('../src/sportsbook-ingest-client.js');
const SECRET = 'ingest-secret-for-test-only-'.padEnd(48, 'x');
const NOW = Date.UTC(2025, 0, 2, 12, 0, 0);

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{
      provider: 'sportmonks',
      enabled: true,
      events: [{
        id: 'event-123',
        sport: 'Football',
        league: 'Premier League',
        country: 'England',
        startTime: new Date(NOW + 3600000).toISOString(),
        status: 'SCHEDULED',
        live: false,
        home: { name: 'Home FC' },
        away: { name: 'Away FC' },
        markets: [{
          id: 'market-123',
          type: '1X2',
          period: 'FT',
          source: 'sportmonks',
          suspended: false,
          selections: [{
            key: 'selection-123',
            label: 'Home',
            odds: 2.1,
            suspended: false,
            source: 'sportmonks',
            updatedAt: null
          }]
        }],
        _refs: { sportmonks: 'provider-event-123' },
        _sources: ['sportmonks']
      }]
    }]
  };
}

function requestFor(body, headers) {
  const request = Readable.from([body]);
  request.headers = headers;
  return request;
}

function signedRequest(payload, { timestamp = Math.floor(NOW / 1000), maxPayloadBytes } = {}) {
  return createSportsbookIngestRequest(payload, SECRET, { timestamp, maxPayloadBytes });
}

test('accepts a fresh HMAC-signed snapshot and stores only its verified JSON', async () => {
  const payload = snapshot();
  const signed = signedRequest(payload);
  let stored;
  let storedBytes;
  const result = await acceptSportsbookSnapshot(
    requestFor(signed.body, signed.headers),
    {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async (value, serialized) => { stored = value; storedBytes = serialized; }
    }
  );

  assert.deepEqual(result, {
    accepted: true,
    generatedAt: payload.generatedAt,
    providerResults: ['sportmonks'],
    eventCount: 1
  });
  assert.deepEqual(stored, payload);
  assert.equal(storedBytes, signed.body.toString());
});

test('accepts active display-only events that carry no priced markets yet', async () => {
  const payload = snapshot();
  payload.providerResults[0].events.push({
    id: 'event-unpriced',
    sport: 'Football',
    league: 'Serie A',
    country: 'Italy',
    startTime: new Date(NOW + 7200000).toISOString(),
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Home B FC' },
    away: { name: 'Away B FC' },
    markets: [],
    _refs: { sportmonks: 'provider-event-unpriced' },
    _sources: ['sportmonks']
  });
  const signed = signedRequest(payload);
  let stored;
  const result = await acceptSportsbookSnapshot(
    requestFor(signed.body, signed.headers),
    {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async value => { stored = value; }
    }
  );

  assert.equal(result.eventCount, 2, 'event aktif tanpa pasar tetap diterima sebagai katalog display-only');
  assert.equal(stored.providerResults[0].events.length, 2);
  assert.deepEqual(stored.providerResults[0].events[1].markets, []);
});

test('rejects an invalid signature without storing the snapshot', async () => {
  const signed = signedRequest(snapshot());
  signed.headers['x-sportsbook-signature'] = '0'.repeat(64);
  let stored = false;
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(signed.body, signed.headers), {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => { stored = true; }
    }),
    error => error.code === 'SPORTSBOOK_INGEST_SIGNATURE_INVALID'
  );
  assert.equal(stored, false);
});

test('rejects stale signing timestamps before reading or storing a body', async () => {
  const signed = signedRequest(snapshot(), { timestamp: Math.floor(NOW / 1000) - 181 });
  let stored = false;
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(signed.body, signed.headers), {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => { stored = true; }
    }),
    error => error.code === 'SPORTSBOOK_INGEST_SIGNATURE_EXPIRED'
  );
  assert.equal(stored, false);
});

test('rejects stale snapshot data despite a fresh request signature', async () => {
  const payload = snapshot();
  payload.generatedAt = new Date(NOW - 181000).toISOString();
  const signed = signedRequest(payload);
  let stored = false;
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(signed.body, signed.headers), {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => { stored = true; }
    }),
    error => error.code === 'SPORTSBOOK_INGEST_SNAPSHOT_STALE'
  );
  assert.equal(stored, false);
});

test('rejects snapshots over the configured byte limit before reading the full body', async () => {
  const signed = signedRequest(snapshot());
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(signed.body, signed.headers), {
      secret: SECRET,
      maxPayloadBytes: signed.body.length - 1,
      now: NOW,
      storeSnapshot: async () => assert.fail('oversized snapshot must not be stored')
    }),
    error => error.code === 'SPORTSBOOK_INGEST_PAYLOAD_TOO_LARGE'
  );
});

test('rejects malformed normalized events and snapshots above 500 events', async () => {
  const malformed = snapshot();
  malformed.providerResults[0].events[0].markets[0].selections[0].odds = 1;
  const malformedSigned = signedRequest(malformed);
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(malformedSigned.body, malformedSigned.headers), {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => assert.fail('invalid event must not be stored')
    }),
    error => error.code === 'SPORTSBOOK_INGEST_INVALID'
  );

  const oversized = snapshot();
  oversized.providerResults[0].events = Array(501).fill(oversized.providerResults[0].events[0]);
  const oversizedSigned = signedRequest(oversized);
  await assert.rejects(
    acceptSportsbookSnapshot(requestFor(oversizedSigned.body, oversizedSigned.headers), {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => assert.fail('over-limit snapshot must not be stored')
    }),
    error => error.code === 'SPORTSBOOK_INGEST_EVENT_LIMIT'
  );
});

test('client signs the raw JSON bytes and refuses non-HTTPS endpoints', async () => {
  const signed = signedRequest(snapshot());
  assert.equal(signed.headers['content-length'], String(signed.body.length));
  assert.equal(signed.headers['x-sportsbook-signature'].length, 64);
  await assert.rejects(
    import('../src/sportsbook-ingest-client.js').then(({ postSportsbookSnapshot }) =>
      postSportsbookSnapshot('http://railway.example/api/internal/sportsbook/ingest', snapshot(), { secret: SECRET })
    ),
    /must use HTTPS/
  );
});
