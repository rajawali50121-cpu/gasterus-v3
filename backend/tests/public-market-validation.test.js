import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.MEMBER_PROXY_SECRET ||= 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET ||= 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET ||= 'o'.repeat(48);
process.env.SESSION_HMAC_KEY ||= 's'.repeat(48);
process.env.API_KEY_PEPPER ||= 'p'.repeat(48);
process.env.MFA_ENCRYPTION_KEY_BASE64 ||= Buffer.alloc(32).toString('base64');

const { mapMarket } = await import('../src/markets.js');

test('unmapped market with ---- result does not publish a fake result', () => {
  const row = {
    slug: 'toto-macau-midnight',
    code: 'TMC-00',
    name: 'TOTO MACAU MIDNIGHT',
    result: '----',
    period: null,
    category: 'asia',
    tags: ['popular'],
    status: 'open',
    sort_order: 2,
    verification_status: 'UNMAPPED',
    betting_status: 'SUSPENDED',
    betting_period: null,
    close_at: null,
    source_updated_at: null,
    updated_at: '2026-10-10T00:00:00Z',
    draw_date: null,
    draw_time: null,
    history_result: null,
    history_period: null,
    history_draw_date: null,
    history_draw_time: null,
    history_source_updated_at: null,
    history_created_at: null
  };

  const market = mapMarket(row, { includeHistorical: false });

  assert.equal(market.result, null);
  assert.equal(market.resultTrusted, false);
  assert.equal(market.verificationStatus, 'UNMAPPED');
});
