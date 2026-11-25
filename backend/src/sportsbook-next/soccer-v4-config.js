const MINUTE = 60_000;

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(name + " must be a positive integer");
  return parsed;
}

export function loadSoccerV4Config(env = process.env) {
  const enabled = String(env.SPORTRADAR_SOCCER_ENABLED || "false").toLowerCase() === "true";
  const pollMinutes = positiveInteger("SPORTRADAR_SOCCER_POLL_MINUTES", env.SPORTRADAR_SOCCER_POLL_MINUTES ?? 60);
  if (pollMinutes < 60) throw new Error("Soccer v4 polling must be at least 60 minutes to protect the trial request budget");
  const maxCallsPerCycle = positiveInteger("SPORTRADAR_SOCCER_MAX_CALLS_PER_CYCLE", env.SPORTRADAR_SOCCER_MAX_CALLS_PER_CYCLE ?? 1);
  if (maxCallsPerCycle !== 1) throw new Error("Soccer v4 is limited to one request per cycle; increase cadence only after verifying quota");

  if (!enabled) return Object.freeze({ enabled, pollIntervalMs: pollMinutes * MINUTE, maxCallsPerCycle });

  const apiKey = String(env.SPORTRADAR_SOCCER_API_KEY || env.SPORTRADAR_API_KEY || "").trim();
  if (!apiKey) throw new Error("SPORTRADAR_SOCCER_API_KEY or SPORTRADAR_API_KEY is required when Soccer v4 is enabled");
  const accessLevel = String(env.SPORTRADAR_SOCCER_ACCESS_LEVEL || env.SPORTRADAR_ACCESS_LEVEL || "trial").toLowerCase();
  if (!["trial", "production"].includes(accessLevel)) throw new Error("SPORTRADAR_ACCESS_LEVEL must be trial or production");

  const quotaRaw = env.SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS;
  const initialRaw = env.SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE;
  if (quotaRaw === undefined || initialRaw === undefined) {
    throw new Error("Soccer v4 requires explicit SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS and SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE");
  }
  const maxCallsPer30Days = positiveInteger("SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS", quotaRaw);
  if (String(env.SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED || "").toLowerCase() !== "true") {
    throw new Error("Soccer provider quota baseline is unconfirmed; set SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED=true only after checking current Soccer product usage");
  }
  const initialCallsUsed30Days = Number(initialRaw);
  if (!Number.isSafeInteger(initialCallsUsed30Days) || initialCallsUsed30Days < 0 || initialCallsUsed30Days > maxCallsPer30Days) {
    throw new Error("SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE must be an integer within the Soccer quota");
  }
  if (accessLevel === "trial" && maxCallsPer30Days > 800) {
    throw new Error("Soccer trial internal budget must not exceed 800 calls per rolling 30 days");
  }
  const language = String(env.SPORTRADAR_SOCCER_LANGUAGE || "en").trim();
  const requestTimeoutMs = positiveInteger("SPORTRADAR_SOCCER_TIMEOUT_MS", env.SPORTRADAR_SOCCER_TIMEOUT_MS ?? 15000);

  return Object.freeze({
    enabled, apiKey, accessLevel, language, maxCallsPer30Days, initialCallsUsed30Days,
    maxCallsPerCycle, pollIntervalMs: pollMinutes * MINUTE, requestTimeoutMs,
    baseUrl: "https://api.sportradar.com/soccer/" + accessLevel + "/v4/" + language
  });
}
