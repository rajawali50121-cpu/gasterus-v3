import { config } from './config.js';

function wibParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0)
  };
}

// Full schedule snapshots are used because Sportradar's Change Log is a rolling five-minute window.
// Budget the trial quota over a ten-day operating window, reserving 50 calls for unexpected/manual usage.
export const SPORTRADAR_OPERATION_WINDOW_DAYS = 10;
export const SPORTRADAR_QUOTA_RESERVE_CALLS = 50;
export const SPORTRADAR_DEFAULT_REQUESTS_PER_CYCLE = 10;

export function assertSportradarQuotaCapacity(settings, requestsPerCycle = SPORTRADAR_DEFAULT_REQUESTS_PER_CYCLE) {
  const monthlyLimit = Number(settings?.sportradarMaxCallsPer30Days || 0);
  const initialUsage = Number(settings?.sportradarInitial30DayUsage || 0);
  const callsPerCycle = Math.max(1, Math.ceil(Number(requestsPerCycle) || 1));
  const availableMonthlyCalls = monthlyLimit - initialUsage - SPORTRADAR_QUOTA_RESERVE_CALLS;
  if (!Number.isSafeInteger(monthlyLimit) || !Number.isSafeInteger(initialUsage) ||
      initialUsage < 0 || initialUsage > monthlyLimit ||
      availableMonthlyCalls < callsPerCycle) {
    throw new Error(
      `Sportradar quota is insufficient: need at least ${callsPerCycle + SPORTRADAR_QUOTA_RESERVE_CALLS} remaining calls including the 50-call safety reserve; available after current rolling usage is ${Math.max(0, monthlyLimit - initialUsage)} of ${Number.isFinite(monthlyLimit) ? monthlyLimit : 0}.`
    );
  }
  return true;
}

export function sportsbookRenderIntervalSeconds(settings, requestsPerCycle = SPORTRADAR_DEFAULT_REQUESTS_PER_CYCLE) {
  const monthlyLimit = Number(settings?.sportradarMaxCallsPer30Days || 0);
  const initialUsage = Number(settings?.sportradarInitial30DayUsage || 0);
  const safeBudget = Math.max(0, monthlyLimit - initialUsage - SPORTRADAR_QUOTA_RESERVE_CALLS);
  const callsPerCycle = Math.max(1, Math.ceil(Number(requestsPerCycle) || 1));
  if (!Number.isSafeInteger(monthlyLimit) || !Number.isSafeInteger(initialUsage) || safeBudget < callsPerCycle) {
    throw new Error('Sportradar ten-day polling budget is unavailable after applying current usage and the 50-call reserve.');
  }
  const windowSeconds = SPORTRADAR_OPERATION_WINDOW_DAYS * 24 * 60 * 60;
  const budgetInterval = Math.ceil((windowSeconds * callsPerCycle) / safeBudget);
  const hourlyLimit = Number(settings?.sportradarSharedMaxCallsPerHour || 0);
  const hourlyInterval = hourlyLimit > 0 ? Math.ceil((3600 * callsPerCycle) / hourlyLimit) : 0;
  return Math.max(60, budgetInterval, hourlyInterval);
}

export function combineSportsbookProviderResults(providerResults, { maxEvents = 0 } = {}) {
  if (!Array.isArray(providerResults) || providerResults.length !== 1) {
    throw new Error('Sportradar must be the only sportsbook provider in a worker snapshot.');
  }
  if (maxEvents !== 0 && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
    throw new Error('Worker sportsbook maxEvents must be a positive integer or 0 (unlimited).');
  }
  const result = providerResults[0];
  if (result?.provider !== 'sportradar' || result.enabled !== true || !Array.isArray(result.events)) {
    throw new Error('Worker snapshot contains an invalid or non-Sportradar provider result.');
  }
  const events = maxEvents > 0 ? result.events.slice(0, maxEvents) : result.events;
  return {
    providerResults: [{ ...result, events }],
    eventCount: events.length,
    truncatedEventCount: result.events.length - events.length
  };
}

