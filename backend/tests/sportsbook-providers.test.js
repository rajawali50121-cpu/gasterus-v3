import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  THE_ODDS_API_ENABLED: 'true',
  THE_ODDS_API_KEY: 'test-existing-odds-key',
  THE_ODDS_API_EVENT_MARKETS_ENABLED: 'true',
  THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: '5',
  THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: '8',
  THE_ODDS_API_MAX_TOTAL_EVENTS: '10',
  THE_ODDS_API_SPORT_KEYS: 'soccer_epl,basketball_nba,tennis_atp_us_open'
});

const { __sportsbookProviders, fetchTheOddsApi, publicEvent } = await import('../src/sportsbook-providers.js');

test('The Odds API normalizer creates stable 1X2 and totals markets', () => {
  const event = __sportsbookProviders.normalizeOddsApiEvent({
    id: 'odds-1',
    sport_key: 'soccer_epl',
    sport_title: 'Premier League',
    commence_time: '2026-08-06T12:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [{
      key: 'book-a',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.8 }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 4.2 }] },
        { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: 1.91 }, { name: 'Under', point: 2.5, price: 1.95 }] }
      ]
    }]
  });
  assert.equal(event.sport, 'Football');
  assert.ok(event.markets.some(market => market.type === '1X2' && market.selections.length === 3));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.selections.length === 2));
  assert.equal(event.markets[0].selections[0].source, 'the-odds-api');
  assert.equal(event.markets[0].bookmaker, 'book-a');
});

test('The Odds API selects one coherent bookmaker per market and retains market-only coverage', () => {
  const event = __sportsbookProviders.normalizeOddsApiEvent({
    id: 'odds-books', sport_key: 'soccer_epl', sport_title: 'Premier League', commence_time: '2026-08-06T12:00:00Z',
    home_team: 'Arsenal', away_team: 'Chelsea',
    bookmakers: [
      { key: 'book-a', title: 'Book A', markets: [
        { key: 'h2h', last_update: '2026-08-06T11:00:00Z', outcomes: [{ name: 'Arsenal', price: 1.91 }, { name: 'Draw', price: 3.7 }, { name: 'Chelsea', price: 4.8 }] }
      ] },
      { key: 'book-b', title: 'Book B', markets: [
        { key: 'h2h', last_update: '2026-08-06T11:00:00Z', outcomes: [{ name: 'Arsenal', price: 1.8 }, { name: 'Draw', price: 3.8 }, { name: 'Chelsea', price: 4.8 }] },
        { key: 'btts', last_update: '2026-08-06T11:00:00Z', outcomes: [{ name: 'Yes', price: 1.8 }, { name: 'No', price: 2.0 }] }
      ] }
    ]
  });
  const winner = event.markets.find(market => market.type === '1X2');
  const btts = event.markets.find(market => market.type === 'BTTS');
  assert.equal(winner.bookmaker, 'Book A');
  assert.equal(winner.selections.find(selection => selection.label === 'Home').odds, 1.91);
  assert.equal(publicEvent(event).markets.find(market => market.type === '1X2').bookmaker, 'Book A');
  assert.equal(btts.bookmaker, 'Book B');
  assert.equal(btts.selections.length, 2);
});

test('The Odds API fetches extra markets by event ID and reuses the existing detail cache', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const eventId = 'existing-event-detail-cache-2027';
  const event = {
    id: eventId,
    sport_key: 'soccer_epl',
    sport_title: 'Premier League',
    commence_time: '2027-08-06T12:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [{ key: 'list-book', title: 'List Book', markets: [
      { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.91 }, { name: 'Draw', price: 3.7 }, { name: 'Chelsea', price: 4.8 }] }
    ] }]
  };
  const detail = {
    id: eventId,
    bookmakers: [{ key: 'detail-book', title: 'Detail Book', markets: [
      { key: 'btts', last_update: '2027-08-06T11:00:00Z', outcomes: [{ name: 'Yes', price: 1.85 }, { name: 'No', price: 2.05 }] },
      { key: 'totals', last_update: '2027-08-06T11:00:00Z', outcomes: [{ name: 'Over', point: 2.5, price: 1.91 }, { name: 'Under', point: 2.5, price: 1.95 }] }
    ] }]
  };
  __sportsbookProviders.providerRequestCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url);
    const body = url.pathname.includes(`/events/${eventId}/odds`)
      ? detail
      : url.pathname.includes('/sports/soccer_epl/odds') ? [event] : [];
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
  try {
    const result = await fetchTheOddsApi();
    assert.equal(result.events.length, 1);
    const markets = result.events[0].markets;
    assert.ok(markets.some(market => market.type === 'BTTS' && market.bookmaker === 'Detail Book'));
    assert.ok(markets.some(market => market.type === 'TOTALS' && market.line === 2.5));
    assert.ok(calls.some(url => url.pathname.includes(`/events/${eventId}/odds`)));
    const callCount = calls.length;
    await fetchTheOddsApi();
    assert.equal(calls.length, callCount, 'list and event-detail responses must be served from cache');
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.providerRequestCache.clear();
  }
});

