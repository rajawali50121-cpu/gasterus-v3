import { assert } from './errors.js';

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function integer(value, name, min, max) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, 400, `${name} tidak valid.`, 'SPORTSBOOK_INPUT_INVALID');
  return parsed;
}
export function combinations(items, size) {
  const output = [];
  function visit(start, current) {
    if (current.length === size) {
      output.push([...current]);
      return;
    }
    for (let index = start; index <= items.length - (size - current.length); index += 1) {
      current.push(items[index]);
      visit(index + 1, current);
      current.pop();
    }
  }
  visit(0, []);
  return output;
}
export function choose(n, r) {
  const size = Math.min(r, n - r);
  let result = 1;
  for (let index = 1; index <= size; index += 1) result = Math.round((result * (n - size + index)) / index);
  return result;
}
export function ticketCalculation(type, stake, legs, systemSize = null, maxSystemCombinations = 120) {
  const totalOdds = legs.reduce((total, leg) => total * leg.selection.odds, 1);
  if (type !== 'SYSTEM') {
    return {
      systemSize: null,
      combinationCount: 1,
      unitStake: stake,
      totalStake: stake,
      totalOdds,
      potentialPayout: Math.floor(stake * totalOdds)
    };
  }
  const combinationCount = choose(legs.length, systemSize);
  assert(combinationCount <= maxSystemCombinations, 400, `System bet menghasilkan ${combinationCount} kombinasi, melewati batas ${maxSystemCombinations}.`, 'SPORTSBOOK_SYSTEM_TOO_LARGE');
  const potentialPayout = combinations(legs, systemSize).reduce((total, group) => {
    const comboOdds = group.reduce((product, leg) => product * leg.selection.odds, 1);
    return total + Math.floor(stake * comboOdds);
  }, 0);
  return {
    systemSize,
    combinationCount,
    unitStake: stake,
    totalStake: stake * combinationCount,
    totalOdds,
    potentialPayout
  };
}
export function validateBetType(raw, selectionCount, systemSizeRaw) {
  const type = clean(raw || (selectionCount === 1 ? 'SINGLE' : 'PARLAY'), 20).toUpperCase();
  assert(['SINGLE', 'PARLAY', 'SYSTEM'].includes(type), 400, 'Jenis taruhan tidak valid.', 'SPORTSBOOK_TYPE_INVALID');
  if (type === 'SINGLE') assert(selectionCount === 1, 400, 'Single bet hanya boleh berisi satu pilihan.', 'SPORTSBOOK_SINGLE_LEGS_INVALID');
  if (type === 'PARLAY') assert(selectionCount >= 2, 400, 'Mix parlay minimal dua pertandingan.', 'SPORTSBOOK_PARLAY_LEGS_INVALID');
  let systemSize = null;
  if (type === 'SYSTEM') {
    assert(selectionCount >= 3, 400, 'System bet minimal tiga pertandingan.', 'SPORTSBOOK_SYSTEM_LEGS_INVALID');
    systemSize = integer(systemSizeRaw, 'Ukuran system bet', 2, selectionCount - 1);
  }
  return { type, systemSize };
}
