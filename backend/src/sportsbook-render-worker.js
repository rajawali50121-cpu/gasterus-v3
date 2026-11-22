import { randomBytes } from 'node:crypto';
process.on('uncaughtException', (e) => { console.error('WORKER_UNCAUGHT', e && e.stack ? e.stack : String(e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('WORKER_UNHANDLED', e && e.stack ? e.stack : String(e)); process.exit(1); });
console.log('WORKER_BOOT');
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
    'API_KEY_PEPPER',
    'MFA_ENCRYPTION_KEY_BASE64'
  ]) {
    process.env[name] = randomBytes(32).toString('base64url');
  }
}

configureProviderOnlyRuntime();

const [
  { config },
  { fetchSportradar },
  { postSportsbookSnapshot },
  { buildSportsbookRenderSnapshot, sportsbookRenderIntervalSeconds }
] = await Promise.all([
  import('./config.js'),
  import('./sportradar-provider.js'),
  import('./sportsbook-ingest-client.js'),
  import('./sportsbook-render-worker-core.js')
]);

console.log('WORKER_IMPORTS_DONE');

const cronOnce = String(process.env.SPORTSBOOK_CRON_ONCE || '').trim().toLowerCase() === 'true';
if (config.nodeEnv === 'production') {
  if (!config.sportradarEnabled) {
    throw new Error('SPORTRADAR_ENABLED must be true for the production sportsbook render worker.');
  }
  if (!config.sportradarApiKey) {
    throw new Error('SPORTRADAR_API_KEY is required by the production sportsbook render worker.');
  }
  const sportradarPath = new URL(config.sportradarBaseUrl).pathname.replace(/\/+$/, '');
  const productionAccess = /\/production\/v2\/en$/i.test(sportradarPath);
  if (!productionAccess) {
    throw new Error('Production sportsbook worker requires production Sportradar access.');
  }
}
const endpoint = String(process.env.SPORTSBOOK_INGEST_URL || '').trim();
if (!endpoint) throw new Error('SPORTSBOOK_INGEST_URL is required.');
if (config.sportsbookIngestHmacSecret.length < 32) {
  throw new Error('SPORTSBOOK_INGEST_HMAC_SECRET must contain at least 32 characters.');
}
const ingestUrl = new URL(endpoint);
const sportradarUrl = new URL(config.sportradarBaseUrl);
console.info(JSON.stringify({
  service: 'sportsbook-render-worker',
  event: 'worker-config',
  cronOnce,
  dailyRefreshEnabled: config.sportsbookDailyRefreshEnabled !== false && !cronOnce,
  sportradarEnabled: config.sportradarEnabled,
  sportradarAccessLevel: /\/trial\//i.test(sportradarUrl.pathname) ? 'trial' : /\/production\//i.test(sportradarUrl.pathname) ? 'production' : 'other',
  sportIds: config.sportradarSportIds || null,
  ingestHost: ingestUrl.host,
  ingestPath: ingestUrl.pathname
}));

const { nextSportsbookDailyRefreshMs } = await import('./sportsbook-render-worker-core.js');
const snapshotIntervalSeconds = sportsbookRenderIntervalSeconds(config);
const intervalMs = snapshotIntervalSeconds * 1000;
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());
let consecutiveCycleFailures = 0;
let lastDailyRunWibDate = null;
let firstPullDone = false;
let lastFailureRetryAt = 0;
let lastCycleRateLimited = false;

function wibDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function wibClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { hour: Number(map.hour || 0), minute: Number(map.minute || 0) };
}
function dailySlotDue(now = Date.now()) {
  const clock = wibClock(new Date(now));
  const h = Number(config.sportsbookDailyRefreshHourWib ?? 0);
  const m = Number(config.sportsbookDailyRefreshMinuteWib ?? 5);
  return clock.hour * 60 + clock.minute >= h * 60 + m;
}