test('The Odds API event-detail request budget is globally capped and shared fairly across sports', () => {
  const allocations = __sportsbookProviders.allocateOddsApiEventMarkets(['soccer', 'basketball', 'tennis']);
  const values = [...allocations.values()];
  assert.equal(values.reduce((sum, value) => sum + value, 0), 8);
  assert.ok(values.every(value => value <= 5));
  assert.ok(Math.max(...values) - Math.min(...values) <= 1);
});

test('The Odds API fetches at most eight event-detail markets across three sports with five fixture events each', async () => {
  const originalFetch = globalThis.fetch;
  const sports = ['soccer_epl', 'basketball_nba', 'tennis_atp_us_open'];
  const calls = [];
  const fixtures = new Map(sports.map(sport => [sport, Array.from({ length: 5 }, (_, index) => ({
    id: `global-cap-${sport}-${index}`,
    sport_key: sport,
    sport_title: sport,
    commence_time: new Date(Date.now() + (index + 1) * 60 * 60 * 1000).toISOString(),
    home_team: `${sport} Home ${index}`,
    away_team: `${sport} Away ${index}`,
    bookmakers: [{ key: 'list-book', title: 'List Book', markets: [
      { key: 'h2h', outcomes: [{ name: `${sport} Home ${index}`, price: 1.9 }, { name: `${sport} Away ${index}`, price: 2.0 }] }
    ] }]
  }))]));
  __sportsbookProviders.providerRequestCache.clear();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url);
    const detail = url.pathname.match(/\/sports\/([^/]+)\/events\/([^/]+)\/odds$/);
    const sportList = url.pathname.match(/\/sports\/([^/]+)\/odds$/);
    const body = detail
      ? { id: detail[2], bookmakers: [{ key: 'detail-book', title: 'Detail Book', markets: [
          { key: 'btts', last_update: new Date().toISOString(), outcomes: [{ name: 'Yes', price: 1.85 }, { name: 'No', price: 2.05 }] }
        ] }] }
      : sportList ? fixtures.get(sportList[1]) || [] : [];
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
  try {
    await fetchTheOddsApi();
    const details = calls.map(url => url.pathname.match(/\/sports\/([^/]+)\/events\/([^/]+)\/odds$/)).filter(Boolean);
    assert.equal(details.length, 8);
    const counts = new Map(sports.map(sport => [sport, details.filter(match => match[1] === sport).length]));
    assert.ok([...counts.values()].every(count => count <= 5));
    assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1);
  } finally {
    globalThis.fetch = originalFetch;
    __sportsbookProviders.providerRequestCache.clear();
  }
});

test('API-Sports preserves bookmaker labels while selecting coherent odds per market', () => {
  const payload = { response: [{ fixture: { id: 7711 }, bookmakers: [
    { id: 1, name: 'Book A', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.91 }, { value: 'Draw', odd: 3.7 }, { value: 'Beta FC', odd: 4.8 }
    ] }] },
    { id: 2, name: 'Book B', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.8 }, { value: 'Draw', odd: 3.8 }, { value: 'Beta FC', odd: 4.8 }
    ] }, { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: 1.85 }, { value: 'No', odd: 2.05 }] }] }
  ] }] };
  const odds = __sportsbookProviders.extractApiSportsOdds(payload).get('7711');
  const event = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 7711, date: '2027-08-06T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League' }, teams: { home: { name: 'Alpha FC' }, away: { name: 'Beta FC' } }
  }, odds);
  const winner = event.markets.find(market => market.type === '1X2');
  assert.equal(winner.bookmaker, 'Book A');
  assert.equal(winner.selections.find(selection => selection.label === 'Alpha FC').odds, 1.91);
  assert.ok(event.markets.some(market => market.type === 'BTTS' && market.bookmaker === 'Book B'));
});

