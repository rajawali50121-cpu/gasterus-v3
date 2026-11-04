import { leagueKey } from './sportsbook-providers.js';

const MAX_EVENTS = 500;
const MAX_PAGES = 120;
const DUPLICATE_KICKOFF_WINDOW_MS = 3 * 60 * 60 * 1000;
const INGESTION_ALLOWED_STATUSES = new Set(['SCHEDULED', 'LIVE', 'FINISHED', 'SUSPENDED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID']);
const INGESTION_MAX_MARKETS_PER_EVENT = 120;
const INGESTION_MAX_SELECTIONS_PER_MARKET = 250;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidSelection(selection, provider) {
  if (!isRecord(selection)) return false;
  if (!requiredString(selection.key, 160)) return false;
  if (!requiredString(selection.label, 120)) return false;
  const odds = Number(selection.odds);
  if (!Number.isFinite(odds) || odds <= 1 || odds > 10000) return false;
  if (typeof selection.suspended !== 'boolean') return false;
  if (Array.isArray(selection.source)) {
    if (!selection.source.includes(provider)) return false;
  } else if (selection.source !== provider) {
    return false;
  }
  if (selection.updatedAt !== null && !validIsoTimestamp(selection.updatedAt)) return false;
  return true;
}

function isValidMarket(market, provider) {
  if (!isRecord(market)) return false;
  if (!requiredString(market.id, 128)) return false;
  if (!requiredString(market.type, 60)) return false;
  if (!requiredString(market.period, 20)) return false;
  if (Array.isArray(market.source)) {
    if (!market.source.includes(provider)) return false;
  } else if (market.source !== provider) {
    return false;
  }
  if (typeof market.suspended !== 'boolean') return false;
  if (!Array.isArray(market.selections) || market.selections.length === 0 || market.selections.length > INGESTION_MAX_SELECTIONS_PER_MARKET) return false;
  return market.selections.every(selection => isValidSelection(selection, provider));
}

function isValidEventForIngestion(event, provider) {
  if (!isRecord(event)) return false;
  if (!requiredString(event.id, 128)) return false;
  if (!requiredString(event.sport, 40)) return false;
  if (!requiredString(event.league, 120)) return false;
  if (event.country !== null && !requiredString(event.country, 80)) return false;
  if (!validIsoTimestamp(event.startTime)) return false;
  if (!INGESTION_ALLOWED_STATUSES.has(event.status)) return false;
  if (typeof event.live !== 'boolean') return false;
  if (!isRecord(event.home) || !requiredString(event.home.name, 120)) return false;
  if (!isRecord(event.away) || !requiredString(event.away.name, 120)) return false;
  if (!Array.isArray(event.markets)) return false;
  if (event.markets.length > INGESTION_MAX_MARKETS_PER_EVENT) return false;
  // Allow display-only events with empty markets
  if (event.markets.length > 0 && !event.markets.every(market => isValidMarket(market, provider))) return false;
  if (!isRecord(event._refs) || !requiredString(event._refs[provider], 160)) return false;
  if (!Array.isArray(event._sources) || event._sources.length !== 1 || event._sources[0] !== provider) return false;
  return true;
}

function filterValidIngestionEvents(providerResults) {
  const filtered = providerResults.map(result => {
    const validEvents = [];
    let skippedCount = 0;
    for (const event of result.events || []) {
      if (isValidEventForIngestion(event, result.provider)) {
        validEvents.push(event);
      } else {
        skippedCount += 1;
      }
    }
    if (skippedCount > 0) {
      console.warn(JSON.stringify({
        service: 'sportsbook-render-worker',
        event: 'snapshot-event-validation-skipped',
        provider: result.provider,
        skippedCount,
        retainedCount: validEvents.length
      }));
    }
    return {
      ...result,
      events: validEvents
    };
  }).filter(result => result.events.length > 0);
// Merge two selections: keep best odds, preserve provenance across providers
function mergeSelection(selectionA, selectionB, providerA, providerB) {
  const oddsA = Number(selectionA.odds);
  const oddsB = Number(selectionB.odds);
  if (oddsA > oddsB) return { ...selectionA, source: providerA };
  if (oddsB > oddsA) return { ...selectionB, source: providerB };
  // Equal odds: keep both provenance in combined label
  return {
    ...selectionA,
    label: `${selectionA.label} / ${selectionB.label}`,
    source: [providerA, providerB],
    odds: oddsA
  };
}

// Merge two markets: keep best selections, preserve provenance across providers
function mergeMarkets(marketA, marketB, providerA, providerB) {
  if (!marketA || !marketB) return marketA || marketB;
  const typeMatch = marketA.type === marketB.type;
  const periodMatch = marketA.period === marketB.period;
  const lineMatch = String(marketA.line || '') === String(marketB.line || '');
  if (!typeMatch || !periodMatch || !lineMatch) return null; // different markets
  // Merge selections: keep best odds per unique key
  const mergedSelections = new Map();
  for (const sel of marketA.selections || []) {
    const key = sel.key;
    const existing = mergedSelections.get(key);
    if (!existing) mergedSelections.set(key, { ...sel, source: providerA });
    else { const merged = mergeSelection(existing, sel, providerA, providerB); mergedSelections.set(key, merged); }
  }
  for (const sel of marketB.selections || []) {
    const key = sel.key;
    const existing = mergedSelections.get(key);
    if (!existing) mergedSelections.set(key, { ...sel, source: providerB });
    else { const merged = mergeSelection(existing, sel, providerA, providerB); mergedSelections.set(key, merged); }
  }
  return { ...marketA, selections: Array.from(mergedSelections.values()), source: [providerA, providerB] };
}


  return filtered;
}

