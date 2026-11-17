import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  SPORTRADAR_ENABLED: 'true',
  SPORTRADAR_API_KEY: 'test-sportradar-key',
  SPORTRADAR_MIN_INTERVAL_MS: '100',
  SPORTRADAR_MAX_CALLS_PER_HOUR: '0',
  SPORTRADAR_DAYS_AHEAD: '7',
  SPORTSBOOK_PREMATCH_WINDOW_DAYS: '7'
});

const [{ fetchSportradar }, { buildSportsbookRenderSnapshot }, { teamKey }, { validateSportsbookSnapshot }] = await Promise.all([
  import('../src/sportradar-provider.js'),
  import('../src/sportsbook-render-worker-core.js'),
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-ingestion.js')
]);

function todayWibKey() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}
function eventTimeTomorrowWib() {
  const today = todayWibKey();
  return new Date(Date.parse(`${today}T00:00:00+07:00`) + 36 * 3600000).toISOString();
}
function apiEvent(index) {
  return {
    sport_event: {
      id: `sr:sport_event:bulk-${index}`,
      start_time: eventTimeTomorrowWib(),
      status: 'not_started',
      sport_event_context: {
        competition: { id: 'sr:competition:1', name: 'Premier League' },
        category: { name: 'England', country: 'England' }
      },
      competitors: [
        { id: `home-${index}`, name: `Home Team ${index}`, qualifier: 'home', country: 'England' },
        { id: `away-${index}`, name: `Away Team ${index}`, qualifier: 'away', country: 'England' }
      ]
    },
    markets: [
      {
        id: `market-1x2-${index}`,
        name: '1x2',
        is_live: false,
        books: [
          { id: 'book-a', name: 'Bookmaker A', outcomes: [
            { id: `a-h-${index}`, type: 'home', odds_decimal: '2.10' },
            { id: `a-d-${index}`, type: 'draw', odds_decimal: '3.20' },
            { id: `a-a-${index}`, type: 'away', odds_decimal: '3.60' }
          ] },
          { id: 'book-b', name: 'Bookmaker B', outcomes: [
            { id: `b-h-${index}`, type: 'home', odds_decimal: '2.15' },
            { id: `b-d-${index}`, type: 'draw', odds_decimal: '3.25' },
            { id: `b-a-${index}`, type: 'away', odds_decimal: '3.55' }
          ] }
        ]
      },
      {
        id: `market-total-${index}`,
        name: 'total',
        is_live: false,
        books: [{ id: 'book-a', name: 'Bookmaker A', outcomes: [
          { id: `over-${index}`, type: 'over', total: '2.5', odds_decimal: '1.90' },
          { id: `under-${index}`, type: 'under', total: '2.5', odds_decimal: '1.95' }
        ] }]
      },
      {
        id: `market-extra-${index}`,
        name: 'team total goals',
        is_live: false,
        books: [{ id: 'book-b', name: 'Bookmaker B', outcomes: [
          { id: `extra-${index}`, name: 'Home team over 0.5', total: '0.5', odds_decimal: '1.50' }
        ] }]
      },
      {
        id: `market-removed-${index}`,
        name: 'winner (incl. extra innings)',
        is_live: false,
        books: [{ id: 'book-removed', name: 'Removed Book', removed: true, outcomes: [
          { id: `removed-${index}`, type: 'home', odds_decimal: '1.00', removed: true },
          { id: `removed-no-price-${index}`, type: 'away', removed: true }
        ] }]
      }
    ]
  };
}

test('Sportradar pagination imports 121 fixtures and retains every bookmaker and supported/unknown market', async () => {
  const wibToday = todayWibKey();
  const scheduleDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  const allItems = Array.from({ length: 121 }, (_, index) => apiEvent(index));
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const date = url.pathname.match(/schedules\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    const start = Number(url.searchParams.get('start') || 0);
    calls.push({ date, start });
    const items = date === scheduleDate ? allItems.slice(start, start + 50) : [];
    const maxResults = date === scheduleDate ? allItems.length : 0;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-max-results': String(maxResults) }),
      json: async () => ({ sport_schedule_sport_event_markets: items }),
      text: async () => ''
    };
  };

  const result = await fetchSportradar({ daysAhead: 7, maxEvents: 0, maxPages: 0 });
  assert.equal(result.enabled, true);
  assert.equal(result.transportOk, true);
  assert.equal(result.events.length, 121);
  assert.equal(calls.filter(call => call.date === undefined).length, 0);
  assert.equal(result.diagnostics.eventsAccepted, 121);
  assert.equal(calls.filter(call => call.date === scheduleDate).length, 3);
  assert.equal(calls.filter(call => call.date === scheduleDate).map(call => call.start).join(','), '0,50,100');

  const first = result.events[0];
  assert.equal(first.league, 'Premier League');
  assert.equal(first.markets.filter(market => market.type === '1X2').length, 2, 'both bookmakers survive normalization');
  assert.ok(first.markets.some(market => market.type === 'TOTALS'));
  assert.ok(first.markets.some(market => market.type === 'TEAM_TOTAL' || market.type === 'OTHER'));
  assert.ok(first.markets.every(market => market.source === 'sportradar'));
  assert.ok(first.markets.every(market => market.selections.every(selection => selection.source === 'sportradar')));
  const removedBookMarket = first.markets.find(market => market.sourceBookId === 'book-removed');
  assert.ok(removedBookMarket, 'removed bookmaker market remains in the ingested source data');
  assert.equal(removedBookMarket.suspended, true);
  assert.equal(removedBookMarket.selections[0].odds, 1);
  assert.equal(removedBookMarket.selections[1].odds, null);
  assert.equal(removedBookMarket.selections[0].removed, true);

  const snapshot = await buildSportsbookRenderSnapshot({
    fetchSportradar: async () => result,
    maxEvents: 0,
    maxPages: 0,
    teamKey
  });
  assert.equal(snapshot.providerResults.length, 1);
  assert.deepEqual(snapshot.providerResults.map(provider => provider.provider), ['sportradar']);
  assert.equal(snapshot.eventCount, 121);
  assert.equal(validateSportsbookSnapshot(snapshot).eventCount, 121);
});

test('Sportradar partial page response is rejected rather than published as a complete snapshot', async () => {
  const wibToday = todayWibKey();
  const scheduleDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const date = url.pathname.match(/schedules\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    const start = Number(url.searchParams.get('start') || 0);
    if (date !== scheduleDate) {
      return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '0' }), json: async () => ({ sport_schedule_sport_event_markets: [] }), text: async () => '' };
    }
    if (start > 0) {
      return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '60' }), json: async () => ({ sport_schedule_sport_event_markets: [] }), text: async () => '' };
    }
    return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '60' }), json: async () => ({ sport_schedule_sport_event_markets: Array.from({ length: 50 }, (_, index) => apiEvent(index)) }), text: async () => '' };
  };
  await assert.rejects(fetchSportradar({ daysAhead: 7 }), /empty page at offset 50 while x-max-results reports 60/);
});
