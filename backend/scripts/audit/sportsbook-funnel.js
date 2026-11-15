// Offline diagnostic only: builds normalized fixtures and runs pure pipeline
// stages. It does not call provider APIs, Redis, or PostgreSQL.
process.env.NODE_ENV = 'test';
process.env.SPORTSBOOK_RENDER_WORKER = 'true';
process.env.SPORTMONKS_PASSTHROUGH = 'false';
process.env.DATABASE_URL = 'postgres://localhost/gasterus-audit-unused';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.MEMBER_PROXY_SECRET = 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET = 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET = 'o'.repeat(48);
process.env.SESSION_HMAC_KEY = 's'.repeat(48);
process.env.API_KEY_PEPPER = 'p'.repeat(48);
process.env.MFA_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');

const [
  { buildSportsbookRenderSnapshot },
  { teamKey, normalizedEvent, normalizedMarket, normalizedSelection, mergeProviderEvents, suspendStaleLiveMarkets },
  { validateSportsbookSnapshot, mergeSportsbookSnapshots },
  { validateAllHandicapOdds, __sportsbookFeed },
  { reconcileSportsbookMarketLifecycle },
  { applySportsbookTradingControls },
  { availableMarketPeriods, primaryMarketColumns },
  { filterVisibleEvents },
  { config }
] = await Promise.all([
  import('../../src/sportsbook-render-worker-core.js'),
  import('../../src/sportsbook-providers.js'),
  import('../../src/sportsbook-ingestion.js'),
  import('../../src/sportsbook-feed.js'),
  import('../../src/sportsbook-market-lifecycle.js'),
  import('../../src/sportsbook-trading-policy.js'),
  import('../../../frontend/js/sportsbook-markets.js'),
  import('../../../frontend/js/sportsbook-feed-state.js'),
  import('../../src/config.js')
]);

const now = Date.now();
const providerCounts = [
  ['sportmonks', 120],
  ['sharpapi', 200],
  ['oddspapi', 160]
];
const eventCount = events => events.length;
const marketCount = events => events.reduce((n, event) => n + (event.markets || []).length, 0);
const oddsCount = events => events.reduce((n, event) =>
  n + (event.markets || []).reduce((m, market) => m + (market.selections || []).length, 0), 0);
const recordCounts = results => results.reduce((counts, result) => ({
  events: counts.events + result.events.length,
  markets: counts.markets + marketCount(result.events),
  odds: counts.odds + oddsCount(result.events)
}), { events: 0, markets: 0, odds: 0 });

function fixture(provider, localIndex) {
  const common = localIndex < 50;
  const identity = common ? `shared-${localIndex}` : `${provider}-${localIndex}`;
  const suffix = common ? String(localIndex) : `${provider}-${localIndex}`;
  const startTime = new Date(now + 6 * 60 * 60_000 + localIndex * 60_000).toISOString();
  const event = normalizedEvent({
    provider,
    providerId: `${provider}-source-${identity}`,
    sport: 'soccer',
    league: 'Regional League',
    country: 'Example',
    startTime,
    state: 'SCHEDULED',
    home: `Home ${suffix}`,
    away: `Away ${suffix}`
  });
  const definitions = [
    { type: '1X2', line: null, labels: [['Home', 1.9], ['Draw', 3.2], ['Away', 4.2]] },
    { type: 'HANDICAP', line: -0.5, labels: [['Home', 1.9], ['Away', 1.9]] },
    { type: 'TOTALS', line: 2.5, labels: [['Over', 1.9], ['Under', 1.9]] },
    { type: 'BTTS', line: null, labels: [['Yes', 1.9], ['No', 1.9]] },
    { type: 'DOUBLE_CHANCE', line: null, labels: [['Home / Draw', 1.3], ['Draw / Away', 1.4], ['Home / Away', 1.5]] },
    { type: 'OTHER', line: null, labels: [['Option A', 2.0], ['Option B', 2.0]] }
  ];
  event.markets = definitions.map(definition => {
    const key = `${definition.type}:${definition.line ?? ''}`;
    const selections = definition.labels.map(([label, odds], index) =>
      normalizedSelection(event.id, key, label, odds, {
        line: definition.type === 'HANDICAP'
          ? (index === 0 ? -0.5 : 0.5)
          : definition.line,
        source: provider,
        sourceSelectionId: `${identity}:${key}:${index}`,
        updatedAt: new Date(now).toISOString()
      })
    );
    return normalizedMarket(event.id, {
      key,
      name: definition.type,
      type: definition.type,
      line: definition.line,
      selections,
      source: provider,
      bookmaker: 'fixture-book'
    });
  });
  return event;
}

