import { tx } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
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
  let manualReviewCount = 0;
  let candidateCount = 0;

  for (const event of Array.isArray(events) ? events : []) {
    const kickoff = validDate(event.scheduledAt ?? event.scheduled_at);
    if (kickoff === null || kickoff > cutoff) continue;
    const status = String(event.resultStatus ?? event.event_status ?? "").toLowerCase();
    const generatedAt = validDate(event.providerGeneratedAt ?? event.provider_generated_at ?? event.source_updated_at);
    const isVerifiedFinal = status === "closed" &&
      (event.resultVerified ?? event.verified) === true && generatedAt !== null;
    if (isVerifiedFinal) continue;
    if (kickoff < oldestAllowed) {
      manualReviewCount += 1;
      continue;
    }
    const date = new Date(kickoff).toISOString().slice(0, 10);
    groups.set(date, (groups.get(date) || 0) + 1);
    candidateCount += 1;
  }

  return {
    dates: [...groups.keys()].sort(),
    candidateCount,
    manualReviewCount
  };
}

export function selectOldestDueSoccerResultDate(dates, lastPolls = {}, now = Date.now(), intervalMs = 60 * 60 * 1000) {
  if (!Array.isArray(dates) || !lastPolls || typeof lastPolls !== "object" ||
      !Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new TypeError("SOCCER_V4_RESULT_DATE_SELECTION_INVALID");
  }
  return [...new Set(dates)].sort().find(date => {
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
  return tx(async client => {
    const result = await client.query(`
      SELECT e.scheduled_at,
             r.event_status AS result_status,
             r.verified AS result_verified,
             r.source_updated_at AS provider_generated_at
      FROM sportsbook_v2_events e
      LEFT JOIN sportsbook_v2_event_results r
        ON r.provider_event_id = e.provider_event_id
      WHERE e.scheduled_at IS NOT NULL
        AND e.scheduled_at <= $1::timestamptz - ($2::text || ' minutes')::interval
      ORDER BY e.scheduled_at ASC
    `, [now, bufferMinutes]);
    return buildSoccerResultCandidateGroups(result.rows, {
      now, bufferMinutes, maxLookbackDays
    });
  });
}

export async function persistSoccerResultRevisions(results) {
  if (!Array.isArray(results)) throw new TypeError("SPORTSBOOK_RESULTS_INVALID");
  return tx(async client => {
    let inserted = 0;
    let duplicates = 0;
    let verified = 0;
    for (const result of results) {
      if (!result?.providerGeneratedAt) continue;
      const providerAt = new Date(result.providerGeneratedAt);
      const receivedAt = new Date(result.receivedAt);
      if (!Number.isFinite(providerAt.getTime()) || !Number.isFinite(receivedAt.getTime())) continue;
      const payload = JSON.stringify(result.payload ?? {});
      const revision = await client.query(`
        INSERT INTO sportsbook_v2_event_result_revisions(
          provider_event_id,result_source,event_status,home_score,away_score,provider_generated_at,received_at,verified,provider_payload
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
        WHERE EXISTS (SELECT 1 FROM sportsbook_v2_events WHERE provider_event_id=$1)
        ON CONFLICT (provider_event_id,result_source,provider_generated_at)
          WHERE provider_generated_at IS NOT NULL DO NOTHING
        RETURNING id
      `,[result.eventId,result.source,result.status,result.homeScore,result.awayScore,providerAt,receivedAt,result.verified===true,payload]);
      if (!revision.rowCount) { duplicates += 1; continue; }
      inserted += 1;
      if (result.verified === true) verified += 1;
      await client.query(`
        INSERT INTO sportsbook_v2_event_results(
          provider_event_id,result_source,event_status,home_score,away_score,source_updated_at,verified,provider_payload
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT(provider_event_id) DO UPDATE SET
          result_source=excluded.result_source,event_status=excluded.event_status,
          home_score=excluded.home_score,away_score=excluded.away_score,
          source_updated_at=excluded.source_updated_at,verified=excluded.verified,
          provider_payload=excluded.provider_payload
        WHERE sportsbook_v2_event_results.source_updated_at <= excluded.source_updated_at
      `,[result.eventId,result.source,result.status,result.homeScore,result.awayScore,providerAt,result.verified===true,payload]);
    }
    return { received: results.length, inserted, duplicates, verified };
  });
}
