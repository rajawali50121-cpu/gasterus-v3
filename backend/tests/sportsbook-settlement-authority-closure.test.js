import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/sportsbook_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});
const { advanceProviderLifecycle, PROVIDER_LIFECYCLE_STATES } = await import('../src/sportsbook-provider-lifecycle.js');
const { reconcileSportsbookMarketLifecycle } = await import('../src/sportsbook-market-lifecycle.js');
const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { eventSettlementAuthority, SPORTSBOOK_SETTLEMENT_SOURCES } = await import('../src/sportsbook-settlement-authority.js');

const providerPolicy = { failureThreshold: 3, recoverySuccesses: 2, cooldownSeconds: 30 };
const marketPolicy = { reopenSuccesses: 2, reopenObservationSeconds: 30, retentionSeconds: 3600 };

function directSourceEvent() {
  return [{
    id: 'source-evt-1',
    status: 'SCHEDULED',
    providerStatus: 'NS',
    live: false,
    markets: [{
      id: 'source-ft-1x2',
      type: '1X2',
      period: 'FT',
      source: 'public-market',
      suspended: false,
      selections: [
        { key: 'home', odds: 1.91, source: 'public-market', suspended: false },
        { key: 'draw', odds: 3.2, source: 'public-market', suspended: false },
        { key: 'away', odds: 4.1, source: 'public-market', suspended: false }
      ]
    }]
  }];
}

test('R6.9.0.11 fresh direct source becomes provider-healthy on its first healthy generation sample', () => {
  const next = advanceProviderLifecycle(null, {
    code: 'public-market',
    enabled: true,
    transportHealthy: true,
    pricingReady: true
  }, providerPolicy, 1000);

  assert.equal(next.state, PROVIDER_LIFECYCLE_STATES.HEALTHY);
  assert.equal(next.transportHealthy, true);
  assert.equal(next.pricingReady, true);
  assert.equal(next.bettingAllowed, true);
});

test('R6.9.0.11 fresh FT market starts ACTIVE instead of inheriting an obsolete recovery streak', () => {
  const result = reconcileSportsbookMarketLifecycle({}, directSourceEvent(), { ...marketPolicy, now: 1000 });
  const market = result.events[0].markets[0];

  assert.equal(market.lifecycleState, 'ACTIVE');
  assert.equal(market.lifecycleReason, 'INITIAL_ACTIVE');
  assert.equal(market.suspended, false);
  assert.equal(result.stats.active, 1);
  assert.equal(result.stats.reopening, 0);
});

test('sportsbook feed cache is generation-isolated from the previous production lifecycle', () => {
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');

  assert.match(feed, /LIFECYCLE_GENERATION\s*=\s*'render-ingest-provider-backed-v3'/);
  assert.match(feed, /sportsbook:aggregated-feed'/);
  assert.match(feed, /sportsbook:provider-lifecycle'/);
  assert.match(feed, /sportsbook:market-lifecycle'/);
  assert.match(feed, /parsed\.lifecycleGeneration !== LIFECYCLE_GENERATION/);
  assert.match(feed, /memory\.lifecycleGeneration === LIFECYCLE_GENERATION/);
});

test('provider market safety and settlement authority share the same fail-closed source policy', () => {
  assert.deepEqual(SPORTSBOOK_SETTLEMENT_SOURCES, {
    automaticFt: ['api-sports', 'public-market', 'sportmonks'],
    manualFt: ['manual-ops'],
    ht: ['api-sports', 'public-market']
  });
  const sources = [...new Set([
    ...SPORTSBOOK_SETTLEMENT_SOURCES.automaticFt,
    ...SPORTSBOOK_SETTLEMENT_SOURCES.manualFt,
    'footballdata-io',
    'sharpapi',
    'unknown'
  ])];

  for (const source of sources) {
    const event = {
      _settlementReadySources: [source],
      markets: ['FT', '1H'].map(period => ({
        period,
        suspended: false,
        selections: [{ suspended: false }]
      }))
    };
    const authority = eventSettlementAuthority(event);
    __sportsbookProviders.applySettlementSafety(event);
    assert.equal(event.markets[0].suspended, !authority.ft, `${source} FT decision`);
    assert.equal(event.markets[1].suspended, !authority.ht, `${source} HT decision`);
    assert.equal(authority.ft, SPORTSBOOK_SETTLEMENT_SOURCES.automaticFt.includes(source)
      || SPORTSBOOK_SETTLEMENT_SOURCES.manualFt.includes(source));
    assert.equal(authority.ht, SPORTSBOOK_SETTLEMENT_SOURCES.ht.includes(source));
  }
});
