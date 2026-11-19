import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://user:pass@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379/0';
process.env.MEMBER_PROXY_SECRET ||= 'm'.repeat(40);
process.env.ADMIN_PROXY_SECRET ||= 'a'.repeat(40);
process.env.OPS_INTERNAL_SECRET ||= 'o'.repeat(40);
process.env.SESSION_HMAC_KEY ||= 's'.repeat(40);
process.env.API_KEY_PEPPER ||= 'p'.repeat(40);
const { applySportsbookRiskRepricing } = await import('../src/sportsbook-risk-pricing.js');

function fixture() {
  return [{ id:'evt', markets:[{ id:'mkt', source:'sportradar', type:'1X2', period:'FT', selections:[
    { key:'home', label:'Home', source:'sportradar', odds:2.0, updatedAt:'2026-08-17T00:00:00.000Z', anchorUpdatedAt:'2026-08-17T00:00:00.000Z' },
    { key:'draw', label:'Draw', source:'sportradar', odds:3.5, updatedAt:'2026-08-17T00:00:00.000Z', anchorUpdatedAt:'2026-08-17T00:00:00.000Z' },
    { key:'away', label:'Away', source:'sportradar', odds:4.0, updatedAt:'2026-08-17T00:00:00.000Z', anchorUpdatedAt:'2026-08-17T00:00:00.000Z' }
  ]}] }];
}

test('R6.9.0.15 internal exposure shortens backed price without random movement', () => {
  const before = fixture();
  const after = applySportsbookRiskRepricing(before, [{ eventId:'evt', marketId:'mkt', selectionId:'home', liability:'500000000' }], { now: Date.parse('2026-08-17T01:00:00.000Z') });
  const [home, draw, away] = after[0].markets[0].selections;
  assert.ok(home.odds < 2.0);
  assert.ok(draw.odds > 3.5);
  assert.ok(away.odds > 4.0);
  assert.equal(home.anchorUpdatedAt, '2026-08-17T00:00:00.000Z');
  assert.equal(home.updatedAt, '2026-08-17T00:00:00.000Z', 'risk repricing must not refresh provider timestamp');
  assert.equal(home.riskRepricedAt, '2026-08-17T01:00:00.000Z');
  assert.equal(after[0].markets[0].updatedAt, null, 'risk repricing must not create a provider market timestamp');
  assert.equal(after[0].markets[0].riskRepricedAt, '2026-08-17T01:00:00.000Z');
  assert.equal(home.pricingModel, 'GASTERUS_RISK_SHADE_V1');
  assert.equal(home.riskShadeBps, 600);
  const repeated = applySportsbookRiskRepricing(fixture(), [{ eventId:'evt', marketId:'mkt', selectionId:'home', liability:'500000000' }], { now: Date.parse('2026-08-17T01:00:00.000Z') });
  assert.deepEqual(repeated, after);
});

test('R6.9.0.15 no exposure preserves source prices exactly', () => {
  const before = fixture();
  assert.deepEqual(applySportsbookRiskRepricing(before, [], { now: 1 }), before);
});
