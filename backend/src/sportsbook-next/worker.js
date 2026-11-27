import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { connectRedis, redis, closeRedis } from "./redis.js";
import { closeDatabase } from "./db.js";
import { logger } from "../logger.js";
import { loadSportsbookConfig, isSportradarOddsEnabled } from "./config.js";
import { SportradarClient } from "./sportradar-client.js";
import { normalizeDailySchedule, normalizeDailySportEventMarkets, normalizeEventMarkets } from "./normalize.js";
import { getChangedSportEventIds, shouldReconcileChangeLog } from "./change-log.js";
import { getSportradarQuotaUsage, reserveSportradarCall, waitForSportradarRequestSlot, applySportradarRateLimitCooldown } from "./quota.js";
import { persistSportsbookSchedules, persistSportsbookSnapshot, confirmSportsbookPricesThrough } from "./repository.js";
import { setSportsbookHalt, getSportsbookHalt, clearSportsbookHalt } from "./halt.js";

const SNAPSHOT_KEY = "sportsbook:next:snapshot:v1";
const LOCK_KEY = "sportsbook:next:poll-lock:v1";
const HEARTBEAT_KEY = "sportsbook:next:worker-heartbeat:v1";
const FEED_STATUS_KEY = "sportsbook:next:feed-status:v1";
const CHANGE_LOG_LAST_SUCCESS_KEY = "sportsbook:next:changelog:last-success-ms:v1";
const CHANGE_LOG_RECONCILE_QUEUE_KEY = "sportsbook:next:changelog:reconcile-queue:v1";
const CHANGE_LOG_PENDING_IDS_KEY = "sportsbook:next:changelog:pending-event-ids:v1";
const COVERAGE_KEY = "sportsbook:next:coverage:v1";
const COVERAGE_TTL_SECONDS = 24 * 60 * 60;
const SCHEDULE_CURSOR_PREFIX = "sportsbook:next:schedule-cursor:v1:";
const SCHEDULE_COMPLETE_PREFIX = "sportsbook:next:schedule-complete:v1:";
const SCHEDULE_CACHE_TTL_SECONDS = 20 * 60 * 60;
const SCHEDULE_CURSOR_TTL_SECONDS = 48 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
let stopping = false;

