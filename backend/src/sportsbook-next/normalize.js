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
      competition: item?.sport_event_context?.competition?.name ?? null
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
          openingOddsDecimal: Number.isFinite(Number(outcome.open_odds_decimal)) ? Number(outcome.open_odds_decimal) : null,
          line: outcome.line ?? null
        }];
      });
      return outcomes.length ? [{ id: book.id, name: book.name ?? null, outcomes }] : [];
    });
    return [{ id: marketId, name: market.name ?? null, live: market.is_live === true, books }];
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
