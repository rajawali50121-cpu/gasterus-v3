export function chooseCombinations(total, size) {
  if (!Number.isInteger(total) || !Number.isInteger(size) || size < 0 || size > total) return 0;
  const reducedSize = Math.min(size, total - size);
  let result = 1;
  for (let index = 1; index <= reducedSize; index += 1) {
    result = Math.round((result * (total - reducedSize + index)) / index);
  }
  return result;
}

export function systemBetMetrics(stake, odds, systemSize) {
  if (!Array.isArray(odds) || odds.length < 3 || !Number.isInteger(systemSize) || systemSize < 2 || systemSize >= odds.length) {
    return { combinationCount: 0, potentialPayout: 0 };
  }

  let potentialPayout = 0;
  function visit(start, depth, combinedOdds) {
    if (depth === systemSize) {
      potentialPayout += Math.floor(stake * combinedOdds);
      return;
    }
    for (let index = start; index <= odds.length - (systemSize - depth); index += 1) {
      visit(index + 1, depth + 1, combinedOdds * Number(odds[index]));
    }
  }
  visit(0, 0, 1);

  return {
    combinationCount: chooseCombinations(odds.length, systemSize),
    potentialPayout
  };
}