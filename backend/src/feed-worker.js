import { config } from './config.js';
import { connectRedis, closeRedis } from './redis.js';
import { closeDatabase } from './db.js';
import { logger } from './logger.js';
import { runTotoCollector, loadTotoRuntimeState, persistTotoRuntimeState } from './toto-collector.js';
import { schedulerSnapshot, TOTO_RESULT_TIMES_WIB } from './toto-draw-scheduler.js';
import { syncJobs, dueJobs, markPolled, applyPollResult, pollerSnapshot } from './toto-draw-poller.js';
import { refreshSportsbookFeedFromPoll } from './sportsbook-feed.js';
import { startMemoryGuard } from './memory-guard.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let memoryGuard = null;
let stopping = false;

// Jadwal operator memakai jam result per pool. Collector hanya bangun bila ada
// pool yang sudah waktunya poll, sehingga tidak ada polling sepanjang hari dan
// hari libur tidak diulang endlessly.
const SCHEDULED_SLUGS = Object.freeze(Object.keys(TOTO_RESULT_TIMES_WIB));

// Loop TOTO sekarang digerakkan poller per pool: collector hanya jalan bila ada
// pool yang memang sudah waktunya poll (T-5 kecloak, lalu tiap 3 menit), dan
// berhenti begitu result baru valid untuk pool itu. Tidak ada lagi scrape
// setiap menit sepanjang jendela T-20/T+25.
async function pollDuePools() {
  if (!config.totoCollectorEnabled) return;
  const now = new Date();
  syncJobs(now);
  const due = dueJobs(now);
  if (!due.length) return;
  const polledKeys = due.map(item => item.key);
  logger.info('TOTO draw poll dijalankan', {
    pools: due.map(item => ({ pool: item.job.slug, resultWib: clockFromMinutes(item.job.resultTime), attempt: item.job.attempts + 1 }))
  });
  try {
    const result = await runTotoCollector({ reason: 'toto-draw-poller' });
    for (const key of polledKeys) markPolled(key, new Date());
    const outcome = applyPollResult(result?.decisions || [], { now: new Date(), polled: polledKeys });
    await persistTotoRuntimeState();
    if (outcome.advanced.length) {
      logger.info('TOTO result baru terdeteksi', { pools: outcome.advanced });
    }
    if (outcome.skippedDays.length) {
      logger.info('TOTO pool ditandai libur hari ini', { pools: outcome.skippedDays });
    }
  } catch (error) {
    for (const key of polledKeys) markPolled(key, new Date());
    logger.warn('TOTO draw poll gagal; menunggu jadwal berikutnya', { error: error.message, pools: due.map(item => item.job.slug) });
  } finally {
    if (global.gc && process.memoryUsage().heapUsed > 180 * 1024 * 1024) {
      try { global.gc(); } catch {}
    }
  }
}

function clockFromMinutes(minutes) {
  const normalized = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

async function refreshSportsFeedIfDue(state) {
  if (!config.sportsSourceBackgroundPollEnabled || Date.now() - state.lastSportsbookFeedRefresh < config.sportsFeedRefreshSeconds * 1000) return;
  state.lastSportsbookFeedRefresh = Date.now();
  try {
    await refreshSportsbookFeedFromPoll({ reason: 'feed-worker-background-poll' });
  } catch (error) {
    logger.warn('Feed worker sportsbook refresh unavailable', { code: error.code, error: error.message });
  }
}

async function main() {
  await connectRedis();
  await loadTotoRuntimeState();
  memoryGuard = startMemoryGuard({ label: 'feed-worker' });
  const state = { lastSportsbookFeedRefresh: 0 };
  logger.info('Feed worker ready', {
    totoCollectorEnabled: config.totoCollectorEnabled,
    sportsFeedRefreshSeconds: config.sportsFeedRefreshSeconds,
    scheduledPools: SCHEDULED_SLUGS.length,
    schedule: schedulerSnapshot(),
    poller: pollerSnapshot()
  });

  await refreshSportsFeedIfDue(state);
  while (!stopping) {
    await pollDuePools();
    await refreshSportsFeedIfDue(state);
    await sleep(1000);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('Feed worker shutdown requested', { signal });
  memoryGuard?.stop();
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
main().catch(error => {
  logger.error('Feed worker startup failed', { error: error.message });
  process.exit(1);
});
