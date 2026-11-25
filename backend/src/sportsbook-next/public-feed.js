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
export async function readPublicSportsbookSnapshot({ redis, now = Date.now(), maxAgeMs = MAX_SNAPSHOT_AGE_MS }) {
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

  return { ...snapshot, events, ageMs };
}
