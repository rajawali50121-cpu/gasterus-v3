import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "./redis.js";
import { closeDatabase } from "./db.js";
import { logger } from "../logger.js";
import { loadSoccerV4Config } from "./soccer-v4-config.js";
import { SoccerV4Client, getSoccerNextPageStart } from "./soccer-v4-client.js";
import { reserveSoccerV4Call, waitForSoccerV4RequestSlot, applySoccerV4RateLimitCooldown, nextSoccerPollDelayMs } from "./soccer-v4-quota.js";
import { normalizeSoccerResults, normalizeSportEventId } from "./results.js";
import { listResultCandidateDates, persistSoccerResultRevisions, selectOldestDueSoccerResultDate } from "./results-repository.js";

const LOCK_KEY = "sportsbook:soccer-v4:poll-lock:v1";
const HEARTBEAT_KEY = "sportsbook:soccer-v4:worker-heartbeat:v1";
const STATUS_KEY = "sportsbook:soccer-v4:status:v1";
const LAST_SUCCESS_PREFIX = "sportsbook:soccer-v4:last-success:";
const PAGE_CURSOR_PREFIX = "sportsbook:soccer-v4:page-cursor:";
const DAY_MS = 24 * 60 * 60 * 1000;
let stopping = false;

const shutdownController = new AbortController();

async function runCycle(config, client) {
  const heartbeatTtlSeconds = Math.ceil(Math.max(config.pollIntervalMs * 3, 3 * 60 * 60 * 1000) / 1000);
  const token = randomUUID();
  const lock = await redis.set(LOCK_KEY, token, { NX: true, PX: 30 * 60 * 1000 });
  if (!lock) return { skipped: "another Soccer v4 worker owns the poll lock" };
  client.cycleCalls = 0;
  try {
    const candidateResult = await listResultCandidateDates({
      bufferMinutes: config.resultBufferMinutes,
      maxLookbackDays: config.maxLookbackDays
    });
    const lastPolls = {}, cursors = {};
    for (const candidateDate of candidateResult.dates) {
      lastPolls[candidateDate] = Number(await redis.get(LAST_SUCCESS_PREFIX + candidateDate) || 0);
      cursors[candidateDate] = Number(await redis.get(PAGE_CURSOR_PREFIX + candidateDate) || 0);
    }
    const currentUtcDate = new Date().toISOString().slice(0, 10), cycleResults = [];
    let receivedTotal = 0, projectedTotal = 0, insertedTotal = 0, duplicateTotal = 0, verifiedTotal = 0;
    for (let requestIndex = 0; requestIndex < config.maxCallsPerCycle; requestIndex += 1) {
      const date = selectOldestDueSoccerResultDate(candidateResult.dates, lastPolls, Date.now(),
        config.pollIntervalMs, cursors,
        candidateDate => candidateDate === currentUtcDate ? config.pollIntervalMs : DAY_MS, currentUtcDate);
      if (!date) break;
      const start = cursors[date] || 0, limit = 200;
      const response = await client.getDailySummaries(date, { start, limit });
      const receivedAt = new Date().toISOString();
      const results = normalizeSoccerResults(response.body, receivedAt)
        .map(result => ({ ...result, eventId: normalizeSportEventId(result.eventId) })).filter(result => result.eventId !== null);
      const nextStart = getSoccerNextPageStart({ start, limit,
        returned: response.metadata.pageResultCount ?? response.body.summaries.length,
        maxResults: response.metadata.maxResults, resultCountHeader: response.metadata.resultCountHeader });
      const persisted = await persistSoccerResultRevisions(results);
      if (nextStart === 0) {
        await redis.del(PAGE_CURSOR_PREFIX + date);
        lastPolls[date] = Date.now(); cursors[date] = 0;
        await redis.set(LAST_SUCCESS_PREFIX + date, String(lastPolls[date]), { EX: 7 * 24 * 60 * 60 });
      } else {
        cursors[date] = nextStart;
        await redis.set(PAGE_CURSOR_PREFIX + date, String(nextStart), { EX: 7 * 24 * 60 * 60 });
      }
      receivedTotal += persisted.received; projectedTotal += persisted.projected;
      insertedTotal += persisted.inserted; duplicateTotal += persisted.duplicates; verifiedTotal += persisted.verified;
      cycleResults.push({ date, pagination: { start, limit, returned: response.metadata.pageResultCount ?? results.length,
        maxResults: response.metadata.maxResults, nextStart, complete: nextStart === 0 },
        received: persisted.received, projected: persisted.projected, inserted: persisted.inserted,
        duplicates: persisted.duplicates, verified: persisted.verified,
        providerGeneratedAt: response.body.generated_at || null, cacheControl: response.metadata.cacheControl,
        cacheTtlMs: response.metadata.cacheTtlMs, etag: response.metadata.etag, lastModified: response.metadata.lastModified });
      if (nextStart !== 0) break;
    }
    const completedAt = new Date().toISOString();
    const status = { attemptedAt: completedAt, cycleComplete: true, dates: cycleResults.length,
      date: cycleResults[0]?.date || null, candidates: candidateResult.candidateCount,
      manualReviewRequired: candidateResult.manualReviewCount, manualReviewEventIds: candidateResult.manualReviewEventIds,
      manualReviewEvents: candidateResult.manualReviewEvents, cycleResults,
      pagination: { complete: cycleResults.every(item => item.pagination.complete) },
      calls: client.cycleCalls, received: receivedTotal, projected: projectedTotal,
      revisionInserted: insertedTotal, revisionDuplicates: duplicateTotal, verified: verifiedTotal };
    if (!cycleResults.length) status.skipped = "no Soccer result date is due";
    await redis.set(STATUS_KEY, JSON.stringify(status), { EX: 30 * 24 * 60 * 60 });
    await redis.set(HEARTBEAT_KEY, completedAt, { EX: heartbeatTtlSeconds });
    return status;
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
    let nextDelayMs = config.pollIntervalMs;
    try {
      const result = await runCycle(config, client);
      logger.info("Sportradar Soccer v4 results sync completed", result);
      nextDelayMs = nextSoccerPollDelayMs(result, config.pollIntervalMs);
    } catch (error) {
      logger.warn("Sportradar Soccer v4 results sync stopped safely", {
        code: error?.code || "SOCCER_V4_SYNC_FAILED",
        quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
        quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
        httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
        retryAfter: error?.retryAfter || null
      });
      const retrySeconds = Number(error?.retryAfter);
      if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
        nextDelayMs = Math.max(nextDelayMs, retrySeconds * 1000 + 1000);
      }
    }
    await sleep(nextDelayMs, undefined, { signal: shutdownController.signal }).catch(() => {});
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
