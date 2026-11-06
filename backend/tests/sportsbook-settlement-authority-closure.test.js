import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { advanceProviderLifecycle, PROVIDER_LIFECYCLE_STATES } from '../src/sportsbook-provider-lifecycle.js';
import { reconcileSportsbookMarketLifecycle } from '../src/sportsbook-market-lifecycle.js';

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

  assert.match(feed, /LIFECYCLE_GENERATION\s*=\s*'render-ingest-multisource-v2'/);
  assert.match(feed, /sportsbook:aggregated-feed:v17/);
  assert.match(feed, /sportsbook:provider-lifecycle:v6/);
  assert.match(feed, /sportsbook:market-lifecycle:v6/);
  assert.match(feed, /parsed\.lifecycleGeneration !== LIFECYCLE_GENERATION/);
  assert.match(feed, /memory\.lifecycleGeneration === LIFECYCLE_GENERATION/);
});
