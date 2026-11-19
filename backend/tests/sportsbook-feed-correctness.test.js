import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const feedSource = readFileSync(new URL('../src/sportsbook-feed-source.js', import.meta.url), 'utf8');
const feedUtils = readFileSync(new URL('../src/sportsbook-feed-utils.js', import.meta.url), 'utf8');
const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
const e2e = readFileSync(new URL('../../scripts/verify-sportsbook-e2e.mjs', import.meta.url), 'utf8');

test('feed closes finished and kickoff-pending markets before bettable counting', () => {
  assert.match(feed, /function eventBettingOpen\(event, now = Date\.now\(\)\)/);
  assert.match(feed, /CLOSED_EVENT_STATUSES/);
  assert.match(feed, /kickoff \+ Number\(config\.sportsbookPrematchCloseGraceSeconds/);
  assert.match(feed, /events = enforceEventBettingWindow\(events, Date\.now\(\)\)/);
  assert.match(feed, /if \(!eventBettingOpen\(event, now\)\) return total/);
});

test('stale live markets fail closed using provider-neutral feed utilities', () => {
  assert.match(feed, /events = suspendStaleLiveMarkets\(events, Date\.now\(\)\)/);
  assert.match(feed, /sportsbook-feed-utils\.js/);
  assert.match(feedUtils, /export function suspendStaleLiveMarkets/);
});

test('backend never calls an odds provider and requires a verified worker snapshot', () => {
  assert.doesNotMatch(feed, /fetchSportradar|fetchSportmonks|fetchSharpApi|fetchOddsPapi|fetchRapidApiOdds|fetchLocalProviders/);
  assert.match(feedSource, /SPORTS_SNAPSHOT_REQUIRED/);
  assert.match(feedSource, /verifyStoredSportsbookSnapshot/);
  assert.doesNotMatch(feedSource, /fetchLocalProviders\s*\(/);
});

test('member catalog removes closed results and has bounded horizon', () => {
  assert.match(feed, /function memberVisibleEvent/);
  assert.match(feed, /sportsbookMemberHorizonDays/);
  assert.match(feed, /\.filter\(event => memberVisibleEvent\(event, now\)\)/);
});

test('member source status reflects the overall feed even when the current page is empty', () => {
  assert.match(feed, /const visibleBettableMarkets = bettableMarketCount\(events\)/);
  assert.match(feed, /const memberHealthy = !unavailable && !stale && !feed\.readOnlySource/);
  assert.match(feed, /status: unavailable \? 'OFFLINE' : feed\.readOnlySource/);
});

test('member projection strips unused source and freshness metadata', () => {
  const block = feed.slice(feed.indexOf('function memberPublicEvent(event)'), feed.indexOf('export async function sportsbookSnapshot'));
  for (const token of ['sourceMarketId', 'sourceSelectionId', 'lifecycleState', 'lifecycleReason', 'reopenSuccessStreak', 'updatedAt: market.updatedAt', 'providerStatus']) {
    assert.equal(block.includes(token), false, `member event leaks ${token}`);
  }
});

test('member quote and ticket responses omit provider telemetry', () => {
  assert.match(betting, /function memberTicket\(ticket\)/);
  const memberBlock = betting.slice(betting.indexOf('function memberTicket(ticket)'), betting.indexOf('async function ticketBy'));
  for (const token of ['provider:', 'providerStates', 'sourceUpdatedAt', 'acceptedFeedRevision', 'providerStateAtAcceptance', 'settlementSource', 'settlementFeedRevision', 'metadata:']) {
    assert.equal(memberBlock.includes(token), false, `member ticket leaks ${token}`);
  }
  const quoteReturn = betting.slice(betting.indexOf('return {\n    quoteId'), betting.indexOf('export async function createSportsbookBet'));
  assert.equal(quoteReturn.includes('providerStates,'), false);
  assert.equal(quoteReturn.includes('feedRevisions,'), false);
  assert.equal(quoteReturn.includes('tradingControlVersions,'), false);
});

test('worker-only source policy rejects legacy odds provider names', () => {
  for (const token of ['sportmonks', 'sharpapi', 'oddspapi', 'therundown', 'rapidapi-odds', 'api-sports', 'public-market', 'footballdata-io']) {
    assert.equal(feed.toLowerCase().includes(token), false, `feed retains legacy source ${token}`);
    assert.equal(feedUtils.toLowerCase().includes(token), false, `feed utilities retain legacy source ${token}`);
  }
});

test('member requests do not wait on a competing feed refresh beyond the proxy budget', () => {
  assert.match(feed, /const REFRESH_LOCK_WAIT_MS = 5000/);
  assert.match(feed, /SPORTS_REFRESH_IN_PROGRESS/);
  assert.doesNotMatch(feed, /if \(error\?\.code === 'SPORTS_REFRESH_IN_PROGRESS'\) throw error/);
  assert.equal(feed.match(/return activateUnavailableFeed\(error, 'refresh-in-progress-no-cache'\)/g)?.length, 2);
});

test('E2E enforces expanded event volume and core market coverage without derived markets per event', () => {
  assert.match(e2e, /const minimumEvents = 300/);
  assert.match(e2e, /const minimumPricedEvents = 25/);
  assert.match(e2e, /const requiredCoreMarketTypes = \['1X2', 'HANDICAP', 'TOTALS'\]/);
  assert.match(e2e, /const requiredCoreMarkets = \[[\s\S]*HT_1X2[\s\S]*HT_HANDICAP[\s\S]*HT_TOTALS/);
  assert.match(e2e, /function coreMarketState\(markets, type, period\)/);
  assert.match(e2e, /coreMarketCoverageSummary/);
  assert.match(e2e, /const marketPeriodCoverage/);
  assert.doesNotMatch(e2e, /minimumDerivedMarkets|hasDerivedTypes/);
});
