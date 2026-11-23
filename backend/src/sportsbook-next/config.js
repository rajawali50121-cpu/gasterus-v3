const MINUTE = 60_000;

function requiredPositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadSportsbookConfig(env = process.env) {
  const apiKey = String(env.SPORTRADAR_API_KEY || "").trim();
  if (!apiKey) throw new Error("SPORTRADAR_API_KEY is required");

  const accessLevel = String(env.SPORTRADAR_ACCESS_LEVEL || "trial").toLowerCase();
  if (!["trial", "production"].includes(accessLevel)) throw new Error("SPORTRADAR_ACCESS_LEVEL must be trial or production");

  const pollMinutes = requiredPositiveInteger("SPORTSBOOK_POLL_MINUTES", env.SPORTSBOOK_POLL_MINUTES ?? 150);
  const quota30d = requiredPositiveInteger("SPORTRADAR_MAX_CALLS_PER_30_DAYS", env.SPORTRADAR_MAX_CALLS_PER_30_DAYS);
  const used30d = Number(env.SPORTRADAR_INITIAL_30_DAY_USAGE ?? 0);
  if (!Number.isSafeInteger(used30d) || used30d < 0 || used30d > quota30d) {
    throw new Error("SPORTRADAR_INITIAL_30_DAY_USAGE must be an integer within the configured 30-day quota");
  }

  const language = String(env.SPORTRADAR_LANGUAGE || "en").trim();
  return Object.freeze({
    apiKey,
    accessLevel,
    language,
    pollIntervalMs: pollMinutes * MINUTE,
    maxCallsPer30Days: quota30d,
    initialCallsUsed30Days: used30d,
    prematchBaseUrl: `https://api.sportradar.com/oddscomparison-prematch/${accessLevel}/v2/${language}`,
    soccerBaseUrl: `https://api.sportradar.com/soccer/${accessLevel}/v4/${language}`,
    requestTimeoutMs: requiredPositiveInteger("SPORTRADAR_TIMEOUT_MS", env.SPORTRADAR_TIMEOUT_MS ?? 15_000)
  });
}
