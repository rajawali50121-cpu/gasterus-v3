import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64'),
  MOVIODDS_ENABLED: 'false'
});

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url),'utf8');
const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url),'utf8');
const e2e = readFileSync(new URL('../../scripts/verify-sportsbook-e2e.mjs', import.meta.url),'utf8');
const { __sportsbookFeed } = await import('../src/sportsbook-feed.js');

test('core FT/1H coverage reports per-market counts and matches the legacy all-six boolean', () => {
  const allSixTypes = [
    ['1X2', 'FT'],
    ['HANDICAP', 'FT'],
    ['TOTALS', 'FT'],
    ['1X2', '1H'],
    ['HANDICAP', '1H'],
    ['TOTALS', '1H']
  ];
  const makeEvent = (markets, suffix) => ({
    id: suffix,
    markets: markets.map(([type, period, suspended = false]) => ({
      type,
      period,
      suspended
    }))
  });
  const events = [
    makeEvent(allSixTypes, 'all-six'),
    makeEvent([['1X2', 'FT'], ['TOTALS', '1H']], 'partial'),
    makeEvent(allSixTypes.map(([type, period]) => [type, period, true]), 'suspended'),
    makeEvent([['1X2', undefined], ['HANDICAP', undefined]], 'missing-period')
  ];

  const metrics = __sportsbookFeed.ftHtCoreMarketMetrics(events);
  assert.equal(metrics.ftHtCoreMarkets, true);
  assert.deepEqual(metrics.ftHtCoreMarketCoverage, {
    totalEvents: 4,
    byMarket: {
      '1X2:FT': { count: 3, percentage: 75 },
      'HANDICAP:FT': { count: 2, percentage: 50 },
      'TOTALS:FT': { count: 1, percentage: 25 },
      '1X2:1H': { count: 1, percentage: 25 },
      'HANDICAP:1H': { count: 1, percentage: 25 },
      'TOTALS:1H': { count: 2, percentage: 50 }
    },
    allSixCount: 1
  });

  const noCompleteEvent = __sportsbookFeed.ftHtCoreMarketMetrics(events.slice(1));
  assert.equal(noCompleteEvent.ftHtCoreMarkets, false);
  assert.equal(noCompleteEvent.ftHtCoreMarketCoverage.allSixCount, 0);
});

test('R6.9.0.22 feed closes finished and kickoff-pending markets before bettable counting', () => {
  assert.match(feed,/function eventBettingOpen\(event, now = Date\.now\(\)\)/);
  assert.match(feed,/CLOSED_EVENT_STATUSES/);
  assert.match(feed,/kickoff \+ Number\(config\.sportsbookPrematchCloseGraceSeconds/);
  assert.match(feed,/events = enforceEventBettingWindow\(events, Date\.now\(\)\)/);
  assert.match(feed,/if \(!eventBettingOpen\(event, now\)\) return total/);
});

test('R6.9.0.22 feed suspends stale live markets fail-closed before bettable counting', () => {
  assert.match(feed,/events = suspendStaleLiveMarkets\(events, Date\.now\(\)\)/);
  assert.match(feed,/import \{[^}]*suspendStaleLiveMarkets[^}]*\} from '\.\/sportsbook-providers\.js'/);
});

test('R6.9.0.22 member catalog removes closed results and has bounded horizon', () => {
  assert.match(feed,/function memberVisibleEvent/);
  assert.match(feed,/sportsbookMemberHorizonDays/);
  assert.match(feed,/sportsbookMemberMaxEvents/);
  assert.match(feed,/\.filter\(event => memberVisibleEvent\(event, now\)\)/);
});

test('member source status reflects the overall feed even when the current page is empty', () => {
  assert.match(feed, /const visibleBettableMarkets = bettableMarketCount\(events\)/);
  assert.match(feed, /const memberHealthy = !stale && !feed\.readOnlySource && Number\(feed\.bettableMarkets \|\| 0\) > 0/);
  assert.match(feed, /status: feed\.readOnlySource \? .* : memberHealthy \? 'ONLINE' : 'DEGRADED'/);
});

