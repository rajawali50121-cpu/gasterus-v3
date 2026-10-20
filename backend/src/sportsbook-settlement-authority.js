function cleanSource(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export const SPORTSBOOK_SETTLEMENT_SOURCES = Object.freeze({
  automaticFt: Object.freeze(['api-sports', 'public-market', 'sportmonks']),
  manualFt: Object.freeze(['manual-ops']),
  ht: Object.freeze(['api-sports', 'public-market'])
});

export function eventSettlementAuthority(event) {
  const readySources = Array.isArray(event?._settlementReadySources)
    ? event._settlementReadySources
    : (Array.isArray(event?._sources) ? event._sources : []);
  const sources = [...new Set(readySources.map(cleanSource).filter(Boolean))];
  const automaticFt = SPORTSBOOK_SETTLEMENT_SOURCES.automaticFt.some(source => sources.includes(source));
  const manualFt = !automaticFt && SPORTSBOOK_SETTLEMENT_SOURCES.manualFt.some(source => sources.includes(source));
  return {
    ft: automaticFt || manualFt,
    ht: SPORTSBOOK_SETTLEMENT_SOURCES.ht.some(source => sources.includes(source)),
    automaticFt,
    manualFt,
    mode: automaticFt ? 'AUTOMATIC' : manualFt ? 'MANUAL_FALLBACK' : 'NONE',
    sources
  };
}

export function settlementAuthoritySummary(events = []) {
  const authorities = (events || []).map(eventSettlementAuthority);
  return {
    ftEvents: authorities.filter(authority => authority.ft).length,
    htEvents: authorities.filter(authority => authority.ht).length,
    automaticFtEvents: authorities.filter(authority => authority.automaticFt).length,
    manualFtEvents: authorities.filter(authority => authority.manualFt).length,
    modes: [...new Set(authorities.map(authority => authority.mode).filter(mode => mode !== 'NONE'))],
    sources: [...new Set(authorities.flatMap(authority => authority.sources))]
  };
}
