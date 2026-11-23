export function evaluateSoccerLeg({ marketName, outcomeType, outcomeName, line, homeScore, awayScore, cancelled = false }) {
  if (cancelled) return "VOID";
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) return null;
  const market = String(marketName || "").toLowerCase();
  const type = String(outcomeType || "").toLowerCase();
  const name = String(outcomeName || "").toLowerCase();
  const winner = homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
  const total = homeScore + awayScore;

  if (/(1x2|3.?way|winner|moneyline)/.test(market)) {
    if (!["home", "draw", "away"].includes(type)) return null;
    return type === winner ? "WON" : "LOST";
  }
  if (/(draw no bet|dnb)/.test(market)) {
    if (winner === "draw") return "PUSH";
    if (!["home", "away"].includes(type)) return null;
    return type === winner ? "WON" : "LOST";
  }
  if (/(double chance)/.test(market)) {
    const combinations = {
      home_draw: ["home", "draw"], "1x": ["home", "draw"],
      draw_away: ["draw", "away"], "x2": ["draw", "away"],
      home_away: ["home", "away"], "12": ["home", "away"]
    };
    const selected = combinations[type] || combinations[name.replace(/[\s/+]/g, "_")];
    return selected ? selected.includes(winner) ? "WON" : "LOST" : null;
  }
  if (/(total|over.?under|goals)/.test(market) && ["over", "under"].includes(type)) {
    const threshold = Number(line);
    if (!Number.isFinite(threshold)) return null;
    if (total === threshold) return "PUSH";
    return (type === "over" ? total > threshold : total < threshold) ? "WON" : "LOST";
  }
  if (/(handicap|spread)/.test(market) && ["home", "away"].includes(type)) {
    const handicap = Number(line);
    if (!Number.isFinite(handicap)) return null;
    const adjusted = type === "home" ? homeScore + handicap - awayScore : awayScore + handicap - homeScore;
    if (adjusted === 0) return "PUSH";
    return adjusted > 0 ? "WON" : "LOST";
  }
  if (/(both teams to score|team to score)/.test(market) && ["yes", "no"].includes(type)) {
    const yes = homeScore > 0 && awayScore > 0;
    return (type === "yes" ? yes : !yes) ? "WON" : "LOST";
  }
  if (/(odd.?even)/.test(market) && ["odd", "even"].includes(type)) {
    return ((total % 2 === 1) === (type === "odd")) ? "WON" : "LOST";
  }
  if (/(correct score)/.test(market)) {
    const score = name.match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (!score) return null;
    return Number(score[1]) === homeScore && Number(score[2]) === awayScore ? "WON" : "LOST";
  }
  return null;
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
