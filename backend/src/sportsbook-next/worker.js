import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "./redis.js";
import { closeDatabase } from "./db.js";
import { logger } from "../logger.js";
import { loadSportsbookConfig } from "./config.js";
import { SportradarClient } from "./sportradar-client.js";
import { normalizeDailySchedule, normalizeEventMarkets } from "./normalize.js";
import { reserveSportradarCall } from "./quota.js";
import { persistSportsbookSnapshot } from "./repository.js";

const SNAPSHOT_KEY = "sportsbook:next:snapshot:v1";
const LOCK_KEY = "sportsbook:next:poll-lock:v1";
const HEARTBEAT_KEY = "sportsbook:next:worker-heartbeat:v1";
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
  let budgetLimited = false;
  let coverage = null;
  try {
    try {
      coverage = await client.getSports();
    } catch (error) {
      if (["SPORTRADAR_HOURLY_QUOTA_EXHAUSTED","SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"].includes(error?.code)) {
        quotaLimited = true;
        quotaReason = error.code;
      } else {
        throw error;
      }
    }
    for (const sportId of (quotaLimited ? [] : config.sportIds)) {
      for (let day = 0; day <= config.daysAhead; day += 1) {
        if (client.cycleCalls >= config.maxCallsPerCycle) { budgetLimited = true; break; }
        const date = utcDate(day);
        const remaining = config.maxCallsPerCycle - client.cycleCalls;
        if (remaining <= 0) break;
        try {
          const rows = await client.getAllDailySchedules(sportId, date, { pageSize: 50, maxPages: Math.min(10, remaining) });
          for (const event of normalizeDailySchedule({ schedules: rows })) events.set(event.id, { ...event, sportId });
        } catch (error) {
          if (["SPORTRADAR_HOURLY_QUOTA_EXHAUSTED","SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"].includes(error?.code)) {
            quotaLimited = true;
            quotaReason = error.code;
            break;
          }
          throw error;
        }
      }
      if (client.cycleCalls >= config.maxCallsPerCycle) { budgetLimited = true; break; }
    }

    const pricedEvents = [];
    for (const event of events.values()) {
      if (quotaLimited) break;
      if (client.cycleCalls >= config.maxCallsPerCycle) { budgetLimited = true; break; }
      try {
        const result = await client.getSportEventMarkets(event.id);
        const normalized = normalizeEventMarkets(result.body);
        pricedEvents.push({ ...event, ...normalized.event, markets: normalized.markets });
      } catch (error) {
        if (error?.code === "SPORTRADAR_RATE_LIMITED") throw error;
        if (["SPORTRADAR_HOURLY_QUOTA_EXHAUSTED","SPORTRADAR_30_DAY_QUOTA_EXHAUSTED"].includes(error?.code)) {
          quotaLimited = true;
          quotaReason = error.code;
          break;
        }
        errors.push({ eventId: event.id, code: error?.code || "EVENT_MARKETS_FAILED" });
      }
    }

    const snapshot = {
      schemaVersion: 1,
      provider: "sportradar-odds-comparison-prematch-v2",
      fetchedAt: new Date().toISOString(),
      complete: errors.length === 0 && !quotaLimited && !budgetLimited,
      callsThisCycle: client.cycleCalls,
      quotaLimited,
      quotaReason,
      budgetLimited,
      events: pricedEvents,
      errors
    };
    // Never replace a last-known-good snapshot with partial or quota-truncated data.
    const persisted = snapshot.complete
      ? await persistSportsbookSnapshot(pricedEvents, snapshot.fetchedAt)
      : { skipped: true, reason: quotaReason || (budgetLimited ? "SPORTRADAR_CYCLE_BUDGET_EXHAUSTED" : "SPORTRADAR_CYCLE_INCOMPLETE") };
    if (snapshot.complete) {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    }
    await redis.set(HEARTBEAT_KEY, snapshot.fetchedAt, { EX: 600 });
    return {
      events: pricedEvents.length, scheduled: events.size, calls: snapshot.callsThisCycle,
      persisted, errors: errors.length, quotaLimited, quotaReason, budgetLimited,
      complete: snapshot.complete,
      coverageFeeds: Array.isArray(coverage?.body?.sports) ? coverage.body.sports.length : null
    };
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
    quotaLimit30Days: config.maxCallsPer30Days
  });

  while (!stopping) {
    client.cycleCalls = 0;
    try {
      const result = await runCycle(config, client);
      logger.info("Sportradar sportsbook poll completed", result);
    } catch (error) {
      logger.warn("Sportradar sportsbook poll stopped safely", {
        code: error?.code || "SPORTRADAR_POLL_FAILED",
        quotaScope: error?.quotaScope || null,
        quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
        quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
        retryAfter: error?.retryAfter || null
      });
      if (error?.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED") {
        await sleep(config.pollIntervalMs, undefined, { signal: shutdownController.signal }).catch(() => {});
        continue;
      }
    }
    await sleep(config.pollIntervalMs);
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
