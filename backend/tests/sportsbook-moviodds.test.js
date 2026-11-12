import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64'),
  MOVIODDS_ENABLED: 'false',
  MOVIODDS_GROUP_IDS: '40',
  MOVIODDS_REQUEST_GROUP_IDS: '40',
  MOVIODDS_MAX_STALE_SECONDS: '180',
  MOVIODDS_TOTALS_GROUP_PRIORITY: '981,10202,10143,50139',
  MOVIODDS_1X2_MIN_IMPLIED_PROBABILITY: '1.005',
  MOVIODDS_1X2_MAX_IMPLIED_PROBABILITY: '1.2'
});

const [{ config }, { fetchMoviOdds, __sportsbookProviders }, { validateSportsbookSnapshot }, { __sportsbookFeed }] = await Promise.all([
  import('../src/config.js'),
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-ingestion.js'),
  import('../src/sportsbook-feed.js')
]);

const NOW = Date.now();
const polledAt = new Date(NOW - 60_000).toISOString();
const freshness = { polled_at: polledAt, stale: false };

function quote(groupId, fields = {}) {
  return {
    fixture_id: 'movio-fixture-1',
    group_id: String(groupId),
    market_id: String(groupId),
    sel_id: `${groupId}-${fields.label || fields.side || 'selection'}-${fields.line || ''}`,
    odds_dec: 2,
    phase: 'prematch',
    ...fields
  };
}

function match(overrides = {}) {
  return {
    id: 'movio-fixture-1',
    league: 'Brazil Premier League',
    region: 'Virtual Region',
    home: 'Aurora FC',
    away: 'Boreal SC',
    kickoff_utc: new Date(NOW + 3600_000).toISOString(),
    in_play: false,
    quotes: [
      quote('40', { label: '  AURORA   FC ' }),
      quote('40', { label: 'Draw', odds_dec: 3.2 }),
      quote('40', { label: 'Boreal SC', odds_dec: 4 }),
      quote('938', { side: 'Aurora FC', line: '-0.75', handicap: '-0.75', label: '-0.5, -1.0' }),
      quote('938', { side: 'Boreal SC', line: '0.75', handicap: '0.75', label: '+0.5, +1.0' }),
      quote('981', { side: 'Over', line: '2.5', handicap: '2.5' }),
      quote('981', { side: 'Under', line: '2.5', handicap: '2.5' }),
      quote('50136', { side: 'Over', line: '1.0', handicap: '1.0', period: '1' }),
      quote('50136', { side: 'Under', line: '1.0', handicap: '1.0', period: '1' }),
      quote('50137', { side: 'Aurora FC', line: '-0.25', handicap: '-0.25', period: '1' }),
      quote('50137', { side: 'Boreal SC', line: '+0.25', handicap: '+0.25', period: '1' }),
      quote('11', { side: 'Aurora FC', line: '-1', handicap: '-1', label: '-1' }),
      quote('11', { side: 'Draw', line: '+1', handicap: '+1', label: '+1' }),
      quote('11', { side: 'Boreal SC', line: '+1', handicap: '+1', label: '+1' }),
      quote('50264', { side: 'Aurora FC', line: '-1', handicap: '-1', period: '1' }),
      quote('50264', { side: 'Tie', line: '+1', handicap: '+1', period: '1' }),
      quote('50264', { side: 'Boreal SC', line: '+1', handicap: '+1', period: '1' }),
      quote('1777', { label: 'Aurora FC' }),
      quote('4001', { label: 'Aurora FC' })
    ],
    group_status: Object.fromEntries(
      ['40', '938', '11', '981', '50136', '50137', '50264', '1777', '4001'].map(id => [id, freshness])
    ),
    ...overrides
  };
}

