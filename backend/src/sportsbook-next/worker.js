import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "../redis.js";
import { logger } from "../logger.js";
import { loadSportsbookConfig } from "./config.js";
import { SportradarClient } from "./sportradar-client.js";
import { normalizeDailySchedule, normalizeEventMarkets } from "./normalize.js";
import { reserveSportradarCall } from "./quota.js";

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

  const startedCalls = client.callsUsed30Days;
  const events = new Map();
  const errors = [];
  try {
    const coverage = await client.getSports();
    for (const sportId of config.sportIds) {
      for (let day = 0; day <= config.daysAhead; day += 1) {
        if (client.callsUsed30Days - startedCalls >= config.maxCallsPerCycle) break;
        const date = utcDate(day);
        const rows = await client.getAllDailySchedules(sportId, date, { pageSize: 50, maxPages: 10 });
        for (const event of normalizeDailySchedule({ schedules: rows })) events.set(event.id, event);
      }
      if (client.callsUsed30Days - startedCalls >= config.maxCallsPerCycle) break;
    }

    const pricedEvents = [];
    for (const event of events.values()) {
      if (client.callsUsed30Days - startedCalls >= config.maxCallsPerCycle) break;
      try {
        const result = await client.getSportEventMarkets(event.id);
        pricedEvents.push({ ...event, ...normalizeEventMarkets(result.body).event, markets: normalizeEventMarkets(result.body).markets });
      } catch (error) {
        if (error?.code === "SPORTRADAR_RATE_LIMITED" || error?.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED") throw error;
        errors.push({ eventId: event.id, code: error?.code || "EVENT_MARKETS_FAILED" });
      }
    }

    const snapshot = {
      schemaVersion: 1,
      provider: "sportradar-odds-comparison-prematch-v2",
      fetchedAt: new Date().toISOString(),
      complete: errors.length === 0 && client.callsUsed30Days - startedCalls < config.maxCallsPerCycle,
      callsThisCycle: client.callsUsed30Days - startedCalls,
      events: pricedEvents,
      errors
    };
    await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    await redis.set(HEARTBEAT_KEY, snapshot.fetchedAt, { EX: 600 });
    return { events: pricedEvents.length, scheduled: events.size, calls: snapshot.callsThisCycle, errors: errors.length, complete: snapshot.complete, coverageFeeds: Array.isArray(coverage.body?.sports) ? coverage.body.sports.length : null };
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
    beforeRequest: () => reserveSportradarCall(redis, config)
  });
  logger.info("Sportradar sportsbook replacement worker started", {
    pollMinutes: config.pollIntervalMs / 60_000,
    sportCount: config.sportIds.length,
    daysAhead: config.daysAhead,
    maxCallsPerCycle: config.maxCallsPerCycle,
    quotaLimit30Days: config.maxCallsPer30Days
  });

  while (!stopping) {
    try {
      const result = await runCycle(config, client);
      logger.info("Sportradar sportsbook poll completed", result);
    } catch (error) {
      logger.warn("Sportradar sportsbook poll stopped safely", {
        code: error?.code || "SPORTRADAR_POLL_FAILED",
        retryAfter: error?.retryAfter || null
      });
      if (error?.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED") {
        await sleep(config.pollIntervalMs);
        continue;
      }
    }
    await sleep(config.pollIntervalMs);
  }
}

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });
main().catch(async error => {
  logger.error("Sportradar sportsbook worker failed to start", { code: error?.code || "WORKER_START_FAILED", error: error?.message });
  await closeRedis().catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (stopping) await closeRedis().catch(() => {});
});
