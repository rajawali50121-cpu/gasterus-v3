function cleanSource(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function eventSettlementAuthority(event) {
  const readySources = Array.isArray(event?._settlementReadySources)
    ? event._settlementReadySources
    : (Array.isArray(event?._sources) ? event._sources : []);
  const sources = [...new Set(readySources.map(cleanSource).filter(Boolean))];
  // Sportradar Odds Comparison is an odds feed, not an independent results authority.
  // FT settlement remains operator-authorized; HT settlement remains unavailable.
  const automaticFt = false;
  const manualFt = sources.includes('manual-ops');
  return {
    ft: automaticFt || manualFt,
    ht: false,
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
