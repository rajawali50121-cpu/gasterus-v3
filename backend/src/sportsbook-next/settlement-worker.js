import { setTimeout as sleep } from "node:timers/promises";
import { closeDatabase } from "../db.js";
import { closeRedis, connectRedis, redis } from "./redis.js";
import { logger } from "../logger.js";
import { settleReadySportsbookTickets } from "./settlement-service.js";

const HEARTBEAT_KEY = "sportsbook:settlement:heartbeat:v1";
const STATUS_KEY = "sportsbook:settlement:status:v1";
let stopping = false;
const shutdown = new AbortController();
process.once("SIGTERM", () => { stopping = true; shutdown.abort(); });
process.once("SIGINT", () => { stopping = true; shutdown.abort(); });

function positiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function main() {
  if (String(process.env.SPORTSBOOK_SETTLEMENT_ENABLED || "").toLowerCase() !== "true") {
    logger.info("Sportsbook settlement worker disabled; no ticket or ledger rows will be changed");
    return;
  }
  const pollSeconds = positiveInteger(process.env.SPORTSBOOK_SETTLEMENT_POLL_SECONDS, 15, 5, 300);
  const batchSize = positiveInteger(process.env.SPORTSBOOK_SETTLEMENT_BATCH_SIZE, 50, 1, 250);
  await connectRedis();
  await redis.set(STATUS_KEY, JSON.stringify({ healthy: false, state: "starting", attemptedAt: new Date().toISOString() }), { EX: 300 });
  logger.info("Sportsbook settlement worker started", {
    pollSeconds, batchSize, resultAuthority: "sportradar-soccer-v4-closed",
    supportedMarket: "SOCCER_1X2_3WAY"
  });

  while (!stopping) {
    const completedAt = new Date().toISOString();
    try {
      const summary = await settleReadySportsbookTickets({ limit: batchSize });
      await redis.set(STATUS_KEY, JSON.stringify({
        healthy: true, completedAt, summary, resultAuthority: "sportradar-soccer-v4-closed"
      }), { EX: 300 });
      await redis.set(HEARTBEAT_KEY, completedAt, { EX: 120 });
      if (summary.scanned || summary.manualReview || summary.liquidityBlocked) {
        logger.info("Sportsbook settlement cycle", summary);
      }
    } catch (error) {
      await redis.set(STATUS_KEY, JSON.stringify({
        healthy: false, completedAt, code: error?.code || "SPORTSBOOK_SETTLEMENT_FAILED"
      }), { EX: 300 }).catch(() => {});
      await redis.set(HEARTBEAT_KEY, completedAt, { EX: 120 }).catch(() => {});
      logger.error("Sportsbook settlement cycle failed safely", {
        code: error?.code || "SPORTSBOOK_SETTLEMENT_FAILED"
      });
    }
    await sleep(pollSeconds * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

main()
  .catch(error => {
    logger.error("Sportsbook settlement worker failed to start", {
      code: error?.code || "SPORTSBOOK_SETTLEMENT_WORKER_START_FAILED"
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => {});
  await closeRedis().catch(() => {});
  });
