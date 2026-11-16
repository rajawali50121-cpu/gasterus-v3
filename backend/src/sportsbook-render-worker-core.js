import { leagueKey } from './sportsbook-providers.js';
import { config } from './config.js';

const DUPLICATE_KICKOFF_WINDOW_MS = 3 * 60 * 60 * 1000;

function wibParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: map.year, month: map.month, day: map.day, hour: Number(map.hour || 0), minute: Number(map.minute || 0) };
}

export function nextSportsbookDailyRefreshMs(settings, now = Date.now()) {
  const hour = Number(settings?.sportsbookDailyRefreshHourWib ?? 0);
  const minute = Number(settings?.sportsbookDailyRefreshMinuteWib ?? 5);
  // Compute next target in WIB by comparing local WIB clock; schedule daily.
  const current = wibParts(new Date(now));
  const currentMinutes = current.hour * 60 + current.minute;
  const targetMinutes = hour * 60 + minute;
  let deltaMinutes = targetMinutes - currentMinutes;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return deltaMinutes * 60 * 1000;
}

export function sportsbookRenderIntervalSeconds(settings) {
  if (settings?.sportsbookDailyRefreshEnabled === true) {
    // Bounded poll interval to hit daily WIB schedule without API calls when not due.
    return 60;
  }
  const freshnessInterval = Math.floor(Number(settings?.sportsbookIngestMaxAgeSeconds) / 2);
  const providerIntervals = [];
  if (settings?.sportmonksEnabled) {
    providerIntervals.push(
      settings.sportmonksRefreshSeconds,
      settings.sportmonksOddsRefreshSeconds,
      settings.sportmonksLiveRefreshSeconds
    );
  }
  if (settings?.sharpApiEnabled) providerIntervals.push(settings.sharpApiRefreshSeconds);
  if (settings?.oddsPapiEnabled) providerIntervals.push(settings.oddsPapiRefreshSeconds);
  const validIntervals = providerIntervals
    .map(Number)
    .filter(value => Number.isFinite(value) && value > 0);
  const nextProviderRefresh = validIntervals.length
    ? Math.min(...validIntervals)
    : Number.isFinite(freshnessInterval) && freshnessInterval > 0
      ? freshnessInterval
      : 90;
  const maxFreshnessInterval = Number.isFinite(freshnessInterval) && freshnessInterval > 0
    ? freshnessInterval
    : 90;
  return Math.max(15, Math.min(nextProviderRefresh, maxFreshnessInterval));
}

function leaguePriority(event, priorities) {
  const league = String(event?.league || '').trim().toLowerCase();
  const index = priorities.findIndex(name => league === name || league.includes(name));
  return index < 0 ? priorities.length : index;
}

function providerPriority(provider, live) {
  if (live) return 1;
  return provider === 'sportmonks' ? 2 : 1;
}

function compareCandidates(a, b, priorities) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  const leagueDifference = leaguePriority(a.event, priorities) - leaguePriority(b.event, priorities);
  if (leagueDifference) return leagueDifference;
  const kickoffDifference = Date.parse(a.event.startTime) - Date.parse(b.event.startTime);
  if (Number.isFinite(kickoffDifference) && kickoffDifference !== 0) return kickoffDifference;
  const sourceDifference = providerPriority(b.provider, b.event.live) - providerPriority(a.provider, a.event.live);
  return sourceDifference || a.event.id.localeCompare(b.event.id);
}

function sameFixture(a, b, teamKey) {
  if (a.event.sport !== b.event.sport
    || !leagueKey(a.event.league)
    || leagueKey(a.event.league) !== leagueKey(b.event.league)) return false;
  const direct = teamKey(a.event.home.name) === teamKey(b.event.home.name)
    && teamKey(a.event.away.name) === teamKey(b.event.away.name);
  if (!direct) return false;
  const kickoffA = Date.parse(a.event.startTime);
  const kickoffB = Date.parse(b.event.startTime);
  return Number.isFinite(kickoffA)
    && Number.isFinite(kickoffB)
    && Math.abs(kickoffA - kickoffB) <= DUPLICATE_KICKOFF_WINDOW_MS;
}

