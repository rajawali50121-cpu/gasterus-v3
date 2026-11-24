import http from "node:http";
import { config, assertRedisConfig } from "./config.js";
import { connectRedis, redis, readSnapshots, keys } from "./redis.js";
import { quotaStatus } from "./guard.js";

assertRedisConfig();
await connectRedis();

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    if (url.pathname === "/health") {
      const quota = await quotaStatus();
      return send(res, 200, { ok: true, redis: redis.isReady, breaker_seconds: Math.max(0, await redis.ttl(keys.breaker)), quota });
    }
    if (url.pathname === "/api/sportsbook/events") {
      const sportId = url.searchParams.get("sport_id") || "";
      if (sportId && !/^sr:sport:\d+$/.test(sportId)) return send(res, 400, { error: "invalid_sport_id" });
      const snapshots = await readSnapshots(sportId);
      return send(res, 200, { ok: true, stale_while_revalidate: true, count: snapshots.length, data: snapshots });
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("API request failed:", error.message);
    return send(res, 503, { error: "service_unavailable" });
  }
});

server.listen(config.port, "0.0.0.0", () => console.log(`Sportradar feed API listening on ${config.port}`));
