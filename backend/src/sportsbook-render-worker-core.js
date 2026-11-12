import {
  createMovioddsCycleDiagnostics,
  hasTrustedResultAuthority,
  sportsbookEventsMatch
} from './sportsbook-providers.js';
import { config } from './config.js';

const MAX_EVENTS = 5000;

function leaguePriority(event, priorities) {
  const league = String(event?.league || '').trim().toLowerCase();
  const index = priorities.findIndex(name => league === name || league.includes(name));
  return index < 0 ? priorities.length : index;
}

function providerPriority(provider) {
  if (provider === 'sportmonks') return 3;
  if (provider === 'api-sports') return 2.5;
  if (provider === 'sharpapi') return 2;
  if (provider === 'the-odds-api') return 1.5;
  if (provider === 'moviodds') return 1;
  return 1;
}

function compareCandidates(a, b, priorities) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  const sourceDifference = providerPriority(b.provider) - providerPriority(a.provider);
  if (sourceDifference) return sourceDifference;
  const leagueDifference = leaguePriority(a.event, priorities) - leaguePriority(b.event, priorities);
  if (leagueDifference) return leagueDifference;
  const kickoffDifference = Date.parse(a.event.startTime) - Date.parse(b.event.startTime);
  if (Number.isFinite(kickoffDifference) && kickoffDifference !== 0) return kickoffDifference;
  return a.event.id.localeCompare(b.event.id);
}

function compareDuplicateCandidates(a, b, priorities) {
  if (a.event.live !== b.event.live) return Number(b.event.live) - Number(a.event.live);
  const sourceDifference = providerPriority(b.provider) - providerPriority(a.provider);
  if (sourceDifference) return sourceDifference;
  return compareCandidates(a, b, priorities);
}

function sameFixture(a, b, teamKey) {
  return sportsbookEventsMatch(a.event, b.event, teamKey);
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
  const providerCandidates = enabledResults.flatMap(result =>
    (Array.isArray(result.events) ? result.events : [])
      .map(event => ({ provider: result.provider, event }))
  );
  const resultCandidates = providerCandidates.filter(candidate => hasTrustedResultAuthority(candidate.provider));
  const fixtureMatchingByProvider = new Map(enabledResults.map(result => [result.provider, {
    matched: 0,
    ambiguous: 0,
    unmatched: 0
  }]));
  const debugExamples = [];
  const includeDebugExamples = String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
  const candidateMatchCounts = new Map();
  for (const candidate of providerCandidates) {
    if (hasTrustedResultAuthority(candidate.provider)) continue;
    const matches = resultCandidates.filter(other => sameFixture(other, candidate, teamKey));
    candidateMatchCounts.set(candidate, matches.length);
    const matching = fixtureMatchingByProvider.get(candidate.provider);
    if (matches.length === 0) matching.unmatched += 1;
    else if (matches.length === 1) matching.matched += 1;
    else matching.ambiguous += 1;
    if (includeDebugExamples && matches.length !== 1 && debugExamples.length < 5) {
      debugExamples.push({
        provider: candidate.provider,
        category: matches.length ? 'ambiguous' : 'unmatched',
        home: candidate.event.home?.name || '',
        away: candidate.event.away?.name || ''
      });
    }
  }
  const candidates = providerCandidates.filter(candidate => hasTrustedResultAuthority(candidate.provider)
    || candidateMatchCounts.get(candidate) === 0
    || candidateMatchCounts.get(candidate) === 1
    || candidateMatchCounts.get(candidate) > 1);
  candidates.sort((a, b) => compareCandidates(a, b, priorityLeagues));

  const groups = [];
  for (const candidate of candidates) {
    const isAmbiguous = !hasTrustedResultAuthority(candidate.provider)
      && candidateMatchCounts.get(candidate) > 1;
    if (isAmbiguous) {
      groups.push([candidate]);
      continue;
    }
    const duplicateIndex = groups.findIndex(group => sameFixture(group[0], candidate, teamKey));
    if (duplicateIndex === -1) {
      groups.push([candidate]);
      continue;
    }
    const group = groups[duplicateIndex];
    if (!group.some(existing => existing.provider === candidate.provider)) group.push(candidate);
  }
  groups.sort((a, b) => compareDuplicateCandidates(a[0], b[0], priorityLeagues));
  const boundedGroups = groups.slice(0, maxEvents);

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
    diagnostics: {
      ...(result.diagnostics || {}),
      receivedFixtures: result.diagnostics?.receivedFixtures ?? (result.events || []).length,
      acceptedFixtures: result.diagnostics?.acceptedFixtures ?? (result.events || []).length,
      snapshotFixtures: (selectedByProvider.get(result.provider) || []).length,
      discardedFixtures: {
        ...(result.diagnostics?.discardedFixtures || {}),
        ambiguous: fixtureMatchingByProvider.get(result.provider)?.ambiguous || 0,
        unmatched: fixtureMatchingByProvider.get(result.provider)?.unmatched || 0
      },
      fixtureMatching: {
        ...(fixtureMatchingByProvider.get(result.provider) || { matched: 0, ambiguous: 0, unmatched: 0 }),
        usedAsSupplement: hasTrustedResultAuthority(result.provider)
          ? 0
          : (selectedByProvider.get(result.provider) || []).length,
        ambiguousUsedAsSupplement: 0,
        ambiguousNotUsed: fixtureMatchingByProvider.get(result.provider)?.ambiguous || 0
      },
      ...(includeDebugExamples && debugExamples.some(example => example.provider === result.provider)
        ? { debugExamples: debugExamples.filter(example => example.provider === result.provider) }
        : {})
    },
    events: selectedByProvider.get(result.provider) || []
  }));
  return {
    providerResults: combinedResults,
    eventCount: boundedGroups.length
  };
}

