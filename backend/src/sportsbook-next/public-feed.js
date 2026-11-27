import { query } from "../db.js";
import { AppError } from "../errors.js";

const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 60 * 1000;

function hasValidOdds(market) {
  if (market?.live === true || !Array.isArray(market?.books)) return false;
  return market.books.some(book =>
    Array.isArray(book?.outcomes) && book.outcomes.some(outcome => {
      const odds = Number(outcome?.oddsDecimal);
      return Number.isFinite(odds) && odds > 1;
    })
  );
}

/**
 * Read-only public projection of the worker-owned Redis snapshot.
 * This function never calls the Sportradar provider or writes to Redis.
 */
export async function readPublicSportsbookSnapshot({ redis, now = Date.now(), maxAgeMs = MAX_SNAPSHOT_AGE_MS, loadMappings = query }) {
  let raw;
  try {
    raw = await redis.get("sportsbook:next:snapshot:v1");
  } catch {
    throw new AppError(503, "Feed sportsbook sementara tidak dapat dibaca.", "SPORTSBOOK_CACHE_UNAVAILABLE");
  }
  if (!raw) throw new AppError(503, "Feed sportsbook belum tersedia.", "SPORTSBOOK_FEED_UNAVAILABLE");

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new AppError(503, "Snapshot sportsbook tidak valid.", "SPORTSBOOK_SNAPSHOT_INVALID");
  }

  const fetchedAt = Date.parse(snapshot?.fetchedAt || "");
  const ageMs = Number.isFinite(fetchedAt) ? Math.max(0, now - fetchedAt) : NaN;
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    throw new AppError(503, "Snapshot sportsbook sudah kedaluwarsa.", "SPORTSBOOK_FEED_STALE");
  }
  if (
    snapshot?.complete !== true ||
    snapshot?.quotaLimited === true ||
    snapshot?.budgetLimited === true ||
    snapshot?.truncated === true ||
    (Array.isArray(snapshot?.errors) && snapshot.errors.length > 0) ||
    !Array.isArray(snapshot?.events)
  ) {
    throw new AppError(503, "Snapshot sportsbook tidak lengkap.", "SPORTSBOOK_FEED_INCOMPLETE");
  }

  const events = snapshot.events.flatMap(event => {
    const markets = Array.isArray(event?.markets) ? event.markets.filter(hasValidOdds) : [];
    return markets.length ? [{ ...event, markets }] : [];
  });
  if (!events.length) {
    throw new AppError(503, "Belum ada pertandingan dengan market berodds pada snapshot terakhir.", "SPORTSBOOK_ODDS_UNAVAILABLE");
  }

  // Only operator-approved, verified full-time Soccer 1X2 mappings are selectable.
  // If mappings are absent or the catalog cannot be read, odds remain display-only.
  let mappingRows = [];
  let bettingMappingsAvailable = false;
  try {
    const mapped = await loadMappings(`
      SELECT pm.sport_id,pm.provider_market_id,pm.provider_market_name,
             COALESCE(pm.provider_definition->>'specifiers','') AS specifiers,
             pm.outcomes,pm.market_code,pm.settlement_rule
      FROM sportsbook_v2_provider_market_mappings pm
      JOIN sportsbook_v2_market_catalog catalog
        ON catalog.market_code=pm.market_code AND catalog.enabled=TRUE
      WHERE pm.provider_product='oddscomparison-prematch-v2'
        AND pm.sport_id='sr:sport:1'
        AND pm.period_code='FT'
        AND pm.mapping_status='VERIFIED'
        AND pm.enabled=TRUE
        AND pm.market_code='SOCCER_1X2_3WAY'
        AND catalog.settlement_rule='SOCCER_1X2_3WAY'
    `);
    mappingRows = mapped.rows;
    bettingMappingsAvailable = true;
  } catch {
    // Never turn a feed/schema outage into permission to bet.
    bettingMappingsAvailable = false;
  }

  const projectedEvents = events.map(event => ({
    ...event,
    markets: event.markets.map(market => {
      const specifiers = typeof market.specifiers === "string" ? market.specifiers : "";
      const matches = mappingRows.filter(row =>
        row.sport_id === event.sportId &&
        row.provider_market_id === market.id &&
        row.provider_market_name === market.name &&
        row.specifiers === specifiers
      );
      const mapping = matches.length === 1 ? matches[0] : null;
      const outcomeMap = mapping?.outcomes && typeof mapping.outcomes === "object" ? mapping.outcomes : {};
      return {
        ...market,
        bettable: Boolean(mapping && !market.live),
        books: market.books.map(book => ({
          ...book,
          outcomes: book.outcomes.map(outcome => ({
            ...outcome,
            bettable: Boolean(mapping && !market.live &&
              ["HOME","DRAW","AWAY"].includes(String(outcomeMap[String(outcome.type || "").toUpperCase()] || "").toUpperCase()))
          }))
        }))
      };
    })
  }));

  return {
    ...snapshot, events: projectedEvents, ageMs, bettingMappingsAvailable,
    betAcceptanceEnabled: snapshot.complete === true && bettingMappingsAvailable
  };
}