while (!shutdown.signal.aborted) {
  const cycleStartedAt = Date.now();
  let nextDelayMs = intervalMs;
  lastCycleRateLimited = false;
  try {
    // Daily mode: only fetch providers once per day at configured WIB slot.
    if (config.sportsbookDailyRefreshEnabled !== false && !cronOnce) {
      const nowMs = Date.now();
      const todayWib = wibDateKey();
      const forceFirstPull = String(process.env.SPORTSBOOK_FORCE_FIRST_PULL || '').toLowerCase() === 'true';
      const needsFirstPull = forceFirstPull && !firstPullDone && lastDailyRunWibDate !== todayWib;
      const retryAfterFailure = lastDailyRunWibDate !== todayWib && consecutiveCycleFailures > 0 && (nowMs - lastFailureRetryAt) >= 60 * 60 * 1000;
      const due = dailySlotDue(nowMs) && lastDailyRunWibDate !== todayWib;
      // Skip API calls on restart/member access/deploy; rely on stored ingest snapshot in Redis.
      if (!due && !needsFirstPull && !retryAfterFailure) {
        nextDelayMs = Math.min(nextSportsbookDailyRefreshMs(config, nowMs), 60 * 60 * 1000);
        console.info(JSON.stringify({ service:'sportsbook-render-worker', event:'daily-refresh-wait', nextRefreshInMs: nextDelayMs, lastDailyRunWibDate }));
        if (!shutdown.signal.aborted) await sleep(Math.max(30_000, nextDelayMs), undefined, { signal: shutdown.signal }).catch(e => { if (e.name !== 'AbortError') throw e; });
        continue;
      }
      if (retryAfterFailure) lastFailureRetryAt = nowMs;
    }
    console.log('CYCLE_START');
    const snapshot = await buildSportsbookRenderSnapshot({
      fetchSportradar: () => fetchSportradar({}),
      maxEvents: config.sportsbookRenderMaxEvents,
      maxPages: config.sportsbookRenderMaxPages,
    });
    const snapshotBuiltAt = Date.now();
    const accepted = await postSportsbookSnapshot(endpoint, snapshot, {
      secret: config.sportsbookIngestHmacSecret,
    });
    const acceptedAt = Date.now();
    if (config.sportsbookDailyRefreshEnabled !== false && !cronOnce) {
      lastDailyRunWibDate = wibDateKey();
      firstPullDone = true;
      consecutiveCycleFailures = 0;
    }
    const providers = snapshot.providerResults.map(result => ({
      provider: result.provider,
      enabled: result.enabled === true,
      eventCount: Array.isArray(result.events) ? result.events.length : 0,
      stale: result.stale === true,
      errors: Array.isArray(result.errors) ? result.errors.length : 0,
      diagnostics: result.diagnostics || null
    }));
    console.info(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-accepted',
      eventCount: accepted?.data?.eventCount ?? accepted?.eventCount ?? snapshot.eventCount,
      providers,
      ...(snapshot.diagnostics ? { diagnostics: snapshot.diagnostics } : {}),
      generatedAt: snapshot.generatedAt,
      buildDurationMs: snapshotBuiltAt - cycleStartedAt,
      deliveryDurationMs: acceptedAt - snapshotBuiltAt,
      cycleDurationMs: acceptedAt - cycleStartedAt,
      nextRefreshInMs: intervalMs
    }));
    consecutiveCycleFailures = 0;
  } catch (error) {
    consecutiveCycleFailures += 1;
    lastCycleRateLimited = /Sportradar rate limited \(HTTP 429/i.test(error?.message || String(error));
    lastFailureRetryAt = Date.now();
    const retryCeilingMs = Math.max(
      intervalMs,
      Math.min(300_000, config.sportsbookIngestMaxAgeSeconds * 500)
    );
    // In daily mode failed/quota-limited runs retry hourly (within quota gate in fetchers), without overwriting stored data.
    nextDelayMs = config.sportsbookDailyRefreshEnabled !== false && !cronOnce
      ? 60 * 60 * 1000
      : Math.min(retryCeilingMs, intervalMs * (2 ** Math.min(consecutiveCycleFailures, 6)));
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: lastCycleRateLimited && cronOnce ? 'snapshot-deferred-rate-limit' : 'snapshot-failed',
      failureClass: lastCycleRateLimited
        ? (/Limit Exceeded/i.test(error?.message || String(error)) ? 'provider-limit-exceeded' : 'provider-rate-limit')
        : 'worker-error',
      message: error?.message || String(error),
      ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
      consecutiveFailures: consecutiveCycleFailures,
      cycleDurationMs: Date.now() - cycleStartedAt,
      retryInMs: nextDelayMs
    }));
  }
  if (cronOnce) {
    // Preserve the last accepted snapshot and let the next scheduled run retry a provider 429.
    // Other worker errors remain non-zero so real faults are visible in Railway.
    if (consecutiveCycleFailures > 0 && !lastCycleRateLimited) process.exitCode = 1;
    break;
  }
  if (!shutdown.signal.aborted) {
    try {
      await sleep(nextDelayMs, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}
