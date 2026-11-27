import { setTimeout as sleep } from "node:timers/promises";
import { closeDatabase } from "../db.js";
import { logger } from "../logger.js";
import { settleReadySportsbookTickets } from "./settlement-service.js";

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
  logger.info("Sportsbook settlement worker started", {
    pollSeconds, batchSize, resultAuthority: "sportradar-soccer-v4-closed",
    supportedMarket: "SOCCER_1X2_3WAY"
  });

  while (!stopping) {
    try {
      const summary = await settleReadySportsbookTickets({ limit: batchSize });
      if (summary.scanned || summary.manualReview || summary.liquidityBlocked) {
        logger.info("Sportsbook settlement cycle", summary);
      }
    } catch (error) {
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
  });
