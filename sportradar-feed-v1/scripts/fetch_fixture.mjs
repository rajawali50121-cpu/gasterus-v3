import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertWorkerConfig } from "../src/config.js";
import { connectRedis, redis } from "../src/redis.js";
import { fetchMarketsPage } from "../src/provider.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sportId = (process.env.SPORTRADAR_FIXTURE_SPORT_ID || config.sportIds[0]).trim();
const date = (process.env.SPORTRADAR_FIXTURE_DATE || new Date().toISOString().slice(0, 10)).trim();

if (!/^sr:sport:\d+$/.test(sportId)) throw new Error("Invalid SPORTRADAR_FIXTURE_SPORT_ID");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) {
  throw new Error("Invalid SPORTRADAR_FIXTURE_DATE");
}

assertWorkerConfig();
await connectRedis();
try {
  // One guarded request only: consumes the same rolling quota and respects global pacing/breaker.
  const page = await fetchMarketsPage(sportId, date, 0, 5);
  const target = resolve(packageDir, "fixtures/daily_markets.sample.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(page.payload, null, 2) + "\n", { flag: "wx" });
  console.log("Fixture captured locally (not committed): " + target);
  console.log("HTTP status: 200");
  console.log("X-Max-Results: " + (page.headers.maxResults ?? "(absent)"));
  console.log("X-Offset: " + (page.headers.offset ?? "(absent)"));
  console.log("X-Result: " + (page.headers.result ?? "(absent)"));
  console.log("generated_at: " + (typeof page.payload?.generated_at === "string" ? page.payload.generated_at : "(absent)"));
} finally {
  await redis.quit();
}
