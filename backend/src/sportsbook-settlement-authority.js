function cleanSource(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function eventSettlementAuthority(event) {
  const readySources = Array.isArray(event?._settlementReadySources)
    ? event._settlementReadySources
    : (Array.isArray(event?._sources) ? event._sources : []);
  const sources = [...new Set(readySources.map(cleanSource).filter(Boolean))];
  // Odds Comparison supplies prices, not official results. Manual operator
  // settlement is retained only for already-accepted historical tickets and
  // must never authorize new markets or bets.
  return {
    ft: false,
    ht: false,
    automaticFt: false,
    manualFt: false,
    mode: 'NONE',
    sources: sources.filter(source => source !== 'manual-ops')
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
