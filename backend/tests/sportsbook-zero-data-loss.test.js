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
  THE_ODDS_API_KEY: 'test-odds-api-key',
  THE_ODDS_API_BASE_URL: 'https://api.the-odds-api.test/v4',
  THE_ODDS_API_SPORT_KEYS: 'soccer_test_league',
  THE_ODDS_API_REGIONS: 'eu',
  THE_ODDS_API_MARKETS: 'h2h',
  THE_ODDS_API_REFRESH_SECONDS: '60',
  THE_ODDS_API_EVENT_MARKETS_ENABLED: 'false',
  THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: '0',
  THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: '0',
  SPORTMONKS_ENABLED: 'false',
  SPORTMONKS_API_KEY: 'fixture-sportmonks-key',
  MOVIODDS_ENABLED: 'false',
  SHARP_API_ENABLED: 'false',
  SHARP_API_KEY: 'fixture-sharpapi-key',
  API_SPORTS_ENABLED: 'false',
  API_SPORTS_KEY: 'fixture-api-sports-key',
  ODDSPAPI_ENABLED: 'false',
  ODDSPAPI_KEY: 'fixture-oddspapi-key'
});

const {
  __sportsbookProviders,
  normalizedEvent,
  normalizedMarket,
  normalizedSelection
} = await import('../src/sportsbook-providers.js');

const P = __sportsbookProviders;
const {
  normalizeOddsApiEvent,
  normalizeApiSportsFixture,
  normalizeSharpApiRows,
  normalizeSportmonksFixture,
  mergeProviderEvents,
  marketIdentity,
  mergeMarkets,
  extractApiSportsOdds,
  movioddsMarketsForGroup
} = P;

// ── Helper: build a normalized event ──────────────────────────────────────
function makeEvent(provider, providerId, home, away, startTime, markets = []) {
  return normalizedEvent({
    provider,
    providerId,
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime,
    home,
    away,
    markets
  });
}

function makeMarket(id, type, period, line, source, bookmaker, selections, suspended = false) {
  return normalizedMarket('event-1', {
    id,
    key: `${source}:${type}:${period}:${line ?? ''}`,
    name: type,
    type,
    period,
    line,
    source,
    bookmaker,
    suspended,
    selections
  });
}

function makeSelection(key, label, odds, source, line = null, suspended = false) {
  return normalizedSelection('event-1', 'market-1', label, odds, {
    line,
    source,
    sourceSelectionId: key,
    suspended
  });
}

// ── PART 7.1: Two providers give identical odds for same selection ──
test('B1: Two providers give identical odds for same selection — both retained', () => {
  const eventA = makeEvent('the-odds-api', 'evt-1', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ])
  ]);
  const eventB = makeEvent('api-sports', 'evt-2', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m2', '1X2', 'FT', null, 'api-sports', 'book-x', [
      makeSelection('s4', 'Home', 1.91, 'api-sports'),
      makeSelection('s5', 'Draw', 3.4, 'api-sports'),
      makeSelection('s6', 'Away', 4.2, 'api-sports')
    ])
  ]);
  const merged = mergeProviderEvents([
    { provider: 'the-odds-api', events: [eventA] },
    { provider: 'api-sports', events: [eventB] }
  ]);
  assert.equal(merged.length, 1);
  const h2h = merged[0].markets.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 2, 'Both provider markets should be retained');
  assert.ok(h2h.some(m => m.source === 'the-odds-api' && m.bookmaker === 'book-a'));
  assert.ok(h2h.some(m => m.source === 'api-sports' && m.bookmaker === 'book-x'));
});

