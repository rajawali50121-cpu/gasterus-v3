const arr = value => Array.isArray(value) ? value : [];

export function isPersistableDiscoverySnapshot({ errors = [], quotaLimited = false, budgetLimited = false, truncated = false, events = [] } = {}) {
  return errors.length === 0 && !quotaLimited && !budgetLimited && !truncated && events.length > 0;
}

export async function persistDiscoverySnapshotIfComplete(snapshot, { persist, redis, snapshotKey, ttlSeconds, incompleteReason = "SPORTRADAR_CYCLE_INCOMPLETE" }) {
  const eligible = snapshot?.complete === true && isPersistableDiscoverySnapshot(snapshot);
  if (!eligible) return { skipped: true, reason: incompleteReason };
  const persisted = await persist(snapshot.events, snapshot.fetchedAt);
  await redis.set(snapshotKey, JSON.stringify(snapshot), { EX: ttlSeconds });
  return { skipped: false, persisted };
}

export function isRemoved(value) {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

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
    if (typeof marketId !== "string" || !/^sr:market:\d+$/.test(marketId)) return [];
    const normalizeOutcome = outcome => {
      const price = outcome?.odds_decimal == null ? null : Number(outcome.odds_decimal);
      const line = outcome.handicap ?? outcome.total ?? outcome.spread ?? outcome.line ?? null;
      const outcomeType = outcome.type ?? null;
      const outcomeName = outcome.name ?? null;
      const outcomeId = outcome.id ?? null;
      const selectionKey = [outcomeId || outcomeType || outcomeName || "unknown", line ?? ""].join("|");
      return {
        id: outcomeId,
        type: outcomeType,
        name: outcomeName,
        selectionKey,
        oddsDecimal: Number.isFinite(price) ? price : null,
        oddsAmerican: outcome.odds_american ?? null,
        oddsFraction: outcome.odds_fraction ?? null,
        openingOddsDecimal: outcome.open_odds_decimal != null && Number.isFinite(Number(outcome.open_odds_decimal)) ? Number(outcome.open_odds_decimal) : null,
        openingOddsAmerican: outcome.open_odds_american ?? null,
        openingOddsFraction: outcome.open_odds_fraction ?? null,
        line,
        openingLine: outcome.open_handicap ?? outcome.open_total ?? outcome.open_spread ?? null,
        fieldId: outcome.field_id ?? null,
        externalOutcomeId: outcome.external_outcome_id ?? null,
        playerId: outcome.player_id ?? null,
        playerName: outcome.player_name ?? null,
        removed: isRemoved(outcome.removed)
      };
    };
    const books = [];
    const removedBooks = [];
    for (const book of arr(market?.books)) {
      if (!book?.id) continue;
      const normalizedOutcomes = arr(book.outcomes).map(normalizeOutcome);
      const normalizedBook = {
        id: book.id, name: book.name ?? null,
        externalMarketId: book.external_market_id ?? null,
        externalSportEventId: book.external_sport_event_id ?? null,
        outcomes: normalizedOutcomes
      };
      if (isRemoved(book.removed)) {
        removedBooks.push({ ...normalizedBook, removed: true });
        continue;
      }
      const activeOutcomes = normalizedOutcomes.filter(outcome =>
        !isRemoved(outcome.removed) && Number.isFinite(outcome.oddsDecimal) && outcome.oddsDecimal > 1
      );
      const removedOutcomes = normalizedOutcomes.filter(outcome => isRemoved(outcome.removed));
      if (activeOutcomes.length || removedOutcomes.length) {
        books.push({ ...normalizedBook, removed: false, outcomes: activeOutcomes, removedOutcomes });
      }
    }
    const name = market.name ?? marketId;
    return [{
      id: marketId, key: `${marketId}|${name}`, name,
      specifiers: market.specifiers ?? null,
      live: market.is_live === true, books, removedBooks
    }];
  });
  return {
    schemaVersion: 1,
    provider: "sportradar-odds-comparison-prematch-v2",
    fetchedAt,
    providerGeneratedAt: typeof payload?.generated_at === "string" && Number.isFinite(Date.parse(payload.generated_at)) ? new Date(payload.generated_at).toISOString() : null,
    event: {
      id: eventId,
      scheduled: event.start_time ?? null,
      status: event.status ?? "unknown",
      startTimeConfirmed: event.start_time_confirmed === true,
      replacedBy: typeof event.replaced_by === "string" ? event.replaced_by : null,
      resumeTime: typeof event.resume_time === "string" ? event.resume_time : null,
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
    const markets = marketsPayload?.markets ?? item?.markets ?? [];
    if (!Array.isArray(markets)) throw new Error("SPORTRADAR_MARKETS_SHAPE_INVALID");
    const normalized = normalizeEventMarkets({ generated_at: payload?.generated_at, sport_event: event, markets }, fetchedAt);
    return [{
      ...normalized.event,
      providerGeneratedAt: normalized.providerGeneratedAt,
      sportId,
      competition: item?.sport_event_context?.competition?.name ?? item?.competition?.name ?? null,
      competitionId: item?.sport_event_context?.competition?.id ?? item?.competition?.id ?? null,
      markets: normalized.markets
    }];
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

export function filterPrematchEvents(events, now = Date.now()) {
  const filtered = { started: 0, invalidScheduled: 0, liveMarkets: 0 };
  const kept = [];
  for (const event of arr(events)) {
    const scheduledAt = Date.parse(event?.scheduled ?? "");
    if (!Number.isFinite(scheduledAt)) {
      filtered.invalidScheduled += 1;
      continue;
    }
    if (scheduledAt <= now) {
      filtered.started += 1;
      continue;
    }
    const markets = arr(event.markets);
    const safeMarkets = markets.filter(market => {
      if (market?.live === true) {
        filtered.liveMarkets += 1;
        return false;
      }
      return true;
    });
    if (safeMarkets.length === 0) continue;
    kept.push({ ...event, markets: safeMarkets });
  }
  return { events: kept, filtered };
}