test('Sportsbook feed composes Sportmonks, MoviOdds and SharpAPI with provider-neutral errors', () => {
  assert.match(feed,/fetchSportmonks/);
  assert.match(feed,/fetchMoviOdds/);
  assert.match(feed,/fetchSharpApi/);
  assert.match(feed,/fetchApiSports/);
  assert.match(feed,/fetchTheOddsApi/);
  assert.doesNotMatch(feed,/fetchFootballDataIo|fetchPublicMarketFeed|suppliedSnapshotResult/);
  assert.match(feed,/SPORTS_MARKET_TEMPORARILY_UNAVAILABLE/);
  assert.doesNotMatch(feed,/throw new AppError\(409, 'Provider odds sedang degraded\/recovery/);
});

test('R6.9.0.22 member projection strips unused source and freshness metadata', () => {
  const block = feed.slice(feed.indexOf('function memberPublicEvent(event)'), feed.indexOf('export async function sportsbookSnapshot'));
  for (const token of ['sourceMarketId','sourceSelectionId','lifecycleState','lifecycleReason','reopenSuccessStreak','updatedAt: market.updatedAt','providerStatus']) {
    assert.equal(block.includes(token), false, `member event leaks ${token}`);
  }
});

test('R6.9.0.22 member quote and ticket responses omit provider telemetry', () => {
  assert.match(betting,/function memberTicket\(ticket\)/);
  const memberBlock = betting.slice(betting.indexOf('function memberTicket(ticket)'), betting.indexOf('async function ticketBy'));
  for (const token of ['provider:','providerStates','sourceUpdatedAt','acceptedFeedRevision','providerStateAtAcceptance','settlementSource','settlementFeedRevision','metadata:']) {
    assert.equal(memberBlock.includes(token), false, `member ticket leaks ${token}`);
  }
  const quoteReturn = betting.slice(betting.indexOf('return {\n    quoteId'), betting.indexOf('export async function createSportsbookBet'));
  assert.equal(quoteReturn.includes('providerStates,'), false);
  assert.equal(quoteReturn.includes('feedRevisions,'), false);
  assert.equal(quoteReturn.includes('tradingControlVersions,'), false);
});

test('local sportsbook refresh registers the configured provider adapters', () => {
  assert.match(feed,/code: provider\.code,\s*enabled: provider\.enabled,\s*fetcher: provider\.code === 'sportmonks'\s*\? fetchSportmonks\s*:\s*provider\.code === 'moviodds'\s*\? fetchMoviOdds\s*:\s*provider\.code === 'sharpapi'\s*\? fetchSharpApi\s*:\s*provider\.code === 'api-sports'\s*\? fetchApiSports\s*:\s*provider\.code === 'the-odds-api'\s*\? fetchTheOddsApi\s*:\s*fetchOddsPapi/);
  assert.match(feed,/code: 'sportmonks'/);
  assert.match(feed,/code: 'moviodds'/);
  assert.match(feed,/code: 'sharpapi'/);
  assert.match(feed,/code: 'api-sports'/);
  assert.match(feed,/code: 'the-odds-api'/);
  assert.doesNotMatch(feed,/code: '(?:public-market|footballdata-io)'/);
});

test('member requests do not wait on a competing feed refresh beyond the proxy budget', () => {
  assert.match(feed,/const REFRESH_LOCK_WAIT_MS = 5000/);
  assert.match(feed,/SPORTS_REFRESH_IN_PROGRESS/);
  assert.equal(feed.match(/if \(error\?\.code === 'SPORTS_REFRESH_IN_PROGRESS'\) throw error/g)?.length, 2);
});

test('E2E enforces expanded event volume and core market coverage without requiring derived markets per event', () => {
  assert.match(e2e,/const minimumEvents = 25/);
  assert.match(e2e,/const requiredCoreMarketTypes = \['1X2', 'HANDICAP', 'TOTALS'\]/);
  assert.match(e2e,/const marketPeriodCoverage/);
  assert.doesNotMatch(e2e,/minimumDerivedMarkets|hasDerivedTypes/);
  assert.match(feed, /ftHtCoreMarkets: allSixCount > 0/);
  assert.match(feed, /ftHtCoreMarketCoverage:/);
});
