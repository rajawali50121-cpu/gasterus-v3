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
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SPORTSBOOK_CASHOUT_ENABLED: 'true',
  SPORTSBOOK_CASHOUT_FACTOR_BPS: '9600',
  SPORTSBOOK_CASHOUT_MIN_OFFER: '100',
  SPORTSBOOK_REALTIME_ENABLED: 'true'
});

const { signCashoutOffer, verifyCashoutOfferToken, fairCashoutValue, offerAmount } = await import('../src/sportsbook-cashout-policy.js');

function signedPayload(overrides = {}) {
  return {
    v: 1,
    offerId: '11111111-1111-4111-8111-111111111111',
    memberId: 'member-1',
    ticketId: '22222222-2222-4222-8222-222222222222',
    invoice: 'SB-TEST-1',
    amount: 9600,
    fairValue: 10000,
    factorBps: 9600,
    offeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8000).toISOString(),
    feedRevisions: ['feed-1'],
    pricing: [{ legNo: 1, eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1', acceptedOdds: 2, currentOdds: 2, priceVersion: 'price-123456', provider: 'provider-a' }],
    ...overrides
  };
}

test('enterprise Cash Out offer is signed, member-bound, ticket-bound, and expiry-bound', () => {
  const token = signCashoutOffer(signedPayload());
  const verified = verifyCashoutOfferToken(token, { memberId: 'member-1', ticketId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(verified.amount, 9600);
  assert.throws(() => verifyCashoutOfferToken(token, { memberId: 'member-2' }), error => error.code === 'SPORTSBOOK_CASHOUT_OWNER_MISMATCH');
  assert.throws(() => verifyCashoutOfferToken(token, { ticketId: '33333333-3333-4333-8333-333333333333' }), error => error.code === 'SPORTSBOOK_CASHOUT_TICKET_MISMATCH');
  const expired = signCashoutOffer(signedPayload({ expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.throws(() => verifyCashoutOfferToken(expired), error => error.code === 'SPORTSBOOK_CASHOUT_OFFER_EXPIRED');
});

test('enterprise Cash Out pricing discounts current fair value and never exceeds potential payout', () => {
  const ticket = { bet_type: 'SINGLE', potential_payout: 20000 };
  const pricing = [{ acceptedOdds: 2, currentOdds: 2 }];
  assert.equal(fairCashoutValue(ticket, pricing), 10000);
  assert.equal(offerAmount(ticket, 10000), 9600);
  assert.equal(offerAmount(ticket, 50000), 20000);
});

test('production closure routes, migration and member wiring are present', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/014_sportsbook_cashout_realtime.sql', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  const proxy = readFileSync(new URL('../../deploy/member-server.js', import.meta.url), 'utf8');
  const realtime = readFileSync(new URL('../src/sportsbook-realtime.js', import.meta.url), 'utf8');
  assert.match(app, /sportsbook\\\/stream/);
  assert.match(app, /cashout\\\/offers/);
  assert.match(app, /cashout-offer/);
  assert.match(app, /acceptSportsbookCashout/);
  assert.match(app, /internal\\\/sportsbook\\\/readiness/);
  assert.match(migration, /CASHED_OUT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sportsbook_cashouts/);
  assert.match(ui, /STREAM_URL\s*=\s*['"]\/api\/member\/sportsbook\/stream['"]/);
  assert.match(ui, /fetch\(streamUrl\(\)/);
  assert.match(ui, /cashout|quoteToken/i);
  assert.match(proxy, /isRealtimeStream/);
  assert.match(proxy, /url\.pathname === '\/api\/internal\/sportsbook\/ingest'/);
  assert.match(proxy, /request\.method !== 'POST'/);
  assert.match(proxy, /x-sportsbook-timestamp/);
  assert.match(proxy, /x-sportsbook-signature/);
  assert.match(realtime, /text\/event-stream/);
  assert.match(realtime, /feedRevision/);
  assert.match(realtime, /bettableMarkets/);
});
