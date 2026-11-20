import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSportsbookIngestEndpoint } from '../src/sportsbook-ingest-client.js';

test('accepts HTTPS ingestion endpoints', () => {
  assert.equal(
    validateSportsbookIngestEndpoint('https://api.example.com/api/internal/sportsbook/ingest').protocol,
    'https:'
  );
});

test('accepts HTTP only on Railway private service DNS', () => {
  const url = validateSportsbookIngestEndpoint('http://gasterus-v3.railway.internal:8080/api/internal/sportsbook/ingest');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, 'gasterus-v3.railway.internal');
});

test('rejects public HTTP ingestion endpoints', () => {
  assert.throws(
    () => validateSportsbookIngestEndpoint('http://api.example.com/api/internal/sportsbook/ingest'),
    /must use HTTPS/
  );
});

test('rejects credentials embedded in ingestion URLs', () => {
  assert.throws(
    () => validateSportsbookIngestEndpoint('http://user:pass@gasterus-v3.railway.internal:8080/ingest'),
    /must not contain URL credentials/
  );
});