// ── PART 7.2: Two bookmakers give identical odds ──
test('B2: Two bookmakers give identical odds — both retained', () => {
  const event = makeEvent('the-odds-api', 'evt-1', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ]),
    makeMarket('m2', '1X2', 'FT', null, 'the-odds-api', 'book-b', [
      makeSelection('s4', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s5', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s6', 'Away', 4.2, 'the-odds-api')
    ])
  ]);
  const merged = mergeProviderEvents([{ provider: 'the-odds-api', events: [event] }]);
  const h2h = merged[0].markets.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 2, 'Both bookmaker markets should be retained');
  assert.equal(h2h.find(m => m.bookmaker === 'book-a').selections[0].odds, 1.91);
  assert.equal(h2h.find(m => m.bookmaker === 'book-b').selections[0].odds, 1.91);
});

// ── PART 7.3: One bookmaker has multiple different prices ──
test('B3: One bookmaker multiple different prices — none overwritten', () => {
  const event = makeEvent('the-odds-api', 'evt-1', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ]),
    makeMarket('m2', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s4', 'Home', 2.10, 'the-odds-api'),
      makeSelection('s5', 'Draw', 3.10, 'the-odds-api'),
      makeSelection('s6', 'Away', 4.50, 'the-odds-api')
    ])
  ]);
  const merged = mergeProviderEvents([{ provider: 'the-odds-api', events: [event] }]);
  const h2h = merged[0].markets.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 2, 'Different quotes from same bookmaker retained');
  assert.ok(h2h.find(m => m.selections[0].odds === 1.91), 'First quote retained');
  assert.ok(h2h.find(m => m.selections[0].odds === 2.10), 'Second quote retained');
});

// ── PART 7.4: Markets with different lines ──
test('B4: Markets with different lines — not merged', () => {
  const event = normalizeOddsApiEvent({
    id: 'evt-lines',
    sport_key: 'soccer_epl',
    sport_title: 'Premier League',
    commence_time: '2026-08-06T12:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [{
      key: 'book-a',
      title: 'Book A',
      markets: [
        { key: 'spreads', outcomes: [{ name: 'Arsenal', point: -0.5, price: 1.91 }, { name: 'Chelsea', point: 0.5, price: 1.91 }] },
        { key: 'spreads', outcomes: [{ name: 'Arsenal', point: -1.0, price: 1.85 }, { name: 'Chelsea', point: 1.0, price: 2.0 }] }
      ]
    }]
  });
  const handicaps = event.markets.filter(m => m.type === 'HANDICAP');
  assert.equal(handicaps.length, 2, 'Different handicap lines should be separate markets');
  const lines = handicaps.map(m => m.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [-1, -0.5]);
});

// ── PART 7.5: Markets with different periods ──
test('B5: Markets with different periods — not merged', () => {
  const events = normalizeSharpApiRows([
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'book-a',
      selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.9, id: 's1' },
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'book-a',
      selection: 'Draw', selection_type: 'draw', odds_decimal: 3.4, id: 's2' },
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'book-a',
      selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.2, id: 's3' },
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'first_half', sportsbook: 'book-a',
      selection: 'Arsenal', selection_type: 'home', odds_decimal: 2.3, id: 's4' },
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'first_half', sportsbook: 'book-a',
      selection: 'Draw', selection_type: 'draw', odds_decimal: 2.1, id: 's5' },
    { event_id: 'evt-periods', event_uuid: 'evt-periods-uuid', sport: 'soccer', league: 'epl', home_team: 'Arsenal', away_team: 'Chelsea',
      event_start_time: '2026-08-06T12:00:00Z', is_live: false,
      is_main_line: true, is_active: true, timestamp: '2026-08-06T10:00:00Z',
      market_type: 'moneyline', market_segment: 'first_half', sportsbook: 'book-a',
      selection: 'Chelsea', selection_type: 'away', odds_decimal: 3.8, id: 's6' }
  ]);
  assert.equal(events.length, 1, 'One event created');
  const periods = events[0].markets.map(m => m.period);
  assert.ok(periods.includes('FT'), 'FT market present');
  assert.ok(periods.includes('1H'), '1H market present');
});

