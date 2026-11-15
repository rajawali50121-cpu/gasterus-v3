import { createHash } from 'node:crypto';
import { config } from './config.js';

export const MARKET_LIFECYCLE_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REOPENING: 'REOPENING',
  CLOSED: 'CLOSED'
});

function integer(value, fallback, min = 0, max = 1000000) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizedPrevious(previous = {}, key = '') {
  previous = previous || {};
  const state = Object.values(MARKET_LIFECYCLE_STATES).includes(previous.state)
    ? previous.state
    : MARKET_LIFECYCLE_STATES.SUSPENDED;
  return {
    key: String(previous.key || key || ''),
    eventId: String(previous.eventId || ''),
    marketId: String(previous.marketId || ''),
    state,
    reopenSuccessStreak: integer(previous.reopenSuccessStreak, 0),
    lastSeenAt: Number.isFinite(Number(previous.lastSeenAt)) ? Number(previous.lastSeenAt) : 0,
    lastStateChangeAt: Number.isFinite(Number(previous.lastStateChangeAt)) ? Number(previous.lastStateChangeAt) : 0,
    reason: previous.reason ? String(previous.reason).slice(0, 160) : null,
    source: previous.source ? String(previous.source).slice(0, 80) : null,
    lastObservationToken: previous.lastObservationToken ? String(previous.lastObservationToken).slice(0, 64) : null,
    lastReopenObservationAt: Number.isFinite(Number(previous.lastReopenObservationAt)) ? Number(previous.lastReopenObservationAt) : 0
  };
}

function eventClosed(event) {
  const status = String(event?.status || '').toUpperCase();
  const providerStatus = String(event?.providerStatus || '').toUpperCase();
  return status === 'FINISHED' || /^(FT|AET|PEN|CANC)$/.test(providerStatus);
}


function marketObservationToken(market) {
  const selections = [...(market?.selections || [])]
    .sort((a, b) => String(a?.key || '').localeCompare(String(b?.key || '')))
    .map(selection => [
      selection?.key || '', selection?.priceVersion || '', selection?.updatedAt || '',
      selection?.odds ?? '', selection?.line ?? '', selection?.suspended ? 1 : 0
    ].join('|'));
  return createHash('sha256').update([
    market?.id || '', market?.source || '', market?.updatedAt || '', market?.suspended ? 1 : 0,
    ...selections
  ].join('||')).digest('hex').slice(0, 32);
}

function marketProviderActive(market) {
  if (!market || market.suspended) return false;
  return (market.selections || []).some(selection =>
    !selection.suspended && Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1
  );
}

export function sportsbookMarketLifecycleKey(eventId, marketId) {
  return `MARKET:${String(eventId || '')}:${String(marketId || '')}`;
}

function transitionRecord(before, next, action, reason, now) {
  return {
    key: next.key,
    eventId: next.eventId,
    marketId: next.marketId,
    previousState: before?.state || null,
    state: next.state,
    action,
    reason,
    source: next.source || null,
    reopenSuccessStreak: next.reopenSuccessStreak,
    lastObservationToken: next.lastObservationToken || null,
    lastReopenObservationAt: Number(next.lastReopenObservationAt || 0),
    occurredAt: Number(now)
  };
}

