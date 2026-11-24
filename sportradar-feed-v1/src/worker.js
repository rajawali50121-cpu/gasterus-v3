import { config, assertWorkerConfig } from "./config.js";
import { connectRedis, redis, keys } from "./redis.js";
import { fetchMarketsPage } from "./provider.js";
import { sanitizePayload } from "./sanitize.js";
import { quotaStatus } from "./guard.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isoDate = date => date.toISOString().slice(0, 10);

function nextDates() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: config.daysAhead }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + index);
    return isoDate(date);
  });
}

async function pollOne(sportId, date) {
  const lockKey = keys.lock + ":" + sportId + ":" + date;
  const lockToken = crypto.randomUUID();
  const locked = await redis.set(lockKey, lockToken, { NX: true, EX: 3600 });
  if (!locked) return { skipped: "poll lock held" };

  try {
    const pages = [];
    let start = 0;
    const pageLimit = 100;
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await fetchMarketsPage(sportId, date, start, pageLimit);
      pages.push(sanitizePayload(page.payload));

      // Continue only when all pagination headers provide a usable numeric next offset.
      const maxResults = Number(page.headers.maxResults);
      const offset = Number(page.headers.offset);
      const resultCount = Number(page.headers.result);
      if (!Number.isFinite(maxResults) || !Number.isFinite(offset) || !Number.isFinite(resultCount)
        || resultCount <= 0 || offset + resultCount >= maxResults) break;
      start = offset + resultCount;
    }

    const snapshot = {
      version: 1, sport_id: sportId, date,
      fetched_at: new Date().toISOString(),
      page_count: pages.length,
      pages
    };
    const key = keys.snapshot(sportId, date);
    await redis.set(key, JSON.stringify(snapshot), { EX: 8 * 24 * 60 * 60 });
    await redis.zAdd(keys.index, { score: Date.now(), value: sportId + "|" + date });
    console.log(`Cached ${sportId} ${date}: ${pages.length} page(s)`);
    return { cached: true, pages: pages.length };
  } finally {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", {
      keys: [lockKey], arguments: [lockToken]
    });
  }
}

async function runCycle() {
  for (const sportId of config.sportIds) {
    for (const date of nextDates()) {
      try { await pollOne(sportId, date); }
      catch (error) {
        console.error(`Poll failed for ${sportId} ${date}: ${error.message}`);
        if (/Circuit breaker|quota limit|HTTP 403|HTTP 429/.test(error.message)) return;
      }
    }
  }
  const quota = await quotaStatus();
  console.log(`Cycle complete. Rolling quota: ${quota.used}/${quota.limit}`);
}

assertWorkerConfig();
await connectRedis();
console.log(`Sportradar feed worker started; interval=${config.pollHours}h; sports=${config.sportIds.length}; dates=${config.daysAhead}`);
while (true) {
  await runCycle();
  await sleep(config.pollHours * 60 * 60 * 1000);
}
