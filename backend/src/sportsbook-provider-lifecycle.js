export const PROVIDER_LIFECYCLE_STATES = Object.freeze({
  DISABLED: 'DISABLED',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  OPEN: 'OPEN_CIRCUIT',
  RECOVERING: 'RECOVERING'
});

function integer(value, fallback, min = 1, max = 1000) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizedPrevious(previous = {}, code = '') {
  previous = previous || {};
  return {
    code: String(previous.code || code || ''),
    state: Object.values(PROVIDER_LIFECYCLE_STATES).includes(previous.state) ? previous.state : PROVIDER_LIFECYCLE_STATES.DISABLED,
    failureStreak: integer(previous.failureStreak, 0, 0, 1000000),
    successStreak: integer(previous.successStreak, 0, 0, 1000000),
    nextProbeAt: Number.isFinite(Number(previous.nextProbeAt)) ? Number(previous.nextProbeAt) : 0,
    lastAttemptAt: Number.isFinite(Number(previous.lastAttemptAt)) ? Number(previous.lastAttemptAt) : 0,
    lastSuccessAt: Number.isFinite(Number(previous.lastSuccessAt)) ? Number(previous.lastSuccessAt) : 0,
    lastFailureAt: Number.isFinite(Number(previous.lastFailureAt)) ? Number(previous.lastFailureAt) : 0,
    lastStateChangeAt: Number.isFinite(Number(previous.lastStateChangeAt)) ? Number(previous.lastStateChangeAt) : 0,
    transportHealthy: Boolean(previous.transportHealthy),
    pricingReady: Boolean(previous.pricingReady),
    bettingAllowed: Boolean(previous.bettingAllowed),
    lastError: previous.lastError ? String(previous.lastError).slice(0, 500) : null
  };
}

export function shouldProbeProvider(previous, now = Date.now()) {
  const state = normalizedPrevious(previous, previous?.code);
  if (state.state !== PROVIDER_LIFECYCLE_STATES.OPEN) return true;
  return !state.nextProbeAt || Number(now) >= state.nextProbeAt;
}

export function advanceProviderLifecycle(previous, sample, options = {}, now = Date.now()) {
  const failureThreshold = integer(options.failureThreshold, 3, 1, 20);
  const recoverySuccesses = integer(options.recoverySuccesses, 2, 1, 20);
  const cooldownSeconds = integer(options.cooldownSeconds, 30, 1, 3600);
  const current = normalizedPrevious(previous, sample?.code);
  const timestamp = Number(now);
  const enabled = Boolean(sample?.enabled);

  if (!enabled) {
    const next = {
      ...current,
      code: String(sample?.code || current.code),
      state: PROVIDER_LIFECYCLE_STATES.DISABLED,
      failureStreak: 0,
      successStreak: 0,
      nextProbeAt: 0,
      lastAttemptAt: timestamp,
      transportHealthy: false,
      pricingReady: false,
      bettingAllowed: false,
      lastError: null
    };
    if (current.state !== next.state || current.bettingAllowed !== next.bettingAllowed) next.lastStateChangeAt = timestamp;
    return next;
  }

  if (sample?.skipped && current.state === PROVIDER_LIFECYCLE_STATES.OPEN) {
    return {
      ...current,
      code: String(sample?.code || current.code),
      lastAttemptAt: timestamp,
      transportHealthy: false,
      pricingReady: false,
      bettingAllowed: false
    };
  }

  const transportHealthy = Boolean(sample?.transportHealthy);
  const pricingReady = Boolean(sample?.pricingReady);
  let state = current.state;
  let failureStreak = current.failureStreak;
  let successStreak = current.successStreak;
  let nextProbeAt = current.nextProbeAt;
  let lastSuccessAt = current.lastSuccessAt;
  let lastFailureAt = current.lastFailureAt;
  let lastError = sample?.error ? String(sample.error).slice(0, 500) : null;

  if (transportHealthy) {
    failureStreak = 0;
    lastSuccessAt = timestamp;
    nextProbeAt = 0;
    if ([PROVIDER_LIFECYCLE_STATES.DEGRADED, PROVIDER_LIFECYCLE_STATES.OPEN, PROVIDER_LIFECYCLE_STATES.RECOVERING].includes(current.state)) {
      successStreak = current.successStreak + 1;
      state = successStreak >= recoverySuccesses ? PROVIDER_LIFECYCLE_STATES.HEALTHY : PROVIDER_LIFECYCLE_STATES.RECOVERING;
    } else {
      successStreak = Math.max(1, current.successStreak + 1);
      state = PROVIDER_LIFECYCLE_STATES.HEALTHY;
    }
    lastError = null;
  } else {
    successStreak = 0;
    failureStreak = current.failureStreak + 1;
    lastFailureAt = timestamp;
    if (failureStreak >= failureThreshold) {
      state = PROVIDER_LIFECYCLE_STATES.OPEN;
      nextProbeAt = timestamp + cooldownSeconds * 1000;
    } else {
      state = PROVIDER_LIFECYCLE_STATES.DEGRADED;
      nextProbeAt = 0;
    }
  }

  const bettingAllowed = state === PROVIDER_LIFECYCLE_STATES.HEALTHY && pricingReady;
  const next = {
    ...current,
    code: String(sample?.code || current.code),
    state,
    failureStreak,
    successStreak,
    nextProbeAt,
    lastAttemptAt: timestamp,
    lastSuccessAt,
    lastFailureAt,
    transportHealthy,
    pricingReady,
    bettingAllowed,
    lastError
  };
  if (current.state !== next.state || current.bettingAllowed !== next.bettingAllowed) next.lastStateChangeAt = timestamp;
  return next;
}

export function transitionProviderLifecycle(previous, sample, options = {}, now = Date.now()) {
  const before = normalizedPrevious(previous, sample?.code);
  const next = advanceProviderLifecycle(before, sample, options, now);
  const stateChanged = before.state !== next.state;
  const bettingChanged = before.bettingAllowed !== next.bettingAllowed;
  return {
    next,
    changed: stateChanged || bettingChanged,
    transition: stateChanged || bettingChanged ? {
      providerCode: next.code,
      previousState: before.state,
      state: next.state,
      previousBettingAllowed: before.bettingAllowed,
      bettingAllowed: next.bettingAllowed,
      failureStreak: next.failureStreak,
      successStreak: next.successStreak,
      transportHealthy: next.transportHealthy,
      pricingReady: next.pricingReady,
      nextProbeAt: next.nextProbeAt || null,
      lastError: next.lastError || null,
      occurredAt: Number(now)
    } : null
  };
}

export function publicProviderLifecycle(value = {}) {
  const state = normalizedPrevious(value, value.code);
  const iso = timestamp => timestamp ? new Date(timestamp).toISOString() : null;
  return {
    code: state.code,
    state: state.state,
    failureStreak: state.failureStreak,
    successStreak: state.successStreak,
    transportHealthy: state.transportHealthy,
    pricingReady: state.pricingReady,
    bettingAllowed: state.bettingAllowed,
    nextProbeAt: iso(state.nextProbeAt),
    lastAttemptAt: iso(state.lastAttemptAt),
    lastSuccessAt: iso(state.lastSuccessAt),
    lastFailureAt: iso(state.lastFailureAt),
    lastStateChangeAt: iso(state.lastStateChangeAt),
    lastError: state.lastError
  };
}
