import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SPORTRADAR_ENABLED: 'true',
  SPORTRADAR_API_KEY: 'test-sportradar-key',
  SPORTRADAR_BASE_URL: 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en',
  SPORTRADAR_SPORT_IDS: 'sr:sport:1',
  SPORTRADAR_MIN_INTERVAL_MS: '100',
  SPORTRADAR_MAX_CALLS_PER_HOUR: '20',
  SPORTRADAR_REQUEST_TIMEOUT_MS: '5000'
});

const { fetchSportradarV2, __sportradarV2 } = await import('../src/sportradar-provider-v2.js');

test('v2 adapter discovers books/sports/competition coverage then consumes documented daily sport event markets', async () => {
  const calls = [];
  const eventDate = __sportradarV2.utcDates(1)[0];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith('/sports.json')) {
      return new Response(JSON.stringify({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }), { status: 200 });
    }
    if (url.pathname.endsWith('/books.json')) {
      return new Response(JSON.stringify({ books: [{ id: 'sr:book:25080', name: 'consensus' }] }), { status: 200 });
    }
    if (url.pathname.endsWith('/competitions.json')) {
      return new Response(JSON.stringify({ competitions: [{ id: 'sr:competition:1', name: 'League', markets: true }] }), { status: 200 });
    }
    if (url.pathname.includes('/sport_event_markets.json')) {
      assert.equal(url.pathname, `/oddscomparison-prematch/trial/v2/en/sports/sr:sport:1/schedules/${eventDate}/sport_event_markets.json`);
      assert.equal(url.searchParams.get('limit'), '50');
      const item = {
        sport_event: {
          id: 'sr:sport_event:fixture-1',
          start_time: '2026-12-01T18:00:00Z',
          status: 'not_started',
          sport_event_context: { competition: { name: 'League' } },
          competitors: [
            { id: 'sr:competitor:1', name: 'Home FC', qualifier: 'home' },
            { id: 'sr:competitor:2', name: 'Away FC', qualifier: 'away' }
          ]
        },
        markets: [{
          id: 'sr:market:1',
          name: '1x2',
          is_live: false,
          books: [{
            id: 'sr:book:25080',
            name: 'consensus',
            removed: false,
            outcomes: [
              { id: 'sr:outcome:1', type: 'home', odds_decimal: '2.10', removed: false },
              { id: 'sr:outcome:2', type: 'draw', odds_decimal: '3.20', removed: false },
              { id: 'sr:outcome:3', type: 'away', odds_decimal: '3.50', removed: false }
            ]
          }]
        }]
      };
      return new Response(JSON.stringify({ generated_at: '2026-11-22T00:00:00Z', sport_event_markets: [item] }), {
        status: 200,
        headers: { 'x-max-results': '1' }
      });
    }
    throw new Error(`Unexpected Sportradar endpoint: ${url.pathname}`);
  };

  const result = await fetchSportradarV2({ daysAhead: 1 });
  assert.equal(result.provider, 'sportradar');
  assert.equal(result.enabled, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'sr:sport_event:fixture-1');
  assert.equal(result.events[0].home.name, 'Home FC');
  assert.equal(result.events[0].away.name, 'Away FC');
  assert.equal(result.events[0].markets.length, 1);
  assert.equal(result.events[0].markets[0].sourceBookId, 'sr:book:25080');
  assert.deepEqual(calls.map(url => url.pathname.split('/').pop()), [
    'sports.json', 'books.json', 'competitions.json', 'sport_event_markets.json',
    'sport_event_markets.json'
  ]);
});

test('v2 adapter rejects incomplete pagination and does not publish partial event lists', async () => {
  const date = __sportradarV2.utcDates(1)[0];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sports.json')) return new Response(JSON.stringify({ sports: [{ id: 'sr:sport:1', name: 'Soccer', type: 'competition' }] }));
    if (url.pathname.endsWith('/books.json')) return new Response(JSON.stringify({ books: [{ id: 'sr:book:1', name: 'Book' }] }));
    if (url.pathname.endsWith('/competitions.json')) return new Response(JSON.stringify({ competitions: [{ id: 'sr:competition:1', markets: true }] }));
    if (url.pathname.includes('/sport_event_markets.json')) {
      const start = Number(url.searchParams.get('start') || 0);
      if (start === 0) {
        return new Response(JSON.stringify({ sport_event_markets: [{ sport_event: { id: 'sr:sport_event:1' }, markets: [] }] }), {
          headers: { 'x-max-results': '60' }
        });
      }
      return new Response(JSON.stringify({ sport_event_markets: [] }), { headers: { 'x-max-results': '60' } });
    }
    throw new Error('Unexpected endpoint');
  };
  await assert.rejects(fetchSportradarV2({ daysAhead: 1 }), /pagination incomplete at offset 50/);
});
