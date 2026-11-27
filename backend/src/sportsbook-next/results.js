const FINAL_STATUSES = new Set(["closed", "cancelled"]);
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString()
  : null;

export function normalizeSportEventId(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^sr:(?:match|sport_event):(\d+)$/);
  return match ? "sr:sport_event:" + match[1] : null;
}

function normalizeReplacedBy(value) {
  if (typeof value === "string") return normalizeSportEventId(value);
  if (value && typeof value === "object") return normalizeSportEventId(value.id);
  return null;
}

export function normalizeSoccerResult(item, { generatedAt = null, receivedAt = null } = {}) {
  const event = item?.sport_event;
  const status = item?.sport_event_status;
  const eventId = normalizeSportEventId(event?.id);
  if (!eventId) throw new Error("SPORTRADAR_RESULT_EVENT_ID_INVALID");

  const eventStatus = typeof status?.status === "string" ? status.status.toLowerCase() : "unknown";
  const replacedBy = normalizeReplacedBy(event?.replaced_by);
  const homeScore = eventStatus === "cancelled" ? null
    : Number.isInteger(status?.home_score) && status.home_score >= 0 ? status.home_score : null;
  const awayScore = eventStatus === "cancelled" ? null
    : Number.isInteger(status?.away_score) && status.away_score >= 0 ? status.away_score : null;
  const providerGeneratedAt = validTimestamp(generatedAt || item?.generated_at);
  const isFinal = FINAL_STATUSES.has(eventStatus);
  const scoreComplete = eventStatus === "cancelled" || (homeScore !== null && awayScore !== null);
  const reviewRequired = eventStatus === "abandoned" ||
    (eventStatus === "postponed" && replacedBy !== null);

  return {
    eventId,
    replacedBy,
    reviewRequired,
    source: "sportradar-soccer-v4",
    status: eventStatus,
    homeScore,
    awayScore,
    providerGeneratedAt,
    receivedAt: validTimestamp(receivedAt) || new Date().toISOString(),
    isFinal,
    // "closed" is Sportradar's confirmed-result state; a provider generation
    // timestamp is useful audit metadata but is not required by the summaries
    // endpoint contract. A provider-reported cancellation is terminal for void.
    verified: eventStatus === "cancelled" || (eventStatus === "closed" && scoreComplete),
    payload: item
  };
}

export function normalizeSoccerResults(payload, receivedAt = null, generatedAtOverride = null) {
  const summaries = payload?.summaries;
  if (!Array.isArray(summaries)) throw new Error("SPORTRADAR_RESULTS_SHAPE_INVALID");
  const normalized = new Map();
  for (const item of summaries) {
    const result = normalizeSoccerResult(item, {
      generatedAt: generatedAtOverride || payload.generated_at,
      receivedAt
    });
    const previous = normalized.get(result.eventId);
    const priority = value => value.status === "closed" || value.status === "cancelled" ? 2 : 1;
    const previousAt = previous?.providerGeneratedAt ? Date.parse(previous.providerGeneratedAt) : 0;
    const currentAt = result.providerGeneratedAt ? Date.parse(result.providerGeneratedAt) : 0;
    if (!previous || priority(result) > priority(previous) ||
        (priority(result) === priority(previous) && currentAt > previousAt)) {
      normalized.set(result.eventId, result);
    }
  }
  return [...normalized.values()];
}