export async function runWithProviderDeadline(fetcher, args, signal, deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => abortCause('provider-timeout'), deadlineMs);
  let firstCause = null;

  const abortCause = (reason) => {
    if (firstCause === null) {
      firstCause = reason;
    }
    controller.abort();
  };

  const onExternalAbort = () => abortCause('shutdown');
  if (signal) {
    if (signal.aborted) abortCause('shutdown');
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await fetcher({ ...args, signal: controller.signal });
  } catch (error) {
    error.cause = firstCause ?? error.cause ?? 'provider-error';
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

export async function buildSportsbookRenderSnapshot({
  fetchMoviOdds,
  fetchOddsPapi,
  fetchSportmonks,
  fetchSharpApi,
  fetchTheOddsApi,
  fetchApiSports,
  maxEvents = 5000,
  teamKey,
  now,
  revision,
  signal
}) {
  const providers = [
    ['sportmonks', fetchSportmonks],
    ['moviodds', fetchMoviOdds],
    ['sharpapi', fetchSharpApi],
    ['the-odds-api', fetchTheOddsApi],
    ['api-sports', fetchApiSports],
    ['oddspapi', fetchOddsPapi]
  ].filter(([, fetcher]) => typeof fetcher === 'function');

  const deadlineMs = Number(config.sportsFeedRequestTimeoutMs) || 12000;
  const providerResults = await Promise.all(providers.map(async ([provider, fetcher]) => {
    try {
      return await runWithProviderDeadline(fetcher, { maxEvents }, signal, deadlineMs);
    } catch (error) {
      return {
        provider,
        enabled: true,
        events: [],
        errors: [String(error?.message || error).slice(0, 300)],
        transportOk: false,
        cause: error?.cause ?? 'provider-error',
        ...(provider === 'moviodds' ? { diagnostics: createMovioddsCycleDiagnostics() } : {})
      };
    }
  }));

  if (signal?.aborted) {
    throw new Error('Worker shutdown detected; snapshot was not sent.');
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
    revision,
    providerResults: combined.providerResults,
    eventCount: combined.eventCount
  };
}
