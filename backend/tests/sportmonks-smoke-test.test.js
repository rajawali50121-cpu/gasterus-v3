import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSportmonksResult } from '../scripts/sportmonks-smoke-test.js';

test('Sportmonks smoke summary reports fixtures, normalized data, bookmakers, and pages', () => {
  const summary = summarizeSportmonksResult({
    events: [
      { markets: [
        { bookmaker: 'Book A', selections: [{}, {}] },
        { bookmaker: 'Book B', selections: [{}] }
      ] },
      { markets: [{ bookmaker: 'Book A', selections: [{}, {}] }] }
    ],
    diagnostics: {
      fixturesFetched: 5,
      fixturesAdvertiseOdds: 4,
      fixturesWithOddsRows: 3,
      oddsRowsFetched: 9,
      fixturesWithMarkets: 2,
      unknownMarketCount: 2,
      pagesFetched: 3
    }
  });

  assert.deepEqual(summary, {
    fixtures: 5,
    fixturesAdvertiseOdds: 4,
    fixturesWithOddsRows: 3,
    oddsRowsFetched: 9,
    fixturesWithMarkets: 2,
    events: 2,
    markets: 3,
    odds: 5,
    bookmakers: 2,
    unknownMarkets: 2,
    pagesFetched: 3
  });
});