// ── PART 7.6: All Sportmonks valid markets retained ──
test('B6: Sportmonks retains all valid market types (not just core)', () => {
  const fixture = {
    id: 'sm-1',
    state: { name: 'NS', short_name: 'NS' },
    starting_at_timestamp: Math.floor(Date.now() / 1000) + 3600,
    participants: [
      { name: 'Arsenal', meta: { location: 'home' }, image_path: null },
      { name: 'Chelsea', meta: { location: 'away' }, image_path: null }
    ],
    league: { name: 'Premier League', country: { name: 'England' }, image_path: null },
    scores: [],
    odds: [
      { market_id: '1', market_description: '1X2', name: '1X2', id: '1', stopped: false, value: 1.9, latest_bookmaker_update: null },
      { market_id: '2', market_description: 'Match Winner', name: '1', id: '2', stopped: false, value: 1.9, latest_bookmaker_update: null },
      { market_id: '3', market_description: 'Correct Score', name: '1-0', id: '3', stopped: false, value: 7.5, latest_bookmaker_update: null },
      { market_id: '4', market_description: 'Corners', name: 'Over 9.5', id: '4', stopped: false, value: 1.85, latest_bookmaker_update: null },
      { market_id: '5', market_description: 'Cards', name: 'Over 3.5', id: '5', stopped: false, value: 2.1, latest_bookmaker_update: null },
      { market_id: '6', market_description: 'BTTS', name: 'Yes', id: '6', stopped: false, value: 1.75, latest_bookmaker_update: null }
    ]
  };
  const event = normalizeSportmonksFixture(fixture, fixture.odds);
  assert.ok(event, 'Sportmonks event should be created');
  const types = event.markets.map(m => m.type);
  assert.equal(event.markets.length, 6, 'All 6 Sportmonks markets retained');
  assert.ok(types.includes('1X2'), '1X2 retained');
  assert.ok(types.includes('BTTS'), 'BTTS retained');
  // Non-core types (Correct Score, Corners, Cards) are retained even if classified as OTHER
  const nonCore = types.filter(t => t !== '1X2' && t !== 'BTTS');
  assert.equal(nonCore.length, 3, 'Correct Score, Corners, Cards all retained');
});

// ── PART 7.7: All SharpAPI sportsbooks retained ──
test('B7: SharpAPI retains all sportsbooks, not just chosen one', () => {
  const base = {
    event_id: 'sharp-e1', event_uuid: 'sharp-uuid-1', sport: 'soccer',
    league: 'england_-_premier_league', home_team: 'Arsenal', away_team: 'Chelsea',
    event_start_time: '2026-08-14T19:00:00Z', is_live: false
  };
  const rows = [
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'sbobet',
      selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.9, id: 's1' },
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'sbobet',
      selection: 'Draw', selection_type: 'draw', odds_decimal: 3.5, id: 's2' },
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'sbobet',
      selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.1, id: 's3' },
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'pinnacle',
      selection: 'Arsenal', selection_type: 'home', odds_decimal: 1.95, id: 's4' },
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'pinnacle',
      selection: 'Draw', selection_type: 'draw', odds_decimal: 3.6, id: 's5' },
    { ...base, is_main_line: true, is_active: true, timestamp: '2026-08-14T10:00:00Z',
      market_type: 'moneyline', market_segment: 'full_game', sportsbook: 'pinnacle',
      selection: 'Chelsea', selection_type: 'away', odds_decimal: 4.2, id: 's6' }
  ];
  const [event] = normalizeSharpApiRows(rows);
  assert.ok(event, 'SharpAPI event created');
  const bookmakers = [...new Set(event.markets.map(m => m.bookmaker))];
  assert.deepEqual(bookmakers.sort(), ['pinnacle', 'sbobet'], 'Both sportsbooks retained');
  assert.ok(event._refs.sharpapiSportsbook, 'sharpapiSportsbook ref present');
});

