import { query } from './db.js';

const EVENT_STATUS_VALUES = new Set([
  'SCHEDULED',
  'LIVE',
  'FINISHED',
  'SUSPENDED',
  'CANCELLED',
  'CANCELED',
  'ABANDONED',
  'POSTPONED',
  'VOID'
]);

export async function persistSportsbookEventStates(events, {
  feedRevision = null,
  observedAt = new Date().toISOString(),
  queryImpl = query
} = {}) {
  const validEvents = [...new Map((Array.isArray(events) ? events : [])
    .filter(event => event?.id && EVENT_STATUS_VALUES.has(String(event.status || '').toUpperCase()))
    .map(event => [String(event.id), event])).values()];
  if (!validEvents.length) return { rowCount: 0 };

  const values = [];
  const rows = validEvents.map((event, index) => {
    const offset = index * 15;
    values.push(
      String(event.id),
      String(event.sport || 'Football'),
      String(event.league || 'Other'),
      event.startTime || null,
      String(event.status).toUpperCase(),
      event.providerStatus || null,
      Boolean(event.live),
      String(event.home?.name || 'Unknown'),
      String(event.away?.name || 'Unknown'),
      event.home?.score !== null && event.home?.score !== undefined && Number.isFinite(Number(event.home.score))
        ? Number(event.home.score)
        : null,
      event.away?.score !== null && event.away?.score !== undefined && Number.isFinite(Number(event.away.score))
        ? Number(event.away.score)
        : null,
      JSON.stringify(event.periodScores || {}),
      JSON.stringify({
        sources: [...new Set(Array.isArray(event._sources) ? event._sources : [])],
        refs: event._refs && typeof event._refs === 'object' ? event._refs : {}
      }),
      feedRevision,
      observedAt
    );
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12}::jsonb,$${offset + 13}::jsonb,$${offset + 14},$${offset + 15})`;
  });

  return queryImpl(`
    INSERT INTO sportsbook_event_states (
      event_id,sport,league,start_time,status,provider_status,is_live,
      home_team,away_team,home_score,away_score,period_scores,provider_data,
      feed_revision,state_updated_at
    ) VALUES ${rows.join(',')}
    ON CONFLICT (event_id) DO UPDATE SET
      sport=EXCLUDED.sport,
      league=EXCLUDED.league,
      start_time=EXCLUDED.start_time,
      status=EXCLUDED.status,
      provider_status=EXCLUDED.provider_status,
      is_live=EXCLUDED.is_live,
      home_team=EXCLUDED.home_team,
      away_team=EXCLUDED.away_team,
      home_score=EXCLUDED.home_score,
      away_score=EXCLUDED.away_score,
      period_scores=EXCLUDED.period_scores,
      provider_data=EXCLUDED.provider_data,
      feed_revision=EXCLUDED.feed_revision,
      state_updated_at=EXCLUDED.state_updated_at,
      updated_at=now()
    WHERE (sportsbook_event_states.sport,sportsbook_event_states.league,sportsbook_event_states.start_time,
      sportsbook_event_states.status,sportsbook_event_states.provider_status,sportsbook_event_states.is_live,
      sportsbook_event_states.home_team,sportsbook_event_states.away_team,sportsbook_event_states.home_score,
      sportsbook_event_states.away_score,sportsbook_event_states.period_scores,sportsbook_event_states.provider_data)
      IS DISTINCT FROM
      (EXCLUDED.sport,EXCLUDED.league,EXCLUDED.start_time,EXCLUDED.status,EXCLUDED.provider_status,
      EXCLUDED.is_live,EXCLUDED.home_team,EXCLUDED.away_team,EXCLUDED.home_score,EXCLUDED.away_score,
      EXCLUDED.period_scores,EXCLUDED.provider_data)
  `, values);
}
