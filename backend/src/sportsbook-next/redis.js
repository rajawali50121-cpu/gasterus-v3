import { createClient } from "redis";

const url = String(process.env.REDIS_URL || "").trim();
if (!url) throw new Error("REDIS_URL is required for the sportsbook worker");

export const redis = createClient({
  url,
  socket: { reconnectStrategy: retries => Math.min(1000 + retries * 250, 10_000) }
});
redis.on("error", error => process.stderr.write(JSON.stringify({
  ts: new Date().toISOString(), level: "error",
  message: "Sportsbook v2 Redis client error", code: error?.code || "REDIS_CLIENT_ERROR"
})+"\n"));
export async function connectRedis() { if (!redis.isOpen) await redis.connect(); }
export async function closeRedis() { if (redis.isOpen) await redis.quit(); }
