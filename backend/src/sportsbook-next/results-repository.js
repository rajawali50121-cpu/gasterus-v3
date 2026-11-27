import { normalizeSportEventId } from "./results.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value) {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parsePayload(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function providerEventIdFrom(event) {
  const payload = parsePayload(event.providerPayload ?? event.provider_payload ?? event.payload);
  return normalizeSportEventId(payload?.sport_event?.id) ??
    normalizeSportEventId(event.providerEventId ?? event.provider_event_id);
}

function replacedByFrom(event) {
  const payload = parsePayload(event.providerPayload ?? event.provider_payload ?? event.payload);
  const value = event.replacedBy ?? event.replaced_by ?? payload?.sport_event?.replaced_by;
  const id = typeof value === "string" ? value : value?.id;
  return normalizeSportEventId(id);
}

export function buildSoccerResultCandidateGroups(events, {
  now = Date.now(), bufferMinutes = 150, maxLookbackDays = 7
} = {}) {
  const nowMs = validDate(now);
  if (nowMs === null || !Number.isFinite(bufferMinutes) || bufferMinutes < 0 ||
      !Number.isInteger(maxLookbackDays) || maxLookbackDays < 1) {
    throw new TypeError("SOCCER_V4_RESULT_CANDIDATE_CONFIG_INVALID");
  }
  const cutoff = nowMs - bufferMinutes * 60_000;
  const oldestAllowed = nowMs - maxLookbackDays * DAY_MS;
  const groups = new Map();
  const uniqueEvents = new Map();
  const manualReviewEventIds = [];
  const manualReviewEvents = [];
  let candidateCount = 0;

  for (const event of Array.isArray(events) ? events : []) {
    const eventId = providerEventIdFrom(event);
    if (!eventId) {
      const rawId = event.providerEventId ?? event.provider_event_id;
      const kickoff = validDate(event.scheduledAt ?? event.scheduled_at);
      if (typeof rawId === "string" && kickoff !== null &&
          kickoff <= cutoff && kickoff < oldestAllowed) {
        manualReviewEventIds.push(rawId);
        manualReviewEvents.push({ eventId: rawId, replacedBy: null, reason: "lookback_exceeded" });
      }
      continue;
    }
    const existing = uniqueEvents.get(eventId);
    const rank = value => {
      const state = String(value.resultStatus ?? value.result_status ?? value.event_status ?? "").toLowerCase();
      const providerAt = validDate(value.providerGeneratedAt ?? value.provider_generated_at ?? value.source_updated_at);
      const verified = (value.resultVerified ?? value.result_verified ?? value.verified) === true;
      if (state === "cancelled" || (state === "closed" && verified)) return 3;
      if (state === "abandoned" || (state === "postponed" && replacedByFrom(value))) return 2;
      return 1;
    };
    if (!existing || rank(event) > rank(existing)) uniqueEvents.set(eventId, { ...event, providerEventId: eventId });
  }

  for (const event of uniqueEvents.values()) {
    const eventId = event.providerEventId;
    const kickoff = validDate(event.scheduledAt ?? event.scheduled_at);
    if (kickoff === null || kickoff > cutoff) continue;
    const status = String(event.resultStatus ?? event.result_status ?? event.event_status ?? "").toLowerCase();
    const providerAt = validDate(event.providerGeneratedAt ?? event.provider_generated_at ?? event.source_updated_at);
    const verified = (event.resultVerified ?? event.result_verified ?? event.verified) === true;
    const isVerifiedFinal = status === "cancelled" || (status === "closed" && verified);
    if (isVerifiedFinal) continue;

    const replacedBy = replacedByFrom(event);
    if (status === "abandoned" || (status === "postponed" && replacedBy)) {
      manualReviewEventIds.push(eventId);
      manualReviewEvents.push({ eventId, replacedBy, reason: status === "abandoned" ? "abandoned" : "postponed_replaced" });
      continue;
    }
    if (kickoff < oldestAllowed) {
      manualReviewEventIds.push(eventId);
      manualReviewEvents.push({ eventId, replacedBy: null, reason: "lookback_exceeded" });
      continue;
    }

    const date = new Date(kickoff).toISOString().slice(0, 10);
    groups.set(date, (groups.get(date) || 0) + 1);
    candidateCount += 1;
  }

  return {
    dates: [...groups.keys()].sort(),
    candidateCount,
    manualReviewCount: manualReviewEvents.length,
    manualReviewEventIds,
    manualReviewEvents
  };
}

export function selectOldestDueSoccerResultDate(dates, lastPolls = {}, now = Date.now(), intervalMs = 60 * 60 * 1000, cursors = {}) {
  if (!Array.isArray(dates) || !lastPolls || typeof lastPolls !== "object" ||
      !Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new TypeError("SOCCER_V4_RESULT_DATE_SELECTION_INVALID");
  }
  return [...new Set(dates)].sort().find(date => {
    const cursor = Number(cursors[date] || 0);
    if (cursor > 0) return true;
    const lastPoll = Number(lastPolls[date] || 0);
    return !Number.isFinite(lastPoll) || lastPoll <= 0 || now - lastPoll >= intervalMs;
  }) ?? null;
}

