import { config } from './config.js';
import { eventSettlementAuthority } from './sportsbook-settlement-authority.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value) {
  return clean(value).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function teamKey(value) {
  return slug(value)
    .replace(/\b(fc|cf|sc|afc|club|the)\b/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function leagueKey(value) {
  const key = slug(value);
  const aliases = {
    epl: 'premier-league',
    'english-premier-league': 'premier-league',
    laliga: 'la-liga',
    'spanish-la-liga': 'la-liga',
    'italian-serie-a': 'serie-a',
    'german-bundesliga': 'bundesliga',
    'french-ligue-1': 'ligue-1',
    'ligue-one': 'ligue-1',
    ucl: 'champions-league',
    'uefa-champions-league': 'champions-league'
  };
  return aliases[key] || key;
}

function marketBettingAvailable(market) {
  return Boolean(market && !market.suspended
    && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1));
}

export function suspendStaleLiveMarkets(events = [], now = Date.now()) {
  const maxAgeMs = Number(config.sportsbookMaxLivePriceAgeSeconds || 0) * 1000;
  return events.map(event => {
    const status = String(event?.status || '').toUpperCase();
    const live = Boolean(event?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status);
    if (!live) return event;
    let changed = false;
    const markets = (event.markets || []).map(market => {
      const updatedMs = Date.parse(market?.updatedAt || '');
      if (Number.isFinite(updatedMs) && now - updatedMs <= maxAgeMs) return market;
      changed = true;
      return {
        ...market,
        suspended: true,
        selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
      };
    });
    return changed ? { ...event, markets } : event;
  });
}

function applyManualFtSettlementFallback(event, {
  enabled = config.sportsbookManualFtSettlementFallbackEnabled
} = {}) {
  if (!enabled || !event || event.live || event.status !== 'SCHEDULED') return event;
  const sources = new Set(Array.isArray(event._sources) ? event._sources : []);
  const readySources = new Set(Array.isArray(event._settlementReadySources) ? event._settlementReadySources : []);
  if (!sources.has('sportradar') || !readySources.has('sportradar')) return event;
  const hasHealthyPrematchFt = (event.markets || []).some(market =>
    (market.period || 'FT') === 'FT'
    && market.source === 'sportradar'
    && !market.suspended
    && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1)
  );
  if (!hasHealthyPrematchFt) return event;
  event._settlementReadySources = [...new Set([...readySources, 'manual-ops'])];
  event._settlementMode = 'MANUAL_FT_FALLBACK';
  return event;
}

function applySettlementSafety(event) {
  const authority = eventSettlementAuthority(event);
  event.markets = (event.markets || []).map(market => {
    const mustSuspend = (market.period || 'FT') === '1H' ? !authority.ht : !authority.ft;
    if (!mustSuspend) return market;
    return {
      ...market,
      suspended: true,
      selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
    };
  });
  return event;
}

export function mergeProviderEvents(providerResults, options = {}) {
  const results = (providerResults || []).filter(result => result?.enabled === true);
  if (results.some(result => result.provider !== 'sportradar')) {
    throw new Error('Non-Sportradar sportsbook provider result rejected.');
  }
  const eventsById = new Map();
  for (const result of results) {
    for (const incoming of Array.isArray(result.events) ? result.events : []) {
      const current = eventsById.get(incoming.id);
      if (!current) {
        eventsById.set(incoming.id, structuredClone(incoming));
        continue;
      }
      const marketById = new Map((current.markets || []).map(market => [market.id, market]));
      for (const market of incoming.markets || []) {
        const existing = marketById.get(market.id);
        if (!existing || marketBettingAvailable(market) || !marketBettingAvailable(existing)) {
          marketById.set(market.id, market);
        }
      }
      current.markets = [...marketById.values()];
      current._refs = { ...(current._refs || {}), ...(incoming._refs || {}) };
      current._sources = ['sportradar'];
      current._settlementReadySources = [...new Set([
        ...(current._settlementReadySources || []),
        ...(incoming._settlementReadySources || [])
      ])];
      current.home.score = incoming.home?.score ?? current.home.score;
      current.away.score = incoming.away?.score ?? current.away.score;
      current.status = incoming.status || current.status;
      current.live = incoming.live ?? current.live;
      current.providerStatus = incoming.providerStatus || current.providerStatus || null;
    }
  }
  return [...eventsById.values()].map(event =>
    applySettlementSafety(applyManualFtSettlementFallback(event, options))
  );
}

export function publicEvent(event) {
  return {
    id: event.id,
    sport: event.sport,
    league: event.league,
    country: event.country,
    startTime: event.startTime,
    status: event.status,
    providerStatus: event.providerStatus || null,
    live: event.live,
    clock: event.clock,
    home: { name: event.home.name, score: event.home.score, logo: event.home.logo || null },
    away: { name: event.away.name, score: event.away.score, logo: event.away.logo || null },
    leagueLogo: event.leagueLogo || null,
    venue: event.venue,
    periodScores: event.periodScores || {},
    statistics: Array.isArray(event.statistics) ? event.statistics : [],
    events: Array.isArray(event.events) ? event.events : [],
    ...(event._sources?.includes('sportradar') ? {
      sportId: event.sportId || null,
      replacedBy: event.replacedBy || null,
      startTimeConfirmed: event.startTimeConfirmed ?? null,
      resumeTime: event.resumeTime || null,
      sourceData: event.sourceData || null
    } : {}),
    availableMarketCount: Number(event.availableMarketCount || event.markets?.length || 0),
    detailLoaded: Boolean(event.detailFetchedAt),
    detailFetchedAt: event.detailFetchedAt || null,
    markets: (event.markets || []).map(market => ({
      id: market.id,
      key: market.key,
      type: market.type,
      label: market.label,
      period: market.period,
      line: market.line,
      suspended: market.suspended,
      updatedAt: market.updatedAt,
      source: market.source || null,
      sourceMarketId: market.sourceMarketId || null,
      bookmaker: market.bookmaker || null,
      mainLine: market.mainLine ?? null,
      ...(market.source === 'sportradar' ? {
        sourceMarketName: market.sourceMarketName || null,
        sourceBookId: market.sourceBookId || null,
        externalMarketId: market.externalMarketId || null,
        externalSportEventId: market.externalSportEventId || null,
        removed: market.removed === true,
        isLive: market.isLive === true,
        sourceData: market.sourceData || null
      } : {}),
      lifecycleState: market.lifecycleState || null,
      lifecycleReason: market.lifecycleReason || null,
      reopenSuccessStreak: Number(market.reopenSuccessStreak || 0),
      selections: (market.selections || []).map(selection => ({
        key: selection.key,
        label: selection.label,
        odds: selection.odds,
        line: selection.line,
        suspended: selection.suspended,
        source: selection.source || market.source || null,
        sourceSelectionId: selection.sourceSelectionId || null,
        updatedAt: selection.updatedAt || market.updatedAt || null,
        priceVersion: selection.priceVersion || null,
        ...(selection.source === 'sportradar' ? {
          removed: selection.removed === true,
          outcomeType: selection.outcomeType || null,
          fieldId: selection.fieldId || null,
          externalOutcomeId: selection.externalOutcomeId || null,
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
          playerId: selection.playerId || null,
          playerName: selection.playerName || null,
          sourceData: selection.sourceData || null
        } : {})
      }))
    }))
  };
}

export const __sportsbookProviders = {
  mergeProviderEvents,
  applyManualFtSettlementFallback,
  marketBettingAvailable
};