test('provider merger combines API-Sports score with The Odds API markets', () => {
  const oddsEvent = __sportsbookProviders.normalizeOddsApiEvent({
    id: 'odds-2', sport_key: 'soccer_epl', sport_title: 'Premier League', commence_time: '2026-08-06T12:00:00Z',
    home_team: 'Arsenal', away_team: 'Chelsea',
    bookmakers: [{ key: 'book-a', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.8 }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 4.2 }] }] }]
  });
  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 7788, date: '2026-08-06T12:00:00Z', status: { short: '1H', elapsed: 23 }, venue: { name: 'Emirates Stadium' } },
    league: { name: 'Premier League', country: 'England' },
    teams: { home: { name: 'Arsenal', logo: 'home.png' }, away: { name: 'Chelsea', logo: 'away.png' } },
    goals: { home: 1, away: 0 }
  });
  const merged = __sportsbookProviders.mergeProviderEvents([
    { events: [oddsEvent] },
    { events: [apiEvent] }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].live, true);
  assert.equal(merged[0].home.score, 1);
  assert.equal(merged[0].markets.length, 1);
  assert.deepEqual(new Set(merged[0]._sources), new Set(['the-odds-api', 'api-sports']));
});


test('The Odds API prices stay visible but suspended without settlement authority', () => {
  const oddsEvent = __sportsbookProviders.normalizeOddsApiEvent({
    id: 'odds-readonly', sport_key: 'soccer_epl', sport_title: 'Premier League', commence_time: '2026-08-07T12:00:00Z',
    home_team: 'Liverpool', away_team: 'Everton',
    bookmakers: [{ key: 'book-a', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 1.7 }, { name: 'Draw', price: 3.8 }, { name: 'Everton', price: 5.1 }] }] }]
  });
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [oddsEvent] }]);
  assert.ok(merged.markets.length > 0);
  assert.ok(merged.markets.every(market => market.suspended));
  assert.ok(merged.markets.every(market => market.selections.every(selection => selection.suspended)));
});

test('API-Sports settlement authority unlocks merged FT prices', () => {
  const oddsEvent = __sportsbookProviders.normalizeOddsApiEvent({
    id: 'odds-authority', sport_key: 'soccer_epl', sport_title: 'Premier League', commence_time: '2026-08-07T12:00:00Z',
    home_team: 'Liverpool', away_team: 'Everton',
    bookmakers: [{ key: 'book-a', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 1.7 }, { name: 'Draw', price: 3.8 }, { name: 'Everton', price: 5.1 }] }] }]
  });
  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 9911, date: '2026-08-07T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League', country: 'England' },
    teams: { home: { name: 'Liverpool' }, away: { name: 'Everton' } }, goals: { home: null, away: null }
  });
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [oddsEvent] }, { events: [apiEvent] }]);
  assert.ok(merged._sources.includes('api-sports'));
  assert.ok(merged.markets.some(market => market.period === 'FT' && !market.suspended));
});

