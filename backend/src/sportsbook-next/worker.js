import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "./redis.js";
import { closeDatabase } from "./db.js";
import { logger } from "../logger.js";
import { loadSportsbookConfig } from "./config.js";
import { SportradarClient } from "./sportradar-client.js";
import { normalizeDailySportEventMarkets } from "./normalize.js";
import { getSportradarQuotaUsage, reserveSportradarCall } from "./quota.js";
import { persistSportsbookSnapshot } from "./repository.js";

const SNAPSHOT_KEY = "sportsbook:next:snapshot:v1";
const LOCK_KEY = "sportsbook:next:poll-lock:v1";
const HEARTBEAT_KEY = "sportsbook:next:worker-heartbeat:v1";
const FEED_STATUS_KEY = "sportsbook:next:feed-status:v1";
const DAY_MS = 24 * 60 * 60 * 1000;
let stopping = false;

function utcDate(offset) {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

async function runCycle(config, client) {
  const token = randomUUID();
  const lock = await redis.set(LOCK_KEY, token, { NX: true, PX: 30 * 60 * 1000 });
  if (!lock) return { skipped: "another worker owns the poll lock" };

  client.cycleCalls = 0;
  const events = new Map();
  const errors = [];
  let quotaLimited = false;
  let quotaReason = null;
  let quotaDetails = null;
  let budgetLimited = false;
  let coverage = null;
  try {
    // The configured sport IDs are already known. Pull each sport/date board
    // in one bulk request instead of one schedule request plus one request per event.
    // Two-day discovery window; quota reservations remain authoritative across workers.
    for (const sportId of config.sportIds) {
      for (let day = 0; day <= config.daysAhead; day += 1) {
        if (client.cycleCalls >= config.maxCallsPerCycle) { budgetLimited = true; break; }
        const date = utcDate(day);
        try {
          const result = await client.getAllDailySportEventMarkets(sportId, date, { pageSize: 50, maxPages: 10 });
          const rows = normalizeDailySportEventMarkets(result.body, sportId);
          for (const event of rows) events.set(event.id, event);
        } catch (error) {
          if (["SPORTRADAR_HOURLY_QUOTA_EXHAUSTED","SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"].includes(error?.code)) {
            quotaLimited = true;
            quotaReason = error.code;
            quotaDetails = { scope: error.quotaScope || null, used: error.quotaUsed ?? null, limit: error.quotaLimit ?? null, retryAfter: error.retryAfter || null };
            break;
          }
          throw error;
        }
      }
      if (quotaLimited || budgetLimited) break;
    }

    const pricedEvents = [...events.values()];

    const snapshot = {
      schemaVersion: 1,
      provider: "sportradar-odds-comparison-prematch-v2",
      fetchedAt: new Date().toISOString(),
      complete: errors.length === 0 && !quotaLimited && !budgetLimited && pricedEvents.length > 0,
      emptyFeed: pricedEvents.length === 0,
      callsThisCycle: client.cycleCalls,
      quotaLimited,
      quotaReason,
      quotaDetails,
      budgetLimited,
      events: pricedEvents,
      errors
    };
    // Never replace a last-known-good snapshot with partial or quota-truncated data.
    const persisted = snapshot.complete
      ? await persistSportsbookSnapshot(pricedEvents, snapshot.fetchedAt)
      : { skipped: true, reason: quotaReason || (budgetLimited ? "SPORTRADAR_CYCLE_BUDGET_EXHAUSTED" : (pricedEvents.length === 0 ? "SPORTRADAR_EMPTY_FEED" : "SPORTRADAR_CYCLE_INCOMPLETE")) };
    if (snapshot.complete) {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    }
    await redis.set(FEED_STATUS_KEY, JSON.stringify({ attemptedAt: snapshot.fetchedAt, complete: snapshot.complete, quotaLimited, quotaReason, quotaDetails, budgetLimited, errorCount: errors.length }), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    await redis.set(HEARTBEAT_KEY, snapshot.fetchedAt, { EX: 600 });
    return {
      events: pricedEvents.length, scheduled: events.size, calls: snapshot.callsThisCycle,
      persisted, errors: errors.length, quotaLimited, quotaReason, quotaDetails, budgetLimited, emptyFeed: snapshot.emptyFeed,
      complete: snapshot.complete,
      coverageFeeds: null
    };
  } catch (error) {
    await redis.set(FEED_STATUS_KEY, JSON.stringify({ attemptedAt: new Date().toISOString(), complete: false, providerError: error?.code || "SPORTRADAR_POLL_FAILED", httpStatus: error?.httpStatus || null, retryAfter: error?.retryAfter || null }), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) }).catch(() => {});
    throw error;
  } finally {
    await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", {
      keys: [LOCK_KEY], arguments: [token]
    });
  }
}

async function main() {
  const config = loadSportsbookConfig();
  await connectRedis();
  const client = new SportradarClient(config, {
    onResponse: details => logger.info("Sportradar provider response", details),
    beforeRequest: async () => {
      if (client.cycleCalls >= config.maxCallsPerCycle) {
        const error = new Error('SPORTRADAR_CYCLE_BUDGET_EXHAUSTED');
        error.code = 'SPORTRADAR_CYCLE_BUDGET_EXHAUSTED';
        throw error;
      }
      await reserveSportradarCall(redis, config);
      client.cycleCalls += 1;
    }
  });
  logger.info("Sportradar sportsbook replacement worker started", {
    pollMinutes: config.pollIntervalMs / 60_000,
    sportCount: config.sportIds.length,
    daysAhead: config.daysAhead,
    maxCallsPerCycle: config.maxCallsPerCycle,
    quotaLimit30Days: config.maxCallsPer30Days,
    syncStrategy: "daily-sport-event-markets-bulk"
  });

  while (!stopping) {
    client.cycleCalls = 0;
    let nextDelayMs = config.pollIntervalMs;
    try {
      const result = await runCycle(config, client);
      const quotaUsage = await getSportradarQuotaUsage(redis, config).catch(() => null);
      logger.info("Sportradar sportsbook poll completed", { ...result, quotaUsage });
      if (result.quotaLimited && result.quotaReason === "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED") {
        const retrySeconds = Number(result.quotaDetails?.retryAfter);
        if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
          // Resume shortly after the oldest hourly reservation expires; do not
          // sleep the full 150-minute discovery interval after a short quota wait.
          nextDelayMs = retrySeconds * 1000 + 1_000;
        }
      }
    } catch (error) {
      logger.warn("Sportradar sportsbook poll stopped safely", {
        code: error?.code || "SPORTRADAR_POLL_FAILED",
        quotaScope: error?.quotaScope || null,
        quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
        quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
        httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
        retryAfter: error?.retryAfter || null
      });
      if (error?.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED") {
        nextDelayMs = config.pollIntervalMs;
      } else if (error?.code === "SPORTRADAR_RATE_LIMITED") {
        const retrySeconds = Number(error?.retryAfter);
        nextDelayMs = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? retrySeconds * 1000 + 1_000
          : Math.min(config.pollIntervalMs, 5 * 60 * 1000);
      }
    }
    await sleep(nextDelayMs, undefined, { signal: shutdownController.signal }).catch(() => {});
  }
}

const shutdownController = new AbortController();
process.once("SIGTERM", () => { stopping = true; shutdownController.abort(); });
process.once("SIGINT", () => { stopping = true; shutdownController.abort(); });
main().catch(async error => {
  logger.error("Sportradar sportsbook worker failed to start", { code: error?.code || "WORKER_START_FAILED", error: error?.message });
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
});
