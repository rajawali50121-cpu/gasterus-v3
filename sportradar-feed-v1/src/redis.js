import { createClient } from "redis";
import { config } from "./config.js";

export const redis = createClient({ url: config.redisUrl });
redis.on("error", error => console.error("Redis connection error:", error.message));

export async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
}

export const keys = {
  breaker: "srfeed:v1:breaker",
  lock: "srfeed:v1:poll-lock",
  quota: "srfeed:v1:quota:rolling-30d",
  lastRequest: "srfeed:v1:last-request",
  snapshot: (sportId, date) => `srfeed:v1:snapshot:${sportId}:${date}`,
  index: "srfeed:v1:snapshot-index"
};

export async function readSnapshots(sportId = "") {
  const members = await redis.zRange(keys.index, 0, -1);
  const output = [];
  for (const member of members) {
    if (sportId && !member.startsWith(sportId + "|")) continue;
    const raw = await redis.get(keys.snapshot(...member.split("|")));
    if (!raw) continue;
    try { output.push(JSON.parse(raw)); } catch { /* ignore corrupt cache entry */ }
  }
  return output;
}