function utcDate(offset) {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

async function refreshCoverage(config, client, { allowFetch = true } = {}) {
  const cached = await redis.get(COVERAGE_KEY);
  if (cached) {
    try {
      const value = JSON.parse(cached);
      if (value?.checkedAt && Date.now() - Date.parse(value.checkedAt) < COVERAGE_TTL_SECONDS * 1000) return value;
    } catch { /* refresh malformed cache below */ }
  }

  if (!allowFetch) return null;

  // Official Odds Comparison discovery order: Sports, Books, then
  // Sport Competitions. Never infer a sport, book or competition from IDs.
  // Keep discovery sequential: if Sports is rejected (especially HTTP 429),
  // do not send a queued Books request after the provider cooldown begins.
  const sportsResult = await client.getSports();
  const sports = sportsResult.body?.sports;
  if (!Array.isArray(sports)) {
    const error = new Error("SPORTRADAR_SPORTS_SHAPE_INVALID");
    error.code = error.message;
    throw error;
  }
  const booksResult = await client.getBooks();
  const books = booksResult.body?.books;
  if (!Array.isArray(books)) {
    const error = new Error("SPORTRADAR_BOOKS_SHAPE_INVALID");
    error.code = error.message;
    throw error;
  }

  const selectedSport = sports.find(item => item?.id === config.sportIds[0]);
  if (!selectedSport) {
    const error = new Error("SPORTRADAR_CONFIGURED_SPORT_NOT_ENTITLED");
    error.code = error.message;
    throw error;
  }
  const competitionResult = await client.getCompetitions(selectedSport.id);
  const competitions = competitionResult.body?.competitions;
  if (!Array.isArray(competitions)) {
    const error = new Error("SPORTRADAR_COMPETITIONS_SHAPE_INVALID");
    error.code = error.message;
    throw error;
  }

  const coverage = {
    checkedAt: new Date().toISOString(),
    sport: { id: selectedSport.id, name: selectedSport.name, type: selectedSport.type || null },
    books: books.map(book => ({ id: book.id, name: book.name })),
    competitions: competitions
      .filter(item => item?.markets === true)
      .map(item => ({ id: item.id, name: item.name, markets: item.markets === true }))
  };
  await redis.set(COVERAGE_KEY, JSON.stringify(coverage), { EX: COVERAGE_TTL_SECONDS });
  return coverage;
}

async function syncDailySchedules(config, client) {
  const rows = [];
  const status = [];
  for (const sportId of config.sportIds) {
    for (let day = 0; day <= config.daysAhead; day += 1) {
      const date = utcDate(day);
      const completeKey = `${SCHEDULE_COMPLETE_PREFIX}${sportId}:${date}`;
      if (await redis.get(completeKey)) continue;
      if (client.cycleCalls >= config.maxCallsPerCycle) {
        status.push({ sportId, date, deferred: true, reason: "CYCLE_BUDGET" });
        continue;
      }
      const cursorKey = `${SCHEDULE_CURSOR_PREFIX}${sportId}:${date}`;
      const cursorRaw = await redis.get(cursorKey);
      const start = cursorRaw === null ? 0 : Number(cursorRaw);
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new Error("SPORTRADAR_SCHEDULE_CURSOR_INVALID");
      }
      try {
        const response = await client.getDailySchedules(sportId, date, { start, limit: 50 });
        const scheduleItems = response.body?.schedules;
        if (!Array.isArray(scheduleItems)) {
          throw new Error("SPORTRADAR_DAILY_SCHEDULES_SHAPE_INVALID");
        }
        const normalized = normalizeDailySchedule({ schedules: scheduleItems });
        const receivedAt = new Date().toISOString();
        await persistSportsbookSchedules(normalized, sportId, receivedAt);
        rows.push(...normalized);

        const maxHeader = response.headers.get("x-max-results");
        const resultHeader = response.headers.get("x-result");
        const maxResults = maxHeader === null ? null : Number(maxHeader);
        const receivedCount = resultHeader === null ? null : Number(resultHeader);
        const hasMore = scheduleItems.length > 0 && (
          (maxResults !== null && Number.isFinite(maxResults))
            ? start + scheduleItems.length < maxResults
            : (receivedCount !== null && Number.isFinite(receivedCount))
              ? receivedCount >= 50
              : scheduleItems.length >= 50
        );
        if (hasMore) {
          await redis.set(cursorKey, String(start + scheduleItems.length), { EX: SCHEDULE_CURSOR_TTL_SECONDS });
        } else {
          await redis.del(cursorKey);
          await redis.set(completeKey, receivedAt, { EX: SCHEDULE_CACHE_TTL_SECONDS });
        }
        status.push({
          sportId, date, start, received: scheduleItems.length,
          normalized: normalized.length, complete: !hasMore
        });
      } catch (error) {
        if (["SPORTRADAR_HOURLY_QUOTA_EXHAUSTED","SPORTRADAR_30_DAY_QUOTA_EXHAUSTED","SPORTRADAR_RATE_LIMITED"].includes(error?.code)) {
          status.push({
            sportId, date, deferred: true, quotaLimited: true,
            code: error.code, retryAfter: error.retryAfter || null
          });
          break;
        }
        status.push({ sportId, date, deferred: true, code: error?.code || "SCHEDULE_SYNC_FAILED" });
        logger.warn("Sportradar Daily Schedules sync deferred", {
          sportId, date, code: error?.code || "SCHEDULE_SYNC_FAILED"
        });
        break;
      }
    }
  }
  return { rows, status };
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
    // Discover entitled sports/books/competitions once per day before pulling
    // the selected sport's current-day bulk market board.
    coverage = await refreshCoverage(config, client);
    for (const sportId of config.sportIds) {
      for (let day = 0; day <= config.daysAhead; day += 1) {
        if (client.cycleCalls >= config.maxCallsPerCycle) { budgetLimited = true; break; }
        const date = utcDate(day);
        try {
          const result = await client.getAllDailySportEventMarkets(sportId, date, { pageSize: 50, maxPages: 2 });
          if (result.pagination?.complete !== true) {
            const error = new Error("SPORTRADAR_FEED_PAGINATION_INCOMPLETE");
            error.code = error.message;
            error.pagination = result.pagination;
            throw error;
          }
          const rows = normalizeDailySportEventMarkets(result.body, sportId, new Date().toISOString());
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

    const receivedAt = new Date().toISOString();
    const sourceTimes = pricedEvents.map(event => Date.parse(event.providerGeneratedAt || "")).filter(Number.isFinite);
    const snapshot = {
      schemaVersion: 1,
      provider: "sportradar-odds-comparison-prematch-v2",
      fetchedAt: receivedAt,
      providerGeneratedAt: sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : null,
      receivedAt,
      complete: errors.length === 0 && !quotaLimited && !budgetLimited && pricedEvents.length > 0,
      emptyFeed: pricedEvents.length === 0,
      callsThisCycle: client.cycleCalls,
      quotaLimited,
      quotaReason,
      quotaDetails,
      budgetLimited,
      coverage,
      events: pricedEvents,
      errors
    };
    // Never replace a last-known-good snapshot with partial or quota-truncated data.
    const persisted = snapshot.complete
      ? await persistSportsbookSnapshot(pricedEvents, snapshot.receivedAt)
      : { skipped: true, reason: quotaReason || (budgetLimited ? "SPORTRADAR_CYCLE_BUDGET_EXHAUSTED" : (pricedEvents.length === 0 ? "SPORTRADAR_EMPTY_FEED" : "SPORTRADAR_CYCLE_INCOMPLETE")) };
    if (snapshot.complete) {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    }
    await redis.set(FEED_STATUS_KEY, JSON.stringify({ attemptedAt: snapshot.receivedAt, complete: snapshot.complete, quotaLimited, quotaReason, quotaDetails, budgetLimited, errorCount: errors.length }), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    await redis.set(HEARTBEAT_KEY, snapshot.receivedAt, { EX: 600 });
    return {
      events: pricedEvents.length, scheduled: events.size, calls: snapshot.callsThisCycle,
      persisted, errors: errors.length, quotaLimited, quotaReason, quotaDetails, budgetLimited, emptyFeed: snapshot.emptyFeed,
      complete: snapshot.complete,
      coverageFeeds: coverage ? {
        sport: coverage.sport,
        bookmakers: coverage.books.length,
        competitionsWithMarkets: coverage.competitions.length,
        checkedAt: coverage.checkedAt
      } : null
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

async function runChangeLogCycle(config, client) {
  const token = randomUUID();
  const lock = await redis.set(LOCK_KEY, token, { NX: true, PX: 30 * 60 * 1000 });
  if (!lock) return { skipped: "another worker owns the poll lock" };

  client.cycleCalls = 0;
  try {
    if (config.maxCallsPerCycle < 2) {
      throw new Error("SPORTRADAR_CHANGELOG_REQUIRES_TWO_CALLS_PER_CYCLE");
    }
    const rawSnapshot = await redis.get(SNAPSHOT_KEY);
    if (!rawSnapshot) return { skipped: "no complete snapshot to refresh" };
    const snapshot = JSON.parse(rawSnapshot);
    if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.events)) {
      throw new Error("SPORTRADAR_CHANGELOG_SNAPSHOT_INVALID");
    }

    const now = Date.now();
    const lastSuccess = await redis.get(CHANGE_LOG_LAST_SUCCESS_KEY);
    const tracked = new Map(snapshot.events.map(event => [event.id, event]));
    const trackedIds = new Set(tracked.keys());
    const readQueue = async key => {
      const raw = await redis.get(key);
      if (!raw) return [];
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? [...new Set(value.filter(id => trackedIds.has(id)))] : [];
      } catch { return []; }
    };

    let reconcileQueue = await readQueue(CHANGE_LOG_RECONCILE_QUEUE_KEY);
    const fullReconcile = shouldReconcileChangeLog(lastSuccess, now) || reconcileQueue.length > 0;
    if (fullReconcile && reconcileQueue.length === 0) reconcileQueue = [...tracked.keys()];
    let pendingQueue = await readQueue(CHANGE_LOG_PENDING_IDS_KEY);

    const refreshed = [];
    const refreshedIds = new Set();
    const refreshEvent = async eventId => {
      const previous = tracked.get(eventId);
      if (!previous || refreshedIds.has(eventId)) return;
      const result = await client.getSportEventMarkets(eventId);
      const normalized = normalizeEventMarkets(result.body, new Date().toISOString());
      if (normalized.event.id !== eventId) throw new Error("SPORTRADAR_CHANGELOG_EVENT_ID_MISMATCH");
      if (!normalized.providerGeneratedAt) throw new Error("SPORTRADAR_CHANGELOG_PROVIDER_TIMESTAMP_MISSING");
      refreshed.push({
        ...normalized.event,
        providerGeneratedAt: normalized.providerGeneratedAt,
        sportId: previous.sportId,
        competition: previous.competition ?? null,
        competitionId: previous.competitionId ?? null,
        markets: normalized.markets
      });
      refreshedIds.add(eventId);
    };

    // Always reserve one call for the five-minute Change Log. A missed window
    // is reconciled in bounded batches, so large slates cannot starve polling.
    const reconcileCapacity = fullReconcile ? config.maxCallsPerCycle - 1 : 0;
    const reconcileBatch = reconcileQueue.slice(0, reconcileCapacity);
    for (const eventId of reconcileBatch) await refreshEvent(eventId);
    const remainingReconcile = reconcileQueue.slice(reconcileBatch.length);

    const changeLogResult = await client.getSportEventMarketsChangeLog();
    const windowFrom = Number(changeLogResult.body?.status?.from);
    const windowTo = Number(changeLogResult.body?.status?.to);
    if (!Number.isFinite(windowFrom) || !Number.isFinite(windowTo) || windowFrom <= 0 || windowTo < windowFrom) {
      throw new Error("SPORTRADAR_CHANGELOG_WINDOW_INVALID");
    }
    const changedIds = getChangedSportEventIds(changeLogResult.body, trackedIds);
    const queued = [...new Set([...pendingQueue, ...changedIds])]
      .filter(eventId => trackedIds.has(eventId) && !refreshedIds.has(eventId));
    pendingQueue = queued;
    while (pendingQueue.length && client.cycleCalls < config.maxCallsPerCycle) {
      const eventId = pendingQueue[0];
      await refreshEvent(eventId);
      pendingQueue.shift();
    }

    const fetchedAt = new Date().toISOString();
    if (refreshed.length) {
      await persistSportsbookSnapshot(refreshed, fetchedAt);
      const updates = new Map(refreshed.map(event => [event.id, event]));
      snapshot.events = snapshot.events.map(event => updates.get(event.id) || event);
    }
    const sourceTimes = snapshot.events.map(event => Date.parse(event.providerGeneratedAt || "")).filter(Number.isFinite);
    snapshot.providerGeneratedAt = sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : null;
    snapshot.fetchedAt = fetchedAt;
    snapshot.receivedAt = fetchedAt;
    snapshot.callsThisCycle = client.cycleCalls;
    snapshot.complete = true;
    snapshot.emptyFeed = snapshot.events.length === 0;
    snapshot.refreshPending = remainingReconcile.length > 0 || pendingQueue.length > 0;

    if (remainingReconcile.length) {
      await redis.set(CHANGE_LOG_RECONCILE_QUEUE_KEY, JSON.stringify(remainingReconcile), { EX: 30 * 24 * 60 * 60 });
    } else {
      await redis.del(CHANGE_LOG_RECONCILE_QUEUE_KEY);
    }
    if (pendingQueue.length) {
      await redis.set(CHANGE_LOG_PENDING_IDS_KEY, JSON.stringify(pendingQueue), { EX: 30 * 24 * 60 * 60 });
    } else {
      await redis.del(CHANGE_LOG_PENDING_IDS_KEY);
    }

    // A successful five-minute Change Log window proves unchanged prices remain
    // current only after every changed/reconcile event has been refreshed.
    if (!snapshot.refreshPending) {
      await confirmSportsbookPricesThrough(new Date(windowTo * 1000));
    }
    await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    await redis.set(FEED_STATUS_KEY, JSON.stringify({
      attemptedAt: fetchedAt, complete: true, quotaLimited: false,
      quotaReason: null, budgetLimited: false, errorCount: 0,
      changeLogPoll: true, fullReconcile, changedEvents: changedIds.length,
      refreshedEvents: refreshed.length, reconcilePending: remainingReconcile.length,
      changedPending: pendingQueue.length
    }), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) });
    // Use the provider's window end, not completion time, to detect missed windows.
    await redis.set(CHANGE_LOG_LAST_SUCCESS_KEY, String(windowTo * 1000), { EX: 30 * 24 * 60 * 60 });
    await redis.set(HEARTBEAT_KEY, fetchedAt, { EX: 600 });
    return {
      calls: client.cycleCalls, fullReconcile, changedEvents: changedIds.length,
      refreshedEvents: refreshed.length, reconcilePending: remainingReconcile.length,
      changedPending: pendingQueue.length, complete: true
    };
  } catch (error) {
    const quotaLimited = error?.code === "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED";
    await redis.set(FEED_STATUS_KEY, JSON.stringify({
      attemptedAt: new Date().toISOString(), complete: false,
      quotaLimited, quotaReason: quotaLimited ? error.code : null,
      providerError: error?.code || "SPORTRADAR_CHANGELOG_POLL_FAILED",
      httpStatus: error?.httpStatus || null, errorCount: 1,
      changeLogPoll: true
    }), { EX: Math.ceil(config.maxSnapshotAgeMs / 1000) }).catch(() => {});
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
  if (process.env.SPORTRADAR_CLEAR_HALT_ON_START === "true") {
    await clearSportsbookHalt(redis);
    logger.warn("Sportradar sportsbook halt manually cleared at startup");
  }
  const existingHalt = await getSportsbookHalt(redis);
  if (existingHalt) {
    logger.error("Sportradar sportsbook worker remains halted; manual reset required", {
      code: existingHalt.code,
      httpStatus: existingHalt.httpStatus,
      haltedAt: existingHalt.haltedAt || null
    });
    return;
  }
  const client = new SportradarClient(config, {
    onResponse: details => logger.info("Sportradar provider response", details),
    onRateLimit: ({ retryAfter }) => applySportradarRateLimitCooldown(redis, retryAfter),
    beforeRequest: async () => {
      if (client.cycleCalls >= config.maxCallsPerCycle) {
        const error = new Error("SPORTRADAR_CYCLE_BUDGET_EXHAUSTED");
        error.code = "SPORTRADAR_CYCLE_BUDGET_EXHAUSTED";
        throw error;
      }
      await waitForSportradarRequestSlot(redis);
      await reserveSportradarCall(redis, config);
      client.cycleCalls += 1;
    }
  });
  logger.info("Sportradar sportsbook replacement worker started", {
    pollMinutes: config.pollIntervalMs / 60_000,
    changeLogEnabled: config.changeLogEnabled,
    changeLogPollSeconds: config.changeLogPollMs / 1000,
    minimumChangeLogCalls30Days: config.minimumChangeLogCalls30Days,
    sportCount: config.sportIds.length,
    daysAhead: config.daysAhead,
    maxCallsPerCycle: config.maxCallsPerCycle,
    quotaLimit30Days: config.maxCallsPer30Days,
    syncStrategy: config.changeLogEnabled
      ? "prematch-bulk-discovery-plus-change-log"
      : "daily-sport-event-markets-bulk"
  });

  let nextDiscoveryAt = Date.now();
  let nextChangeLogAt = Date.now() + config.changeLogPollMs;
  while (!stopping) {
    const activeHalt = await getSportsbookHalt(redis);
    if (activeHalt) {
      logger.error("Sportradar sportsbook worker halted; no further provider requests will be made", {
        code: activeHalt.code,
        httpStatus: activeHalt.httpStatus,
        haltedAt: activeHalt.haltedAt || null
      });
      break;
    }
    let now = Date.now();
    if (now >= nextDiscoveryAt) {
      client.cycleCalls = 0;
      try {
        const result = await runCycle(config, client);
        const quotaUsage = await getSportradarQuotaUsage(redis, config).catch(() => null);
        logger.info("Sportradar sportsbook discovery completed", { ...result, quotaUsage });
        nextDiscoveryAt = Date.now() + config.pollIntervalMs;
      } catch (error) {
        if (await setSportsbookHalt(redis, error)) {
          stopping = true;
          logger.error("Sportradar sportsbook worker halted after authentication failure", {
            code: error?.code || "SPORTRADAR_AUTH_REJECTED",
            httpStatus: error?.httpStatus
          });
          break;
        }
        logger.warn("Sportradar sportsbook discovery stopped safely", {
          code: error?.code || "SPORTRADAR_POLL_FAILED",
          quotaScope: error?.quotaScope || null,
          quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
          quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
          httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
          retryAfter: error?.retryAfter || null,
          providerMessage: error?.providerMessage || null,
          originId: error?.originId || null
        });
        const retryAfterSeconds = Number(error?.retryAfter);
        const providerDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000 + 1000
          : 0;
        // A failed trial call must not trigger a five-minute retry loop.
        // Keep retries at least as slow as the configured 150-minute cadence.
        nextDiscoveryAt = Date.now() + Math.max(config.pollIntervalMs, providerDelayMs);
      }
    }

    now = Date.now();
    if (config.changeLogEnabled && now >= nextChangeLogAt) {
      client.cycleCalls = 0;
      const changeLogCycleStartedAt = Date.now();
      try {
        const result = await runChangeLogCycle(config, client);
        const quotaUsage = await getSportradarQuotaUsage(redis, config).catch(() => null);
        logger.info("Sportradar Prematch change-log refresh completed", { ...result, quotaUsage });
        // Schedule from cycle start so network/DB work does not push polling
        // beyond the provider's rolling five-minute window.
        nextChangeLogAt = Math.max(Date.now(), changeLogCycleStartedAt + config.changeLogPollMs);
      } catch (error) {
        if (await setSportsbookHalt(redis, error)) {
          stopping = true;
          logger.error("Sportradar sportsbook worker halted after authentication failure", {
            code: error?.code || "SPORTRADAR_AUTH_REJECTED",
            httpStatus: error?.httpStatus
          });
          break;
        }
        logger.warn("Sportradar Prematch change-log refresh stopped safely", {
          code: error?.code || "SPORTRADAR_CHANGELOG_POLL_FAILED",
          quotaScope: error?.quotaScope || null,
          quotaUsed: Number.isFinite(error?.quotaUsed) ? error.quotaUsed : null,
          quotaLimit: Number.isFinite(error?.quotaLimit) ? error.quotaLimit : null,
          httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
          retryAfter: error?.retryAfter || null,
          providerMessage: error?.providerMessage || null,
          originId: error?.originId || null
        });
        const retrySeconds = Number(error?.retryAfter);
        const retryDelayMs = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.max(config.changeLogPollMs, retrySeconds * 1000 + 1_000)
          : config.changeLogPollMs;
        nextChangeLogAt = Date.now() + retryDelayMs;
      }
    }

    const nextRunAt = config.changeLogEnabled
      ? Math.min(nextDiscoveryAt, nextChangeLogAt)
      : nextDiscoveryAt;
    await sleep(Math.max(250, nextRunAt - Date.now()), undefined, { signal: shutdownController.signal }).catch(() => {});
  }
}

if (!isSportradarOddsEnabled()) {
  logger.info("Sportradar Odds Comparison worker disabled; no provider, Redis, or database requests will be made");
  process.exitCode = 0;
} else {
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
}
