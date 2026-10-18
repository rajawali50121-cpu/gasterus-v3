const MAX_EVENTS = 500;
const MAX_PAGES = 120;
const DUPLICATE_KICKOFF_WINDOW_MS = 3 * 60 * 60 * 1000;

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

function compareDuplicateCandidates(a, b, priorities) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  const sourceDifference = providerPriority(b.provider, b.event.live) - providerPriority(a.provider, a.event.live);
  if (sourceDifference) return sourceDifference;
  return compareCandidates(a, b, priorities);
}

function sameFixture(a, b, teamKey) {
  if (a.event.sport !== b.event.sport) return false;
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
      .filter(event => event?.markets?.length)
      .map(event => ({ provider: result.provider, event }))
  );
  candidates.sort((a, b) => compareCandidates(a, b, priorityLeagues));

  const selected = [];
  for (const candidate of candidates) {
    const duplicateIndex = selected.findIndex(existing => sameFixture(existing, candidate, teamKey));
    if (duplicateIndex === -1) {
      selected.push(candidate);
      continue;
    }
    if (compareDuplicateCandidates(candidate, selected[duplicateIndex], priorityLeagues) < 0) {
      selected[duplicateIndex] = candidate;
    }
  }
  selected.sort((a, b) => compareCandidates(a, b, priorityLeagues));
  const boundedSelection = selected.slice(0, maxEvents);

  const selectedByProvider = new Map();
  for (const candidate of boundedSelection) {
    const events = selectedByProvider.get(candidate.provider) || [];
    events.push(candidate.event);
    selectedByProvider.set(candidate.provider, events);
  }

  const combinedResults = enabledResults.map(result => ({
    ...result,
    events: selectedByProvider.get(result.provider) || []
  }));
  return {
    providerResults: combinedResults,
    eventCount: boundedSelection.length
  };
}

export async function buildSportsbookRenderSnapshot({
  fetchOddsApi,
  fetchSportmonks,
  maxEvents = 500,
  maxPages = MAX_PAGES,
  teamKey,
  now
}) {
  // Sportmonks adalah sumber utama cakupan luas: anggaran halaman dihabiskan
  // round-robin per tanggal (maks 120 halaman x 20 = 2.400 kandidat), berhenti
  // lebih awal begitu candidateLimit tercapai, lalu dibatasi maxEvents. The
  // Odds API dipertahankan sebagai CADANGAN sehingga feed tidak pernah kosong
  // bila salah satu provider gagal (dan sebaliknya). Fetcher dijalankan
  // SEKUENSIAL dan tiap kegagalan diisolasi: hanya satu payload provider yang
  // hidup pada satu waktu, sehingga heap worker 224MB tetap dapat diprediksi
  // (anti-OOM).
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error(`Worker sportsbook maxPages must be an integer between 1 and ${MAX_PAGES}.`);
  }
  const fetchers = [
    { provider: 'sportmonks', fetch: fetchSportmonks },
    { provider: 'the-odds-api', fetch: fetchOddsApi }
  ];
  const providerResults = [];
  const failures = [];
  for (const { provider, fetch } of fetchers) {
    if (typeof fetch !== 'function') continue;
    try {
      const result = await fetch({ maxEvents, maxPages });
      if (result) providerResults.push(result);
    } catch (error) {
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
  if (!combined.eventCount) {
    throw new Error('No enabled sportsbook provider returned normalized, priced fixtures; snapshot was not sent.');
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now ?? Date.now()).toISOString(),
    providerResults: combined.providerResults,
    eventCount: combined.eventCount
  };
}