export function combineSportsbookProviderResults(providerResults, {
  maxEvents = 0,
  passthrough = config.sportmonksPassthrough,
  sportmonksMaxEvents = config.sportmonksMaxTotalEvents,
  priorityLeagues = [],
  teamKey
} = {}) {
  if (maxEvents !== 0 && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
    throw new Error('Worker sportsbook maxEvents must be a positive integer or 0 (unlimited).');
  }
  if (typeof teamKey !== 'function') throw new Error('A normalized team-key helper is required.');

  const enabledResults = providerResults.filter(result => result?.enabled === true);
  const candidates = enabledResults.flatMap(result =>
    (Array.isArray(result.events) ? result.events : [])
      // Pertandingan tanpa pasar (display-only) ikut snapshot: cakupan feed
      // tidak boleh dipotong oleh ketersediaan odds provider. Semua event
      // terstruktur (termasuk yang tanpa odds) dihitung dalam eventCount.
      .map(event => ({ provider: result.provider, event }))
  );
  candidates.sort((a, b) => compareCandidates(a, b, priorityLeagues));

  const fixtureGroups = [];
  for (const candidate of candidates) {
    let group = fixtureGroups.find(existing => sameFixture(existing[0], candidate, teamKey));
    if (!group) fixtureGroups.push(group = []);
    group.push(candidate);
  }
  fixtureGroups.sort((a, b) => compareCandidates(a[0], b[0], priorityLeagues));
  const boundedGroups = [];
  let retainedNonSportmonksGroups = 0;
  let retainedSportmonksGroups = 0;
  let truncatedEventCount = 0;
  let truncatedSportmonksEventCount = 0;
  let truncatedOtherProviderEventCount = 0;
  const nonSportmonksLimit = maxEvents !== 0 ? maxEvents : Infinity;
  for (const group of fixtureGroups) {
    const hasSportmonks = group.some(candidate => candidate.provider === 'sportmonks');
    if (passthrough && hasSportmonks) {
      if (sportmonksMaxEvents > 0 && retainedSportmonksGroups >= sportmonksMaxEvents) {
        truncatedEventCount += 1;
        truncatedSportmonksEventCount += 1;
        continue;
      }
      retainedSportmonksGroups += 1;
      boundedGroups.push(group);
    } else if (retainedNonSportmonksGroups < nonSportmonksLimit) {
      retainedNonSportmonksGroups += 1;
      boundedGroups.push(group);
    } else {
      truncatedEventCount += 1;
      truncatedOtherProviderEventCount += 1;
    }
  }

  const selectedByProvider = new Map();
  for (const group of boundedGroups) {
    for (const candidate of group) {
      const events = selectedByProvider.get(candidate.provider) || [];
      events.push(candidate.event);
      selectedByProvider.set(candidate.provider, events);
    }
  }

  const combinedResults = enabledResults.map(result => ({
    ...result,
    events: selectedByProvider.get(result.provider) || []
  }));
  return {
    providerResults: combinedResults,
    eventCount: boundedGroups.length,
    truncatedEventCount,
    truncatedSportmonksEventCount,
    truncatedOtherProviderEventCount
  };
}