test('SharpAPI normalizer maps soccer FT/HT 1X2 handicap and totals from one sportsbook', () => {
  const base = {
    event_id: 'sharp-epl-1', event_uuid: 'sharp-uuid-epl-1', sport: 'soccer', league: 'england_-_premier_league',
    home_team: 'Arsenal', away_team: 'Chelsea', event_start_time: '2026-08-14T19:00:00Z', is_live: false,
    is_main_line: true, is_alternate_line: false, is_active: true, timestamp: '2026-08-14T10:00:00Z'
  };
  const rows = [
    { ...base, sportsbook: 'book-a', id: 'a-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.9, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.5, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.1, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-sp1', market_type: 'point_spread', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.91, line: -0.5 },
    { ...base, sportsbook: 'book-a', id: 'a-sp2', market_type: 'point_spread', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 1.95, line: 0.5 },
    { ...base, sportsbook: 'book-a', id: 'a-o', market_type: 'total_points', market_segment: 'full_game', selection: 'Over', selection_type: 'over', odds_decimal: 1.88, line: 2.5 },
    { ...base, sportsbook: 'book-a', id: 'a-u', market_type: 'total_points', market_segment: 'full_game', selection: 'Under', selection_type: 'under', odds_decimal: 1.96, line: 2.5 },
    { ...base, sportsbook: 'book-a', id: 'a-1hh', market_type: '1st_half', market_segment: '1st_half', selection: 'Arsenal', selection_type: 'home', odds_decimal: 2.3, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1hd', market_type: '1st_half', market_segment: '1st_half', selection: 'Draw', selection_type: 'draw', odds_decimal: 2.1, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1ha', market_type: '1st_half', market_segment: '1st_half', selection: 'Chelsea', selection_type: 'away', odds_decimal: 3.8, line: null },
    { ...base, sportsbook: 'book-a', id: 'a-1hsp1', market_type: '1st_half', market_segment: '1st_half', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.92, line: -0.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1hsp2', market_type: '1st_half', market_segment: '1st_half', selection: 'Chelsea', selection_type: 'away', odds_decimal: 1.94, line: 0.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1ho', market_type: '1st_half', market_segment: '1st_half', selection: 'Over', selection_type: 'over', odds_decimal: 1.89, line: 1.25 },
    { ...base, sportsbook: 'book-a', id: 'a-1hu', market_type: '1st_half', market_segment: '1st_half', selection: 'Under', selection_type: 'under', odds_decimal: 1.97, line: 1.25 },
    { ...base, sportsbook: 'book-b', id: 'b-h', market_type: 'moneyline', market_segment: 'full_game', selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.95, line: null },
    { ...base, sportsbook: 'book-b', id: 'b-d', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.6, line: null },
    { ...base, sportsbook: 'book-b', id: 'b-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.2, line: null }
  ];
  const [event] = __sportsbookProviders.normalizeSharpApiRows(rows);
  assert.equal(event.sport, 'Football');
  assert.equal(event._refs.sharpapiSportsbook, 'book-a');
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === 'FT' && market.selections.length === 3));
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === 'FT' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === 'FT' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === '1H' && market.selections.length === 3));
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === '1H' && market.selections.length === 2));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H' && market.selections.length === 2));
  assert.ok(event.markets.flatMap(market => market.selections).every(selection => selection.priceVersion && selection.priceVersion.length >= 20));
  assert.ok(event.markets.every(market => market.source === 'sharpapi'));
  assert.ok(event.markets.every(market => market.bookmaker === 'book-a'));
});

test('SharpAPI prices remain visible but suspended without result authority', () => {
  const rows = [
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7, is_main_line: true, is_active: true },
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8, is_main_line: true, is_active: true },
    { event_id: 'sharp-2', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-14T20:00:00Z', sportsbook: 'book-a', market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1, is_main_line: true, is_active: true }
  ];
  const [sharpEvent] = __sportsbookProviders.normalizeSharpApiRows(rows);
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharpEvent] }]);
  assert.ok(merged.markets.length > 0);
  assert.ok(merged.markets.every(market => market.suspended));
});

test('API-Sports authority unlocks matching SharpAPI FT and HT prices', () => {
  const base = { event_id: 'sharp-3', sport: 'soccer', league: 'epl', home_team: 'Liverpool', away_team: 'Everton', event_start_time: '2026-08-15T20:00:00Z', sportsbook: 'book-a', is_main_line: true, is_active: true };
  const sharpRows = [
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Liverpool', selection_type: 'home', odds_decimal: 1.7 },
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Draw', selection_type: 'draw', odds_decimal: 3.8 },
    { ...base, market_type: 'moneyline', market_segment: 'full_game', selection: 'Everton', selection_type: 'away', odds_decimal: 5.1 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Liverpool', selection_type: 'home', odds_decimal: 2.2 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Draw', selection_type: 'draw', odds_decimal: 2.0 },
    { ...base, market_type: '1st_half', market_segment: '1st_half', selection: 'Everton', selection_type: 'away', odds_decimal: 4.0 }
  ];
  const [sharpEvent] = __sportsbookProviders.normalizeSharpApiRows(sharpRows);
  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 20260815, date: '2026-08-15T20:00:00Z', status: { short: 'NS' } },
    league: { name: 'epl', country: 'England' },
    teams: { home: { name: 'Liverpool' }, away: { name: 'Everton' } },
    goals: { home: null, away: null }, score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } }
  });
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharpEvent] }, { events: [apiEvent] }]);
  assert.ok(merged._sources.includes('sharpapi'));
  assert.ok(merged._sources.includes('api-sports'));
  assert.ok(merged.markets.some(market => market.period === 'FT' && !market.suspended));
  assert.ok(merged.markets.some(market => market.period === '1H' && !market.suspended));
});


