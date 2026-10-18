import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

function configureProviderOnlyRuntime() {
  process.env.NODE_ENV ||= 'production';
  process.env.DATABASE_URL = 'postgres://unused.invalid/unused';
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  for (const name of [
    'MEMBER_PROXY_SECRET',
    'ADMIN_PROXY_SECRET',
    'OPS_INTERNAL_SECRET',
    'SESSION_HMAC_KEY',
    'API_KEY_PEPPER'
  ]) {
    process.env[name] = randomBytes(32).toString('base64url');
  }
  process.env.MFA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
}

configureProviderOnlyRuntime();

const [
  { config },
  { fetchTheOddsApi, fetchSportmonks, teamKey },
  { postSportsbookSnapshot },
  { buildSportsbookRenderSnapshot }
] = await Promise.all([
  import('./config.js'),
  import('./sportsbook-providers.js'),
  import('./sportsbook-ingest-client.js'),
  import('./sportsbook-render-worker-core.js')
]);

const endpoint = String(process.env.SPORTSBOOK_INGEST_URL || '').trim();
if (!endpoint) throw new Error('SPORTSBOOK_INGEST_URL is required.');
if (config.sportsbookIngestHmacSecret.length < 32) {
  throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
}

const snapshotIntervalSeconds = Math.max(
  15,
  Math.min(config.theOddsApiRefreshSeconds, Math.floor(config.sportsbookIngestMaxAgeSeconds / 2))
);
const intervalMs = snapshotIntervalSeconds * 1000;
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

while (!shutdown.signal.aborted) {
  try {
    const snapshot = await buildSportsbookRenderSnapshot({
      fetchOddsApi: fetchTheOddsApi,
      fetchSportmonks,
      maxEvents: config.sportsbookRenderMaxEvents,
      maxPages: config.sportsbookRenderMaxPages,
      teamKey
    });
    const accepted = await postSportsbookSnapshot(endpoint, snapshot, {
      secret: config.sportsbookIngestHmacSecret,
      maxPayloadBytes: config.sportsbookIngestMaxPayloadBytes
    });
    console.info(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-accepted',
      eventCount: accepted?.data?.eventCount ?? accepted?.eventCount ?? snapshot.eventCount,
      providers: snapshot.providerResults.map(result => result.provider),
      generatedAt: snapshot.generatedAt
    }));
  } catch (error) {
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-failed',
      message: error?.message || String(error)
    }));
  }
  if (!shutdown.signal.aborted) {
    try {
      await sleep(intervalMs, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}
