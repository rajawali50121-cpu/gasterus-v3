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
  const maxCallsPer30Days = requiredPositiveInteger("SPORTRADAR_MAX_CALLS_PER_30_DAYS", env.SPORTRADAR_MAX_CALLS_PER_30_DAYS);
  const initialCallsUsed30Days = Number(env.SPORTRADAR_INITIAL_30_DAY_USAGE ?? 0);
  if (!Number.isSafeInteger(initialCallsUsed30Days) || initialCallsUsed30Days < 0 || initialCallsUsed30Days > maxCallsPer30Days) {
    throw new Error("SPORTRADAR_INITIAL_30_DAY_USAGE must be an integer within the configured 30-day quota");
  }
  const pollMinutes = requiredPositiveInteger("SPORTSBOOK_POLL_MINUTES", env.SPORTSBOOK_POLL_MINUTES ?? 150);
  const maxCallsPerCycle = requiredPositiveInteger("SPORTRADAR_MAX_CALLS_PER_CYCLE", env.SPORTRADAR_MAX_CALLS_PER_CYCLE ?? 80);
  // GASTERUS does not impose a rolling one-hour cap. The rolling 30-day
  // budget and per-cycle ceiling remain enforced as independent safeguards.
  const maxCallsPerHour = 0;
  const changeLogEnabled = String(env.SPORTRADAR_CHANGELOG_ENABLED || "false").toLowerCase() === "true";
  const changeLogPollSeconds = requiredPositiveInteger("SPORTRADAR_CHANGELOG_POLL_SECONDS", env.SPORTRADAR_CHANGELOG_POLL_SECONDS ?? 300);
  if (changeLogPollSeconds < 60 || changeLogPollSeconds > 300) {
    throw new Error("SPORTRADAR_CHANGELOG_POLL_SECONDS must be between 60 and 300 seconds");
  }
  const minimumChangeLogCalls30Days = Math.ceil((30 * 24 * 60 * 60) / changeLogPollSeconds);
  if (changeLogEnabled && maxCallsPer30Days < minimumChangeLogCalls30Days + maxCallsPerCycle) {
    throw new Error("SPORTRADAR_CHANGELOG_ENABLED requires a 30-day request budget covering every change-log poll plus the per-cycle safety reserve");
  }
  const daysAhead = requiredPositiveInteger("SPORTRADAR_DAYS_AHEAD", env.SPORTRADAR_DAYS_AHEAD ?? 1);
  const sportIds = String(env.SPORTRADAR_SPORT_IDS || "sr:sport:1").split(",").map(v => v.trim()).filter(Boolean);
  if (!sportIds.length || sportIds.some(id => !/^sr:sport:\d+$/.test(id))) throw new Error("SPORTRADAR_SPORT_IDS must be comma-separated Sportradar sport URNs");
  const language = String(env.SPORTRADAR_LANGUAGE || "en").trim();
  return Object.freeze({
    apiKey, accessLevel, language, sportIds, daysAhead,
    pollIntervalMs: pollMinutes * MINUTE,
    maxCallsPerCycle, maxCallsPerHour, maxCallsPer30Days, initialCallsUsed30Days,
    changeLogEnabled, changeLogPollMs: changeLogPollSeconds * 1000,
    minimumChangeLogCalls30Days,
    maxSnapshotAgeMs: pollMinutes * MINUTE * 2,
    prematchBaseUrl: `https://api.sportradar.com/oddscomparison-prematch/${accessLevel}/v2/${language}`,
    soccerBaseUrl: `https://api.sportradar.com/soccer/${accessLevel}/v4/${language}`,
    requestTimeoutMs: requiredPositiveInteger("SPORTRADAR_TIMEOUT_MS", env.SPORTRADAR_TIMEOUT_MS ?? 15_000)
  });
}
