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

const [{ fetchSportradar, __sportradarNormalizer }, { buildSportsbookRenderSnapshot }, { teamKey, publicEvent }, { validateSportsbookSnapshot }] = await Promise.all([
  import('../src/sportradar-provider.js'),
  import('../src/sportsbook-render-worker-core.js'),
  import('../src/sportsbook-feed-utils.js'),
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
      status: index === 0 ? 'ended' : 'not_started',
      replaced_by: index === 0 ? 'sr:sport_event:replacement-0' : undefined,
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
        id: `market-1x2-${index}`,
        name: '1st half - 1x2',
        is_live: false,
        books: [{ id: 'book-a', name: 'Bookmaker A', outcomes: [
          { id: `first-half-home-${index}`, type: 'home', odds_decimal: '2.00' },
          { id: `first-half-draw-${index}`, type: 'draw', odds_decimal: '3.00' },
          { id: `first-half-away-${index}`, type: 'away', odds_decimal: '4.00' }
        ] }]
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
        is_live: true,
        books: [{ id: 'book-removed', name: 'Removed Book', removed: true, outcomes: [
          { id: `removed-${index}`, type: 'home', odds_decimal: '1.00', removed: true },
          { id: `removed-no-price-${index}`, type: 'away', removed: true }
        ] }]
      },
      {
        id: `market-live-only-${index}`,
        name: 'live market only',
        is_live: true,
        books: [{ id: 'book-live', name: 'Bookmaker Live', outcomes: [
          { id: `live-home-${index}`, type: 'home', odds_decimal: '2.10' },
          { id: `live-away-${index}`, type: 'away', odds_decimal: '3.10' }
        ] }]
      },
    ]
  };
}

test('Sportradar pagination imports 121 fixtures and retains every bookmaker and supported/unknown market', async () => {
  __sportradarNormalizer.resetFeedState();
  __sportradarNormalizer.resetFeedState();
  const wibToday = todayWibKey();
  const scheduleDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  const allItems = Array.from({ length: 121 }, (_, index) => apiEvent(index));
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sports.json')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ generated_at: '2026-11-17T18:59:00Z', sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }), text: async () => '' };
    }
    const date = url.pathname.split('/schedules/')[1]?.split('/')[0];
    const start = Number(url.searchParams.get('start') || 0);
    calls.push({ date, start });
    const items = date === scheduleDate ? allItems.slice(start, start + 50) : [];
    const maxResults = date === scheduleDate ? allItems.length : 0;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-max-results': String(maxResults) }),
      json: async () => ({ generated_at: '2026-11-17T19:00:00Z', sport_schedule_sport_event_markets: items }),
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
  assert.equal(first.markets.filter(market => market.type === '1X2').length, 3, 'same market ID with different names and books survives normalization');
  assert.ok(first.markets.some(market => market.sourceMarketId === `market-1x2-0` && market.sourceMarketName === '1st half - 1x2' && market.period === '1H'));
  assert.equal(result.events[0].status, 'FINISHED', 'documented event statuses are retained instead of status-filtered');
  assert.equal(result.events[0].sourceData.generatedAt, '2026-11-17T19:00:00Z');
  assert.equal(result.diagnostics.sportsFeedGeneratedAt, '2026-11-17T18:59:00Z');
  assert.equal(result.events[0].replacedBy, 'sr:sport_event:replacement-0');
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
  assert.equal(removedBookMarket.isLive, true, 'documented is_live market flag is preserved');
  assert.equal(removedBookMarket.providerRemoved, true);
  assert.equal(liveOnlyMarket?.providerRemoved, false, 'is_live is not a provider removal signal');
  assert.equal(liveOnlyMarket?.suspensionReason, 'live_market_outside_prematch_scope');
  const liveOnlyMarket = first.markets.find(market => market.sourceMarketId === 'market-live-only-0');
  assert.ok(liveOnlyMarket?.suspended, 'live markets are blocked by the Prematch adapter scope');
  assert.ok(liveOnlyMarket?.selections.every(selection => selection.suspended), 'live selections are blocked by the Prematch adapter scope');

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

  const publicFirst = publicEvent(first);
  assert.equal(publicFirst.replacedBy, 'sr:sport_event:replacement-0');
  assert.ok(publicFirst.sourceData?.sportEvent, 'official event payload survives public serialization');
  const publicRemoved = publicFirst.markets.find(market => market.sourceBookId === 'book-removed');
  assert.equal(publicRemoved.removed, true);
  assert.equal(publicRemoved.isLive, true);
  assert.equal(publicRemoved.selections[0].oddsAmerican, null);
  assert.equal(publicRemoved.selections[0].sourceData.removed, true);
});

test('Sportradar partial page response is rejected rather than published as a complete snapshot', async () => {
  const wibToday = todayWibKey();
  const scheduleDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sports.json')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }), text: async () => '' };
    }
    const date = url.pathname.match(/schedules\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    const start = Number(url.searchParams.get('start') || 0);
    if (date !== scheduleDate) {
      return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '0' }), json: async () => ({ generated_at: '2026-11-17T19:00:00Z', sport_schedule_sport_event_markets: [] }), text: async () => '' };
    }
    if (start > 0) {
      return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '60' }), json: async () => ({ sport_schedule_sport_event_markets: [] }), text: async () => '' };
    }
    return { ok: true, status: 200, headers: new Headers({ 'x-max-results': '60' }), json: async () => ({ generated_at: '2026-11-17T19:00:00Z', sport_schedule_sport_event_markets: Array.from({ length: 50 }, (_, index) => apiEvent(index)) }), text: async () => '' };
  };
  await assert.rejects(fetchSportradar({ daysAhead: 7 }), /empty page at offset 50 while x-max-results reports 60/);
});

