export function evaluateSoccer1x2Leg({ marketCode, outcomeCode, result }) {
  if (result?.verified !== true || result?.isFinal !== true) return null;
  if (marketCode !== "SOCCER_1X2_3WAY") return null;
  if (result.status === "cancelled") return "VOID";
  if (!Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore)) return null;
  const winner = result.homeScore > result.awayScore ? "HOME"
    : result.homeScore < result.awayScore ? "AWAY" : "DRAW";
  const selection = String(outcomeCode || "").toUpperCase();
  if (!["HOME", "DRAW", "AWAY"].includes(selection)) return null;
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
  const odds = legs.filter(leg => !["VOID", "PUSH"].includes(leg.resultStatus)).map(leg => Number(leg.acceptedOdds));
  if (!odds.length) return stake;
  const totalOdds = odds.reduce((product, value) => {
    if (!Number.isFinite(value) || value <= 1) throw new TypeError("SPORTSBOOK_ODDS_INVALID");
    return product * value;
  }, 1);
  const payout = Math.floor(stake * totalOdds);
  if (!Number.isSafeInteger(payout)) throw new RangeError("SPORTSBOOK_PAYOUT_LIMIT");
  return payout;
}
