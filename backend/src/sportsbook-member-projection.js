function clean(value) { return String(value ?? '').trim(); }

const MEMBER_MARKET_SOURCE_LABELS = Object.freeze({
  'api-sports': 'API-Sports',
  'the-odds-api': 'The Odds API',
  sharpapi: 'SharpAPI',
  'public-market': 'Gasterus Market Feed',
  'footballdata-io': 'FootballData.io',
  sportmonks: 'Sportmonks'
});

const MEMBER_LIST_MARKET_CAP = 12;
const MEMBER_LIST_PRIORITY = Object.freeze([
  '1X2:FT',
  'HANDICAP:FT',
  'TOTALS:FT',
  '1X2:1H',
  'HANDICAP:1H',
  'TOTALS:1H',
  'BTTS:FT',
  'DOUBLE_CHANCE:FT',
  'DRAW_NO_BET:FT',
  'TEAM_TOTAL:FT',
  'ODD_EVEN:FT',
  'HT_FT:FT'
]);

function totalsPairSpread(market) {
  if (clean(market?.type).toUpperCase() !== 'TOTALS') return null;
  const selections = (market?.selections || []).filter(selection => !selection?.suspended && Number(selection?.odds) > 1);
  const over = selections.find(selection => /^over\b/i.test(clean(selection?.label)));
  const under = selections.find(selection => /^under\b/i.test(clean(selection?.label)));
  if (!over || !under) return null;
  const spread = Math.abs(Number(over.odds) - Number(under.odds));
  return Number.isFinite(spread) ? spread : null;
}
function memberMarketRank(market) {
  const usable = !market?.suspended && (market?.selections || []).some(selection => !selection?.suspended && Number(selection?.odds) > 1);
  const mainLine = market?.mainLine === true;
  const line = Number(market?.line);
  const lineDistance = Number.isFinite(line) ? Math.abs(line) : 1e9;
  const isTotals = clean(market?.type).toUpperCase() === 'TOTALS';
  const pairSpread = isTotals ? totalsPairSpread(market) : null;
  const noValidPair = isTotals && pairSpread === null ? 1 : 0;
  return [
    usable ? 0 : 1,
    mainLine ? 0 : 1,
    noValidPair,
    pairSpread ?? 0,
    lineDistance,
    clean(market?.id)
  ];
}
function compareMemberMarkets(left, right) {
  const a = memberMarketRank(left), b = memberMarketRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}
export function compactMemberMarkets(markets = []) {
  const groups = new Map();
  for (const market of markets || []) {
    const key = `${clean(market?.type).toUpperCase()}:${clean(market?.period || 'FT').toUpperCase()}`;
    if (!key || key === ':FT') continue;
    const current = groups.get(key);
    if (!current || compareMemberMarkets(market, current) < 0) groups.set(key, market);
  }
  const selected = [];
  const used = new Set();
  for (const key of MEMBER_LIST_PRIORITY) {
    const market = groups.get(key);
    if (!market) continue;
    selected.push(market);
    used.add(key);
    if (selected.length >= MEMBER_LIST_MARKET_CAP) return selected;
  }
  const remaining = [...groups.entries()]
    .filter(([key]) => !used.has(key))
    .sort((a, b) => compareMemberMarkets(a[1], b[1]) || a[0].localeCompare(b[0]));
  for (const [, market] of remaining) {
    selected.push(market);
    if (selected.length >= MEMBER_LIST_MARKET_CAP) break;
  }
  return selected;
}
export function projectMemberMarkets(markets = []) {
  return (markets || []).map(market => ({
    id: market.id,
    type: market.type,
    label: market.label,
    period: market.period,
    line: market.line,
    suspended: market.suspended,
    mainLine: market.mainLine ?? null,
    bookmaker: market.bookmaker || null,
    sourceLabel: MEMBER_MARKET_SOURCE_LABELS[clean(market.source).toLowerCase()] || null,
    selections: (market.selections || []).map(selection => ({
      key: selection.key,
      label: selection.label,
      odds: selection.odds,
      line: selection.line,
      suspended: selection.suspended,
      priceVersion: selection.priceVersion
    }))
  }));
}