test('Sportradar removed lifecycle accepts documented boolean and string true values', async () => {
  __sportradarNormalizer.resetFeedState();
  const event = {
    sport_event: {
      id: 'sr:sport_event:removed-string',
      start_time: eventTimeTomorrowWib(),
      status: 'not_started',
      competitors: [
        { id: 'home-string', name: 'Home String', qualifier: 'home' },
        { id: 'away-string', name: 'Away String', qualifier: 'away' }
      ]
    },
    markets: [{
      id: 'sr:market:removed-string',
      name: '1x2',
      is_live: false,
      books: [{
        id: 'sr:book:removed-string',
        name: 'Removed Book',
        removed: 'true',
        outcomes: [{ id: 'sr:outcome:removed-string', type: 'home', odds_decimal: '1.00', removed: 'true' }]
      }]
    }]
  };
  const wibDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sports.json')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }), text: async () => '' };
    }
    const date = url.pathname.match(/schedules\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    const items = date === wibDate ? [event] : [];
    return { ok: true, status: 200, headers: new Headers({ 'x-max-results': String(items.length) }), json: async () => ({ sport_schedule_sport_event_markets: items }), text: async () => '' };
  };
  const result = await fetchSportradar({ daysAhead: 1 });
  const market = result.events[0].markets[0];
  assert.equal(market.removed, true);
  assert.equal(market.suspended, true);
  assert.equal(market.selections[0].removed, true);
  assert.equal(market.selections[0].suspended, true);
});

test('Sportradar change log parser reads documented changes and deduplicates event IDs', () => {
  const ids = __sportradarNormalizer.changeLogEventIds({
    generated_at: '2026-11-20T10:00:00Z',
    status: { from: 1, to: 2 },
    changes: [
      { type: 'sport_event', id: 'sr:sport_event:100' },
      { type: 'sport_event', id: 'sr:sport_event:100' },
      { type: 'player', id: 'sr:player:200' }
    ]
  });
  assert.deepEqual(ids, ['sr:sport_event:100']);
});

test('Sportradar incremental polling refreshes only events reported by the change log', async () => {
  __sportradarNormalizer.resetFeedState();
  const eventId = 'sr:sport_event:bulk-0';
  const scheduleDate = new Date(Date.parse(eventTimeTomorrowWib())).toISOString().slice(0, 10);
  let marketPrice = '2.10';
  const paths = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith('/sports.json')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }), text: async () => '' };
    }
    if (url.pathname.endsWith('/sport_event_markets_changelog.json')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({
        generated_at: '2026-11-20T10:04:00Z',
        status: { from: 1, to: 2 },
        changes: [{ type: 'sport_event', id: eventId, sport_event_markets_odds_change: 2 }]
      }), text: async () => '' };
    }
    if (url.pathname.includes('/sport_events/')) {
      const event = apiEvent(0);
      event.markets[0].books[0].outcomes[0].odds_decimal = marketPrice;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({
        generated_at: '2026-11-20T10:04:01Z',
        sport_event: event.sport_event,
        markets: event.markets
      }), text: async () => '' };
    }
    const date = url.pathname.match(/schedules\\/(\\d{4}-\\d{2}-\\d{2})\\//)?.[1];
    const items = date === scheduleDate ? [apiEvent(0)] : [];
    return { ok: true, status: 200, headers: new Headers({ 'x-max-results': String(items.length) }), json: async () => ({
      generated_at: '2026-11-20T10:00:00Z',
      sport_schedule_sport_event_markets: items
    }), text: async () => '' };
  };

  const first = await fetchSportradar();
  assert.equal(first.diagnostics.mode, 'full-sync');
  assert.equal(first.events.length, 1);
  marketPrice = '2.35';
  const second = await fetchSportradar();
  assert.equal(second.diagnostics.mode, 'change-log');
  assert.equal(second.diagnostics.changesReported, 1);
  assert.equal(second.diagnostics.eventBoardsRefreshed, 1);
  assert.ok(paths.some(path => path.endsWith('/sport_event_markets_changelog.json')));
  assert.ok(paths.some(path => path.includes('/sport_events/')));
  const home = second.events[0].markets.find(market => market.sourceMarketName === '1x2').selections.find(selection => selection.label === 'HOME');
  assert.equal(home.odds, 2.35);
});

test('provider maps live and unknown statuses fail closed rather than masquerading as scheduled', () => {
  const normalize = __sportradarNormalizer.normalizedEventStatus;
  assert.equal(normalize('not_started'), 'SCHEDULED');
  assert.equal(normalize('scheduled'), 'SCHEDULED');
  assert.equal(normalize('live'), 'LIVE');
  assert.equal(normalize('in_progress'), 'LIVE');
  assert.equal(normalize('finished'), 'FINISHED');
  assert.equal(normalize('postponed'), 'SUSPENDED');
  assert.equal(normalize('provider-new-status'), 'SUSPENDED');
  assert.equal(normalize(''), 'SCHEDULED');
});