// ── PART 7.8: All The Odds API bookmakers retained ──
test('B8: The Odds API retains all bookmakers', () => {
  const event = normalizeOddsApiEvent({
    id: 'odds-books',
    sport_key: 'soccer_epl',
    sport_title: 'Premier League',
    commence_time: '2026-08-06T12:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [
      { key: 'book-a', title: 'Book A', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.91 }, { name: 'Draw', price: 3.7 }, { name: 'Chelsea', price: 4.8 }] }
      ] },
      { key: 'book-b', title: 'Book B', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.8 }, { name: 'Draw', price: 3.8 }, { name: 'Chelsea', price: 4.8 }] }
      ] }
    ]
  });
  const h2h = event.markets.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 2, 'Both bookmakers retained');
  assert.ok(h2h.some(m => m.bookmaker === 'Book A'));
  assert.ok(h2h.some(m => m.bookmaker === 'Book B'));
});

// ── PART 7.9: All API-Sports bets and selections retained ──
test('B9: API-Sports retains all bets, bookmakers, markets, selections', () => {
  const payload = { response: [{ fixture: { id: 7711 }, bookmakers: [
    { id: 1, name: 'Book A', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.91 }, { value: 'Draw', odd: 3.7 }, { value: 'Beta FC', odd: 4.8 }
    ] }] },
    { id: 2, name: 'Book B', bets: [{ id: 1, name: 'Match Winner', values: [
      { value: 'Alpha FC', odd: 1.8 }, { value: 'Draw', odd: 3.8 }, { value: 'Beta FC', odd: 4.8 }
    ] }, { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: 1.85 }, { value: 'No', odd: 2.05 }] }] }
  ] }] };
  const odds = extractApiSportsOdds(payload).get('7711');
  const event = normalizeApiSportsFixture({
    fixture: { id: 7711, date: '2027-08-06T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League' }, teams: { home: { name: 'Alpha FC' }, away: { name: 'Beta FC' } }
  }, odds);
  const h2hMarkets = event.markets.filter(m => m.type === '1X2');
  assert.equal(h2hMarkets.length, 2, 'Both bookmaker 1X2 markets retained');
  assert.ok(h2hMarkets.some(m => m.bookmaker === 'Book A'));
  assert.ok(h2hMarkets.some(m => m.bookmaker === 'Book B'));
  const bttsMarkets = event.markets.filter(m => m.type === 'BTTS');
  assert.equal(bttsMarkets.length, 1, 'BTTS market retained');
});

// ── PART 7.10: MovioOdds invalid quote doesn't remove valid quotes ──
test('B10: MovioOdds invalid quote does not remove valid quotes', () => {
  const match = { id: 'm1', home: 'Arsenal', away: 'Chelsea', league: 'Premier League',
    kickoff_utc: new Date(Date.now() + 86400000).toISOString(), in_play: false, score: '' };
  const quotes = [
    { group_id: '40', sel_id: 's1', odds_dec: 1.9, label: 'Arsenal', market_id: 'mk1', phase: 'prematch', suspended: false },
    { group_id: '40', sel_id: 's2', odds_dec: null, label: 'Draw', market_id: 'mk1', phase: 'prematch', suspended: false },
    { group_id: '40', sel_id: 's3', odds_dec: 4.2, label: 'Chelsea', market_id: 'mk1', phase: 'prematch', suspended: false },
    { group_id: '40', sel_id: 's4', odds_dec: 1.5, label: 'Arsenal', market_id: 'mk1', phase: 'prematch', suspended: true }
  ];
  const markets = movioddsMarketsForGroup(match, '40', quotes, new Date().toISOString());
  assert.ok(markets, 'Markets should be returned despite invalid quotes');
  assert.ok(markets.length > 0, 'At least one market retained');
  const selections = markets.flatMap(m => m.selections);
  const validOdds = selections.filter(s => s.odds === 1.9 || s.odds === 4.2);
  assert.equal(validOdds.length, 2, 'Valid quotes preserved');
  const nullOdds = selections.find(s => s.odds === null || s.odds === undefined);
  assert.ok(!nullOdds, 'Null odds filtered out');
  const suspendedOdds = selections.find(s => s.odds === 1.5);
  assert.ok(!suspendedOdds, 'Suspended quote not individually preserved (filtered at group level)');
  // Market itself may be suspended if incomplete (only 2 of 3 outcomes)
  const market = markets[0];
  assert.ok(market.suspended, 'Market suspended when not all outcomes available');
});

