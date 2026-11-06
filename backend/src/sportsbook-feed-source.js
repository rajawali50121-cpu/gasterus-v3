import { config } from './config.js';
import { SPORTSBOOK_INGEST_REDIS_KEY, verifyStoredSportsbookSnapshot } from './sportsbook-ingestion.js';

function stripRailwayAuthority(event) {
  const {
    _settlementReadySources,
    _settlementMode,
    settlementAuthority,
    settlementResult,
    settlementSource,
    riskRepricing,
    ...providerEvent
  } = event;
  return {
    ...providerEvent,
    markets: event.markets.map(market => {
      const {
        lifecycleState,
        lifecycleReason,
        reopenSuccessStreak,
        closedAt,
        suspendedByOperator,
        trading,
        riskRepricing: marketRiskRepricing,
        ...providerMarket
      } = market;
      return {
        ...providerMarket,
        selections: market.selections.map(selection => {
          const {
            priceVersion,
            settlementAuthority: selectionSettlementAuthority,
            settlementResult: selectionSettlementResult,
            riskRepricing: selectionRiskRepricing,
            ...providerSelection
          } = selection;
          return providerSelection;
        })
      };
    })
  };
}

export async function loadRenderProviderSnapshot(redisClient, {
  logger,
  now = Date.now(),
  secret = config.sportsbookIngestHmacSecret,
  maxPayloadBytes = config.sportsbookIngestMaxPayloadBytes,
  maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds
} = {}) {
  if (!redisClient?.isOpen) {
    logger?.warn('Sportsbook worker snapshot unavailable; Redis is not connected, using local provider fetch');
    return null;
  }

  let raw;
  try {
    raw = await redisClient.get(SPORTSBOOK_INGEST_REDIS_KEY);
  } catch (error) {
    logger?.warn('Sportsbook worker snapshot read failed; using local provider fetch', { error: error.message });
    return null;
  }
  if (!raw) return null;

  try {
    const verified = verifyStoredSportsbookSnapshot(raw, { secret, maxPayloadBytes, maxAgeSeconds, now });
    return {
      providerResults: verified.snapshot.providerResults.map(result => ({
        ...result,
        events: result.events.map(stripRailwayAuthority)
      })),
      generatedAt: verified.snapshot.generatedAt,
      receivedAt: verified.receivedAt,
      revision: verified.revision
    };
  } catch (error) {
    logger?.warn('Sportsbook worker snapshot rejected; using local provider fetch', {
      code: error.code || 'SPORTSBOOK_INGEST_STAGING_INVALID',
      error: error.message
    });
    return null;
  }
}

export async function resolveSportsbookProviderResults(redisClient, {
  fetchLocalProviders,
  logger,
  now = Date.now(),
  secret = config.sportsbookIngestHmacSecret,
  maxPayloadBytes = config.sportsbookIngestMaxPayloadBytes,
  maxAgeSeconds = config.sportsbookIngestMaxAgeSeconds
} = {}) {
  const renderSnapshot = await loadRenderProviderSnapshot(redisClient, {
    logger,
    now,
    secret,
    maxPayloadBytes,
    maxAgeSeconds
  });
  if (renderSnapshot) {
    return {
      source: 'render',
      renderSnapshot,
      settled: renderSnapshot.providerResults.map(result => ({
        result: { ...result, transportOk: result.transportOk !== false },
        elapsedMs: 0
      }))
    };
  }
  if (typeof fetchLocalProviders !== 'function') {
    throw new Error('Local sportsbook provider fallback is unavailable.');
  }
  return {
    source: 'local',
    renderSnapshot: null,
    settled: await fetchLocalProviders()
  };
}
