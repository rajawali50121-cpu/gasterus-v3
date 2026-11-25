const FINAL_STATUSES = new Set(["closed", "cancelled"]);
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString()
  : null;

export function normalizeSoccerResult(item, { generatedAt = null, receivedAt = new Date().toISOString() } = {}) {
  const event = item?.sport_event;
  const status = item?.sport_event_status;
  const eventId = event?.id;
  if (typeof eventId !== "string" || !/^sr:sport_event:\d+$/.test(eventId)) {
    throw new Error("SPORTRADAR_RESULT_EVENT_ID_INVALID");
  }
  const eventStatus = typeof status?.status === "string" ? status.status.toLowerCase() : "unknown";
  const homeScore = Number.isInteger(status?.home_score) && status.home_score >= 0 ? status.home_score : null;
  const awayScore = Number.isInteger(status?.away_score) && status.away_score >= 0 ? status.away_score : null;
  const providerGeneratedAt = validTimestamp(generatedAt || item?.generated_at);
  const isFinal = FINAL_STATUSES.has(eventStatus);
  const scoreComplete = eventStatus === "cancelled" || (homeScore !== null && awayScore !== null);
  return {
    eventId,
    source: "sportradar-soccer-v4",
    status: eventStatus,
    homeScore,
    awayScore,
    providerGeneratedAt,
    receivedAt: validTimestamp(receivedAt) || new Date().toISOString(),
    isFinal,
    verified: isFinal && scoreComplete && providerGeneratedAt !== null,
    payload: item
  };
}

export function normalizeSoccerResults(payload, receivedAt = new Date().toISOString(), generatedAtOverride = null) {
  const summaries = payload?.summaries;
  if (!Array.isArray(summaries)) throw new Error("SPORTRADAR_RESULTS_SHAPE_INVALID");
  return summaries.map(item => normalizeSoccerResult(item, { generatedAt: generatedAtOverride || payload.generated_at, receivedAt }));
}