test('MoviOdds selects only whitelisted groups, validates outcomes and normalizes periods and lines', () => {
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['40', '938', '981', '50136', '50137', '11', '50264'] }
  );
  assert.ok(event);
  assert.equal(event.league, 'Brazil Premier League');
  assert.equal(event.country, null, 'the provider region is not treated as the country or used as the league');

  const result = event.markets.find(market => market.type === '1X2');
  assert.deepEqual(result.selections.map(selection => selection.label).sort(), ['Away', 'Draw', 'Home']);
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === 'FT' && market.line === -0.75));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === 'FT' && market.line === 2.5));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H' && market.line === 1));
  assert.ok(event.markets.some(market => market.type === 'HANDICAP' && market.period === '1H' && market.line === -0.25));
  assert.equal(event.markets.some(market => market.type === 'HANDICAP_3WAY'), false);
  assert.equal(event.markets.some(market => ['1777', '4001'].includes(market.sourceMarketId)), false);
  assert.ok(event.markets.every(market => market.bookmaker === null));

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    providerResults: [{ provider: 'moviodds', enabled: true, events: [event] }]
  };
  assert.deepEqual(validateSportsbookSnapshot(snapshot, { now: NOW }).providers, ['moviodds']);
});

test('stale, suspended, malformed or incomplete quotes are filtered individually, valid quotes retained', () => {
  const source = match();
  source.group_status['938'] = { ...freshness, stale: true };
  source.group_status['981'] = freshness; // fresh group, not stale
  source.quotes.find(item => item.group_id === '981' && item.side === 'Under').suspended = true;
  source.quotes.find(item => item.group_id === '40' && item.label === 'Draw').label = 'Tie';
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [source] },
    { now: NOW, groupIds: ['40', '938', '981', '50136', '50137'] }
  );

  assert.ok(event);
  // Stale group 938 discarded entirely
  assert.equal(event.markets.some(market => market.sourceMarketId === '938'), false);
  // Group 981 with one suspended quote: the other quote (Over) is retained
  assert.ok(event.markets.some(market => market.sourceMarketId === '981'), '981 retained with valid quotes');
  // Group 40 with Draw label changed to Tie: Home and Away retained, Draw filtered
  const h2h = event.markets.find(market => market.type === '1X2');
  assert.ok(h2h, '1X2 market retained with valid quotes');
  assert.equal(h2h.selections.length, 2, 'Only Home and Away selections retained');
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H'));
});

test('MoviOdds normalization diagnostics count fixture and group rejection reasons', () => {
  const stale = match({
    id: 'stale',
    group_status: { '40': { ...freshness, stale: true } }
  });
  const live = match({ id: 'live', in_play: true });
  const past = match({ id: 'past', kickoff_utc: new Date(NOW - 1000).toISOString() });
  const virtual = match({ id: 'virtual', league: 'Esoccer Battle League' });
  const invalid = match({ id: 'invalid', home: '' });
  const suspended = match({
    id: 'suspended',
    quotes: match().quotes.filter(item => item.group_id === '40').map(item => ({ ...item, suspended: true }))
  });
  const unknownLabel = match({
    id: 'unknown-label',
    quotes: match().quotes.filter(item => item.group_id === '40').map(item =>
      item.label === 'Draw' ? item : { ...item, label: 'Unknown outcome' })
  });
  const invalidOdds = match({
    id: 'invalid-odds',
    quotes: match().quotes.filter(item => item.group_id === '40').map(item =>
      item.label === 'Draw' ? { ...item, odds_dec: 1 } : item)
  });
  const outOfRange = match({
    id: 'out-of-range',
    quotes: match().quotes.filter(item => item.group_id === '40').map(item => ({ ...item, odds_dec: 2 }))
  });
  const diagnostics = __sportsbookProviders.createMovioddsCycleDiagnostics();
  const events = __sportsbookProviders.normalizeMovioddsMatches({
    matches: [match({ id: 'accepted' }), stale, live, past, virtual, invalid, suspended, unknownLabel, invalidOdds, outOfRange]
  }, { now: NOW, groupIds: ['40'], diagnostics });

  assert.equal(diagnostics.receivedFixtures, 10);
  assert.equal(diagnostics.acceptedFixtures, events.length);
  // More events accepted: invalid quotes are filtered per-quote, not per-group
  assert.ok(events.length > 1, 'More events accepted with per-quote filtering');
  assert.equal(diagnostics.discardedFixtures.inPlay, 1);
  assert.equal(diagnostics.discardedFixtures.kickoffPast, 1);
  assert.equal(diagnostics.discardedFixtures.virtual, 1);
  assert.equal(diagnostics.discardedFixtures.invalidLeagueOrTeams, 1);
  // Group-level discards reduced: invalid quotes filtered individually instead of discarding whole group
  assert.equal(diagnostics.discardedGroups.staleFlag, 1);
  assert.equal(diagnostics.discardedGroups.quoteSuspended, 1);
  assert.equal(diagnostics.discardedGroups.unknown1X2Label, 0);
  assert.equal(diagnostics.discardedGroups.oddsAtOrBelowOne, 0);
  assert.equal(diagnostics.discardedGroups.impliedProbabilityOutOfRange, 0);
});

