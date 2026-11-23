const arr = value => Array.isArray(value) ? value : [];

export function normalizeDailySchedule(payload) {
  return arr(payload?.schedules ?? payload?.sport_events).flatMap(item => {
    const event = item?.sport_event ?? item;
    const id = event?.id;
    if (typeof id !== "string" || !id.startsWith("sr:sport_event:")) return [];
    return [{
      id,
      scheduled: event.start_time ?? null,
      status: event.status ?? "unknown",
      home: event.competitors?.find(c => c.qualifier === "home")?.name ?? null,
      away: event.competitors?.find(c => c.qualifier === "away")?.name ?? null,
      competition: item?.sport_event_context?.competition?.name ?? null,
      competitionId: item?.sport_event_context?.competition?.id ?? null
    }];
  });
}

export function normalizeEventMarkets(payload, fetchedAt = new Date().toISOString()) {
  const event = payload?.sport_event;
  const eventId = event?.id;
  if (typeof eventId !== "string" || !eventId.startsWith("sr:sport_event:")) {
    throw new Error("SPORTRADAR_EVENT_ID_INVALID");
  }
  const markets = arr(payload?.markets).flatMap(market => {
    const marketId = market?.id;
    if (typeof marketId !== "string" || !marketId.startsWith("sr:market:")) return [];
    const books = arr(market?.books).flatMap(book => {
      if (!book?.id || book.removed === true) return [];
      const outcomes = arr(book.outcomes).flatMap(outcome => {
        if (outcome?.removed === true) return [];
        const price = Number(outcome?.odds_decimal);
        if (!Number.isFinite(price) || price <= 1) return [];
        return [{
          id: outcome.id ?? null,
          type: outcome.type ?? null,
          name: outcome.name ?? null,
          oddsDecimal: price,
          openingOddsDecimal: outcome.open_odds_decimal != null && Number.isFinite(Number(outcome.open_odds_decimal)) ? Number(outcome.open_odds_decimal) : null,
          line: outcome.handicap ?? outcome.total ?? outcome.spread ?? outcome.line ?? null,
          fieldId: outcome.field_id ?? null,
          externalOutcomeId: outcome.external_outcome_id ?? null,
          playerId: outcome.player_id ?? null,
          playerName: outcome.player_name ?? null
        }];
      });
      return outcomes.length ? [{
        id: book.id, name: book.name ?? null,
        externalMarketId: book.external_market_id ?? null,
        externalSportEventId: book.external_sport_event_id ?? null,
        outcomes
      }] : [];
    });
    const name = market.name ?? marketId;
    return [{ id: marketId, key: `${marketId}|${name}`, name, live: market.is_live === true, books }];
  });
  return {
    schemaVersion: 1,
    provider: "sportradar-odds-comparison-prematch-v2",
    fetchedAt,
    event: {
      id: eventId,
      scheduled: event.start_time ?? null,
      status: event.status ?? "unknown",
      home: event.competitors?.find(c => c.qualifier === "home")?.name ?? null,
      away: event.competitors?.find(c => c.qualifier === "away")?.name ?? null
    },
    markets
  };
}

export function normalizeDailySportEventMarkets(payload, sportId, fetchedAt = new Date().toISOString()) {
  const rows = arr(payload?.sport_schedule_sport_event_markets ?? payload?.sport_events ?? payload?.events ?? payload?.schedules);
  return rows.flatMap(item => {
    const event = item?.sport_event ?? item;
    const marketsPayload = item?.sport_event_markets ?? item;
    const markets = arr(marketsPayload?.markets ?? item?.markets);
    if (!event?.id || !markets.length) return [];
    try {
      const normalized = normalizeEventMarkets({ sport_event: event, markets }, fetchedAt);
      return [{
        ...normalized.event,
        sportId,
        competition: item?.sport_event_context?.competition?.name ?? item?.competition?.name ?? null,
        competitionId: item?.sport_event_context?.competition?.id ?? item?.competition?.id ?? null,
        markets: normalized.markets
      }];
    } catch {
      return [];
    }
  });
}

export function normalizeSoccerResult(item) {
  const event = item?.sport_event;
  const status = item?.sport_event_status;
  const id = event?.id;
  if (typeof id !== "string" || !id.startsWith("sr:sport_event:")) return null;
  return {
    eventId: id,
    status: typeof status?.status === "string" ? status.status : "unknown",
    homeScore: Number.isInteger(status?.home_score) ? status.home_score : null,
    awayScore: Number.isInteger(status?.away_score) ? status.away_score : null,
    coverage: event?.coverage ?? null
  };
}