export async function listResultCandidateDates({
  bufferMinutes = Number(process.env.SOCCER_V4_RESULT_BUFFER_MINUTES ?? 150),
  maxLookbackDays = Number(process.env.SOCCER_V4_MAX_LOOKBACK_DAYS ?? 7),
  now = new Date()
} = {}) {
  if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0 ||
      !Number.isInteger(maxLookbackDays) || maxLookbackDays < 1) {
    throw new TypeError("SOCCER_V4_RESULT_CANDIDATE_CONFIG_INVALID");
  }
  const { tx } = await import("./db.js");
  return tx(async client => {
    const result = await client.query(`
      SELECT e.provider_event_id, e.scheduled_at,
             r.event_status AS result_status,
             r.verified AS result_verified,
             r.source_updated_at AS provider_generated_at,
             r.received_at,
             r.provider_payload
      FROM sportsbook_v2_events e
      LEFT JOIN sportsbook_v2_event_results r
        ON regexp_replace(e.provider_event_id, '^sr:match:', 'sr:sport_event:') =
           regexp_replace(r.provider_event_id, '^sr:match:', 'sr:sport_event:')
      WHERE e.scheduled_at IS NOT NULL
        AND e.scheduled_at <= $1::timestamptz - ($2::text || ' minutes')::interval
      ORDER BY e.scheduled_at ASC
    `, [now, bufferMinutes]);
    return buildSoccerResultCandidateGroups(result.rows, { now, bufferMinutes, maxLookbackDays });
  });
}

export async function persistSoccerResultRevisions(results) {
  if (!Array.isArray(results)) throw new TypeError("SPORTSBOOK_RESULTS_INVALID");
  const { tx } = await import("./db.js");
  return tx(async client => {
    let inserted = 0;
    let duplicates = 0;
    let projected = 0;
    let verified = 0;
    for (const result of results) {
      // Provider generation time may be absent from Daily Summaries. Keep it NULL;
      // record local receipt time separately and never substitute it as provider time.
      const eventId = normalizeSportEventId(result?.eventId);
      if (!eventId) continue;
      const trackedEvent = await client.query(`
        SELECT provider_event_id FROM sportsbook_v2_events
        WHERE regexp_replace(provider_event_id, '^sr:match:', 'sr:sport_event:') = $1
        ORDER BY provider_event_id LIMIT 1
      `, [eventId]);
      if (!trackedEvent.rowCount) continue;
      const storageEventId = trackedEvent.rows[0].provider_event_id;
      const providerAt = result.providerGeneratedAt ? new Date(result.providerGeneratedAt) : null;
      const receivedAt = result.receivedAt ? new Date(result.receivedAt) : new Date();
      if (providerAt && !Number.isFinite(providerAt.getTime())) continue;
      if (!Number.isFinite(receivedAt.getTime())) continue;
      const payload = JSON.stringify({
        ...(result.payload ?? {}),
        soccer_v4: { replaced_by: result.replacedBy ?? null, review_required: result.reviewRequired === true }
      });
      if (providerAt) {
        const revision = await client.query(`
          INSERT INTO sportsbook_v2_event_result_revisions(
            provider_event_id,result_source,event_status,home_score,away_score,provider_generated_at,received_at,verified,provider_payload
          )
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
          WHERE EXISTS (
            SELECT 1 FROM sportsbook_v2_events
            WHERE provider_event_id = $1
          )
          ON CONFLICT (provider_event_id,result_source,provider_generated_at)
            WHERE provider_generated_at IS NOT NULL DO NOTHING
          RETURNING id
        `,[storageEventId,result.source,result.status,result.homeScore,result.awayScore,providerAt,receivedAt,result.verified===true,payload]);
        if (!revision.rowCount) duplicates += 1;
        else inserted += 1;
      }
      const projection = await client.query(`
        INSERT INTO sportsbook_v2_event_results(
          provider_event_id,result_source,event_status,home_score,away_score,source_updated_at,received_at,verified,provider_payload
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
        WHERE EXISTS (
          SELECT 1 FROM sportsbook_v2_events
          WHERE provider_event_id = $1
        )
        ON CONFLICT(provider_event_id) DO UPDATE SET
          result_source=excluded.result_source,event_status=excluded.event_status,
          home_score=excluded.home_score,away_score=excluded.away_score,
          source_updated_at=excluded.source_updated_at,received_at=excluded.received_at,
          verified=excluded.verified,provider_payload=excluded.provider_payload
        WHERE sportsbook_v2_event_results.received_at <= excluded.received_at
        RETURNING provider_event_id
      `,[storageEventId,result.source,result.status,result.homeScore,result.awayScore,providerAt,receivedAt,result.verified===true,payload]);
      if (projection.rowCount) projected += 1;
      if (result.verified === true) verified += 1;
    }
    return { received: results.length, inserted, duplicates, projected, verified };
  });
}
