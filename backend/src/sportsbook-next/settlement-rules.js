export function evaluateSoccer1x2Leg({ marketName, outcomeType, homeScore, awayScore, cancelled = false }) {
  if (cancelled) return "VOID";
  if (!/(1x2|3.?way|winner|moneyline)/i.test(String(marketName || ""))) return null;
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) return null;
  const winner = homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
  const selection = String(outcomeType || "").toLowerCase();
  if (!["home", "draw", "away"].includes(selection)) return null;
  return selection === winner ? "WON" : "LOST";
}

export function evaluateTicketStatus(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  if (statuses.includes("LOST")) return "LOST";
  if (!statuses.every(status => ["WON", "VOID", "PUSH"].includes(status))) return null;
  return statuses.every(status => status === "VOID" || status === "PUSH") ? "VOID" : "WON";
}

export function calculateTicketPayout(stake, legs) {
  if (!Number.isSafeInteger(stake) || stake <= 0 || !Array.isArray(legs)) throw new TypeError("SPORTSBOOK_PAYOUT_INPUT_INVALID");
  const odds = legs.filter(leg => !["VOID", "PUSH"].includes(leg.result_status)).map(leg => Number(leg.accepted_odds));
  if (!odds.length) return stake;
  const totalOdds = odds.reduce((product, value) => {
    if (!Number.isFinite(value) || value <= 1) throw new TypeError("SPORTSBOOK_ODDS_INVALID");
    return product * value;
  }, 1);
  const payout = Math.floor(stake * totalOdds);
  if (!Number.isSafeInteger(payout)) throw new RangeError("SPORTSBOOK_PAYOUT_LIMIT");
  return payout;
}
