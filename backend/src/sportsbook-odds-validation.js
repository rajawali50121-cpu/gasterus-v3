const MIN_DECIMAL_ODDS = 1.2;
const MAX_DECIMAL_ODDS = 100;

export function isValidSportsbookDecimalOdds(value) {
  const odds = Number(value);
  return Number.isFinite(odds) && odds >= MIN_DECIMAL_ODDS && odds <= MAX_DECIMAL_ODDS;
}