function snapshotBytes(snapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

function rebuildSnapshot(snapshot, entries) {
  const eventsByProvider = new Map();
  for (const { provider, event } of entries) {
    const events = eventsByProvider.get(provider) || [];
    events.push(event);
    eventsByProvider.set(provider, events);
  }
  const providerResults = snapshot.providerResults.map(result => {
    return { ...result, events: eventsByProvider.get(result.provider) || [] };
  });
  return {
    ...snapshot,
    providerResults,
    eventCount: countSnapshotFixtures(entries.map(entry => entry.event))
  };
}

function normalizedTeamKey(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|club|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function sameSnapshotFixture(a, b) {
  if (a.sport !== b.sport
    || !leagueKey(a.league)
    || leagueKey(a.league) !== leagueKey(b.league)
    || normalizedTeamKey(a.home?.name) !== normalizedTeamKey(b.home?.name)
    || normalizedTeamKey(a.away?.name) !== normalizedTeamKey(b.away?.name)) return false;
  const first = Date.parse(a.startTime || '');
  const second = Date.parse(b.startTime || '');
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= DUPLICATE_KICKOFF_WINDOW_MS;
}

function snapshotFixtureGroups(entries) {
  const groups = [];
  for (const entry of entries) {
    let group = groups.find(items => sameSnapshotFixture(items[0].event, entry.event));
    if (!group) groups.push(group = []);
    group.push(entry);
  }
  return groups;
}

function countSnapshotFixtures(events) {
  return snapshotFixtureGroups(events.map(event => ({ event }))).length;
}

// Endpoint ingest menolak payload di atas anggaran byte; mempertahankan tiap
// event utuh lebih penting daripada mengirim hanya sebagian pasarnya.
export async function buildSportsbookRenderSnapshot({
  fetchSportmonks,
  fetchSharpApi,
  fetchOddsPapi,
  fetchTheRundown,
  maxEvents = 0,
  maxPages = 0,
  teamKey,
  now
}) {
  // Semua provider diambil tanpa batas event/halaman buatan. API quota dan
  // batas fisik (memori, Redis) adalah satu-satunya batas yang berlaku.
  if (!Number.isInteger(maxPages) || maxPages < 0) {
    throw new Error('Worker sportsbook maxPages must be a non-negative integer.');
  }
  if (maxEvents !== 0 && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
    throw new Error('Worker sportsbook maxEvents must be a positive integer or 0 (unlimited).');
  }
  const fetchers = [
    { provider: 'sportmonks', fetch: fetchSportmonks },
    { provider: 'sharpapi', fetch: fetchSharpApi },
    { provider: 'oddspapi', fetch: fetchOddsPapi },
    { provider: 'therundown', fetch: fetchTheRundown },
  ];
  const providerResults = [];
  const failures = [];
  for (const { provider, fetch } of fetchers) {
    if (typeof fetch !== 'function') continue;
    console.log('FETCH_START ' + provider);
    try {
      const options = provider === 'sportmonks'
        ? {
            maxEvents: config.sportmonksPassthrough ? 0 : config.sportmonksMaxTotalEvents,
            maxPages: config.sportmonksPassthrough ? 0 : config.sportmonksMaxPages
          }
        : { maxEvents, maxPages: maxPages || 0 };
      const result = await fetch(options);
      if (!result) continue;
      providerResults.push(result);
      console.log('FETCH_DONE ' + provider + ' events=' + (result?.events?.length ?? 0) + ' errors=' + JSON.stringify(result?.errors || []));
    } catch (error) {
      console.log('FETCH_FAIL ' + provider + ' ' + String(error?.message||error).slice(0,200));
      failures.push(`${provider}: ${error?.message || String(error)}`);
    }
  }
  if (!providerResults.length) {
    throw new Error(`No sportsbook provider could be fetched; snapshot was not sent. ${failures.join('; ')}`);
  }

  const combined = combineSportsbookProviderResults(providerResults, {
    maxEvents,
    passthrough: config.sportmonksPassthrough,
    sportmonksMaxEvents: config.sportmonksMaxTotalEvents,
    teamKey
  });
  console.info(JSON.stringify({
    service: 'sportsbook-render-worker',
    event: 'snapshot-combined',
    eventCount: combined.eventCount,
    providerResults: combined.providerResults.map(result => ({ provider: result.provider, enabled: result.enabled, events: result.events.length }))
  }));
  if (combined.truncatedEventCount > 0) {
    console.warn(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-event-limit-trimmed',
      eventCount: combined.eventCount,
      omittedUniqueEvents: combined.truncatedEventCount,
      maxEvents
    }));
  }
  if (!combined.eventCount) {
    throw new Error('No enabled sportsbook provider returned normalized fixtures; snapshot was not sent.');
  }

  function isValidEvent(e, provider) {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.id !== 'string' || !e.id.trim()) return false;
    if (typeof e.sport !== 'string' || !e.sport.trim()) return false;
    if (typeof e.league !== 'string' || !e.league.trim()) return false;
    if (e.country !== null && (typeof e.country !== 'string' || !e.country.trim())) return false;
    if (provider === 'sportmonks' && config.sportmonksPassthrough) {
      if (e.startTime !== null && (typeof e.startTime !== 'string' || !Number.isFinite(Date.parse(e.startTime)))) return false;
    } else if (typeof e.startTime !== 'string' || !Number.isFinite(Date.parse(e.startTime))) return false;
    if (!['SCHEDULED','LIVE','FINISHED','SUSPENDED','CANCELLED','CANCELED','ABANDONED','POSTPONED','VOID'].includes(e.status)) return false;
    if (typeof e.live !== 'boolean') return false;
    if (!e.home || typeof e.home.name !== 'string' || !e.home.name.trim()) return false;
    if (!e.away || typeof e.away.name !== 'string' || !e.away.name.trim()) return false;
    if (!Array.isArray(e.markets)) return false;
    if (!e._refs || typeof e._refs[provider] !== 'string' || !e._refs[provider].trim()) return false;
    if (!Array.isArray(e._sources) || e._sources.length !== 1 || e._sources[0] !== provider) return false;
    for (const m of e.markets) {
      if (!m || typeof m.id !== 'string' || !m.id.trim()) return false;
      if (typeof m.type !== 'string' || !m.type.trim()) return false;
      if (typeof m.period !== 'string' || !m.period.trim()) return false;
      if (m.source !== provider) return false;
      if (typeof m.suspended !== 'boolean') return false;
      if (!Array.isArray(m.selections) || (!m.selections.length && provider !== 'sportmonks')) return false;
      for (const sel of m.selections) {
        if (!sel || typeof sel.key !== 'string' || !sel.key.trim()) return false;
        if (typeof sel.label !== 'string' || (provider !== 'sportmonks' && !sel.label.trim())) return false;
        if (!Number.isFinite(sel.odds) || (provider !== 'sportmonks' && sel.odds <= 1)) return false;
        if (typeof sel.suspended !== 'boolean') return false;
        if (sel.source !== provider) return false;
      }
    }
    return true;
  }
  const normalizedResults = combined.providerResults.map(result => ({

    ...result,
    events: (result.events || []).filter(event => {
      if (!isValidEvent(event, result.provider)) {
        console.warn('EVENT_DROP ' + JSON.stringify({ provider: result.provider, id: event?.id, reason: 'invalid-structure' }));
        return false;
      }
      // Hanya prematch: event LIVE (status LIVE atau live=true) tidak boleh
      // pernah masuk ke snapshot sportsbook, sehingga ingestion tidak akan
      // gagal karena status LIVE dan member tidak melihat pertandingan live.
      if (event.live === true || event.status === 'LIVE') {
        console.warn('EVENT_DROP ' + JSON.stringify({ provider: result.provider, id: event.id, reason: 'live-event-excluded' }));
        return false;
      }
      return true;
    }).map(event => {
      const seen1x2 = new Set();
      const order1x2 = { HOME: 0, DRAW: 1, AWAY: 2 };
      const markets = [];
      for (const m of (event.markets || [])) {
        if (!m) continue;
        if (!m.source) m.source = result.provider;
        if (m.type === '1X2') {
          const key = `${m.period || 'FT'}|${m.line ?? ''}`;
          if (seen1x2.has(key)) continue;
          seen1x2.add(key);
          if (Array.isArray(m.selections)) {
            m.selections = [...m.selections].sort((a, b) => (order1x2[a.label] || 99) - (order1x2[b.label] || 99));
          }
        }
        for (const s of (m.selections || [])) {
          if (!s.source) s.source = result.provider;
        }
        markets.push(m);
      }
      event.markets = markets;
      return {
        ...event,
        _sources: [result.provider],
        _refs: (event._refs && event._refs[result.provider]) ? { [result.provider]: event._refs[result.provider] } : event._refs
      };
    })
  }));
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults: normalizedResults,
    eventCount: combined.eventCount,
    ...(combined.truncatedEventCount > 0
      ? {
          diagnostics: {
            eventLimit: {
              dataTruncated: true,
              omittedUniqueEvents: combined.truncatedEventCount,
              omittedSportmonksEvents: combined.truncatedSportmonksEventCount,
              omittedOtherProviderEvents: combined.truncatedOtherProviderEventCount,
              envsToIncrease: [
                ...(combined.truncatedSportmonksEventCount > 0 ? ['SPORTMONKS_MAX_TOTAL_EVENTS'] : []),
                ...(combined.truncatedOtherProviderEventCount > 0 ? ['SPORTSBOOK_RENDER_MAX_EVENTS'] : [])
              ]
            }
          }
        }
      : {})
  };
  return snapshot;
}
