import { combinations } from './sportsbook-calculation.js';

export function legReturnMultiplier(leg) {
  const price = Number(leg?.accepted_odds);
  if (!Number.isFinite(price) || price <= 1) return 0;
  if (leg.result_status === 'WON') return price;
  if (leg.result_status === 'HALF_WON') return (price + 1) / 2;
  if (leg.result_status === 'HALF_LOST') return 0.5;
  if (['VOID', 'PUSH'].includes(leg.result_status)) return 1;
  return 0;
}

export function settleCalculation(ticket, legs) {
  const unitStake = Number(ticket?.unit_stake);
  if (!Number.isFinite(unitStake) || unitStake < 0) return 0;
  const comboPayout = group => Math.floor(unitStake * group.reduce((product, leg) => product * legReturnMultiplier(leg), 1));
  if (ticket?.bet_type !== 'SYSTEM') return comboPayout(legs);
  return combinations(legs, Number(ticket.system_size)).reduce((total, group) => total + comboPayout(group), 0);
}
