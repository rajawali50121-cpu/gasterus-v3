const railwayBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : '';
const baseUrl = String(process.env.SPORTSBOOK_BASE_URL || railwayBaseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const requestTimeoutMs = 25000;
const maxRetries = 2;
const retryDelayMs = 500;
// Katalog aktif (pre-match + live, termasuk fixture display-only tanpa odds)
// wajib ratusan pertandingan; ini guard live-coverage anti-regresi.
const minimumEvents = 300;
const minimumPricedEvents = 25;
const minimumInspectedEvents = 10;
const requiredCoreMarketTypes = ['1X2', 'HANDICAP', 'TOTALS'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTransientNetworkError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError) return true;
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
  ]);
  for (let cause = error; cause; cause = cause.cause) {
    if (transientCodes.has(cause.code)) return true;
  }
  return false;
}

async function getJson(path) {
  const url = new URL(path, `${baseUrl}/`);
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    } catch (error) {
      if (attempt < maxRetries && isTransientNetworkError(error)) {
        console.warn(`Transient network error for ${path}; retry ${attempt + 1}/${maxRetries} in ${retryDelayMs * (attempt + 1)}ms: ${error.message}`);
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(`Unable to reach ${url}: ${error.message}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.error?.code || 'HTTP_ERROR';
      const message = payload?.error?.message || response.statusText;
      if (attempt < maxRetries && [502, 503, 504].includes(response.status)) {
        console.warn(`Transient HTTP ${response.status} (${code}) for ${path}; retry ${attempt + 1}/${maxRetries} in ${retryDelayMs * (attempt + 1)}ms`);
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(`GET ${path} returned ${response.status} (${code}): ${message}`);
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) {
      throw new Error(`GET ${path} returned an unexpected JSON envelope`);
    }
    return payload.data;
  }
}

function displayLeague(event) {
  const league = String(event?.league || 'Match').trim();
  const category = typeof event?.category === 'string'
    ? event.category
    : event?.category?.name || event?.category?.label;
  const country = String(event?.country || category || '').trim();
  if (!country || league.toLowerCase().startsWith(`${country.toLowerCase()} -`)) return league.toUpperCase();
  return `${country} - ${league}`.toUpperCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run sportsbook E2E with NODE_ENV=production');
  }

  const snapshot = await getJson('/api/member/sportsbook/events');
  assert(Array.isArray(snapshot.events), 'events endpoint payload.data.events must be an array');
  assert(snapshot.events.length >= minimumEvents,
    `events endpoint returned ${snapshot.events.length} events; expected at least ${minimumEvents}`);

  const labeledEvents = snapshot.events.filter(event => String(event.country || event.category || '').trim() && String(event.league || '').trim());
  assert(labeledEvents.length > 0, 'No event includes both a league and country/category in the API payload');

  // Pertandingan tanpa odds (display-only) sah, tetapi cakupan odds harus tetap
  // ada — minimal 25 pertandingan berharga untuk memastikan pipeline harga hidup.
  const pricedEvents = snapshot.events.filter(event => Array.isArray(event.markets) && event.markets.length > 0);
  assert(pricedEvents.length >= minimumPricedEvents,
    `events endpoint returned only ${pricedEvents.length} priced events; expected at least ${minimumPricedEvents}`);
  const labelSample = {
    country: labeledEvents[0].country || labeledEvents[0].category,
    league: labeledEvents[0].league,
    displayLeague: displayLeague(labeledEvents[0])
  };
  assert(labelSample.displayLeague.includes(' - '), `formatted league label is missing country separator: ${labelSample.displayLeague}`);

  const inspected = [];
  for (const event of pricedEvents.slice(0, Math.min(12, pricedEvents.length))) {
    const detail = await getJson(`/api/member/sportsbook/events/${encodeURIComponent(event.id)}`);
    const fullEvent = detail.event;
    assert(fullEvent?.id === event.id, `event detail did not match requested event ${event.id}`);
    const markets = fullEvent.markets || [];
    const marketTypes = [...new Set(markets.map(market => market.type))];
    const validPricedSelections = markets.every(market =>
      Array.isArray(market.selections) && market.selections.every(selection =>
        Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1
      )
    );
    assert(validPricedSelections, `event ${event.id} contains an empty market or invalid odds`);
    inspected.push({
      id: fullEvent.id,
      country: fullEvent.country || fullEvent.category || null,
      league: fullEvent.league,
      marketCount: markets.length,
      marketTypes,
      periods: [...new Set(markets.map(market => market.period || 'FT'))],
      marketPeriods: [...new Set(markets.map(market => `${market.type}:${market.period || 'FT'}`))]
    });
  }

  assert(inspected.length >= minimumInspectedEvents,
    `Only ${inspected.length} events could be inspected; expected at least ${minimumInspectedEvents}`);
  const marketCoverage = Object.fromEntries([...new Set(inspected.flatMap(event => event.marketTypes))]
    .sort()
    .map(type => [type, inspected.filter(event => event.marketTypes.includes(type)).length]));
  const marketPeriodCoverage = Object.fromEntries([...new Set(inspected.flatMap(event =>
    event.marketPeriods
  ))].sort().map(key => [key, inspected.filter(event => event.marketPeriods.includes(key)).length]));
  const missingCoreMarkets = requiredCoreMarketTypes
    .map(type => `${type}:FT`)
    .filter(key => !marketPeriodCoverage[key]);
  assert(missingCoreMarkets.length === 0,
    `Core market mapping missing from inspected events: ${missingCoreMarkets.join(', ')}`);
  const periodCoverage = [...new Set(inspected.flatMap(event => event.periods))].sort();
  console.log(JSON.stringify({
    status: 'PASS',
    baseUrl,
    eventListCount: snapshot.events.length,
    inspectedEventCount: inspected.length,
    marketCoverage,
    marketPeriodCoverage,
    periodCoverage,
    sourceMode: snapshot.source?.mode || null,
    leagueLabel: labelSample,
    inspectedEvents: inspected.map(event => ({
      id: event.id,
      country: event.country,
      league: event.league,
      displayLeague: displayLeague(event),
      marketCount: event.marketCount,
      marketTypes: event.marketTypes,
      periods: event.periods,
      marketPeriods: event.marketPeriods
    }))
  }, null, 2));
}

main().catch(error => {
  console.error(`Sportsbook E2E verification failed: ${error.message}`);
  process.exitCode = 1;
});
