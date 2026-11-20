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

export function nextSportsbookDailyRefreshMs(settings, now = Date.now()) {
  const targetHour = Number(settings?.sportsbookDailyRefreshHourWib ?? 0);
  const targetMinute = Number(settings?.sportsbookDailyRefreshMinuteWib ?? 5);
  const current = wibParts(new Date(now));
  const currentMinutes = current.hour * 60 + current.minute;
  const targetMinutes = targetHour * 60 + targetMinute;
  let deltaMinutes = targetMinutes - currentMinutes;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return deltaMinutes * 60 * 1000;
}

export function sportsbookRenderIntervalSeconds(settings) {
  if (settings?.sportsbookDailyRefreshEnabled === true) return 60;
  const freshnessInterval = Math.floor(Number(settings?.sportsbookIngestMaxAgeSeconds) / 2);
  const providerInterval = Number(settings?.sportradarRefreshSeconds);
  const validProviderInterval = Number.isFinite(providerInterval) && providerInterval > 0
    ? providerInterval
    : 90;
  const validFreshnessInterval = Number.isFinite(freshnessInterval) && freshnessInterval > 0
    ? freshnessInterval
    : 90;
  return Math.max(15, Math.min(validProviderInterval, validFreshnessInterval));
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

export function sportradarEventValidationProblems(event) {
  const problems = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['event:not-object'];
  if (typeof event.id !== 'string' || !event.id.trim()) problems.push('event.id');
  if (typeof event.sport !== 'string' || !event.sport.trim()) problems.push('event.sport');
  if (event.league !== null && typeof event.league !== 'string') problems.push('event.league');
  if (event.country !== null && (typeof event.country !== 'string' || !event.country.trim())) problems.push('event.country');
  if (typeof event.startTime !== 'string' || !Number.isFinite(Date.parse(event.startTime))) problems.push('event.startTime');
  if (!['SCHEDULED', 'LIVE', 'FINISHED', 'SUSPENDED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID'].includes(event.status)) problems.push('event.status');
  if (typeof event.live !== 'boolean') problems.push('event.live');
  if (!event.home || typeof event.home.name !== 'string' || !event.home.name.trim()) problems.push('event.home.name');
  if (!event.away || typeof event.away.name !== 'string' || !event.away.name.trim()) problems.push('event.away.name');
  if (!Array.isArray(event.markets)) problems.push('event.markets');
  if (event._refs?.sportradar === undefined || !String(event._refs.sportradar).trim()) problems.push('event._refs.sportradar');
  if (!Array.isArray(event._sources) || event._sources.length !== 1 || event._sources[0] !== 'sportradar') problems.push('event._sources');
  for (const [marketIndex, market] of (Array.isArray(event.markets) ? event.markets : []).entries()) {
    const prefix = 'markets[' + marketIndex + ']';
    if (!market || typeof market !== 'object' || Array.isArray(market)) { problems.push(prefix + ':not-object'); continue; }
    if (typeof market.id !== 'string' || !market.id.trim()) problems.push(prefix + '.id');
    if (typeof market.type !== 'string' || !market.type.trim()) problems.push(prefix + '.type');
    if (typeof market.period !== 'string' || !market.period.trim()) problems.push(prefix + '.period');
    if (market.source !== 'sportradar') problems.push(prefix + '.source');
    if (typeof market.suspended !== 'boolean') problems.push(prefix + '.suspended');
    if (!Array.isArray(market.selections)) { problems.push(prefix + '.selections'); continue; }
    for (const [selectionIndex, selection] of market.selections.entries()) {
      const selectionPrefix = prefix + '.selections[' + selectionIndex + ']';
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)) { problems.push(selectionPrefix + ':not-object'); continue; }
      if (typeof selection.key !== 'string' || !selection.key.trim()) problems.push(selectionPrefix + '.key');
      if (typeof selection.label !== 'string' || !selection.label.trim()) problems.push(selectionPrefix + '.label');
      if (!(selection.odds === null || selection.odds === undefined || Number.isFinite(selection.odds))) problems.push(selectionPrefix + '.odds');
      if (typeof selection.suspended !== 'boolean') problems.push(selectionPrefix + '.suspended');
      if (selection.source !== 'sportradar') problems.push(selectionPrefix + '.source');
    }
  }
  return problems;
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
  const invalidEvents = [];
  const providerResults = combined.providerResults.map(providerResult => {
    const events = [];
    for (const event of providerResult.events) {
      const problems = sportradarEventValidationProblems(event);
      if (problems.length) {
        invalidEvents.push({ id: event?.id || null, problems });
        continue;
      }
      events.push({
        ...event,
        _sources: ['sportradar'],
        _refs: { sportradar: event._refs.sportradar }
      });
    }
    return { ...providerResult, events };
  });
  const validEventCount = providerResults.reduce((sum, providerResult) => sum + providerResult.events.length, 0);
  const invalidLimit = Math.max(1, Math.floor(combined.eventCount * 0.02));
  if (validEventCount === 0 && combined.eventCount > 0) {
    throw new Error('No Sportradar events passed structural validation: ' + JSON.stringify(invalidEvents.slice(0, 10)));
  }
  if (invalidEvents.length > invalidLimit) {
    throw new Error('Sportradar snapshot quarantined because invalid-event count exceeded safety threshold: ' + JSON.stringify({
      invalidCount: invalidEvents.length,
      invalidLimit,
      sample: invalidEvents.slice(0, 10)
    }));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults,
    eventCount: validEventCount,
    diagnostics: {
      ...(combined.truncatedEventCount > 0 ? {
        eventLimit: {
          dataTruncated: true,
          omittedUniqueEvents: combined.truncatedEventCount
        }
      } : {}),
      invalidEventCount: invalidEvents.length,
      invalidEvents: invalidEvents.slice(0, 20)
    }
  };
}
