import "dotenv/config";

const integer = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
};

const accessLevel = (process.env.SPORTRADAR_ACCESS_LEVEL || "trial").trim().toLowerCase();
if (!["trial", "production"].includes(accessLevel)) throw new Error("SPORTRADAR_ACCESS_LEVEL must be trial or production");

const sportIds = (process.env.SPORTRADAR_SPORT_IDS || "sr:sport:1")
  .split(",").map(v => v.trim()).filter(Boolean);
if (!sportIds.length || sportIds.some(v => !/^sr:sport:\d+$/.test(v))) throw new Error("Invalid SPORTRADAR_SPORT_IDS");

export const config = Object.freeze({
  apiKey: (process.env.SPORTRADAR_API_KEY || "").trim(),
  accessLevel,
  language: (process.env.SPORTRADAR_LANGUAGE || "en").trim(),
  sportIds,
  pollHours: integer("SPORTRADAR_POLL_HOURS", 5, 4, 6),
  daysAhead: integer("SPORTRADAR_DAYS_AHEAD", 2, 1, 3),
  quotaLimit: integer("SPORTRADAR_30D_QUOTA_LIMIT", 900, 1, 900),
  minGapMs: integer("SPORTRADAR_MIN_REQUEST_GAP_MS", 1150, 1150, 60000),
  breakerMinutes: integer("SPORTRADAR_BREAKER_MINUTES", 30, 1, 240),
  port: integer("SPORTRADAR_PORT", 8080, 1, 65535),
  redisUrl: process.env.REDIS_URL || ""
});

export function assertRedisConfig() {
  if (!config.redisUrl) throw new Error("REDIS_URL is not configured");
}

export function assertWorkerConfig() {
  assertRedisConfig();
  if (!config.apiKey) throw new Error("SPORTRADAR_API_KEY is not configured");
  if (!/^[a-z]{2}$/.test(config.language)) throw new Error("SPORTRADAR_LANGUAGE must be a 2-letter code");
}