test('API-Sports provider status remains authoritative after SharpAPI merge', () => {
  const sharp = __sportsbookProviders.normalizeSharpApiRows([
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Arsenal', selection_type:'home', odds_decimal:1.9, is_main_line:true, is_active:true },
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Draw', selection_type:'draw', odds_decimal:3.4, is_main_line:true, is_active:true },
    { event_id:'sharp-status', sport:'soccer', league:'epl', home_team:'Arsenal', away_team:'Chelsea', event_start_time:'2026-08-14T19:00:00Z', sportsbook:'book-a', market_type:'moneyline', selection:'Chelsea', selection_type:'away', odds_decimal:4.0, is_main_line:true, is_active:true }
  ])[0];
  const api = __sportsbookProviders.normalizeApiSportsFixture({
    fixture:{ id:55, date:'2026-08-14T19:00:00Z', status:{short:'HT', elapsed:45} }, league:{name:'Premier League',country:'England'},
    teams:{home:{name:'Arsenal'},away:{name:'Chelsea'}}, goals:{home:1,away:0}, score:{halftime:{home:1,away:0}}
  });
  const [merged] = __sportsbookProviders.mergeProviderEvents([{events:[sharp]},{events:[api]}]);
  assert.equal(merged.providerStatus, 'HT');
  assert.deepEqual(merged.periodScores['1H'], {home:1,away:0});
});

test('SharpAPI price version changes only when tradable terms change, not timestamp heartbeat', () => {
  const base={event_id:'sharp-version',sport:'soccer',league:'epl',home_team:'A',away_team:'B',event_start_time:'2026-08-14T19:00:00Z',sportsbook:'book-a',market_type:'moneyline',is_main_line:true,is_active:true};
  const make=(timestamp,homeOdds=2)=>[
    {...base,id:'home',selection:'A',selection_type:'home',odds_decimal:homeOdds,timestamp},
    {...base,id:'draw',selection:'Draw',selection_type:'draw',odds_decimal:3,timestamp},
    {...base,id:'away',selection:'B',selection_type:'away',odds_decimal:4,timestamp}
  ];
  const first=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:00Z'))[0].markets[0].selections[0];
  const heartbeat=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:30Z'))[0].markets[0].selections[0];
  const changed=__sportsbookProviders.normalizeSharpApiRows(make('2026-08-14T10:00:31Z',1.95))[0].markets[0].selections[0];
  assert.equal(first.priceVersion, heartbeat.priceVersion);
  assert.notEqual(first.priceVersion, changed.priceVersion);
});


test('SharpAPI core market is fail-closed when any required outcome is suspended', () => {
  const base={event_id:'sharp-suspend',sport:'soccer',league:'epl',home_team:'A',away_team:'B',event_start_time:'2026-08-14T19:00:00Z',sportsbook:'book-a',market_type:'moneyline',is_main_line:true};
  const [event]=__sportsbookProviders.normalizeSharpApiRows([
    {...base,id:'h',selection:'A',selection_type:'home',odds_decimal:2,is_active:true},
    {...base,id:'d',selection:'Draw',selection_type:'draw',odds_decimal:3,is_active:false},
    {...base,id:'a',selection:'B',selection_type:'away',odds_decimal:4,is_active:true}
  ]);
  assert.equal(event.markets[0].suspended, true);
});


test('Live markets fail closed when the provider price timestamp is stale, missing, or heartbeat-only', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const market = updatedAt => ({ id: 'm1', suspended: false, updatedAt, selections: [{ key: 's1', suspended: false, odds: 1.9, updatedAt }] });
  const liveEvent = (updatedAt, overrides = {}) => ({ id: 'e1', live: true, status: 'LIVE', markets: [market(updatedAt)], ...overrides });
  const guard = events => __sportsbookProviders.suspendStaleLiveMarkets(events, now);

  // Harga baru (30 detik lalu, jendela live = 90 detik) tetap terbuka.
  assert.equal(guard([liveEvent('2026-10-06T11:59:30Z')])[0].markets[0].suspended, false);
  // Harga basi (10 menit lalu) ditahan, beserta seluruh selection-nya.
  const stale = guard([liveEvent('2026-10-06T11:50:00Z')])[0].markets[0];
  assert.equal(stale.suspended, true);
  assert.ok(stale.selections.every(selection => selection.suspended));
  // Tanpa timestamp = tidak bisa dibuktikan segar -> dianggap basi (fail-closed).
  assert.equal(guard([liveEvent(null)])[0].markets[0].suspended, true);
  // Prematch tidak pernah disentuh oleh guard ini.
  assert.equal(guard([liveEvent(null, { live: false, status: 'SCHEDULED' })])[0].markets[0].suspended, false);
});
