process.on('uncaughtException', (e) => { console.error('WORKER_UNCAUGHT', e && e.stack ? e.stack : String(e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('WORKER_UNHANDLED', e && e.stack ? e.stack : String(e)); process.exit(1); });
console.log('WORKER_BOOT');
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sportsbookWorkerStorageAvailable } from './sportsbook-render-worker-runtime.js';

function configureProviderOnlyRuntime() {
  process.env.NODE_ENV ||= 'production';
  process.env.SPORTSBOOK_RENDER_WORKER = 'true';
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
  { fetchApiSports, fetchSportmonks, fetchSharpApi, teamKey },
  { fetchOddsPapi },
  { createPostgresOddsPapiStore, createRedisOddsPapiCacheStore },
  { postSportsbookSnapshot },
  { buildSportsbookRenderSnapshot, sportsbookRenderIntervalSeconds }
] = await Promise.all([
  import('./config.js'),
  import('./sportsbook-providers.js'),
  import('./sportsbook-oddspapi.js'),
  import('./sportsbook-oddspapi-store.js'),
  import('./sportsbook-ingest-client.js'),
  import('./sportsbook-render-worker-core.js')
]);

console.log('WORKER_IMPORTS_DONE');
const apiSportsQuotaStore = sportsbookWorkerStorageAvailable()
  ? createPostgresOddsPapiStore({
    providerCode: 'api-sports',
    maxDailyLimit: 100,
    maxMonthlyLimit: 3100,
    cacheStore: createRedisOddsPapiCacheStore({ prefix: 'sportsbook:api-sports:v1' })
  })
  : null;
if (!apiSportsQuotaStore) {
  console.warn(JSON.stringify({
    service: 'sportsbook-render-worker',
    event: 'provider-quota-storage-unavailable',
    providers: ['api-sports', 'oddspapi']
  }));
}

const endpoint = String(process.env.SPORTSBOOK_INGEST_URL || '').trim();
if (!endpoint) throw new Error('SPORTSBOOK_INGEST_URL is required.');
if (config.sportsbookIngestHmacSecret.length < 32) {
  throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
}

const snapshotIntervalSeconds = sportsbookRenderIntervalSeconds(config);
const intervalMs = snapshotIntervalSeconds * 1000;
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());
let consecutiveCycleFailures = 0;

while (!shutdown.signal.aborted) {
  const cycleStartedAt = Date.now();
  let nextDelayMs = intervalMs;
  try {
    console.log('CYCLE_START');
    const withTimeout = (fn, ms, name) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(name + ' timeout ' + ms + 'ms')), ms);
      const task = Promise.resolve().then(() => fn(controller.signal));
      return Promise.race([
        task,
        new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(controller.signal.reason || new Error(name + ' timeout ' + ms + 'ms')), { once: true }))
      ]).finally(() => clearTimeout(timer));
    };
    const snapshot = await buildSportsbookRenderSnapshot({
      fetchApiSports: () => withTimeout(() => fetchApiSports({ quotaStore: apiSportsQuotaStore }), 20000, 'api-sports'),
      fetchSportmonks: (signal) => withTimeout((signal) => fetchSportmonks({ maxEvents: config.sportsbookRenderMaxEvents, maxPages: config.sportsbookRenderMaxPages, signal }), 20000, 'sportmonks'),
      fetchSharpApi: () => withTimeout(() => fetchSharpApi({}), 20000, 'sharpapi'),
      fetchOddsPapi: () => withTimeout(() => fetchOddsPapi({}), 20000, 'oddspapi'),
      maxEvents: config.sportsbookRenderMaxEvents,
      maxPages: config.sportsbookRenderMaxPages,
      maxPayloadBytes: config.sportsbookIngestMaxPayloadBytes,
      teamKey
    });
    const snapshotBuiltAt = Date.now();
    const accepted = await postSportsbookSnapshot(endpoint, snapshot, {
      secret: config.sportsbookIngestHmacSecret,
      maxPayloadBytes: config.sportsbookIngestMaxPayloadBytes
    });
    const acceptedAt = Date.now();
    const providers = snapshot.providerResults.map(result => ({
      provider: result.provider,
      enabled: result.enabled === true,
      eventCount: Array.isArray(result.events) ? result.events.length : 0,
      stale: result.stale === true,
      errors: Array.isArray(result.errors) ? result.errors.length : 0
    }));
    console.info(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-accepted',
      eventCount: accepted?.data?.eventCount ?? accepted?.eventCount ?? snapshot.eventCount,
      providers,
      generatedAt: snapshot.generatedAt,
      buildDurationMs: snapshotBuiltAt - cycleStartedAt,
      deliveryDurationMs: acceptedAt - snapshotBuiltAt,
      cycleDurationMs: acceptedAt - cycleStartedAt,
      nextRefreshInMs: intervalMs
    }));
    consecutiveCycleFailures = 0;
  } catch (error) {
    consecutiveCycleFailures += 1;
    const retryCeilingMs = Math.max(
      intervalMs,
      Math.min(300_000, config.sportsbookIngestMaxAgeSeconds * 500)
    );
    nextDelayMs = Math.min(
      retryCeilingMs,
      intervalMs * (2 ** Math.min(consecutiveCycleFailures, 6))
    );
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-failed',
      message: error?.message || String(error),
      consecutiveFailures: consecutiveCycleFailures,
      cycleDurationMs: Date.now() - cycleStartedAt,
      retryInMs: nextDelayMs
    }));
  }
  if (!shutdown.signal.aborted) {
    try {
      await sleep(nextDelayMs, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}