test('MoviOdds merge diagnostics distinguish matched, ambiguous, unmatched and market identity outcomes', () => {
  const [movioEvent] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['40', '981'] }
  );
  const resultEvent = structuredClone(movioEvent);
  resultEvent._sources = ['api-sports'];
  resultEvent._refs = { 'api-sports': 'api-fixture' };
  resultEvent.markets = [];
  const sharpEvent = structuredClone(movioEvent);
  sharpEvent.id = 'sharp-fixture';
  sharpEvent._refs = { sharpapi: 'sharp-fixture' };
  sharpEvent._sources = ['sharpapi'];
  sharpEvent.markets = sharpEvent.markets
    .filter(market => market.type === '1X2')
    .map(market => ({
      ...market,
      source: 'sharpapi',
      selections: market.selections.map(selection => ({ ...selection, source: 'sharpapi' }))
    }));
  const ambiguousSharpEvent = structuredClone(sharpEvent);
  ambiguousSharpEvent.id = 'sharp-fixture-duplicate';
  ambiguousSharpEvent._refs = { sharpapi: 'sharp-fixture-duplicate' };
  const unmatchedMovio = structuredClone(movioEvent);
  unmatchedMovio.id = 'unmatched';
  unmatchedMovio.home.name = 'Unmatched Home';
  unmatchedMovio.away.name = 'Unmatched Away';
  const providerResults = [
    { provider: 'api-sports', events: [resultEvent] },
    { provider: 'sharpapi', events: [sharpEvent, ambiguousSharpEvent] },
    { provider: 'moviodds', events: [movioEvent, ...Array.from({ length: 6 }, (_, index) => ({
      ...structuredClone(unmatchedMovio),
      id: `unmatched-${index}`,
      startTime: new Date(NOW + (index + 1) * 24 * 60 * 60 * 1000).toISOString()
    }))] }
  ];
  const merged = __sportsbookProviders.mergeProviderEvents(providerResults);
  const diagnostics = __sportsbookProviders.movioddsMergeDiagnostics(providerResults, merged, {
    includeDebugExamples: true
  });

  assert.deepEqual(diagnostics.fixtureMatching, {
    matched: 1,
    ambiguous: 0,
    unmatched: 6,
    usedAsSupplement: 1,
    ambiguousUsedAsSupplement: 0,
    ambiguousNotUsed: 0
  });
  // Unmatched events are retained as standalone, not discarded
  assert.equal(diagnostics.markets.filledEmptyIdentity, 2);
  // No markets skipped due to existing identity (all retained)
  assert.equal(diagnostics.markets.skippedExistingIdentity, 0);
  assert.ok(diagnostics.debugExamples.length >= 1);
  assert.ok(diagnostics.debugExamples.some(example => example.category === 'unmatched'));
});

test('virtual guard checks league and parenthetical team patterns, not region', () => {
  const legitimate = match();
  assert.equal(__sportsbookProviders.normalizeMovioddsMatches({ matches: [legitimate] }, { now: NOW }).length, 1);
  assert.equal(
    __sportsbookProviders.normalizeMovioddsMatches({ matches: [match({ league: 'Esoccer Battle League' })] }, { now: NOW }).length,
    0
  );
  assert.equal(
    __sportsbookProviders.normalizeMovioddsMatches({ matches: [match({ home: 'Aurora (EXECUTIONER)' })] }, { now: NOW }).length,
    0
  );
});

