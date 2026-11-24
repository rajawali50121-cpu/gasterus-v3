import { assert } from './errors.js';

const SCOPE_TYPES = new Set(['EVENT', 'MARKET', 'SELECTION']);

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeSportsbookTradingScope(input = {}) {
  const scopeType = clean(input.scopeType, 20).toUpperCase();
  const eventId = clean(input.eventId, 120);
  const marketId = clean(input.marketId, 120) || null;
  const selectionId = clean(input.selectionId, 120) || null;
  assert(SCOPE_TYPES.has(scopeType), 400, 'Scope trading control tidak valid.', 'SPORTSBOOK_TRADING_SCOPE_INVALID');
  assert(eventId, 400, 'Event ID wajib diisi.', 'SPORTSBOOK_TRADING_EVENT_REQUIRED');
  if (scopeType === 'EVENT') assert(!marketId && !selectionId, 400, 'Event control tidak boleh membawa market/selection ID.', 'SPORTSBOOK_TRADING_SCOPE_INVALID');
  if (scopeType === 'MARKET') assert(marketId && !selectionId, 400, 'Market control membutuhkan market ID tanpa selection ID.', 'SPORTSBOOK_TRADING_SCOPE_INVALID');
  if (scopeType === 'SELECTION') assert(marketId && selectionId, 400, 'Selection control membutuhkan market dan selection ID.', 'SPORTSBOOK_TRADING_SCOPE_INVALID');
  return { scopeType, eventId, marketId, selectionId };
}

export function sportsbookTradingScopeKey(input) {
  const { scopeType, eventId, marketId, selectionId } = normalizeSportsbookTradingScope(input);
  return scopeType === 'EVENT'
    ? `EVENT:${eventId}`
    : scopeType === 'MARKET'
      ? `MARKET:${eventId}:${marketId}`
      : `SELECTION:${eventId}:${marketId}:${selectionId}`;
}

function controlPublicState(control) {
  if (!control) return null;
  return {
    id: control.id,
    scopeKey: control.scopeKey,
    scopeType: control.scopeType,
    eventId: control.eventId,
    marketId: control.marketId || null,
    selectionId: control.selectionId || null,
    suspended: Boolean(control.suspended),
    maxStake: control.maxStake ?? null,
    maxLiability: control.maxLiability ?? null,
    reason: control.reason || null,
    expiresAt: control.expiresAt || null,
    version: Number(control.version || 1),
    updatedAt: control.updatedAt || null
  };
}

export function tradingPolicyFromControls(controls = [], identity = {}) {
  const { eventId, marketId = null, selectionId = null } = identity;
  const matches = controls.filter(control => control.eventId === eventId && (
    control.scopeType === 'EVENT' ||
    (control.scopeType === 'MARKET' && control.marketId === marketId) ||
    (control.scopeType === 'SELECTION' && control.marketId === marketId && control.selectionId === selectionId)
  ));
  const eventControl = matches.find(control => control.scopeType === 'EVENT') || null;
  const marketControl = matches.find(control => control.scopeType === 'MARKET') || null;
  const selectionControl = matches.find(control => control.scopeType === 'SELECTION') || null;
  const stakeLimits = matches.map(control => control.maxStake).filter(value => Number.isSafeInteger(value) && value > 0);
  const versionToken = matches.length
    ? matches.map(control => `${control.scopeKey}@${control.version}`).sort().join('|')
    : null;
  return {
    suspended: matches.some(control => control.suspended),
    maxStake: stakeLimits.length ? Math.min(...stakeLimits) : null,
    eventMaxLiability: eventControl?.maxLiability ?? null,
    marketMaxLiability: marketControl?.maxLiability ?? null,
    selectionMaxLiability: selectionControl?.maxLiability ?? null,
    controls: matches.map(controlPublicState),
    versionToken
  };
}

export function applySportsbookTradingControls(events = [], controls = []) {
  return events.map(event => {
    const eventPolicy = tradingPolicyFromControls(controls, { eventId: event.id });
    const nextEvent = { ...event, trading: { suspendedByOperator: eventPolicy.suspended, maxStake: eventPolicy.maxStake, versionToken: eventPolicy.versionToken } };
    nextEvent.markets = (event.markets || []).map(market => {
      const marketPolicy = tradingPolicyFromControls(controls, { eventId: event.id, marketId: market.id });
      const marketSuspended = Boolean(market.suspended || marketPolicy.suspended);
      return {
        ...market,
        suspended: marketSuspended,
        trading: { suspendedByOperator: marketPolicy.suspended, maxStake: marketPolicy.maxStake, versionToken: marketPolicy.versionToken },
        selections: (market.selections || []).map(selection => {
          const selectionPolicy = tradingPolicyFromControls(controls, { eventId: event.id, marketId: market.id, selectionId: selection.key });
          return {
            ...selection,
            suspended: Boolean(selection.suspended || marketSuspended || selectionPolicy.suspended),
            trading: { suspendedByOperator: selectionPolicy.suspended, maxStake: selectionPolicy.maxStake, versionToken: selectionPolicy.versionToken }
          };
        })
      };
    });
    return nextEvent;
  });
}

export const __sportsbookTradingPolicy = {
  normalizeSportsbookTradingScope,
  tradingPolicyFromControls,
  applySportsbookTradingControls
};
