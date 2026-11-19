import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { reconcileSportsbookMarketLifecycle, __sportsbookMarketLifecycle } = await import('../src/sportsbook-market-lifecycle.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');
const { priceVersionChangeCount } = await import('../src/sportsbook-live-observability.js');

function feedEvent({ marketSuspended = false, selectionSuspended = false, updatedAt = '2026-08-14T12:00:00Z' } = {}) {
  return [{
    id: 'evt-1', status: 'SCHEDULED', providerStatus: 'NS', live: false,
    markets: [{
      id: 'mkt-1', source: 'sportradar', updatedAt, suspended: marketSuspended,
      selections: [
        { key: 'home', odds: 1.91, source: 'sportradar', updatedAt, priceVersion: 'p-home', suspended: selectionSuspended },
        { key: 'away', odds: 1.95, source: 'sportradar', updatedAt, priceVersion: 'p-away', suspended: selectionSuspended }
      ]
    }]
  }];
}

test('HF6 Phase 3 automatic BET STOP and reopen require fresh provider observations', () => {
  const opts = { reopenSuccesses: 2, reopenObservationSeconds: 30, retentionSeconds: 3600 };
  const initial = reconcileSportsbookMarketLifecycle({}, feedEvent(), { ...opts, now: 100000 });
  assert.equal(initial.events[0].markets[0].lifecycleState, 'ACTIVE');

  const stopped = reconcileSportsbookMarketLifecycle(initial.state, feedEvent({ marketSuspended: true }), { ...opts, now: 110000 });
  assert.equal(stopped.events[0].markets[0].lifecycleState, 'SUSPENDED');
  assert.equal(stopped.transitions[0].action, 'BET_STOP');

  const firstRecovery = reconcileSportsbookMarketLifecycle(stopped.state, feedEvent(), { ...opts, now: 120000 });
  assert.equal(firstRecovery.events[0].markets[0].lifecycleState, 'REOPENING');
  assert.equal(firstRecovery.events[0].markets[0].reopenSuccessStreak, 1);

  // Aggregate refreshes inside provider cache TTL must not fake a second recovery confirmation.
  const cachedRepeat = reconcileSportsbookMarketLifecycle(firstRecovery.state, feedEvent(), { ...opts, now: 128000 });
  assert.equal(cachedRepeat.events[0].markets[0].lifecycleState, 'REOPENING');
  assert.equal(cachedRepeat.events[0].markets[0].reopenSuccessStreak, 1);
  assert.equal(cachedRepeat.events[0].markets[0].lifecycleReason, 'WAITING_FRESH_PROVIDER_OBSERVATION');

  const confirmed = reconcileSportsbookMarketLifecycle(cachedRepeat.state, feedEvent(), { ...opts, now: 151000 });
  assert.equal(confirmed.events[0].markets[0].lifecycleState, 'ACTIVE');
  assert.equal(confirmed.transitions[0].action, 'REOPEN');
});

test('HF6 Phase 3 absent market is retained without a false BET STOP or reopen cycle', () => {
  const opts = { reopenSuccesses: 2, reopenObservationSeconds: 30, retentionSeconds: 3600 };
  const initial = reconcileSportsbookMarketLifecycle({}, feedEvent(), { ...opts, now: 100000 });
  const missing = reconcileSportsbookMarketLifecycle(initial.state, [{ id:'evt-1', status:'SCHEDULED', markets:[] }], { ...opts, now: 108000 });
  assert.equal(missing.events[0].markets.length, 0);
  assert.equal(Object.values(missing.state)[0].state, 'ACTIVE');
  assert.equal(missing.transitions.length, 0);

  const returned = reconcileSportsbookMarketLifecycle(missing.state, feedEvent(), { ...opts, now: 131000 });
  assert.equal(returned.events[0].markets[0].lifecycleState, 'ACTIVE');
  assert.equal(returned.events[0].markets[0].suspended, false);
  assert.equal(returned.transitions.length, 0);
});

test('HF6 Phase 3 absent market expires from lifecycle state after retention', () => {
  const opts = { reopenSuccesses: 2, reopenObservationSeconds: 30, retentionSeconds: 300 };
  const initial = reconcileSportsbookMarketLifecycle({}, feedEvent(), { ...opts, now: 100000 });
  const expired = reconcileSportsbookMarketLifecycle(initial.state, [{ id:'evt-1', status:'SCHEDULED', markets:[] }], { ...opts, now: 401000 });
  assert.deepEqual(expired.state, {});
  assert.equal(expired.transitions.length, 0);
});

