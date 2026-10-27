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

const {
  advanceProviderLifecycle,
  shouldProbeProvider,
  PROVIDER_LIFECYCLE_STATES
} = await import('../src/sportsbook-provider-lifecycle.js');
const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');

const policy = { failureThreshold: 3, recoverySuccesses: 2, cooldownSeconds: 30 };
const healthy = (code = 'sharpapi') => ({ code, enabled: true, transportHealthy: true, pricingReady: true });
const failed = (code = 'sharpapi', error = 'timeout') => ({ code, enabled: true, transportHealthy: false, pricingReady: false, error });

test('provider circuit breaker fails closed and requires confirmed recovery streak', () => {
  let state = advanceProviderLifecycle(null, healthy(), policy, 1000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.HEALTHY);
  assert.equal(state.bettingAllowed, true);

  state = advanceProviderLifecycle(state, failed(), policy, 2000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.DEGRADED);
  assert.equal(state.bettingAllowed, false);
  state = advanceProviderLifecycle(state, failed(), policy, 3000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.DEGRADED);
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

test('transport can recover without making a metadata-only provider a pricing authority', () => {
  const state = advanceProviderLifecycle(null, {
    code: 'api-sports', enabled: true, transportHealthy: true, pricingReady: false
  }, policy, 1000);
  assert.equal(state.state, PROVIDER_LIFECYCLE_STATES.HEALTHY);
  assert.equal(state.transportHealthy, true);
  assert.equal(state.pricingReady, false);
  assert.equal(state.bettingAllowed, false);
});

function market(source, suspended) {
  return {
    id: `${source}-m`, key: 'h2h', type: '1X2', label: '1X2', period: 'FT', line: null,
    source, suspended,
    selections: [
      { key: `${source}-h`, label: 'Home', odds: 1.9, source, suspended },
      { key: `${source}-d`, label: 'Draw', odds: 3.2, source, suspended },
      { key: `${source}-a`, label: 'Away', odds: 4.1, source, suspended }
    ]
  };
}
function event(source, marketValue, settlementReady = []) {
  return {
    id: `${source}-event`, sport: 'Football', league: 'Premier League', country: 'England',
    startTime: '2026-08-14T19:00:00Z', status: 'SCHEDULED', providerStatus: 'NS', live: false, clock: null,
    home: { name: 'Alpha FC', score: null, logo: null }, away: { name: 'Beta FC', score: null, logo: null },
    periodScores: {}, markets: marketValue ? [marketValue] : [], _refs: { [source]: `${source}-1` }, _sources: [source],
    _settlementReadySources: settlementReady
  };
}

test('active lower-priority provider wins over a quarantined higher-priority price during failover', () => {
  const sharp = event('sharpapi', market('sharpapi', true), []);
  const api = event('api-sports', market('api-sports', false), ['api-sports']);
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharp] }, { events: [api] }]);
  assert.equal(merged.markets.length, 1);
  assert.equal(merged.markets[0].source, 'api-sports');
  assert.equal(merged.markets[0].suspended, false);
});

test('recovering score authority cannot silently unlock another providers prices', () => {
  const sharp = event('sharpapi', market('sharpapi', false), []);
  const recoveringApiSports = event('api-sports', null, []);
  const [merged] = __sportsbookProviders.mergeProviderEvents([{ events: [sharp] }, { events: [recoveringApiSports] }]);
  assert.ok(merged._sources.includes('api-sports'));
  assert.deepEqual(merged._settlementReadySources, []);
  assert.ok(merged.markets.every(item => item.suspended));
});

test('HF5 acceptance trace stores feed revision and provider lifecycle state', () => {
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
  assert.ok(app.includes('sportsbook\\/health'));
  assert.ok(app.includes('sportsbook\\/provider-incidents'));
});