function resolveObservedMarket(previous, event, market, { reopenSuccesses, reopenObservationSeconds, now }) {
  const key = sportsbookMarketLifecycleKey(event.id, market.id);
  const before = previous ? normalizedPrevious(previous, key) : null;
  const observationGapMs = Math.max(1, reopenObservationSeconds) * 1000;
  const source = market.source || market.selections?.find(selection => selection.source)?.source || null;
  const observationToken = marketObservationToken(market);
  const base = {
    key,
    eventId: String(event.id),
    marketId: String(market.id),
    source: source ? String(source).slice(0, 80) : null,
    lastSeenAt: Number(now),
    lastObservationToken: observationToken
  };

  if (eventClosed(event)) {
    const next = {
      ...base,
      state: MARKET_LIFECYCLE_STATES.CLOSED,
      reopenSuccessStreak: 0,
      lastStateChangeAt: before?.state === MARKET_LIFECYCLE_STATES.CLOSED ? before.lastStateChangeAt : Number(now),
      reason: 'EVENT_CLOSED',
      lastReopenObservationAt: before?.lastReopenObservationAt || 0
    };
    const transition = before?.state !== next.state ? transitionRecord(before, next, 'CLOSE', next.reason, now) : null;
    return { next, transition };
  }

  const providerActive = marketProviderActive(market);
  if (!providerActive) {
    const reason = market?.suspended ? 'UPSTREAM_SUSPENDED' : 'NO_ACTIVE_SELECTIONS';
    const next = {
      ...base,
      state: MARKET_LIFECYCLE_STATES.SUSPENDED,
      reopenSuccessStreak: 0,
      lastStateChangeAt: before?.state === MARKET_LIFECYCLE_STATES.SUSPENDED ? before.lastStateChangeAt : Number(now),
      reason,
      lastReopenObservationAt: before?.lastReopenObservationAt || 0
    };
    const transition = before && before.state !== MARKET_LIFECYCLE_STATES.SUSPENDED
      ? transitionRecord(before, next, 'BET_STOP', reason, now)
      : null;
    return { next, transition };
  }

  if (!before) {
    return {
      next: {
        ...base,
        state: MARKET_LIFECYCLE_STATES.ACTIVE,
        reopenSuccessStreak: reopenSuccesses,
        lastStateChangeAt: Number(now),
        reason: 'INITIAL_ACTIVE',
        lastReopenObservationAt: Number(now)
      },
      transition: null
    };
  }

  if (before.state === MARKET_LIFECYCLE_STATES.ACTIVE) {
    return {
      next: { ...base, state: MARKET_LIFECYCLE_STATES.ACTIVE, reopenSuccessStreak: reopenSuccesses, lastStateChangeAt: before.lastStateChangeAt, reason: 'UPSTREAM_ACTIVE', lastReopenObservationAt: before.lastReopenObservationAt || Number(now) },
      transition: null
    };
  }

  const tokenChanged = Boolean(observationToken && observationToken !== before.lastObservationToken);
  const observationDue = !before.lastReopenObservationAt || Number(now) - before.lastReopenObservationAt >= observationGapMs;
  const confirmedObservation = tokenChanged || observationDue;
  const successStreak = confirmedObservation
    ? Math.min(reopenSuccesses, before.reopenSuccessStreak + 1)
    : before.reopenSuccessStreak;
  const lastReopenObservationAt = confirmedObservation ? Number(now) : before.lastReopenObservationAt;
  if (successStreak >= reopenSuccesses) {
    const next = {
      ...base,
      state: MARKET_LIFECYCLE_STATES.ACTIVE,
      reopenSuccessStreak: successStreak,
      lastStateChangeAt: Number(now),
      reason: 'REOPEN_CONFIRMED',
      lastReopenObservationAt
    };
    return { next, transition: transitionRecord(before, next, 'REOPEN', next.reason, now) };
  }

  const next = {
    ...base,
    state: MARKET_LIFECYCLE_STATES.REOPENING,
    reopenSuccessStreak: successStreak,
    lastStateChangeAt: before.state === MARKET_LIFECYCLE_STATES.REOPENING ? before.lastStateChangeAt : Number(now),
    reason: confirmedObservation ? 'REOPEN_CONFIRMATION_REQUIRED' : 'WAITING_FRESH_PROVIDER_OBSERVATION',
    lastReopenObservationAt
  };
  const transition = before.state !== MARKET_LIFECYCLE_STATES.REOPENING
    ? transitionRecord(before, next, 'REOPENING', next.reason, now)
    : null;
  return { next, transition };
}

function overlayMarketLifecycle(market, lifecycle) {
  const blocked = lifecycle.state !== MARKET_LIFECYCLE_STATES.ACTIVE;
  return {
    ...market,
    lifecycleState: lifecycle.state,
    lifecycleReason: lifecycle.reason,
    reopenSuccessStreak: lifecycle.reopenSuccessStreak,
    suspended: Boolean(market.suspended || blocked),
    selections: (market.selections || []).map(selection => ({
      ...selection,
      suspended: Boolean(selection.suspended || market.suspended || blocked)
    }))
  };
}

export function reconcileSportsbookMarketLifecycle(previousState = {}, events = [], options = {}) {
  const now = Number(options.now ?? Date.now());
  const reopenSuccesses = integer(options.reopenSuccesses, 2, 1, 20);
  const reopenObservationSeconds = integer(options.reopenObservationSeconds, 30, 1, 3600);
  const retentionSeconds = integer(options.retentionSeconds, 86400, 300, 604800);
  const retentionMs = retentionSeconds * 1000;
  const nextState = {};
  const transitions = [];
  const observedKeys = new Set();

  const outputEvents = (events || []).map(event => ({
    ...event,
    markets: (event.markets || []).map(market => {
      if (config.sportmonksPassthrough && market.source === 'sportmonks') return market;
      const key = sportsbookMarketLifecycleKey(event.id, market.id);
      observedKeys.add(key);
      const { next, transition } = resolveObservedMarket(previousState[key], event, market, { reopenSuccesses, reopenObservationSeconds, now });
      nextState[key] = next;
      if (transition) transitions.push(transition);
      return overlayMarketLifecycle(market, next);
    })
  }));

  for (const [key, raw] of Object.entries(previousState || {})) {
    if (observedKeys.has(key)) continue;
    const before = normalizedPrevious(raw, key);
    if (!before.lastSeenAt || now - before.lastSeenAt > retentionMs) continue;
    // An absent market may reflect a partial provider snapshot. It is not
    // exposed for betting while absent, so retain its state without inventing
    // a lifecycle transition. Reappearance after the observation gap must
    // pass the normal reopen confirmation before it becomes bettable again.
    nextState[key] = before;
  }

  const counts = Object.values(nextState).reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, {});

  return {
    events: outputEvents,
    state: nextState,
    transitions,
    stats: {
      active: counts.ACTIVE || 0,
      suspended: counts.SUSPENDED || 0,
      reopening: counts.REOPENING || 0,
      closed: counts.CLOSED || 0
    }
  };
}

export const __sportsbookMarketLifecycle = { eventClosed, marketProviderActive, marketObservationToken, normalizedPrevious, overlayMarketLifecycle };
