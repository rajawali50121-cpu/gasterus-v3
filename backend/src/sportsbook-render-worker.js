import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectRedis, redis, closeRedis } from './redis.js';
import { allocateRevision } from './sportsbook-revision.js';
import { fetchOddsPapi } from './sportsbook-oddspapi.js';
import {
  acquireLease,
  renewLease,
  releaseLease,
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS
} from './sportsbook-ingest-revision-store.js';

function configureProviderOnlyRuntime() {
  process.env.NODE_ENV ||= 'production';
  // Production worker harus mempertahankan DATABASE_URL dan REDIS_URL dari
  // Railway deployment environment. Jangan pernah mengganti dengan dummy URL
  // secara diam-diam, karena akan merusak Redis lease acquisition dan
  // PostgreSQL quota reservation. Jika variabel wajib tidak tersedia,
  // startup harus gagal dengan pesan aman tanpa bocorkan credential.
  if (process.env.NODE_ENV === 'production') {
    const missing = [];
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!process.env.REDIS_URL) missing.push('REDIS_URL');
    if (missing.length > 0) {
      throw new Error(`Sportsbook render worker requires ${missing.join(', ')} in production.`);
    }
    return;
  }
  // Test/development: hanya isi dummy URL jika test harness belum menyetelnya.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://unused.invalid/unused';
  }
  if (!process.env.REDIS_URL) {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
  }
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
  { fetchMoviOdds, fetchSharpApi, fetchSportmonks, sportsbookProviderStartupSummary, teamKey, fetchTheOddsApi, fetchApiSports },
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
  Math.min(
    config.sportmonksRefreshSeconds,
    config.movioddsRefreshSeconds,
    config.sharpApiRefreshSeconds,
    Math.floor(config.sportsbookIngestMaxAgeSeconds / 2)
  )
);
const intervalMs = snapshotIntervalSeconds * 1000;

const ownerToken = randomBytes(32).toString('hex');
let shutdown = new AbortController();
let ownershipLost = new AbortController();
let abortSignal = AbortSignal.any([shutdown.signal, ownershipLost.signal]);

let shuttingDown = false;
let heartbeatTimer = null;
let renewalInFlight = false;
let cycleInFlight = null;
let shutdownPromise = null;

function isShuttingDown() {
  return shuttingDown;
}

// Hanya untuk uji lifecycle: mengembalikan state shutdown ke kondisi awal sehingga
// gracefulShutdown dapat dijalankan ulang dalam test terpisah tanpa mempengaruhi produksi.
function resetLifecycleForTest() {
  shutdown = new AbortController();
  ownershipLost = new AbortController();
  abortSignal = AbortSignal.any([shutdown.signal, ownershipLost.signal]);
  shuttingDown = false;
  heartbeatTimer = null;
  renewalInFlight = false;
  cycleInFlight = null;
  shutdownPromise = null;
}

async function gracefulShutdown(exitCode = 0) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  shutdown.abort();

  shutdownPromise = (async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // Wait for any in-flight renewal to complete
    while (renewalInFlight) {
      await sleep(10);
    }

    // Wait for active cycle to finish
    if (cycleInFlight) {
      try { await cycleInFlight; } catch {}
    }

    // Release lease only after publisher has stopped
    try { await releaseLease(redis, ownerToken); } catch {}

    await closeRedis().catch(() => {});
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

process.once('SIGINT', () => void gracefulShutdown(0));
process.once('SIGTERM', () => void gracefulShutdown(0));

console.info(JSON.stringify({
  service: 'sportsbook-render-worker',
  event: 'provider-startup',
  ...sportsbookProviderStartupSummary()
}));

async function renewLeaseOnce() {
  if (abortSignal.aborted) return;
  if (renewalInFlight) return;
  renewalInFlight = true;
  try {
    const renewed = await renewLease(redis, ownerToken);
    if (!renewed) {
      console.error(JSON.stringify({
        service: 'sportsbook-render-worker',
        event: 'ownership-lost',
        reason: 'lease-renewal-rejected'
      }));
      ownershipLost.abort();
      void gracefulShutdown(1);  // Non-blocking; renewalInFlight cleared in finally below
    }
  } catch (error) {
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'ownership-lost',
      reason: 'lease-renewal-failed',
      error: error?.message || String(error)
    }));
    ownershipLost.abort();
    void gracefulShutdown(1);  // Non-blocking; renewalInFlight cleared in finally below
  } finally {
    renewalInFlight = false;
  }
}

