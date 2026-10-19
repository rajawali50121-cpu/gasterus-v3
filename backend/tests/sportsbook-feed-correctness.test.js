import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url),'utf8');
const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url),'utf8');
const e2e = readFileSync(new URL('../../scripts/verify-sportsbook-e2e.mjs', import.meta.url),'utf8');

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

test('Sportsbook feed is sourced exclusively from Sportmonks and member errors stay provider-neutral', () => {
  assert.match(feed,/fetchSportmonks/);
  assert.doesNotMatch(feed,/fetchFootballDataIo|fetchPublicMarketFeed|fetchSharpApi|fetchApiSports|fetchTheOddsApi|suppliedSnapshotResult/);
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

test('Sportmonks is the only sportsbook refresh descriptor', () => {
  assert.match(feed,/code: 'sportmonks', enabled: true, fetcher: fetchSportmonks/);
  assert.doesNotMatch(feed,/code: '(?:public-market|sharpapi|api-sports|the-odds-api|footballdata-io)'/);
});

test('member requests do not replace provider errors with synthetic sportsbook data', () => {
  const refreshPath = feed.slice(feed.indexOf('async function performRefresh'), feed.indexOf('function normalizedSport'));
  assert.match(feed,/const REFRESH_LOCK_WAIT_MS = 5000/);
  assert.match(feed,/SPORTS_REFRESH_IN_PROGRESS/);
  assert.equal(feed.match(/throw error;/g)?.length >= 2, true);
  assert.match(feed,/throw new AppError\(503, 'Provider sportsbook belum mengembalikan pertandingan asli\.', 'SPORTS_FEED_EMPTY'\)/);
  assert.doesNotMatch(refreshPath,/activateHardFallback|buildHardFallbackEvents|HARD_FALLBACK/);
});

test('E2E enforces expanded event volume and core market coverage without requiring derived markets per event', () => {
  // Katalog aktif wajib ratusan pertandingan (termasuk fixture display-only
  // tanpa odds) plus jaminan minimal pertandingan berharga tetap ada.
  assert.match(e2e,/const minimumEvents = 300/);
  assert.match(e2e,/const minimumPricedEvents = 25/);
  assert.match(e2e,/const requiredCoreMarketTypes = \['1X2', 'HANDICAP', 'TOTALS'\]/);
  assert.match(e2e,/const marketPeriodCoverage/);
  assert.doesNotMatch(e2e,/minimumDerivedMarkets|hasDerivedTypes/);
});
