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
  if (env.SPORTRADAR_MAX_CALLS_PER_30_DAYS === undefined || env.SPORTRADAR_INITIAL_30_DAY_USAGE === undefined) {
    throw new Error("Sportradar requires explicit SPORTRADAR_MAX_CALLS_PER_30_DAYS and actual SPORTRADAR_INITIAL_30_DAY_USAGE");
  }
  if (String(env.SPORTRADAR_QUOTA_BASELINE_CONFIRMED || "").toLowerCase() !== "true") {
    throw new Error("Sportradar provider quota baseline is unconfirmed; set SPORTRADAR_QUOTA_BASELINE_CONFIRMED=true only after checking current provider usage");
  }
  const maxCallsPer30Days = requiredPositiveInteger("SPORTRADAR_MAX_CALLS_PER_30_DAYS", env.SPORTRADAR_MAX_CALLS_PER_30_DAYS);
  if (accessLevel === "trial" && maxCallsPer30Days > 800) {
    throw new Error("Trial internal budget must not exceed 800 calls per rolling 30 days; provider entitlement is account-specific");
  }
  const initialCallsUsed30Days = Number(env.SPORTRADAR_INITIAL_30_DAY_USAGE);
  if (!Number.isSafeInteger(initialCallsUsed30Days) || initialCallsUsed30Days < 0 || initialCallsUsed30Days > maxCallsPer30Days) {
    throw new Error("SPORTRADAR_INITIAL_30_DAY_USAGE must be an integer within the configured 30-day quota");
  }
  const pollMinutes = requiredPositiveInteger("SPORTSBOOK_POLL_MINUTES", env.SPORTSBOOK_POLL_MINUTES ?? 150);
  const schedulePollMinutes = requiredPositiveInteger("SPORTRADAR_SCHEDULE_POLL_MINUTES", env.SPORTRADAR_SCHEDULE_POLL_MINUTES ?? 60);
  if (schedulePollMinutes < 60) throw new Error("SPORTRADAR_SCHEDULE_POLL_MINUTES must be at least 60 to match official Daily Schedules guidance");
  const maxCallsPerCycle = requiredPositiveInteger("SPORTRADAR_MAX_CALLS_PER_CYCLE", env.SPORTRADAR_MAX_CALLS_PER_CYCLE ?? (accessLevel === "trial" ? 6 : 80));
  if (accessLevel === "trial" && maxCallsPerCycle > 6) {
    throw new Error("Trial max calls per cycle must not exceed 6");
  }
  // GASTERUS does not impose a rolling one-hour cap. The rolling 30-day
  // budget and per-cycle ceiling remain enforced as independent safeguards.
  const maxCallsPerHour = 0;
  const changeLogEnabled = String(env.SPORTRADAR_CHANGELOG_ENABLED || "false").toLowerCase() === "true";
  const changeLogPollSeconds = requiredPositiveInteger("SPORTRADAR_CHANGELOG_POLL_SECONDS", env.SPORTRADAR_CHANGELOG_POLL_SECONDS ?? 240);
  if (changeLogPollSeconds < 60 || changeLogPollSeconds > 300) {
    throw new Error("SPORTRADAR_CHANGELOG_POLL_SECONDS must be between 60 and 300 seconds");
  }
  const daysAhead = Number(env.SPORTRADAR_DAYS_AHEAD ?? 0);
  if (!Number.isSafeInteger(daysAhead) || daysAhead < 0 || daysAhead > (accessLevel === "trial" ? 0 : 14)) {
    throw new Error(accessLevel === "trial"
      ? "Trial mode supports only the current UTC date (SPORTRADAR_DAYS_AHEAD=0)"
      : "SPORTRADAR_DAYS_AHEAD must be an integer between 0 and 14");
  }
  const sportIds = String(env.SPORTRADAR_SPORT_IDS || "sr:sport:1").split(",").map(v => v.trim()).filter(Boolean);
  if (!sportIds.length || sportIds.some(id => !/^sr:sport:\d+$/.test(id))) throw new Error("SPORTRADAR_SPORT_IDS must be comma-separated Sportradar sport URNs");
  if (accessLevel === "trial" && sportIds.length !== 1) {
    throw new Error("Trial mode must track exactly one sport to protect the 30-day request budget");
  }
  const minimumChangeLogCalls30Days = Math.ceil((30 * 24 * 60 * 60) / changeLogPollSeconds);
  const sportCount = sportIds.length;
  const dateCount = daysAhead + 1;
  const minimumScheduleCalls30Days = Math.ceil((30 * 24 * 60) / schedulePollMinutes) * sportCount * dateCount * 2;
  const minimumMarketCalls30Days = Math.ceil((30 * 24 * 60) / pollMinutes) * sportCount * dateCount * 2;
  // Sports, Books and Sport Competitions are refreshed once per day.
  const minimumDiscoveryCalls30Days = 3 * 30;
  const minimumCalls30Days = minimumScheduleCalls30Days + minimumMarketCalls30Days +
    minimumDiscoveryCalls30Days + (changeLogEnabled ? minimumChangeLogCalls30Days + maxCallsPerCycle : 0);
  if (maxCallsPer30Days - initialCallsUsed30Days < minimumCalls30Days) {
    throw new Error("Sportradar 30-day budget is insufficient for the configured Daily Schedules, market discovery, discovery feeds and Change Log request cadence");
  }
  const language = String(env.SPORTRADAR_LANGUAGE || "en").trim();
  return Object.freeze({
    apiKey, accessLevel, language, sportIds, daysAhead,
    pollIntervalMs: pollMinutes * MINUTE,
    schedulePollIntervalMs: schedulePollMinutes * MINUTE,
    maxCallsPerCycle, maxCallsPerHour, maxCallsPer30Days, initialCallsUsed30Days,
    changeLogEnabled, changeLogPollMs: changeLogPollSeconds * 1000,
    minimumChangeLogCalls30Days, minimumScheduleCalls30Days,
    minimumMarketCalls30Days, minimumDiscoveryCalls30Days, minimumCalls30Days,
    maxSnapshotAgeMs: pollMinutes * MINUTE * 2,
    prematchBaseUrl: `https://api.sportradar.com/oddscomparison-prematch/${accessLevel}/v2/${language}`,
    soccerBaseUrl: `https://api.sportradar.com/soccer/${accessLevel}/v4/${language}`,
    requestTimeoutMs: requiredPositiveInteger("SPORTRADAR_TIMEOUT_MS", env.SPORTRADAR_TIMEOUT_MS ?? 15_000)
  });
}


// Strict default-off switch: only exact "true" (case-insensitive) enables the worker.
export function isSportradarOddsEnabled(env = process.env) {
  const value = env?.SPORTRADAR_ODDS_ENABLED;
  return typeof value === "string" && value.toLowerCase() === "true";
}
