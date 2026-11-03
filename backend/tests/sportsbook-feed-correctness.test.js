import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url),'utf8');
const source = readFileSync(new URL('../src/sportsbook-public-market.js', import.meta.url),'utf8');
const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url),'utf8');

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

test('member catalog removes closed results and paginates within the configured horizon', () => {
  assert.match(feed,/function memberVisibleEvent/);
  assert.match(feed,/sportsbookMemberHorizonDays/);
  assert.match(feed,/\.filter\(event => memberVisibleEvent\(event, now\)\)/);
  assert.match(feed,/paginateMemberEvents\(sourceEvents/);
  assert.match(feed,/cursor: filters\.cursor/);
});

test('R6.9.0.22 optional legacy detail source is gated and member errors stay provider-neutral', () => {
  assert.match(feed,/bridgeEvent\(/);
  assert.match(feed,/SPORTS_MARKET_TEMPORARILY_UNAVAILABLE/);
  assert.doesNotMatch(feed,/throw new AppError\(409, 'Provider odds sedang degraded\/recovery/);
});

test('R6.9.0.22 bounded public-market cache fallback stays tradable while incident remains observable', () => {
  assert.match(source,/cachedFallback: true/);
  assert.match(source,/transportOk: true, cachedFallback: true/);
  assert.match(source,/Refresh failed; serving cached public odds/);
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
