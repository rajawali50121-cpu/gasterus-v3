import { tx } from "./db.js";

const selectionKey = outcome => [
  outcome.id || outcome.type || outcome.name || "unknown",
  outcome.line ?? ""
].join("|");

export async function persistSportsbookSnapshot(events, snapshotAt = new Date().toISOString()) {
  const fetchedAt = new Date(snapshotAt);
  if (!Number.isFinite(fetchedAt.getTime())) throw new Error("SPORTSBOOK_SNAPSHOT_TIMESTAMP_INVALID");
  let eventCount = 0, marketCount = 0, priceCount = 0;

  await tx(async client => {
    for (const event of events) {
      await client.query(`
        INSERT INTO sportsbook_v2_events(
          provider_event_id,sport_id,competition_id,competition_name,scheduled_at,event_status,
          home_name,away_name,snapshot_at,provider_payload,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
        ON CONFLICT(provider_event_id) DO UPDATE SET
          sport_id=excluded.sport_id,competition_id=excluded.competition_id,
          competition_name=excluded.competition_name,scheduled_at=excluded.scheduled_at,
          event_status=excluded.event_status,home_name=excluded.home_name,away_name=excluded.away_name,
          snapshot_at=excluded.snapshot_at,provider_payload=excluded.provider_payload,updated_at=now()
      `,[
        event.id,event.sportId,event.competitionId||null,event.competition||null,
        event.scheduled||null,event.status||"unknown",event.home||null,event.away||null,
        fetchedAt,JSON.stringify(event)
      ]);
      eventCount += 1;
      await client.query("UPDATE sportsbook_v2_markets SET is_active=FALSE WHERE provider_event_id=$1",[event.id]);
      await client.query("UPDATE sportsbook_v2_prices SET is_active=FALSE WHERE provider_event_id=$1",[event.id]);

      for (const market of event.markets||[]) {
        await client.query(`
          INSERT INTO sportsbook_v2_markets(
            provider_event_id,provider_market_key,provider_market_id,market_name,is_live,is_active,snapshot_at,provider_payload
          ) VALUES($1,$2,$3,$4,$5,TRUE,$6,$7::jsonb)
          ON CONFLICT(provider_event_id,provider_market_key) DO UPDATE SET
            market_name=excluded.market_name,is_live=excluded.is_live,is_active=TRUE,
            snapshot_at=excluded.snapshot_at,provider_payload=excluded.provider_payload
        `,[event.id,market.id,market.name||null,market.live===true,fetchedAt,JSON.stringify(market)]);
        marketCount += 1;

        for (const book of market.books||[]) {
          for (const outcome of book.outcomes||[]) {
            const key=selectionKey(outcome);
            await client.query(`
              INSERT INTO sportsbook_v2_prices(
                provider_event_id,provider_market_key,provider_market_id,provider_book_id,provider_book_name,
                provider_selection_key,provider_outcome_id,external_outcome_id,external_market_id,external_sport_event_id,field_id,player_id,player_name,outcome_type,outcome_name,
                odds_decimal,opening_odds_decimal,line_value,is_active,source_updated_at,provider_payload
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,TRUE,$19,$20::jsonb)
              ON CONFLICT(provider_event_id,provider_market_key,provider_book_id,provider_selection_key)
              DO UPDATE SET provider_book_name=excluded.provider_book_name,
                provider_outcome_id=excluded.provider_outcome_id,external_outcome_id=excluded.external_outcome_id,external_market_id=excluded.external_market_id,external_sport_event_id=excluded.external_sport_event_id,field_id=excluded.field_id,player_id=excluded.player_id,player_name=excluded.player_name,outcome_type=excluded.outcome_type,
                outcome_name=excluded.outcome_name,odds_decimal=excluded.odds_decimal,
                opening_odds_decimal=excluded.opening_odds_decimal,line_value=excluded.line_value,
                is_active=TRUE,source_updated_at=excluded.source_updated_at,provider_payload=excluded.provider_payload
            `,[
              event.id,market.key||`${market.id}|${market.name||market.id}`,market.id,book.id,book.name||null,key,outcome.id||null,
              outcome.externalOutcomeId||null,book.externalMarketId||null,book.externalSportEventId||null,
              outcome.fieldId==null?null:String(outcome.fieldId),outcome.playerId||null,outcome.playerName||null,
              outcome.type||null,outcome.name||null,outcome.oddsDecimal,
              outcome.openingOddsDecimal,outcome.line==null?null:String(outcome.line),
              fetchedAt,JSON.stringify(outcome)
            ]);
            priceCount += 1;
          }
        }
      }
    }
  });
  return { events:eventCount,markets:marketCount,prices:priceCount };
}
