import { tx } from "./db.js";

const selectionKey = outcome => [
  outcome.selectionKey || [
    outcome.id || outcome.type || outcome.name || "unknown",
    outcome.line ?? ""
  ].join("|")
].join("|");

export async function confirmSportsbookPricesThrough(providerWindowEnd) {
  const verifiedAt = providerWindowEnd instanceof Date ? providerWindowEnd : new Date(providerWindowEnd);
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error("SPORTSBOOK_CHANGELOG_TIMESTAMP_INVALID");
  return tx(async client => {
    const result = await client.query(`
      UPDATE sportsbook_v2_prices
      SET change_log_verified_at = $1
      WHERE is_active = TRUE
        AND EXISTS (
          SELECT 1 FROM sportsbook_v2_markets m
          WHERE m.provider_event_id = sportsbook_v2_prices.provider_event_id
            AND m.provider_market_key = sportsbook_v2_prices.provider_market_key
            AND m.is_active = TRUE
            AND m.is_live = FALSE
        )
      RETURNING id
    `, [verifiedAt]);
    return { verifiedPrices: result.rowCount };
  });
}

export async function persistSportsbookSchedules(events, sportId, snapshotAt = new Date().toISOString()) {
  if (!Array.isArray(events) || typeof sportId !== "string" || !sportId) {
    throw new TypeError("SPORTSBOOK_SCHEDULES_INVALID");
  }
  const fetchedAt = new Date(snapshotAt);
  if (!Number.isFinite(fetchedAt.getTime())) throw new Error("SPORTSBOOK_SCHEDULE_TIMESTAMP_INVALID");
  let schedulesPersisted = 0;
  await tx(async client => {
    for (const event of events) {
      if (!event?.id || !String(event.id).startsWith("sr:sport_event:")) continue;
      await client.query(`
        INSERT INTO sportsbook_v2_events(
          provider_event_id,sport_id,competition_id,competition_name,scheduled_at,event_status,
          home_name,away_name,snapshot_at,schedule_verified_at,provider_payload,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10::jsonb,now())
        ON CONFLICT(provider_event_id) DO UPDATE SET
          sport_id=excluded.sport_id,
          competition_id=COALESCE(excluded.competition_id,sportsbook_v2_events.competition_id),
          competition_name=COALESCE(excluded.competition_name,sportsbook_v2_events.competition_name),
          scheduled_at=COALESCE(excluded.scheduled_at,sportsbook_v2_events.scheduled_at),
          event_status=CASE WHEN excluded.event_status='unknown'
            THEN sportsbook_v2_events.event_status ELSE excluded.event_status END,
          home_name=COALESCE(excluded.home_name,sportsbook_v2_events.home_name),
          away_name=COALESCE(excluded.away_name,sportsbook_v2_events.away_name),
          snapshot_at=GREATEST(sportsbook_v2_events.snapshot_at,excluded.snapshot_at),
          schedule_verified_at=now(),
          provider_payload=sportsbook_v2_events.provider_payload || excluded.provider_payload,
          updated_at=now()
      `, [
        event.id,sportId,event.competitionId||null,event.competition||null,
        event.scheduled||null,event.status||"unknown",event.home||null,event.away||null,
        fetchedAt,JSON.stringify({ daily_schedule: event })
      ]);
      schedulesPersisted += 1;
    }
  });
  return { schedulesPersisted };
}

