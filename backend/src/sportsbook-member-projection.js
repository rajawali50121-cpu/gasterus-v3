function clean(value) { return String(value ?? '').trim(); }
const SUMMARY_MARKET_PERIODS = new Set(['FT', '1H']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function marketIdentity(market) {
  const id = clean(market.id);
  if (id) return `id:${id}|${clean(market.type).toUpperCase()}|${clean(market.period || 'FT').toUpperCase()}|${clean(market.line)}`;
  return `market:${clean(market.type).toUpperCase()}|${clean(market.period || 'FT').toUpperCase()}|${clean(market.line)}|${clean(market.label)}`;
}

const MEMBER_MARKET_SOURCE_LABELS = Object.freeze({
  sportradar: 'Sportradar'
});

export function projectMemberMarkets(markets = []) {
  if (!Array.isArray(markets)) return [];
  const seenMarkets = new Set();
  const projected = [];

  for (const market of markets) {
    if (!isRecord(market)) continue;
    const sourcePassthrough = market.source === 'sportradar';
    const identity = marketIdentity(market);
    if (!sourcePassthrough) {
      if (seenMarkets.has(identity)) continue;
      seenMarkets.add(identity);
    }

    const seenSelections = new Set();
    const selections = [];
    for (const selection of Array.isArray(market.selections) ? market.selections : []) {
      if (!isRecord(selection)) continue;
      const selectionIdentity = `${clean(selection.key || selection.label)}|${clean(selection.line ?? market.line)}`;
      if (!sourcePassthrough) {
        if (seenSelections.has(selectionIdentity)) continue;
        seenSelections.add(selectionIdentity);
      }
      selections.push({
        key: selection.key,
        label: selection.label,
        odds: selection.odds,
        line: selection.line,
        suspended: selection.suspended,
        priceVersion: selection.priceVersion,
        ...(market.source === 'sportradar' ? {
          oddsAmerican: selection.oddsAmerican ?? null,
          oddsFraction: selection.oddsFraction ?? null,
          openOddsDecimal: selection.openOddsDecimal ?? null,
          openOddsAmerican: selection.openOddsAmerican ?? null,
          openOddsFraction: selection.openOddsFraction ?? null,
          handicap: selection.handicap ?? null,
          spread: selection.spread ?? null,
          total: selection.total ?? null,
          openHandicap: selection.openHandicap ?? null,
          openTotal: selection.openTotal ?? null,
          handicap7day: selection.handicap7day ?? null,
          total7day: selection.total7day ?? null,
          odds7dayDecimal: selection.odds7dayDecimal ?? null,
          odds7dayAmerican: selection.odds7dayAmerican ?? null,
          odds7dayFraction: selection.odds7dayFraction ?? null,
          playerName: selection.playerName || null,
        } : {})
      });
    }

    projected.push({
      id: market.id,
      type: market.type,
      label: market.label,
      period: market.period,
      line: market.line,
      suspended: market.suspended,
      mainLine: market.mainLine ?? null,
      bookmaker: market.bookmaker || null,
      sourceLabel: MEMBER_MARKET_SOURCE_LABELS[clean(market.source).toLowerCase()] || null,
      selections
    });
  }

  return projected;
}

export function selectMemberSummaryMarkets(markets = []) {
  if (!Array.isArray(markets)) return [];
  return markets.filter(market => isRecord(market)
    && SUMMARY_MARKET_PERIODS.has(clean(market.period || 'FT').toUpperCase()));
}
