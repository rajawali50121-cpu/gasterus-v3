const arr = value => Array.isArray(value) ? value : [];

export function normalizePrematchPayload(payload, fetchedAt = new Date().toISOString()) {
  const events = arr(payload?.sport_events ?? payload?.sportEvents ?? payload?.schedules);
  const normalized = [];

  for (const event of events) {
    const eventId = event?.id ?? event?.sport_event?.id;
    if (typeof eventId !== "string" || !eventId.startsWith("sr:sport_event:")) continue;
    const sourceEvent = event.sport_event ?? event;
    const markets = arr(event.markets ?? event.sport_event_markets);
    const normalizedMarkets = [];

    for (const market of markets) {
      const marketId = market?.id;
      if (marketId === undefined || marketId === null) continue;
      const books = arr(market.books ?? market.bookmakers);
      const normalizedBooks = books.flatMap(book => {
        if (book?.removed === true) return [];
        const outcomes = arr(book?.outcomes).flatMap(outcome => {
          if (outcome?.removed === true) return [];
          const price = Number(outcome?.odds ?? outcome?.decimal_odds);
          if (!Number.isFinite(price) || price <= 1) return [];
          return [{
            id: outcome.id ?? null,
            name: outcome.name ?? null,
            fieldId: outcome.field_id ?? null,
            type: outcome.type ?? null,
            handicap: outcome.handicap ?? null,
            decimalOdds: price
          }];
        });
        return outcomes.length ? [{
          id: book.id ?? null,
          name: book.name ?? null,
          outcomes
        }] : [];
      });
      normalizedMarkets.push({
        id: String(marketId),
        name: market.name ?? null,
        isLive: market.is_live === true,
        books: normalizedBooks
      });
    }

    normalized.push({
      id: eventId,
      scheduled: sourceEvent.start_time ?? event.start_time ?? null,
      status: sourceEvent.status ?? "unknown",
      home: sourceEvent.competitors?.find(c => c.qualifier === "home")?.name ?? null,
      away: sourceEvent.competitors?.find(c => c.qualifier === "away")?.name ?? null,
      markets: normalizedMarkets
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    provider: "sportradar-odds-comparison-prematch-v2",
    fetchedAt,
    complete: true,
    events: normalized
  });
}

export function normalizeSoccerResult(event) {
  const id = event?.sport_event?.id;
  const status = event?.sport_event_status?.status;
  if (typeof id !== "string" || !id.startsWith("sr:sport_event:")) return null;
  const score = event.sport_event_status?.home_score;
  const awayScore = event.sport_event_status?.away_score;
  return {
    eventId: id,
    status: typeof status === "string" ? status : "unknown",
    homeScore: Number.isInteger(score) ? score : null,
    awayScore: Number.isInteger(awayScore) ? awayScore : null,
    coverage: event.sport_event?.coverage ?? null
  };
}
