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

});

const { signSportsbookQuote, verifySportsbookQuoteToken } = await import('../src/sportsbook-quote.js');

function payload(expiresAt = new Date(Date.now() + 15000).toISOString()) {
  return {
    v: 1,
    quoteId: '11111111-1111-4111-8111-111111111111',
    memberId: 'member-1',
    issuedAt: new Date().toISOString(),
    expiresAt,
    betType: 'SINGLE',
    systemSize: null,
    stake: 10000,
    totalStake: 10000,
    totalOdds: 1.91,
    potentialPayout: 19100,
    selections: [{
      eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1',
      acceptedOdds: 1.91, acceptedPriceVersion: 'price-version-123456'
    }]
  };
}

test('HF6 signed sportsbook quote round-trips and binds to member', () => {
  const token = signSportsbookQuote(payload());
  const verified = verifySportsbookQuoteToken(token, { memberId: 'member-1' });
  assert.equal(verified.quoteId, '11111111-1111-4111-8111-111111111111');
  assert.equal(verified.totalStake, 10000);
  assert.throws(() => verifySportsbookQuoteToken(token, { memberId: 'member-2' }), error => error.code === 'SPORTSBOOK_QUOTE_OWNER_MISMATCH');
});


test('R6.9.0.7 quote verifier accepts the production v2 quote emitted by createSportsbookQuote', () => {
  const v2 = { ...payload(), v: 2, oddsChangePolicy: 'REJECT', feedRevisions: ['rev-1'], providerStates: [], tradingMaxStake: 50000000, tradingControlVersions: [] };
  const verified = verifySportsbookQuoteToken(signSportsbookQuote(v2), { memberId: 'member-1' });
  assert.equal(verified.v, 2);
  assert.equal(verified.oddsChangePolicy, 'REJECT');
});

test('HF6 signed sportsbook quote rejects tamper and expiration', () => {
  const token = signSportsbookQuote(payload());
  const [body, sig] = token.split('.');
  const tampered = `${body.slice(0, -1)}${body.at(-1) === 'A' ? 'B' : 'A'}.${sig}`;
  assert.throws(() => verifySportsbookQuoteToken(tampered, { memberId: 'member-1' }), error => error.code === 'SPORTSBOOK_QUOTE_INVALID');
  const expired = signSportsbookQuote(payload(new Date(Date.now() - 1000).toISOString()));
  assert.throws(() => verifySportsbookQuoteToken(expired, { memberId: 'member-1' }), error => error.code === 'SPORTSBOOK_QUOTE_EXPIRED');
});

test('HF6 member contract uses server quote before real-money acceptance', () => {
  const betting = readFileSync(new URL('../src/sportsbook-betting.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  assert.match(betting, /createSportsbookQuote/);
  assert.match(betting, /SPORTSBOOK_QUOTE_REQUIRED/);
  assert.match(betting, /verifySportsbookQuoteToken\(quoteToken/);
  assert.ok(betting.indexOf('const replay = await ticketBy') < betting.indexOf('verifySportsbookQuoteToken(quoteToken'), 'idempotent replay must run before quote expiry gate');
  assert.match(app, /sportsbook\\\/quotes/);
  assert.match(ui, /\/api\/member\/sportsbook\/quotes/);
  assert.match(ui, /quoteToken: quote\.quoteToken/);
});