test('HF6 Phase 3 explicit provider suspension still stops a market after a feed omission', () => {
  const opts = { reopenSuccesses: 2, reopenObservationSeconds: 30, retentionSeconds: 3600 };
  const initial = reconcileSportsbookMarketLifecycle({}, feedEvent(), { ...opts, now: 100000 });
  const missing = reconcileSportsbookMarketLifecycle(initial.state, [{ id:'evt-1', status:'SCHEDULED', markets:[] }], { ...opts, now: 108000 });
  const suspended = reconcileSportsbookMarketLifecycle(missing.state, feedEvent({ marketSuspended: true }), { ...opts, now: 131000 });

  assert.equal(suspended.events[0].markets[0].lifecycleState, 'SUSPENDED');
  assert.equal(suspended.transitions[0].action, 'BET_STOP');
  assert.equal(suspended.transitions[0].reason, 'UPSTREAM_SUSPENDED');
});

test('HF6 Phase 3 observation token changes on tradable state and price terms', () => {
  const active = feedEvent()[0].markets[0];
  const suspended = feedEvent({ marketSuspended: true })[0].markets[0];
  const repriced = structuredClone(active);
  repriced.selections[0].odds = 1.97;
  repriced.selections[0].priceVersion = 'p-home-2';
  assert.notEqual(__sportsbookMarketLifecycle.marketObservationToken(active), __sportsbookMarketLifecycle.marketObservationToken(suspended));
  assert.notEqual(__sportsbookMarketLifecycle.marketObservationToken(active), __sportsbookMarketLifecycle.marketObservationToken(repriced));
});


test('HF6 Phase 3 live observability counts real price-version changes without treating first observation as a change', () => {
  const previous = feedEvent({ updatedAt:'2026-08-14T12:00:00Z' });
  const identical = structuredClone(previous);
  const repriced = structuredClone(previous);
  repriced[0].markets[0].selections[0].odds = 1.97;
  repriced[0].markets[0].selections[0].priceVersion = 'p-home-v2';
  assert.equal(priceVersionChangeCount([], previous), 0);
  assert.equal(priceVersionChangeCount(previous, identical), 0);
  assert.equal(priceVersionChangeCount(previous, repriced), 1);
});

test('HF6 Phase 3 HT/FT auto settlement requires explicit result authority when authority metadata is present', () => {
  const ftLeg = { market_type:'1X2', market_period:'FT', selection_label:'Home', home_team:'Alpha', away_team:'Beta', market_line:null };
  const htLeg = { ...ftLeg, market_period:'1H' };
  const base = {
    status:'FINISHED', providerStatus:'FT', home:{score:2}, away:{score:1},
    periodScores:{'1H':{home:1,away:0}}
  };
  assert.equal(evaluateSportsbookLeg(ftLeg, { ...base, settlementAuthority:{ft:false,ht:false,sources:[]} }), null);
  assert.equal(evaluateSportsbookLeg(htLeg, { ...base, settlementAuthority:{ft:true,ht:false,sources:['sportradar']} }), null);
  assert.equal(evaluateSportsbookLeg(ftLeg, { ...base, settlementAuthority:{ft:true,ht:false,sources:['sportradar']} }).status, 'WON');
  assert.equal(evaluateSportsbookLeg(htLeg, { ...base, settlementAuthority:{ft:true,ht:false,sources:['sportradar','manual-ops']} }), null);
});

test('HF6 Phase 3 settlement revisions, rollback/cancel routes, pending-funds gate and odds policy are wired before money movement', () => {
  const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const member = readFileSync(new URL('../src/member.js', import.meta.url), 'utf8');
  const owner = readFileSync(new URL('../src/owner.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/013_sportsbook_live_lifecycle_settlement.sql', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');

  assert.match(migration, /sportsbook_settlement_revisions/);
  assert.match(migration, /PENDING_FUNDS/);
  assert.match(migration, /sportsbook_market_lifecycle_history/);
  assert.match(betting, /rollbackSportsbookSettlement/);
  assert.match(betting, /cancelSportsbookSettlement/);
  assert.match(betting, /SPORTSBOOK_ODDS_WORSE_REJECTED/);
  assert.ok(betting.indexOf('const freshLegs = await revalidateResolvedLegs') < betting.indexOf('postTransfer(client'), 'final odds revalidation must precede wallet debit');
  assert.match(feed, /settlementAuthority: authorities\[index\]/);
  assert.match(worker, /retryPendingSportsbookSettlementCorrections/);
  assert.match(member, /SPORTSBOOK_SETTLEMENT_CORRECTION_PENDING/);
  assert.match(owner, /assertNoSportsbookSettlementCorrection/);
  assert.match(owner, /Payout withdrawal ditahan/);
  assert.match(betting, /pendingRevision/);
  assert.match(betting, /Selesaikan koreksi tersebut sebelum membuat revision baru/);
  assert.ok(app.includes('/rollback'));
  assert.ok(app.includes('/cancel'));
  assert.match(ui, /oddsChangePolicy|quote/);
});