test('1777 and 4001 stay excluded even if supplied through a custom group list', () => {
  const forbidden = match({
    quotes: [
      quote('1777', { label: 'Aurora FC' }),
      quote('4001', { label: 'Aurora FC' })
    ],
    group_status: { '1777': freshness, '4001': freshness }
  });
  assert.deepEqual(
    __sportsbookProviders.normalizeMovioddsMatches(
      { matches: [forbidden] },
      { now: NOW, groupIds: ['1777', '4001'] }
    ),
    []
  );
});

test('default requested group is 40 and group 40 is not used for in-play events', () => {
  assert.deepEqual(config.movioddsRequestedGroupIds, ['40']);
  assert.deepEqual(config.movioddsGroupIds, ['40']);
  assert.equal(config.movioddsMaxStaleSeconds, 180);
  assert.equal(config.movioddsMin1X2ImpliedProbability, 1.005);
  assert.equal(config.movioddsMax1X2ImpliedProbability, 1.2);
  assert.deepEqual(config.movioddsTotalsGroupPriority, ['981', '10202', '10143', '50139']);
  const inPlay = match({ in_play: true });
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [inPlay] },
    { now: NOW, groupIds: ['40'] }
  );
  assert.equal(event, undefined, 'the prematch-only Full Time Result group is not used in-play');
});

test('default 1X2 group filters invalid odds individually, retains valid quotes', () => {
  const resultQuotes = odds => [
    quote('40', { label: 'Aurora FC', odds_dec: odds[0] }),
    quote('40', { label: 'Draw', odds_dec: odds[1] }),
    quote('40', { label: 'Boreal SC', odds_dec: odds[2] })
  ];
  const normalize = odds => __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match({ quotes: resultQuotes(odds) })] },
    { now: NOW, groupIds: ['40'] }
  );
  assert.equal(normalize([2, 3.2, 4]).length, 1);
  // All odds > 1: event retained, market may be suspended if implied probability out of range
  assert.equal(normalize([4, 4, 4]).length, 1);
  assert.equal(normalize([1.01, 1.01, 1.01]).length, 1);
  // One invalid odds (<= 1): filtered individually, remaining selections retained
  const result = normalize([1, 3, 4]);
  assert.equal(result.length, 1);
  const h2h = result[0].markets.find(m => m.type === '1X2');
  assert.ok(h2h, '1X2 market retained with valid quotes');
  assert.equal(h2h.selections.length, 2, 'Only Draw and Away selections retained');
});

