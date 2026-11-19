import { config } from './config.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const roundOdds = n => Math.round(clamp(n, 1.01, 250) * 1000) / 1000;

function liabilityNumber(value) {
  const n = Number(String(value ?? '0'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function applySportsbookRiskRepricing(events = [], exposures = [], { now = Date.now() } = {}) {
  if (!config.sportsbookRiskRepricingEnabled || !Array.isArray(exposures) || !exposures.length) return events;
  const maxShade = clamp(Number(config.sportsbookRiskRepricingMaxShadeBps || 0) / 10000, 0, 0.2);
  if (!(maxShade > 0)) return events;
  const maxLiability = Math.max(Number(config.sportsbookMaxSelectionLiability || 1), 1);
  const exposureMap = new Map(exposures.map(item => [`${item.eventId}|${item.marketId}|${item.selectionId}`, liabilityNumber(item.liability)]));
  const repricedAt = new Date(now).toISOString();

  return events.map(event => ({
    ...event,
    markets: (event.markets || []).map(market => {
      const selections = market.selections || [];
      if (market.source !== 'sportradar' || selections.length < 2) return market;
      const implied = selections.map(selection => 1 / Number(selection.odds));
      if (implied.some(value => !Number.isFinite(value) || value <= 0)) return market;
      const totalImplied = implied.reduce((a, b) => a + b, 0);
      const weights = selections.map((selection, index) => {
        const liability = exposureMap.get(`${event.id}|${market.id}|${selection.key}`) || 0;
        const ratio = clamp(liability / maxLiability, 0, 1);
        return { selection, base: implied[index] / totalImplied, liability, ratio, shade: ratio * maxShade };
      });
      if (!weights.some(item => item.liability > 0)) return market;
      const adjustedMass = weights.reduce((sum, item) => sum + item.base * (1 + item.shade), 0);
      const nextSelections = weights.map(item => {
        const adjustedProbability = (item.base * (1 + item.shade)) / adjustedMass;
        const odds = roundOdds(1 / (adjustedProbability * totalImplied));
        return {
          ...item.selection,
          baseOdds: Number(item.selection.baseOdds || item.selection.odds),
          odds,
          // Repricing time is not a provider update time. Keep source freshness timestamps intact.
          updatedAt: item.selection.updatedAt || market.updatedAt || null,
          riskRepricedAt: repricedAt,
          anchorUpdatedAt: item.selection.anchorUpdatedAt || item.selection.updatedAt || market.updatedAt || null,
          pricingModel: 'GASTERUS_RISK_SHADE_V1',
          riskLiability: Math.trunc(item.liability),
          riskShadeBps: Math.round(item.shade * 10000)
        };
      });
      return { ...market, updatedAt: market.updatedAt || null, riskRepricedAt: repricedAt, selections: nextSelections, pricingModel: 'GASTERUS_RISK_SHADE_V1' };
    })
  }));
}
