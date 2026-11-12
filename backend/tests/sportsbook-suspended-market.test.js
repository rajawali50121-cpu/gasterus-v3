import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/gasterus-test',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: process.env.MEMBER_PROXY_SECRET || 'm'.repeat(48),
  ADMIN_PROXY_SECRET: process.env.ADMIN_PROXY_SECRET || 'a'.repeat(48),
  OPS_INTERNAL_SECRET: process.env.OPS_INTERNAL_SECRET || 'o'.repeat(48),
  SESSION_HMAC_KEY: process.env.SESSION_HMAC_KEY || 's'.repeat(48),
  API_KEY_PEPPER: process.env.API_KEY_PEPPER || 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: process.env.MFA_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 1).toString('base64')
});

const [{ suspendStaleLiveMarkets, mergeProviderEvents, teamKey }, { buildSportsbookRenderSnapshot }] = await Promise.all([
  import('../src/sportsbook-providers.js'),
  import('../src/sportsbook-render-worker-core.js')
]);

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function eventWithMarket(provider, { id, suspended = false } = {}) {
  return {
    provider,
    event: {
      id,
      sport: 'Football',
      league: 'Premier League',
      home: { name: 'Home', score: null },
      away: { name: 'Away', score: null },
      status: 'SCHEDULED',
      live: false,
      markets: [
        {
          id: `${id}-m1`,
          type: '1X2',
          period: 'FT',
          line: null,
          source: provider,
          suspended,
          selections: [
            { key: `${id}-s1`, label: 'Home', odds: 2.0, suspended, source: provider },
            { key: `${id}-s2`, label: 'Draw', odds: 3.0, suspended, source: provider },
            { key: `${id}-s3`, label: 'Away', odds: 4.0, suspended, source: provider }
          ]
        }
      ],
      _sources: [provider],
      _refs: { [provider]: id }
    }
  };
}

test('suspendStaleLiveMarkets menandai market live dengan harga basi sebagai suspended', () => {
  const stale = new Date(NOW - 300000).toISOString(); // 5 menit yang lalu
  const events = [
    {
      id: 'evt-1',
      status: 'LIVE',
      live: true,
      markets: [
        {
          id: 'mkt-1',
          type: '1X2',
          period: 'FT',
          source: 'sportmonks',
          suspended: false,
          updatedAt: stale,
          selections: [
            { key: 'sel-1', label: 'Home', odds: 2.0, suspended: false, source: 'sportmonks', updatedAt: stale }
          ]
        }
      ]
    }
  ];

  const result = suspendStaleLiveMarkets(events, NOW);

  assert.equal(result[0].markets[0].suspended, true);
  assert.equal(result[0].markets[0].selections[0].suspended, true);
});

test('market suspended tidak tersedia untuk pasang taruhan (bettable count nol)', () => {
  const events = [
    {
      id: 'evt-2',
      markets: [
        {
          id: 'mkt-2',
          type: '1X2',
          period: 'FT',
          source: 'sportmonks',
          suspended: true,
          selections: [
            { key: 'sel-2', label: 'Home', odds: 2.0, suspended: true, source: 'sportmonks' }
          ]
        }
      ]
    }
  ];

  const bettable = events.reduce((total, event) =>
    total + event.markets.filter(market =>
      !market.suspended && market.selections.some(selection =>
        !selection.suspended && Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1
      )
    ).length, 0);

  assert.equal(bettable, 0);
});

test('mergeProviderEvents dengan hanya provider odds tanpa hasil tetap menghasilkan event', () => {
  const result = mergeProviderEvents([
    {
      provider: 'the-odds-api',
      events: [eventWithMarket('the-odds-api', { id: 'odds-only' }).event]
    }
  ], { enabled: true });

  assert.equal(result.length, 1, 'Odds-only event retained');
  assert.equal(result[0].markets.length, 1);
  assert.equal(result[0].markets[0].selections.length, 3);
});

test('Worker menolak snapshot ketika Sportmonks gagal 429 dan provider lain kosong', async () => {
  await assert.rejects(
    buildSportsbookRenderSnapshot({
      fetchSportmonks: async () => {
        const error = new Error('Sportmonks returned HTTP 429');
        error.status = 429;
        throw error;
      },
      fetchMoviOdds: async () => ({ provider: 'moviodds', enabled: true, events: [] }),
      fetchSharpApi: async () => ({ provider: 'sharpapi', enabled: true, events: [] }),
      fetchOddsApi: async () => ({ provider: 'the-odds-api', enabled: false, events: [] }),
      teamKey
    }),
    /No enabled sportsbook provider returned normalized, priced fixtures/
  );
});
