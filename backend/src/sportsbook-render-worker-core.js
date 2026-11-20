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

function isValidSportradarEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.id !== 'string' || !event.id.trim()) return false;
  if (typeof event.sport !== 'string' || !event.sport.trim()) return false;
  if (event.league !== null && typeof event.league !== 'string') return false;
  if (event.country !== null && (typeof event.country !== 'string' || !event.country.trim())) return false;
  if (typeof event.startTime !== 'string' || !Number.isFinite(Date.parse(event.startTime))) return false;
  if (!['SCHEDULED', 'LIVE', 'FINISHED', 'SUSPENDED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID'].includes(event.status)) return false;
  if (typeof event.live !== 'boolean') return false;
  if (!event.home || typeof event.home.name !== 'string' || !event.home.name.trim()) return false;
  if (!event.away || typeof event.away.name !== 'string' || !event.away.name.trim()) return false;
  if (!Array.isArray(event.markets)) return false;
  if (event._refs?.sportradar === undefined || !String(event._refs.sportradar).trim()) return false;
  if (!Array.isArray(event._sources) || event._sources.length !== 1 || event._sources[0] !== 'sportradar') return false;
  for (const market of event.markets) {
    if (!market || typeof market.id !== 'string' || !market.id.trim()) return false;
    if (typeof market.type !== 'string' || !market.type.trim()) return false;
    if (typeof market.period !== 'string' || !market.period.trim()) return false;
    if (market.source !== 'sportradar' || typeof market.suspended !== 'boolean') return false;
    if (!Array.isArray(market.selections)) return false;
    for (const selection of market.selections) {
      if (!selection || typeof selection.key !== 'string' || !selection.key.trim()) return false;
      if (typeof selection.label !== 'string' || !selection.label.trim()) return false;
      if (!(selection.odds === null || selection.odds === undefined || Number.isFinite(selection.odds))) return false;
      if (typeof selection.suspended !== 'boolean' || selection.source !== 'sportradar') return false;
    }
  }
  return true;
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
  const providerResults = combined.providerResults.map(providerResult => ({
    ...providerResult,
    events: providerResult.events.map(event => {
      if (!isValidSportradarEvent(event)) {
        throw new Error('Sportradar event rejected before publish: ' + JSON.stringify({
          provider: providerResult.provider,
          id: event?.id || null,
          reason: 'invalid-structure'
        }));
      }
      return {
        ...event,
        _sources: ['sportradar'],
        _refs: { sportradar: event._refs.sportradar }
      };
    })
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults,
    eventCount: combined.eventCount,
    ...(combined.truncatedEventCount > 0 ? {
      diagnostics: {
        eventLimit: {
          dataTruncated: true,
          omittedUniqueEvents: combined.truncatedEventCount
        }
      }
    } : {})
  };
}