async function runCycle() {
  if (abortSignal.aborted) return;

  // Step 1: Build snapshot first (without revision)
  const snapshot = await buildSportsbookRenderSnapshot({
    fetchMoviOdds,
    fetchOddsPapi,
    fetchSportmonks,
    fetchSharpApi,
    fetchTheOddsApi,
    fetchApiSports,
    maxEvents: config.sportsbookRenderMaxEvents,
    teamKey,
    signal: abortSignal
  });

  if (abortSignal.aborted) {
    throw new Error('Worker shutdown detected; snapshot was not sent.');
  }

  // Validate snapshot has events (builder already throws if empty)
  if (!snapshot.eventCount || snapshot.eventCount < 1) {
    throw new Error('Snapshot has no events; not sending.');
  }

  // Step 2: Allocate ingestRevision AFTER snapshot is built
  const ingestRevision = await allocateRevision();

  // Step 3: Attach ingestRevision to snapshot (decimal ordering revision)
  snapshot.ingestRevision = ingestRevision;

  // Step 4: Publish with atomic Lua (lease check + revision comparison)
  const accepted = await postSportsbookSnapshot(endpoint, snapshot, {
    secret: config.sportsbookIngestHmacSecret,
    maxPayloadBytes: config.sportsbookIngestMaxPayloadBytes,
    revision: ingestRevision,
    ownerToken,
    signal: abortSignal
  });

  const providerDiagnostics = snapshot.providerResults.map(result => ({
    provider: result.provider,
    diagnostics: {
      receivedFixtures: result.diagnostics?.receivedFixtures ?? result.events.length,
      acceptedFixtures: result.diagnostics?.acceptedFixtures ?? result.events.length,
      snapshotFixtures: result.diagnostics?.snapshotFixtures ?? result.events.length,
      discardedFixtures: result.diagnostics?.discardedFixtures || {},
      discardedGroups: result.diagnostics?.discardedGroups || {},
      fixtureMatching: result.diagnostics?.fixtureMatching || {}
    }
  }));
  console.info(JSON.stringify({
    service: 'sportsbook-render-worker',
    event: 'snapshot-accepted',
    eventCount: accepted?.data?.eventCount ?? accepted?.eventCount ?? snapshot.eventCount,
    providers: snapshot.providerResults.map(result => result.provider),
    providerDiagnostics,
    generatedAt: snapshot.generatedAt,
    ingestRevision
  }));
  const debugExamples = snapshot.providerResults
    .flatMap(result => result.diagnostics?.debugExamples || [])
    .slice(0, 5);
  if (debugExamples.length) {
    console.debug(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'unmatched-or-ambiguous-fixture-examples',
      examples: debugExamples
    }));
  }
}

async function main() {
  await connectRedis();

  const acquired = await acquireLease(redis, ownerToken);
  if (!acquired) {
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'startup-failed',
      reason: 'lease-acquisition-failed'
    }));
    await closeRedis().catch(() => {});
    process.exit(1);
  }

  heartbeatTimer = setInterval(() => {
    void renewLeaseOnce();
  }, LEASE_RENEW_INTERVAL_MS);
  heartbeatTimer.unref();

  try {
    while (!abortSignal.aborted) {
      cycleInFlight = runCycle();
      try {
        await cycleInFlight;
      } catch (error) {
        console.error(JSON.stringify({
          service: 'sportsbook-render-worker',
          event: 'snapshot-failed',
          message: error?.message || String(error)
        }));
      }
      cycleInFlight = null;

      if (abortSignal.aborted) break;

      try {
        await sleep(intervalMs, undefined, { signal: abortSignal });
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    }
  } finally {
    await gracefulShutdown(abortSignal.aborted && ownershipLost.signal.aborted ? 1 : 0);
  }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch(error => {
    console.error(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'startup-failed',
      reason: error?.message || String(error)
    }));
    process.exit(1);
  });
}

export {
  gracefulShutdown,
  shutdownPromise,
  isShuttingDown,
  abortSignal,
  ownershipLost,
  shutdown,
  shuttingDown,
  renewalInFlight,
  cycleInFlight,
  heartbeatTimer,
  renewLeaseOnce,
  runCycle,
  resetLifecycleForTest
};
