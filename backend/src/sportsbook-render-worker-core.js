import { leagueKey } from './sportsbook-providers.js';

const MAX_EVENTS = 500;
const MAX_PAGES = 120;
const DUPLICATE_KICKOFF_WINDOW_MS = 3 * 60 * 60 * 1000;

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
  const boundedGroups = fixtureGroups.slice(0, maxEvents);
  const truncatedEventCount = fixtureGroups.length - boundedGroups.length;

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
    console.log('FETCH_START ' + provider);
    try {
      const result = await fetch({ maxEvents, maxPages });
      if (result) providerResults.push(result);
      console.log('FETCH_DONE ' + provider + ' events=' + (result?.events?.length ?? 0));
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

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults: combined.providerResults,
    eventCount: combined.eventCount
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