const providerResults = providerCounts.map(([provider, count]) => ({
  provider,
  enabled: true,
  events: Array.from({ length: count }, (_, index) => fixture(provider, index))
}));
const input = recordCounts(providerResults);
const uniqueInputEvents = new Set(providerResults.flatMap(result => result.events.map(event => event.id))).size;

const workerSnapshot = await buildSportsbookRenderSnapshot({
  fetchSportmonks: async () => providerResults.find(result => result.provider === 'sportmonks'),
  fetchSharpApi: async () => providerResults.find(result => result.provider === 'sharpapi'),
  fetchOddsPapi: async () => providerResults.find(result => result.provider === 'oddspapi'),
  maxEvents: 500,
  maxPages: 120,
  maxPayloadBytes: config.sportsbookIngestMaxPayloadBytes,
  teamKey,
  now
});
const afterWorker = recordCounts(workerSnapshot.providerResults);
const checked = validateSportsbookSnapshot(workerSnapshot, { now });
const incoming = mergeSportsbookSnapshots(workerSnapshot, null, { now });
const afterIngestMerge = recordCounts(incoming.providerResults);

let events = mergeProviderEvents(incoming.providerResults);
const afterProviderMerge = { events: eventCount(events), markets: marketCount(events), odds: oddsCount(events) };
events = events.map(event => ({ ...event, _settlementReadySources: [...new Set(event._sources)] }));
events = suspendStaleLiveMarkets(events, now);
events = validateAllHandicapOdds(events);
const lifecycle = reconcileSportsbookMarketLifecycle({}, events, {
  reopenSuccesses: config.sportsbookMarketReopenSuccesses,
  reopenObservationSeconds: config.sportsbookMarketReopenObservationSeconds,
  retentionSeconds: config.sportsbookMarketLifecycleRetentionSeconds,
  now
});
events = applySportsbookTradingControls(lifecycle.events, []);
const cached = __sportsbookFeed.cacheWithinLimit({
  events,
  fetchedAt: now,
  expiresAt: now + config.sportsFeedRefreshSeconds * 1000
});
const afterFeed = { events: eventCount(cached.events), markets: marketCount(cached.events), odds: oddsCount(cached.events) };
const memberSummary = cached.events.map(__sportsbookFeed.memberPublicEvent);
const memberDetail = cached.events.map(__sportsbookFeed.memberPublicEventDetail);
const page = __sportsbookFeed.paginateEvents(memberSummary, { offset: 0, limit: 30 });
const visiblePage = filterVisibleEvents(page.events, { sport: 'all', league: 'all', country: 'all', filter: 'all' });
const primary = visiblePage.flatMap(event => primaryMarketColumns(event, 'FT'));
const fullDetail = memberDetail[0];

console.log(JSON.stringify({
  note: 'Synthetic normalized fixtures only; not a production-volume estimate or a provider API test.',
  input: { ...input, uniqueEvents: uniqueInputEvents },
  worker: { ...afterWorker, uniqueEvents: workerSnapshot.eventCount, bytes: Buffer.byteLength(JSON.stringify(workerSnapshot)), diagnostics: workerSnapshot.diagnostics || null },
  ingestValidation: { uniqueEvents: checked.eventCount, providers: checked.providers },
  ingestMerge: { ...afterIngestMerge, uniqueEvents: incoming.eventCount },
  providerMerge: afterProviderMerge,
  feedAfterSafetyCacheAndControls: afterFeed,
  memberSummaryBeforePagination: { events: memberSummary.length, markets: marketCount(memberSummary), odds: oddsCount(memberSummary) },
  memberFirstPageAndPrimaryUI: {
    events: visiblePage.length,
    markets: marketCount(visiblePage),
    odds: oddsCount(visiblePage),
    primarySlots: primary.length,
    primaryMarketsWithOdds: primary.filter(item => item.market && item.outcomes.some(([, selection]) => selection)).length
  },
  memberEventDetail: { markets: fullDetail?.markets.length || 0, odds: oddsCount(fullDetail ? [fullDetail] : []) },
  pagination: page.pagination
}, null, 2));