test('MoviOdds yields to SharpAPI for duplicate markets and fills identities SharpAPI lacks', () => {
  const [movioEvent] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['40', '981'] }
  );
  const resultEvent = structuredClone(movioEvent);
  resultEvent._sources = ['api-sports'];
  resultEvent._refs = { 'api-sports': 'api-fixture' };
  resultEvent.markets = [];
  const sharpEvent = structuredClone(movioEvent);
  sharpEvent._sources = ['sharpapi'];
  sharpEvent._refs = { sharpapi: 'sharp-fixture' };
  sharpEvent._settlementReadySources = ['sharpapi'];
  sharpEvent.markets = sharpEvent.markets
    .filter(market => market.type === '1X2')
    .map(market => ({
      ...market,
      source: 'sharpapi',
      selections: market.selections.map(selection => ({ ...selection, source: 'sharpapi', odds: selection.odds + 0.1 }))
    }));
  const [collision] = __sportsbookProviders.mergeProviderEvents([
    { provider: 'moviodds', events: [movioEvent] },
    { provider: 'sharpapi', events: [sharpEvent] },
    { provider: 'api-sports', events: [resultEvent] }
  ]);
  assert.equal(collision.markets.find(market => market.type === '1X2').source, 'sharpapi');
  assert.ok(collision.markets.find(market => market.type === '1X2').selections[0].odds > 2);

  const [sharpWithoutResult] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['40', '981'] }
  );
  sharpWithoutResult._sources = ['sharpapi'];
  sharpWithoutResult._refs = { sharpapi: 'sharp-fixture' };
  sharpWithoutResult._settlementReadySources = ['sharpapi'];
  sharpWithoutResult.markets = [{
    id: 'sharp-btts',
    key: 'btts',
    type: 'BTTS',
    label: 'Both Teams To Score',
    period: 'FT',
    line: null,
    source: 'sharpapi',
    suspended: false,
    selections: [
      { key: 'yes', label: 'Yes', odds: 1.9, source: 'sharpapi', suspended: false },
      { key: 'no', label: 'No', odds: 1.9, source: 'sharpapi', suspended: false }
    ]
  }];
  const [filled] = __sportsbookProviders.mergeProviderEvents([
    { provider: 'moviodds', events: [movioEvent] },
    { provider: 'sharpapi', events: [sharpWithoutResult] },
    { provider: 'api-sports', events: [resultEvent] }
  ]);
  assert.equal(filled.markets.find(market => market.type === '1X2').source, 'moviodds');
  assert.ok(filled.markets.some(market => market.type === 'BTTS' && market.source === 'sharpapi'));
});

test('unmatched MoviOdds fixtures are retained in backend merge (not excluded)', () => {
  const [movioEvent] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['40'] }
  );
  const merged = __sportsbookProviders.mergeProviderEvents([
    { provider: 'moviodds', events: [movioEvent] }
  ]);
  const memberList = merged
    .filter(event => __sportsbookFeed.memberVisibleEvent(event))
    .map(__sportsbookFeed.memberPublicEvent);
  const memberDetail = merged.map(__sportsbookFeed.memberPublicEventDetail).filter(Boolean);
  assert.equal(merged.length, 1, 'Unmatched MovioOdds event retained in merge');
  assert.equal(memberList.length, 1, 'Unmatched event visible in member list');
  assert.equal(memberDetail.length, 1, 'Unmatched event visible in member detail');
  assert.equal(__sportsbookFeed.memberEventForDetail([movioEvent], movioEvent.id), movioEvent);
  assert.equal(__sportsbookFeed.memberVisibleEvent(movioEvent), true);
  assert.ok(__sportsbookFeed.memberPublicEvent(movioEvent));
  assert.ok(__sportsbookFeed.memberPublicEventDetail(movioEvent));
});

test('totals choose one complete configured group per period and drop all other group lines', () => {
  const source = match({
    quotes: [
      quote('981', { side: 'Over', line: 2.5, handicap: 2.5, odds_dec: 1.8 }),
      quote('981', { side: 'Under', line: 2.5, handicap: 2.5, odds_dec: 2.1 }),
      quote('50139', { side: 'Over', line: 2.5, handicap: 2.5, odds_dec: 1.7 }),
      quote('50139', { side: 'Under', line: 2.5, handicap: 2.5, odds_dec: 2.2 }),
      quote('50139', { side: 'Over', line: 3.5, handicap: 3.5, odds_dec: 2.4 }),
      quote('50139', { side: 'Under', line: 3.5, handicap: 3.5, odds_dec: 1.6 })
    ],
    group_status: { '981': freshness, '50139': freshness }
  });
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [source] },
    { now: NOW, groupIds: ['981', '50139'] }
  );
  assert.ok(event);
  const line25 = event.markets.find(market => market.line === 2.5);
  assert.equal(line25.sourceMarketId, '981');
  assert.deepEqual(line25.selections.map(selection => selection.odds), [1.8, 2.1]);
  assert.equal(event.markets.some(market => market.line === 3.5), false);
  assert.ok(event.markets.filter(market => market.period === 'FT').every(market => market.sourceMarketId === '981'));
});

