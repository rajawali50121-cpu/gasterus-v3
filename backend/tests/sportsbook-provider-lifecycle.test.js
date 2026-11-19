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

});

const {
  advanceProviderLifecycle,
  shouldProbeProvider,
  PROVIDER_LIFECYCLE_STATES
} = await import('../src/sportsbook-provider-lifecycle.js');
const { mergeProviderEvents } = await import('../src/sportsbook-feed-utils.js');
const { eventSettlementAuthority } = await import('../src/sportsbook-settlement-authority.js');

const policy = { failureThreshold: 3, recoverySuccesses: 2, cooldownSeconds: 30 };
const healthy = (code = 'sportradar') => ({ code, enabled: true, transportHealthy: true, pricingReady: true });
const failed = (code = 'sportradar', error = 'timeout') => ({ code, enabled: true, transportHealthy: false, pricingReady: false, error });

test('Sportradar circuit breaker fails closed and requires confirmed recovery streak', () => {
  let state = advanceProviderLifecycle(null, healthy(), policy, 1000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.HEALTHY);
  assert.equal(state.bettingAllowed, true);
  state = advanceProviderLifecycle(state, failed(), policy, 2000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.DEGRADED);
  assert.equal(state.bettingAllowed, false);
  state = advanceProviderLifecycle(state, failed(), policy, 3000);
  state = advanceProviderLifecycle(state, failed(), policy, 4000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.OPEN);
  assert.equal(state.nextProbeAt, 34000);
  assert.equal(shouldProbeProvider(state, 33999), false);
  assert.equal(shouldProbeProvider(state, 34000), true);
  state = advanceProviderLifecycle(state, healthy(), policy, 35000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.RECOVERING);
  assert.equal(state.bettingAllowed, false);
  state = advanceProviderLifecycle(state, healthy(), policy, 36000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.HEALTHY);
  assert.equal(state.bettingAllowed, true);
});

test('transport recovery without valid prices never authorizes betting', () => {
  const state = advanceProviderLifecycle(null, {
    code: 'sportradar', enabled: true, transportHealthy: true, pricingReady: false
  }, policy, 1000);
  assert.equal(state.transportHealthy, true);
  assert.equal(state.pricingReady, false);
  assert.equal(state.bettingAllowed, false);
});

function fixture(source = 'sportradar') {
  return {
    id: 'sr-event-1',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-08-14T19:00:00Z',
    status: 'SCHEDULED',
    live: false,
    home: { name: 'Alpha FC', score: null, logo: null },
    away: { name: 'Beta FC', score: null, logo: null },
    markets: [{
      id: 'sr-market-1',
      key: 'h2h',
      type: '1X2',
      label: '1X2',
      period: 'FT',
      line: null,
      source,
      suspended: false,
      selections: [
        { key: 'home', label: 'Home', odds: 1.9, source, suspended: false },
        { key: 'draw', label: 'Draw', odds: 3.2, source, suspended: false },
        { key: 'away', label: 'Away', odds: 4.1, source, suspended: false }
      ]
    }],
    _refs: { [source]: 'sr:sport_event:1' },
    _sources: [source],
    _settlementReadySources: ['sportradar', 'manual-ops']
  };
}

test('feed merge accepts only Sportradar and preserves operator-only settlement authority', () => {
  const [merged] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [fixture()]
  }]);
  assert.equal(merged._sources[0], 'sportradar');
  assert.equal(merged.markets[0].source, 'sportradar');
  const authority = eventSettlementAuthority(merged);
  assert.equal(authority.ft, true);
  assert.equal(authority.ht, false);
  assert.equal(authority.automaticFt, false);
  assert.equal(authority.manualFt, true);
});

test('feed merge rejects retired odds provider results', () => {
  assert.throws(() => mergeProviderEvents([{
    provider: 'sportmonks',
    enabled: true,
    events: [fixture('sportmonks')]
  }]), /Non-Sportradar/);
});

test('acceptance trace stores feed revision and provider lifecycle state', () => {
  const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/011_sportsbook_provider_lifecycle.sql', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(feed, /SPORTS_MARKET_TEMPORARILY_UNAVAILABLE/);
  assert.match(feed, /feedRevision/);
  assert.match(betting, /accepted_feed_revision/);
  assert.match(betting, /provider_state_at_acceptance/);
  assert.match(migration, /sportsbook_provider_incidents/);
  assert.match(migration, /accepted_feed_revision/);
  assert.ok(app.includes('sportsbook\/health'));
  assert.ok(app.includes('sportsbook\/provider-incidents'));
});