// ── PART 7.11: Event unmatched retained ──
test('B11: Unmatched event retained as standalone', () => {
  const event = makeEvent('the-odds-api', 'evt-unmatched', 'Team X', 'Team Y', '2026-08-07T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ])
  ]);
  const merged = mergeProviderEvents([{ provider: 'the-odds-api', events: [event] }]);
  assert.equal(merged.length, 1, 'Unmatched event retained');
  assert.equal(merged[0]._sources[0], 'the-odds-api');
});

// ── PART 7.12: Event ambiguous retained without wrong merge ──
test('B12: Two different provider events with same teams merge with all markets', () => {
  const eventA = makeEvent('the-odds-api', 'evt-a', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ])
  ]);
  const eventB = makeEvent('api-sports', 'evt-b', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m2', '1X2', 'FT', null, 'api-sports', 'book-x', [
      makeSelection('s4', 'Home', 1.8, 'api-sports'),
      makeSelection('s5', 'Draw', 3.8, 'api-sports'),
      makeSelection('s6', 'Away', 4.8, 'api-sports')
    ])
  ]);
  const merged = mergeProviderEvents([
    { provider: 'the-odds-api', events: [eventA] },
    { provider: 'api-sports', events: [eventB] }
  ]);
  assert.equal(merged.length, 1, 'Events merged into one');
  assert.deepEqual(new Set(merged[0]._sources), new Set(['the-odds-api', 'api-sports']));
  const h2h = merged[0].markets.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 2, 'Both bookmaker markets retained after merge');
});

// ── PART 7.13: Event more than 500 not lost ──
test('B13: More than 500 events not lost (no silent truncation)', () => {
  const events = [];
  for (let i = 0; i < 600; i += 1) {
    events.push(makeEvent('the-odds-api', `evt-${i}`, `Home ${i}`, `Away ${i}`, '2026-08-06T12:00:00Z', [
      makeMarket(`m${i}`, '1X2', 'FT', null, 'the-odds-api', 'book-a', [
        makeSelection(`s${i}`, 'Home', 1.91, 'the-odds-api'),
        makeSelection(`s${i}-d`, 'Draw', 3.4, 'the-odds-api'),
        makeSelection(`s${i}-a`, 'Away', 4.2, 'the-odds-api')
      ])
    ]));
  }
  const merged = mergeProviderEvents([{ provider: 'the-odds-api', events }]);
  assert.equal(merged.length, 600, 'All 600 events retained (no 500-event cap)');
});

// ── PART 7.14: Market identity includes source and bookmaker ──
test('B14: marketIdentity includes source and bookmaker', () => {
  const sel = [makeSelection('s1', 'Home', 1.91, 'the-odds-api')];
  const m1 = makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', sel);
  const m2 = makeMarket('m2', '1X2', 'FT', null, 'api-sports', 'book-x', sel);
  const m3 = makeMarket('m3', '1X2', 'FT', null, 'the-odds-api', 'book-b', sel);
  const id1 = marketIdentity(m1);
  const id2 = marketIdentity(m2);
  const id3 = marketIdentity(m3);
  assert.notEqual(id1, id2, 'Different providers = different identity');
  assert.notEqual(id1, id3, 'Different bookmakers = different identity');
  assert.notEqual(id2, id3, 'Different provider+bookmaker = different identity');
  const m4 = makeMarket('m4', '1X2', 'FT', null, 'the-odds-api', 'book-a', sel);
  assert.equal(marketIdentity(m1), marketIdentity(m4), 'Same source+bookmaker+type+period+line = same identity');
});

