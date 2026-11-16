import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./sportradar-fixture.json', import.meta.url), 'utf8'));

let fetchCallCount = 0;
let lastUrl = null;

globalThis.fetch = async (url) => {
  fetchCallCount += 1;
  lastUrl = String(url);
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-max-results', '2']]),
    json: async () => fixture
  };
};

const { fetchSportradar } = await import('../src/sportradar-provider.js');

test('Sportradar: filters removed books/outcomes, uses qualifier, skips replaced_by and cancelled, skips is_live markets', async () => {
  const result = await fetchSportradar({ maxEvents: 0, maxPages: 0, daysAhead: 7 });
  assert.equal(result.enabled, true);
  assert.ok(fetchCallCount >= 1, `fetch called at least once, got ${fetchCallCount}`);
  assert.ok(lastUrl.includes('/sport_event_markets.json'), 'fetch URL is sport_event_markets endpoint');

  const events = result.events;

  // TEST1: 1x2, handicap, total all present
  const e1 = events.find(e => e.providerId === 'TEST1');
  console.log('TEST1 markets:', e1 ? e1.markets.map(m => ({ type: m.type, selections: m.selections.length })) : 'NOT FOUND');
  console.log('TEST1 all events:', events.map(e => ({ id: e.providerId, markets: e.markets.map(m => m.type) })));
  assert.ok(e1, 'TEST1 event present');
  const types1 = new Set(e1.markets.map(m => m.type));
  assert.ok(types1.has('1X2'), 'TEST1 has 1X2');
  assert.ok(types1.has('HANDICAP'), 'TEST1 has HANDICAP');
  assert.ok(types1.has('TOTALS'), 'TEST1 has TOTALS');

  // TEST1 home/away from qualifier
  assert.equal(e1.home, 'Home Team', 'home from qualifier');
  assert.equal(e1.away, 'Away Team', 'away from qualifier');

  // TEST1 1X2 order HOME/DRAW/AWAY
  const m1x2 = e1.markets.find(m => m.type === '1X2');
  assert.ok(m1x2);
  const labels = m1x2.selections.map(s => s.label);
  assert.deepEqual(labels, ['HOME', 'DRAW', 'AWAY']);

  // TEST2 replaced_by: skipped
  const e2 = events.find(e => e.providerId === 'TEST2');
  assert.equal(e2, undefined, 'TEST2 replaced_by skipped');

  // TEST3 cancelled: skipped
  const e3 = events.find(e => e.providerId === 'TEST3');
  assert.equal(e3, undefined, 'TEST3 cancelled skipped');

  // TEST4: home/away from qualifier (away=home name, away name in home slot)
  const e4 = events.find(e => e.providerId === 'TEST4');
  assert.ok(e4, 'TEST4 event present');
  // TEST4 has 1x2 with removed outcomes: consensus book has home removed:true, away removed:true -> only draw remains -> not 3 selections -> market dropped
  const m1x2_4 = e4.markets.find(m => m.type === '1X2');
  assert.equal(m1x2_4, undefined, 'TEST4 1X2 market dropped (removed outcomes leave <3 selections)');

  // TEST4 has is_live true market -> skipped entirely (no is_live market in output)
  const live1x2 = e4.markets.filter(m => m.type === '1X2' && m.selections.some(s => s.odds > 0 && s.label === 'HOME'));
  // Simply: TEST4 should not have any 1X2 market at all (both removed-outcome and is_live ones are dropped)
  assert.equal(e4.markets.filter(m => m.type === '1X2').length, 0, 'TEST4 no 1X2 market (removed outcomes + is_live skipped)');

  // Replaced by skipped count logged - check via result or console
  console.log('Events:', events.map(e => ({ id: e.providerId, home: e.home, away: e.away, markets: e.markets.map(m => m.type) })));
});
