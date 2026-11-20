// Pure member-side betting readiness guard. Backend remains authoritative.
export function isMarketBettable(market, now = Date.now()) {
  if (!market || typeof market !== 'object') return false;
  if (market.available === false) return false;
  if (market.authorityReady !== true) return false;
  if (String(market.bettingStatus || '').toUpperCase() !== 'OPEN') return false;
  if (!String(market.period || '').trim()) return false;
  const closeMs = Date.parse(String(market.closeAt || ''));
  return Number.isFinite(closeMs) && closeMs > now;
}
