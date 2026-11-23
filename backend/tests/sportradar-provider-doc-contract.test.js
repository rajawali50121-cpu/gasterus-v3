import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const runtimeEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@example.com/test',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
};

function runNormalizer(source) {
  const script = `
    import { __sportradarNormalizer } from './src/sportradar-provider.js';
    ${source}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: runtimeEnv
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\\r?\\n/).at(-1));
}

test('Sportradar OC Prematch market 14 uses documented outcome.type/field_id, not outcome IDs', () => {
  const output = runNormalizer(`
    const event = { id: 'sr:sport_event:1', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
    const raw = { markets: [{
      id: 'sr:market:14', name: 'handicap', is_live: false,
      books: [{ id: 'sr:book:1', name: 'Book', removed: false, outcomes: [
        { id: 'sr:outcome:90001', type: 'home_handicap', field_id: '3', handicap: '-1', odds_decimal: '1.91', removed: false },
        { id: 'sr:outcome:90002', type: 'draw_handicap', field_id: '4', handicap: '0', odds_decimal: '3.40', removed: false },
        { id: 'sr:outcome:90003', type: 'away_handicap', field_id: '5', handicap: '1', odds_decimal: '4.10', removed: false }
      ] }]
    }] };
    const result = __sportradarNormalizer.normalizeOdds(event, raw);
    const market = result.markets[0];
    console.log(JSON.stringify({
      type: market.type,
      outcomes: market.selections.map(item => ({ type: item.outcomeType, label: item.label, line: item.line, odds: item.odds, suspended: item.suspended }))
    }));
  `);
  assert.equal(output.type, 'EUROPEAN_HANDICAP');
  assert.deepEqual(output.outcomes.map(item => item.type), ['home', 'draw', 'away']);
  assert.deepEqual(output.outcomes.map(item => item.line), [-1, 0, 1]);
  assert.deepEqual(output.outcomes.map(item => item.suspended), [false, false, false]);
});

test('unknown market IDs are not force-mapped to handicap', () => {
  const output = runNormalizer(`
    console.log(JSON.stringify({
      unknown: __sportradarNormalizer.marketType('unclassified provider market', 2, false, 'sr:market:16'),
      documentedHandicap: __sportradarNormalizer.marketType('handicap', 3, true, 'sr:market:14')
    }));
  `);
  assert.equal(output.unknown, 'OTHER');
  assert.equal(output.documentedHandicap, 'EUROPEAN_HANDICAP');
});

test('documented three-way handicap with unknown outcome semantics is suspended safely', () => {
  const output = runNormalizer(`
    const event = { id: 'sr:sport_event:2', home: { name: 'Home FC' }, away: { name: 'Away FC' } };
    const result = __sportradarNormalizer.normalizeOdds(event, { markets: [{
      id: 'sr:market:14', name: 'handicap', is_live: false,
      books: [{ id: 'sr:book:1', removed: false, outcomes: [
        { id: 'sr:outcome:arbitrary', type: 'provider_new_value', field_id: '99', handicap: '-0.5', odds_decimal: '1.90', removed: false }
      ] }]
    }] });
    console.log(JSON.stringify(result.markets[0].selections[0].suspended));
  `);
  assert.equal(output, true);
});