export function sportsbookRenderIntervalSeconds(settings) {
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
  if (live) return provider === 'api-sports' ? 2 : 1;
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
  maxEvents = MAX_EVENTS,
  priorityLeagues = [],
  teamKey
} = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_EVENTS) {
    throw new Error(`Worker sportsbook maxEvents must be an integer between 1 and ${MAX_EVENTS}.`);
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
  // Merge markets across providers within each fixture group
  const mergedGroups = fixtureGroups.map(group => {
    try {
    // Collect events by provider for this fixture
    const providerEvents = new Map();
    for (const candidate of group) {
      if (!providerEvents.has(candidate.provider)) providerEvents.set(candidate.provider, []);
      providerEvents.get(candidate.provider).push(candidate.event);
    }
    const providers = Array.from(providerEvents.keys());
    if (providers.length === 0) {
      return group;
    }
    // Build merged events for each candidate - start with deep clone of each event
    const mergedEventsByKey = new Map();
    for (let i = 0; i < group.length; i++) {
      const key = `${group[i].provider}:${group[i].event.id}`;
      mergedEventsByKey.set(key, JSON.parse(JSON.stringify(group[i].event)));
    }
    // Merge markets from all other providers into each base event
    for (let baseIdx = 0; baseIdx < group.length; baseIdx++) {
      const baseCandidate = group[baseIdx];
      const baseKey = `${baseCandidate.provider}:${baseCandidate.event.id}`;
      let baseEvent = mergedEventsByKey.get(baseKey);
      if (!baseEvent) continue;
      for (let p = 0; p < providers.length; p++) {
        const otherProvider = providers[p];
        if (otherProvider === baseCandidate.provider) continue;
        const otherEvents = providerEvents.get(otherProvider) || [];
        for (const evJ of otherEvents) {
          if (sameFixture(baseCandidate, { event: evJ, provider: otherProvider }, teamKey)) {
            // Merge all markets from evJ into baseEvent
            const mergedMarketsMap = new Map();
            for (const mI of (baseEvent.markets || [])) {
              const mkey = `${mI.type}|${mI.period}|${mI.line || ''}`;
              mergedMarketsMap.set(mkey, JSON.parse(JSON.stringify(mI)));
            }
            for (const mJ of (evJ.markets || [])) {
              const mkey = `${mJ.type}|${mJ.period}|${mJ.line || ''}`;
              const existing = mergedMarketsMap.get(mkey);
              if (existing) {
                const mergedM = mergeMarkets(existing, mJ, baseCandidate.provider, otherProvider);
                if (mergedM) {
                  mergedMarketsMap.set(mkey, mergedM);
                }
              } else {
                mergedMarketsMap.set(mkey, JSON.parse(JSON.stringify(mJ)));
              }
            }
            baseEvent.markets = Array.from(mergedMarketsMap.values());
            mergedEventsByKey.set(baseKey, baseEvent);
            break;
          }
        }
      }
    }
    return group.map((g, i) => {
      const key = `${g.provider}:${g.event.id}`;
      const mergedEvent = mergedEventsByKey.get(key) || g.event;
      return { ...g, event: mergedEvent };
    });
    } catch (error) {
      console.error(JSON.stringify({
        service: 'sportsbook-render-worker',
        event: 'market-merge-error',
        error: error?.message || String(error)
      }));
      return group;
    }
  });

  const boundedGroups = mergedGroups.slice(0, maxEvents);
  const truncatedEventCount = mergedGroups.length - maxEvents;

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
    truncatedEventCount
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
export function fitSnapshotToPayloadBudget(snapshot, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return snapshot;
  if (snapshotBytes(snapshot) <= maxBytes) return snapshot;
  const entries = snapshot.providerResults.flatMap(result =>
    (result.events || []).map(event => ({ provider: result.provider, event }))
  );
  if (!entries.length) return snapshot;

  // Buang fixture berperingkat terendah hanya dalam kelompok utuh; jangan
  // memangkas market atau selection sehingga data odds parsial tampak lengkap.
  const fixtureGroups = snapshotFixtureGroups(entries);
  let low = 1;
  let high = fixtureGroups.length;
  let best = null;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidateEntries = fixtureGroups.slice(0, keep).flat();
    const candidate = rebuildSnapshot(snapshot, candidateEntries);
    if (snapshotBytes(candidate) <= maxBytes) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (!best) {
    throw new Error('A single complete sportsbook event exceeds the ingest payload budget.');
  }
  return best;
}

export async function buildSportsbookRenderSnapshot({
  fetchOddsApi,
  fetchApiSports,
  fetchSportmonks,
  fetchSharpApi,
  fetchOddsPapi,
  maxEvents = 500,
  maxPages = MAX_PAGES,
  maxPayloadBytes = null,
  teamKey,
  now
}) {
  // Sportmonks adalah sumber utama cakupan luas: anggaran halaman dihabiskan
  // round-robin per tanggal (maks 120 halaman x 20 = 2.400 kandidat), lalu
  // dibatasi maxEvents. The Odds API dipertahankan sebagai CADANGAN sehingga feed tidak pernah kosong
  // bila salah satu provider gagal (dan sebaliknya). Fetcher dijalankan
  // SEKUENSIAL dan tiap kegagalan diisolasi: hanya satu payload provider yang
  // hidup pada satu waktu, sehingga heap worker 224MB tetap dapat diprediksi
  // (anti-OOM).
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error(`Worker sportsbook maxPages must be an integer between 1 and ${MAX_PAGES}.`);
  }
  const fetchers = [
    { provider: 'sportmonks', fetch: fetchSportmonks },
    { provider: 'sharpapi', fetch: fetchSharpApi },
    { provider: 'api-sports', fetch: fetchApiSports },
    { provider: 'oddspapi', fetch: fetchOddsPapi },
    { provider: 'the-odds-api', fetch: fetchOddsApi }
  ];
  const providerResults = [];
  const failures = [];
  for (const { provider, fetch } of fetchers) {
    if (typeof fetch !== 'function') continue;
    try {
      const result = await fetch({ maxEvents, maxPages });
      if (result && Array.isArray(result.events)) {
        // Ensure events array exists even if empty
        providerResults.push({ ...result, events: result.events || [] });
      } else if (result) {
        providerResults.push({ ...result, events: Array.isArray(result.events) ? result.events : [] });
      }
    } catch (error) {
      failures.push(`${provider}: ${error?.message || String(error)}`);
      console.error(JSON.stringify({
        service: 'sportsbook-render-worker',
        event: 'provider-fetch-error',
        provider,
        error: error?.message || String(error)
      }));
    }
  }
  if (!providerResults.length) {
    throw new Error(`No sportsbook provider could be fetched; snapshot was not sent. ${failures.join('; ')}`);
  }

  const combined = combineSportsbookProviderResults(providerResults, {
    maxEvents,
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

  // Filter events that would fail ingestion validation before building the
  // snapshot. One invalid event must not cause the entire snapshot (and all
  // providers) to be rejected by the web ingest endpoint.
  const validated = filterValidIngestionEvents(combined.providerResults);
  if (!validated.length) {
    throw new Error('No sportsbook event passed ingestion validation; snapshot was not sent.');
  }
  const totalValidatedEvents = validated.reduce((sum, result) => sum + result.events.length, 0);

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults: validated,
    eventCount: totalValidatedEvents
  };
  // Selaraskan dengan anggaran payload ingest (SPORTSBOOK_INGEST_MAX_PAYLOAD_BYTES)
  // sebelum berangkat: lebih baik memotong deterministik daripada seluruh push
  // ditolak 413 dan feed member nyangkut di snapshot lama.
  const fitted = fitSnapshotToPayloadBudget(snapshot, maxPayloadBytes);
  if (fitted !== snapshot) {
    console.warn(JSON.stringify({
      service: 'sportsbook-render-worker',
      event: 'snapshot-payload-trimmed',
      originalEvents: snapshot.eventCount,
      fittedEvents: fitted?.eventCount ?? snapshot.eventCount,
      maxPayloadBytes
    }));
  }
  return fitted;
}
