import { tx } from "./db.js";

export async function listResultCandidateDates() {
  return tx(async client => {
    const result = await client.query(`
      SELECT DISTINCT to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
      FROM sportsbook_v2_events
      WHERE scheduled_at >= now() - interval '3 days'
        AND scheduled_at < now() + interval '1 day'
      ORDER BY date
    `);
    return result.rows.map(row => row.date);
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