export async function persistSportsbookSnapshot(events, snapshotAt = new Date().toISOString(), { complete = false, scopes = [], transaction = tx } = {}) {
  if (complete !== true || !Array.isArray(events) || !Array.isArray(scopes) || scopes.length === 0) throw new Error("SPORTSBOOK_SNAPSHOT_INCOMPLETE");
  const fetchedAt = new Date(snapshotAt);
  if (!Number.isFinite(fetchedAt.getTime())) throw new Error("SPORTSBOOK_SNAPSHOT_TIMESTAMP_INVALID");
  let eventCount = 0, marketCount = 0, priceCount = 0;

  await transaction(async client => {
    const snapshotScopes = new Map();
    for (const scope of scopes) {
      if (typeof scope?.sportId !== "string" || !/^sr:sport:\d+$/.test(scope.sportId) ||
          typeof scope?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scope.date) ||
          !Array.isArray(scope.ids) || scope.ids.some(id => typeof id !== "string" || !/^sr:sport_event:\d+$/.test(id))) {
        throw new Error("SPORTSBOOK_SNAPSHOT_SCOPE_INVALID");
      }
      snapshotScopes.set(`${scope.sportId}:${scope.date}`, { sportId: scope.sportId, date: scope.date, ids: [...new Set(scope.ids)] });
    }
    for (const event of events) {
      await client.query(`
        INSERT INTO sportsbook_v2_events(
          provider_event_id,sport_id,competition_id,competition_name,scheduled_at,event_status,
          home_name,away_name,snapshot_at,provider_generated_at,provider_payload,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now())
        ON CONFLICT(provider_event_id) DO UPDATE SET
          sport_id=excluded.sport_id,
          competition_id=COALESCE(sportsbook_v2_events.competition_id,excluded.competition_id),
          competition_name=COALESCE(sportsbook_v2_events.competition_name,excluded.competition_name),
          scheduled_at=COALESCE(excluded.scheduled_at,sportsbook_v2_events.scheduled_at),
          event_status=CASE WHEN excluded.event_status IS NULL OR excluded.event_status='unknown'
            THEN sportsbook_v2_events.event_status ELSE excluded.event_status END,
          home_name=COALESCE(sportsbook_v2_events.home_name,excluded.home_name),
          away_name=COALESCE(sportsbook_v2_events.away_name,excluded.away_name),
          snapshot_at=GREATEST(sportsbook_v2_events.snapshot_at,excluded.snapshot_at),
          provider_generated_at=COALESCE(excluded.provider_generated_at,sportsbook_v2_events.provider_generated_at),
          provider_payload=sportsbook_v2_events.provider_payload || excluded.provider_payload,
          updated_at=now()
      `,[
        event.id,event.sportId,event.competitionId||null,event.competition||null,
        event.scheduled||null,event.status||"unknown",event.home||null,event.away||null,
        fetchedAt,event.providerGeneratedAt ? new Date(event.providerGeneratedAt) : null,JSON.stringify(event)
      ]);
      eventCount += 1;
      await client.query("UPDATE sportsbook_v2_markets SET is_active=FALSE WHERE provider_event_id=$1",[event.id]);
      await client.query("UPDATE sportsbook_v2_prices SET is_active=FALSE WHERE provider_event_id=$1",[event.id]);

      for (const market of event.markets||[]) {
        await client.query(`
          INSERT INTO sportsbook_v2_markets(
            provider_event_id,provider_market_key,provider_market_id,market_name,is_live,is_active,snapshot_at,provider_generated_at,provider_payload
          ) VALUES($1,$2,$3,$4,$5,TRUE,$6,$7,$8::jsonb)
          ON CONFLICT(provider_event_id,provider_market_key) DO UPDATE SET
            market_name=excluded.market_name,is_live=excluded.is_live,is_active=TRUE,
            snapshot_at=excluded.snapshot_at,provider_generated_at=excluded.provider_generated_at,
            provider_payload=excluded.provider_payload
        `,[event.id,market.key||`${market.id}|${market.name||market.id}`,market.id,market.name||null,market.live===true,fetchedAt,event.providerGeneratedAt ? new Date(event.providerGeneratedAt) : null,JSON.stringify(market)]);
        marketCount += 1;

        for (const book of market.books||[]) {
          for (const outcome of book.outcomes||[]) {
            const price = Number(outcome?.oddsDecimal);
            // Odds <= 1.00 are not valid bet prices. Removed 1.00 rows remain
            // available in the market JSON payload, but cannot enter the price table.
            if (!Number.isFinite(price) || price <= 1) continue;
            const key=selectionKey(outcome);
            await client.query(`
              INSERT INTO sportsbook_v2_prices(
                provider_event_id,provider_market_key,provider_market_id,provider_book_id,provider_book_name,
                provider_selection_key,provider_outcome_id,external_outcome_id,external_market_id,external_sport_event_id,field_id,player_id,player_name,outcome_type,outcome_name,
                odds_decimal,opening_odds_decimal,line_value,is_active,source_updated_at,received_at,change_log_verified_at,provider_payload
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,TRUE,$19,$20,NULL,$21::jsonb)
              ON CONFLICT(provider_event_id,provider_market_key,provider_book_id,provider_selection_key)
              DO UPDATE SET provider_book_name=excluded.provider_book_name,
                provider_outcome_id=excluded.provider_outcome_id,external_outcome_id=excluded.external_outcome_id,external_market_id=excluded.external_market_id,external_sport_event_id=excluded.external_sport_event_id,field_id=excluded.field_id,player_id=excluded.player_id,player_name=excluded.player_name,outcome_type=excluded.outcome_type,
                outcome_name=excluded.outcome_name,odds_decimal=excluded.odds_decimal,
                opening_odds_decimal=excluded.opening_odds_decimal,line_value=excluded.line_value,
                is_active=TRUE,source_updated_at=excluded.source_updated_at,
                received_at=excluded.received_at,change_log_verified_at=NULL,
                provider_payload=excluded.provider_payload
            `,[
              event.id,market.key||`${market.id}|${market.name||market.id}`,market.id,book.id,book.name||null,key,outcome.id||null,
              outcome.externalOutcomeId||null,book.externalMarketId||null,book.externalSportEventId||null,
              outcome.fieldId==null?null:String(outcome.fieldId),outcome.playerId||null,outcome.playerName||null,
              outcome.type||null,outcome.name||null,outcome.oddsDecimal,
              outcome.openingOddsDecimal,outcome.line==null?null:String(outcome.line),
              event.providerGeneratedAt ? new Date(event.providerGeneratedAt) : null,fetchedAt,JSON.stringify(outcome)
            ]);
            priceCount += 1;
          }
        }
      }
    }
    // Complete feed pages are required before an omitted event is considered withdrawn.
    for (const scope of snapshotScopes.values()) {
      const params = [scope.sportId, scope.date, scope.ids];
      await client.query(`
        UPDATE sportsbook_v2_markets m SET is_active=FALSE
        FROM sportsbook_v2_events e
        WHERE e.provider_event_id=m.provider_event_id AND e.sport_id=$1
          AND e.scheduled_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
          AND e.scheduled_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC')
          AND NOT (e.provider_event_id = ANY($3::text[]))
      `, params);
      await client.query(`
        UPDATE sportsbook_v2_prices p SET is_active=FALSE
        FROM sportsbook_v2_events e
        WHERE e.provider_event_id=p.provider_event_id AND e.sport_id=$1
          AND e.scheduled_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
          AND e.scheduled_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC')
          AND NOT (e.provider_event_id = ANY($3::text[]))
      `, params);
    }
  });
  return { events:eventCount,markets:marketCount,prices:priceCount };
}