function sportradarEventValidationIssues(event) {
  const issues = [];
  if (!event || typeof event !== 'object') return ['event:not-object'];
  if (typeof event.id !== 'string' || !event.id.trim()) issues.push('id:missing');
  if (typeof event.sport !== 'string' || !event.sport.trim()) issues.push('sport:missing');
  if (event.league !== null && typeof event.league !== 'string') issues.push('league:invalid-type');
  if (event.country !== null && (typeof event.country !== 'string' || !event.country.trim())) issues.push('country:invalid');
  if (typeof event.startTime !== 'string' || !Number.isFinite(Date.parse(event.startTime))) issues.push('startTime:invalid');
  if (!['SCHEDULED', 'LIVE', 'FINISHED', 'SUSPENDED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID', 'UNKNOWN'].includes(event.status)) issues.push('status:unsupported');
  if (typeof event.live !== 'boolean') issues.push('live:invalid-type');
  if (!event.home || typeof event.home.name !== 'string' || !event.home.name.trim()) issues.push('home.name:missing');
  if (!event.away || typeof event.away.name !== 'string' || !event.away.name.trim()) issues.push('away.name:missing');
  if (!Array.isArray(event.markets)) issues.push('markets:not-array');
  if (event._refs?.sportradar === undefined || !String(event._refs.sportradar).trim()) issues.push('_refs.sportradar:missing');
  if (!Array.isArray(event._sources) || event._sources.length !== 1 || event._sources[0] !== 'sportradar') issues.push('_sources:invalid');
  if (Array.isArray(event.markets)) {
    for (let i = 0; i < event.markets.length; i += 1) {
      const market = event.markets[i];
      if (!market || typeof market.id !== 'string' || !market.id.trim()) { issues.push(`markets[${i}].id:missing`); continue; }
      if (typeof market.type !== 'string' || !market.type.trim()) issues.push(`markets[${i}].type:missing`);
      if (typeof market.period !== 'string' || !market.period.trim()) issues.push(`markets[${i}].period:missing`);
      if (market.source !== 'sportradar' || typeof market.suspended !== 'boolean') issues.push(`markets[${i}].metadata:invalid`);
      if (!Array.isArray(market.selections)) { issues.push(`markets[${i}].selections:not-array`); continue; }
      for (let j = 0; j < market.selections.length; j += 1) {
        const selection = market.selections[j];
        if (!selection || typeof selection.key !== 'string' || !selection.key.trim()) { issues.push(`markets[${i}].selections[${j}].key:missing`); continue; }
        if (typeof selection.label !== 'string' || !selection.label.trim()) issues.push(`markets[${i}].selections[${j}].label:missing`);
        if (!(selection.odds === null || selection.odds === undefined || Number.isFinite(selection.odds))) issues.push(`markets[${i}].selections[${j}].odds:invalid`);
        if (typeof selection.suspended !== 'boolean' || selection.source !== 'sportradar') issues.push(`markets[${i}].selections[${j}].metadata:invalid`);
      }
    }
  }
  return issues;
}

export async function buildSportsbookRenderSnapshot({
  fetchSportradar,
  maxEvents = 0,
  maxPages = 0,
  now
}) {
  if (typeof fetchSportradar !== 'function') {
    throw new Error('Sportradar fetcher is required by the sportsbook render worker.');
  }
  if (!Number.isInteger(maxPages) || maxPages < 0) {
    throw new Error('Worker sportsbook maxPages must be a non-negative integer.');
  }
  if (maxEvents !== 0 && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
    throw new Error('Worker sportsbook maxEvents must be a positive integer or 0 (unlimited).');
  }

  const result = await fetchSportradar({ maxEvents: 0, maxPages: 0 });
  if (!result || result.provider !== 'sportradar' || result.enabled !== true || !Array.isArray(result.events)) {
    throw new Error('Sportradar returned an invalid provider result; snapshot was not sent.');
  }
  if (result.transportOk === false || (Array.isArray(result.errors) && result.errors.length)) {
    throw new Error('Sportradar returned an incomplete result; partial snapshot rejected: ' + (result.errors || []).join('; '));
  }

  const combined = combineSportsbookProviderResults([result], { maxEvents });
  const rejectedEvents = [];
  const providerResults = combined.providerResults.map(providerResult => {
    const validEvents = [];
    for (const event of providerResult.events) {
      const issues = sportradarEventValidationIssues(event);
      if (issues.length) {
        rejectedEvents.push({ id: event?.id || null, issues });
        continue;
      }
      validEvents.push({
        ...event,
        _sources: ['sportradar'],
        _refs: { sportradar: event._refs.sportradar }
      });
    }
    if (providerResult.events.length > 0 && validEvents.length === 0) {
      throw new Error('Sportradar snapshot rejected: every event failed normalization validation. ' +
        JSON.stringify({ rejectedEventCount: rejectedEvents.length, sample: rejectedEvents.slice(0, 5) }));
    }
    return { ...providerResult, events: validEvents };
  });
  const acceptedEventCount = providerResults.reduce((total, item) => total + item.events.length, 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults,
    eventCount: acceptedEventCount,
    ...((combined.truncatedEventCount > 0 || rejectedEvents.length > 0) ? {
      diagnostics: {
        ...(combined.truncatedEventCount > 0 ? {
          eventLimit: {
            dataTruncated: true,
            omittedUniqueEvents: combined.truncatedEventCount
          }
        } : {}),
        ...(rejectedEvents.length > 0 ? {
          eventValidation: {
            rejectedEventCount: rejectedEvents.length,
            acceptedEventCount,
            samples: rejectedEvents.slice(0, 10)
          }
        } : {})
      }
    } : {})
  };
}