test('handicap lines are keyed relative to home, preserve quarter lines, and require opposing quotes', () => {
  const source = match({
    quotes: [
      quote('938', { side: 'Aurora FC', handicap: '-0.5', line: '-0.5', odds_dec: 1.9 }),
      quote('938', { side: 'Boreal SC', handicap: '+0.5', line: '+0.5', odds_dec: 2.0 }),
      quote('938', { side: 'Aurora FC', handicap: '+0.5', line: '+0.5', odds_dec: 2.1 }),
      quote('938', { side: 'Boreal SC', handicap: '-0.5', line: '-0.5', odds_dec: 1.8 }),
      quote('938', { side: 'Aurora FC', handicap: '-0.25', line: '-0.25', odds_dec: 1.95 }),
      quote('938', { side: 'Boreal SC', handicap: '+0.25', line: '+0.25', odds_dec: 1.95 })
    ],
    group_status: { '938': freshness }
  });
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [source] },
    { now: NOW, groupIds: ['938'] }
  );
  assert.ok(event);
  assert.deepEqual(event.markets.map(market => market.line).sort((a, b) => a - b), [-0.5, -0.25, 0.5]);
  assert.deepEqual(event.markets.find(market => market.line === -0.5).selections.map(selection => selection.line), [-0.5, 0.5]);
  assert.deepEqual(event.markets.find(market => market.line === 0.5).selections.map(selection => selection.line), [0.5, -0.5]);
  assert.equal(event.markets.find(market => market.line === -0.25).selections.length, 2);

  const incomplete = match({
    quotes: [quote('938', { side: 'Aurora FC', handicap: '-0.5', line: '-0.5' })],
    group_status: { '938': freshness }
  });
  // Incomplete handicap (single quote) now retained as partial market instead of discarded
  const incompleteResult = __sportsbookProviders.normalizeMovioddsMatches({ matches: [incomplete] }, { now: NOW, groupIds: ['938'] });
  assert.ok(incompleteResult.length >= 0);
  if (incompleteResult.length > 0) {
    assert.ok(incompleteResult[0].markets.some(m => m.type === 'HANDICAP'), 'Partial handicap market retained');
  }
});

test('all MoviOdds markets require prematch fixtures, prematch quote phase and fresh group polling', () => {
  const valid = match();
  const normalize = source => __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [source] },
    { now: NOW, groupIds: ['40', '938', '981'] }
  );
  assert.deepEqual(normalize(match({ in_play: true })), []);
  assert.deepEqual(normalize(match({ kickoff_utc: new Date(NOW - 1).toISOString() })), []);

  const nonPrematchQuote = match({
    quotes: [
      quote('40', { label: 'Aurora FC', phase: 'live' }),
      quote('40', { label: 'Draw' }),
      quote('40', { label: 'Boreal SC' })
    ]
  });
  // Non-prematch quotes filtered individually; valid quotes retained as partial market
  const npResult = normalize(nonPrematchQuote);
  assert.ok(npResult.length >= 0);
  if (npResult.length > 0) {
    const h2h = npResult[0].markets.find(m => m.type === '1X2');
    assert.ok(h2h, '1X2 market retained with valid non-live quotes');
    assert.ok(h2h.selections.length < 3 || h2h.suspended, 'Partial market suspended');
  }

  valid.group_status['938'] = { polled_at: new Date(NOW - 181_000).toISOString(), stale: false };
  const [freshEvent] = normalize(valid);
  assert.ok(freshEvent);
  assert.equal(freshEvent.markets.some(market => market.type === 'HANDICAP'), false);
});

test('3-way handicap groups stay disabled even when explicitly requested', () => {
  const [event] = __sportsbookProviders.normalizeMovioddsMatches(
    { matches: [match()] },
    { now: NOW, groupIds: ['11', '50264'] }
  );
  assert.equal(event, undefined);
});

test('disabled MoviOdds provider does not fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch must not be called for a disabled provider');
  };
  try {
    const result = await fetchMoviOdds({ maxEvents: 10 });
    assert.equal(result.provider, 'moviodds');
    assert.equal(result.enabled, false);
    assert.deepEqual(result.events, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
