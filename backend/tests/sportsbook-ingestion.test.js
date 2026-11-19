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

const { acceptSportsbookSnapshot, createStoredSportsbookSnapshot } = await import('../src/sportsbook-ingestion.js');
const { createSportsbookIngestRequest } = await import('../src/sportsbook-ingest-client.js');
const { loadRenderProviderSnapshot } = await import('../src/sportsbook-feed-source.js');
const SECRET = 'ingest-secret-for-test-only-'.padEnd(48, 'x');
const NOW = Date.UTC(2025, 0, 2, 12, 0, 0);

function signedStagingRecord(snapshot, now) {
  const request = createSportsbookIngestRequest(snapshot, SECRET, { timestamp: Math.floor(now / 1000) });
  return createStoredSportsbookSnapshot({
    serializedSnapshot: request.body.toString('utf8'),
    timestamp: request.headers['x-sportsbook-timestamp'],
    signature: request.headers['x-sportsbook-signature'],
    receivedAt: now
  });
}

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{
      provider: 'sportradar',
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
          source: 'sportradar',
          suspended: false,
          selections: [{
            key: 'selection-123',
            label: 'Home',
            odds: 2.1,
            suspended: false,
            source: 'sportradar',
            updatedAt: null
          }]
        }],
        _refs: { sportradar: 'provider-event-123' },
        _sources: ['sportradar']
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

test('Sportradar snapshot replaces retired source data instead of retaining stale odds sources', async () => {
  const previousPayload = snapshot();
  const previousRequest = signedRequest(previousPayload);
  const previousStored = (await import('../src/sportsbook-ingestion.js')).createStoredSportsbookSnapshot({
    serializedSnapshot: previousRequest.body.toString('utf8'),
    timestamp: previousRequest.headers['x-sportsbook-timestamp'],
    signature: previousRequest.headers['x-sportsbook-signature'],
    receivedAt: NOW
  });
  const previous = (await import('../src/sportsbook-ingestion.js')).verifyStoredSportsbookSnapshot(previousStored, {
    secret: SECRET,
    now: NOW
  });
  const sportradarEvent = structuredClone(previousPayload.providerResults[0].events[0]);
  sportradarEvent.id = 'sportradar-event';
  sportradarEvent.league = 'Premier League';
  sportradarEvent._refs = { sportradar: 'sr:event:123' };
  sportradarEvent._sources = ['sportradar'];
  for (const market of sportradarEvent.markets) {
    market.source = 'sportradar';
    for (const selection of market.selections) selection.source = 'sportradar';
  }
  const incoming = {
    schemaVersion: 1,
    generatedAt: new Date(NOW + 60000).toISOString(),
    providerResults: [{ provider: 'sportradar', enabled: true, events: [sportradarEvent], transportOk: true }]
  };
  const { mergeSportsbookSnapshots } = await import('../src/sportsbook-ingestion.js');
  const merged = mergeSportsbookSnapshots(incoming, previous, { now: NOW + 60000, maxAgeSeconds: 180 });
  assert.deepEqual(merged.providerResults.map(result => result.provider), ['sportradar']);
  assert.equal(merged.providerResults[0].events[0].id, 'sportradar-event');
});

test('Sportradar snapshot merge retains events across the full configured seven-day horizon', async () => {
  const { mergeSportsbookSnapshots } = await import('../src/sportsbook-ingestion.js');
  const event = structuredClone(snapshot().providerResults[0].events[0]);
  event.id = 'sportradar-seven-day-event';
  event.startTime = new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString();
  event._refs = { sportradar: 'sr:sport_event:seven-day' };
  event._sources = ['sportradar'];
  for (const market of event.markets) {
    market.source = 'sportradar';
    for (const selection of market.selections) selection.source = 'sportradar';
  }
  const incoming = {
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{ provider: 'sportradar', enabled: true, events: [event], transportOk: true }]
  };
  const merged = mergeSportsbookSnapshots(incoming, null, { now: NOW });
  assert.equal(merged.providerResults[0].events.length, 1);
  assert.equal(merged.providerResults[0].events[0].id, 'sportradar-seven-day-event');
  assert.equal(merged.eventCount, 1);
});

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
    providerResults: ['sportradar'],
    eventCount: 1
  });
  assert.deepEqual(stored, payload);
  assert.equal(storedBytes, signed.body.toString());
});

test('accepts a complete event with more than the former market and selection caps', async () => {
  const payload = snapshot();
  const event = payload.providerResults[0].events[0];
  event.markets = Array.from({ length: 121 }, (_, marketIndex) => ({
    id: `market-${marketIndex}`,
    type: 'OTHER',
    period: 'FT',
    source: 'sportradar',
    suspended: false,
    selections: Array.from({ length: marketIndex === 0 ? 251 : 1 }, (_, selectionIndex) => ({
      key: `selection-${marketIndex}-${selectionIndex}`,
      label: `Selection ${selectionIndex}`,
      odds: 2,
      suspended: false,
      source: 'sportradar',
      updatedAt: null
    }))
  }));
  const signed = signedRequest(payload);
  let stored;
  const accepted = await acceptSportsbookSnapshot(
    requestFor(signed.body, signed.headers),
    {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async value => { stored = value; }
    }
  );

  assert.equal(accepted.accepted, true);
  assert.equal(stored.providerResults[0].events[0].markets.length, 121);
  assert.equal(stored.providerResults[0].events[0].markets[0].selections.length, 251);
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
    _refs: { sportradar: 'provider-event-unpriced' },
    _sources: ['sportradar']
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

test('counts same-team fixtures in different leagues separately', async () => {
  const payload = snapshot();
  const second = structuredClone(payload.providerResults[0].events[0]);
  second.id = 'event-different-league';
  second.league = 'Serie A';
  second.country = 'Italy';
  second._refs.sportradar = 'provider-event-different-league';
  payload.providerResults[0].events.push(second);

  const signed = signedRequest(payload);
  const accepted = await acceptSportsbookSnapshot(
    requestFor(signed.body, signed.headers),
    {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async () => {}
    }
  );
  assert.equal(accepted.eventCount, 2);
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

test('rejects malformed normalized events but accepts more than 500 Sportradar fixtures', async () => {
  const malformed = snapshot();
  malformed.providerResults[0].events[0].markets[0].selections[0].odds = 'not-a-decimal-price';
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
  const template = oversized.providerResults[0].events[0];
  oversized.providerResults[0].events = Array.from({ length: 501 }, (_, index) => ({
    ...template,
    id: `event-${index}`,
    home: { name: `Home ${index}` },
    away: { name: `Away ${index}` },
    markets: template.markets.map(market => ({
      ...market,
      id: `market-${index}`,
      selections: market.selections.map(selection => ({ ...selection, key: `selection-${index}` }))
    })),
    _refs: { sportradar: `provider-event-${index}` }
  }));
  const oversizedSigned = signedRequest(oversized);
  let stored;
  const accepted = await acceptSportsbookSnapshot(
    requestFor(oversizedSigned.body, oversizedSigned.headers),
    {
      secret: SECRET,
      now: NOW,
      storeSnapshot: async value => { stored = value; }
    }
  );
  assert.equal(accepted.eventCount, 501);
  assert.equal(stored.providerResults[0].events.length, 501);
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

