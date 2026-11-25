import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "./redis.js";
import { closeDatabase } from "./db.js";
import { logger } from "../logger.js";
import { loadSoccerV4Config } from "./soccer-v4-config.js";
import { SoccerV4Client } from "./soccer-v4-client.js";
import { reserveSoccerV4Call, waitForSoccerV4RequestSlot, applySoccerV4RateLimitCooldown, selectSoccerV4DatesRoundRobin } from "./soccer-v4-quota.js";
import { normalizeSoccerResults } from "./results.js";
import { listResultCandidateDates, persistSoccerResultRevisions } from "./results-repository.js";

const LOCK_KEY = "sportsbook:soccer-v4:poll-lock:v1";
const HEARTBEAT_KEY = "sportsbook:soccer-v4:worker-heartbeat:v1";
const STATUS_KEY = "sportsbook:soccer-v4:status:v1";
const DATE_CURSOR_KEY = "sportsbook:soccer-v4:date-cursor:v1";
let stopping = false;
const shutdownController = new AbortController();

async function runCycle(config, client) {
  const token = randomUUID();
  const lock = await redis.set(LOCK_KEY, token, { NX: true, PX: 30 * 60 * 1000 });
  if (!lock) return { skipped: "another Soccer v4 worker owns the poll lock" };
  client.cycleCalls = 0;
  try {
    const candidates = await listResultCandidateDates();
    if (!candidates.length) return { skipped: "no tracked event dates", dates: 0 };
    const cursor = Number(await redis.get(DATE_CURSOR_KEY) || 0);
    const selection = selectSoccerV4DatesRoundRobin(candidates, cursor, config.maxCallsPerCycle);
    const dates = selection.dates;
    let received = 0, inserted = 0, duplicates = 0, verified = 0;
    for (const date of dates) {
      const response = await client.getDailySummaries(date);
      const results = normalizeSoccerResults(response.body, new Date().toISOString());
      const persisted = await persistSoccerResultRevisions(results);
      received += persisted.received;
      inserted += persisted.inserted;
      duplicates += persisted.duplicates;
      verified += persisted.verified;
    }
    await redis.set(DATE_CURSOR_KEY, String(selection.nextCursor), { EX: 30 * 24 * 60 * 60 });
    const completedAt = new Date().toISOString();
    await redis.set(STATUS_KEY, JSON.stringify({
      attemptedAt: completedAt, complete: true, dates: dates.length,
      calls: client.cycleCalls, received, inserted, duplicates, verified
    }), { EX: 30 * 24 * 60 * 60 });
    await redis.set(HEARTBEAT_KEY, completedAt, { EX: 600 });
    return { dates: dates.length, calls: client.cycleCalls, received, inserted, duplicates, verified };
  } catch (error) {
    await redis.set(STATUS_KEY, JSON.stringify({
      attemptedAt: new Date().toISOString(), complete: false,
      code: error?.code || "SOCCER_V4_SYNC_FAILED",
      httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
      retryAfter: error?.retryAfter || null
    }), { EX: 30 * 24 * 60 * 60 }).catch(() => {});
    throw error;
  } finally {
    await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", {
      keys: [LOCK_KEY], arguments: [token]
    });
  }
}

async function main() {
  const config = loadSoccerV4Config();
  if (!config.enabled) {
    logger.info("Sportradar Soccer v4 worker disabled; no provider requests will be sent");
    return;
  }
  await connectRedis();
  const client = new SoccerV4Client(config, {
    beforeRequest: async () => {
      if (client.cycleCalls >= config.maxCallsPerCycle) {
        const error = new Error("SOCCER_V4_CYCLE_BUDGET_EXHAUSTED");
        error.code = error.message;
        throw error;
      }
      await waitForSoccerV4RequestSlot(redis);
      await reserveSoccerV4Call(redis, config);
    },
    onRateLimit: ({ retryAfter }) => applySoccerV4RateLimitCooldown(redis, retryAfter),
    onResponse: details => logger.info("Sportradar Soccer v4 response", details)
  });
  logger.info("Sportradar Soccer v4 results worker started", {
    pollMinutes: config.pollIntervalMs / 60_000,
    maxCallsPerCycle: config.maxCallsPerCycle,
    quotaLimit30Days: config.maxCallsPer30Days
  });
  while (!stopping) {
    try {
      const result = await runCycle(config, client);
      logger.info("Sportradar Soccer v4 results sync completed", result);
    } catch (error) {
      logger.warn("Sportradar Soccer v4 results sync stopped safely", {
        code: error?.code || "SOCCER_V4_SYNC_FAILED",
        quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
        quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
        httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
        retryAfter: error?.retryAfter || null
      });
    }
    await sleep(config.pollIntervalMs, undefined, { signal: shutdownController.signal }).catch(() => {});
  }
}

process.once("SIGTERM", () => { stopping = true; shutdownController.abort(); });
process.once("SIGINT", () => { stopping = true; shutdownController.abort(); });
main().catch(async error => {
  logger.error("Sportradar Soccer v4 worker failed to start", { code: error?.code || "WORKER_START_FAILED" });
  process.exitCode = 1;
}).finally(async () => {
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
});