// ── PART 7.15: mergeMarkets retains cross-provider markets ──
test('B15: mergeMarkets retains all cross-provider/bookmaker markets', () => {
  const target = [
    makeMarket('m1', '1X2', 'FT', null, 'sportmonks', null, [
      makeSelection('s1', 'Home', 1.8, 'sportmonks'),
      makeSelection('s2', 'Draw', 3.4, 'sportmonks'),
      makeSelection('s3', 'Away', 4.2, 'sportmonks')
    ])
  ];
  const incoming = [
    makeMarket('m2', '1X2', 'FT', null, 'sharpapi', 'book-a', [
      makeSelection('s4', 'Home', 1.9, 'sharpapi'),
      makeSelection('s5', 'Draw', 3.5, 'sharpapi'),
      makeSelection('s6', 'Away', 4.0, 'sharpapi')
    ]),
    makeMarket('m3', '1X2', 'FT', null, 'sharpapi', 'pinnacle', [
      makeSelection('s7', 'Home', 1.95, 'sharpapi'),
      makeSelection('s8', 'Draw', 3.6, 'sharpapi'),
      makeSelection('s9', 'Away', 4.1, 'sharpapi')
    ])
  ];
  const merged = mergeMarkets(target, incoming, false);
  const h2h = merged.filter(m => m.type === '1X2');
  assert.equal(h2h.length, 3, 'All three 1X2 markets retained');
  const sources = h2h.map(m => `${m.source}:${m.bookmaker}`).sort();
  assert.deepEqual(sources, ['sharpapi:book-a', 'sharpapi:pinnacle', 'sportmonks:null']);
});

// ── PART 7.16: Provenance preserved through merge ──
test('B16: Provenance preserved through event and market merge', () => {
  const eventA = makeEvent('the-odds-api', 'evt-1', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m1', '1X2', 'FT', null, 'the-odds-api', 'book-a', [
      makeSelection('s1', 'Home', 1.91, 'the-odds-api'),
      makeSelection('s2', 'Draw', 3.4, 'the-odds-api'),
      makeSelection('s3', 'Away', 4.2, 'the-odds-api')
    ])
  ]);
  const eventB = makeEvent('api-sports', 'evt-2', 'Arsenal', 'Chelsea', '2026-08-06T12:00:00Z', [
    makeMarket('m2', '1X2', 'FT', null, 'api-sports', 'book-x', [
      makeSelection('s4', 'Home', 1.8, 'api-sports'),
      makeSelection('s5', 'Draw', 3.8, 'api-sports'),
      makeSelection('s6', 'Away', 4.8, 'api-sports')
    ])
  ]);
  const merged = mergeProviderEvents([
    { provider: 'the-odds-api', events: [eventA] },
    { provider: 'api-sports', events: [eventB] }
  ]);
  assert.deepEqual(new Set(merged[0]._sources), new Set(['the-odds-api', 'api-sports']));
  assert.ok(merged[0]._refs['the-odds-api'], 'Odds API ref preserved');
  assert.ok(merged[0]._refs['api-sports'], 'API-Sports ref preserved');
  const h2h = merged[0].markets.filter(m => m.type === '1X2');
  assert.ok(h2h.some(m => m.source === 'the-odds-api' && m.bookmaker === 'book-a'), 'Odds API provenance preserved');
  assert.ok(h2h.some(m => m.source === 'api-sports' && m.bookmaker === 'book-x'), 'API-Sports provenance preserved');
  const allSelections = h2h.flatMap(m => m.selections);
  assert.ok(allSelections.every(s => s.source === 'the-odds-api' || s.source === 'api-sports'), 'Selection provenance preserved');
});
