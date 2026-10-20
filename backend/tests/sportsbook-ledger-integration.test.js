import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const integrationEnabled = process.env.SPORTSBOOK_INTEGRATION === '1';

if (integrationEnabled) {
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)
    || !/^\/sportsbook_test(?:$|\/)/.test(databaseUrl.pathname)) {
    throw new Error('Sportsbook integration tests require a loopback-only database named sportsbook_test.');
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SPORTSBOOK_QUOTE_REQUIRED: 'true',
    SPORTSBOOK_MAX_MEMBER_LIABILITY: '100000',
    SPORTSBOOK_CASHOUT_ENABLED: 'true',
    SPORTSBOOK_CASHOUT_FACTOR_BPS: '9600',
    SPORTSBOOK_CASHOUT_MIN_OFFER: '1',
    SPORTMONKS_ENABLED: 'true',
    SPORTMONKS_API_KEY: 'integration-fake-provider-key',
    SPORTMONKS_BASE_URL: 'http://127.0.0.1:18081/v3',
    SPORTMONKS_DAYS_AHEAD: '0',
    SESSION_HMAC_KEY: 'integration-session-key-not-a-secret-0000000000000000',
    API_KEY_PEPPER: 'integration-api-key-pepper-not-a-secret-00000000000000',
    MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString('base64')
  });
}

const skipped = { skip: !integrationEnabled };

test('isolated database: sportsbook bet, ledger, settlement, cashout and exposure', skipped, async t => {
  const [{ query, tx, closeDatabase }, { createSportsbookBet, createSportsbookQuote, settleSportsbookTicketAutomatic, rollbackSportsbookSettlement }, { postTransfer, SYSTEM_ACCOUNTS, verifyLedger }, { signSportsbookQuote }, { evaluateSportsbookLeg }, { createSportsbookCashoutOffer, acceptSportsbookCashout }, { signCashoutOffer }, { fetchSportmonks }, { eventSettlementAuthority }] = await Promise.all([
    import('../src/db.js'),
    import('../src/sportsbook-betting.js'),
    import('../src/ledger.js'),
    import('../src/sportsbook-quote.js'),
    import('../src/sportsbook-result-evaluator.js'),
    import('../src/sportsbook-cashout.js'),
    import('../src/sportsbook-cashout-policy.js'),
    import('../src/sportsbook-providers.js'),
    import('../src/sportsbook-settlement-authority.js')
  ]);

  const cleanups = [];
  t.after(async () => {
    await Promise.all(cleanups);
    await closeDatabase();
  });

  async function member(balance = 100000) {
    const id = randomUUID();
    const username = `sbtest-${id.replaceAll('-', '')}`;
    await tx(async client => {
      await client.query(
        'INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',
        [id, username, 'test-only-not-a-password-hash']
      );
      await client.query(
        `INSERT INTO ledger_accounts(id,owner_user_id,account_code,account_type,current_balance,currency)
         VALUES($1,$2,$3,'MEMBER',0,'IDR')`,
        [randomUUID(), id, `TEST:MEMBER:${id}`]
      );
      await postTransfer(client, {
        memberId: id,
        systemCode: SYSTEM_ACCOUNTS.CLEARING,
        memberDelta: balance,
        type: 'TEST_MEMBER_FUNDING',
        referenceType: 'TEST_MEMBER',
        referenceId: id,
        idempotencyKey: `test-funding:${id}`
      });
    });
    return { userId: id, createdAt: new Date(Date.now() - 1000).toISOString() };
  }

  function snapshotFor({ eventId, marketId, selectionId }, {
    odds = 2,
    priceVersion = null,
    suspended = false,
    status = 'SCHEDULED',
    providerStatus = 'NS',
    score = [null, null]
  } = {}) {
    if (suspended) {
      const error = new Error('Pasaran sedang ditutup atau tidak tersedia.');
      error.code = 'SPORTS_MARKET_SUSPENDED';
      error.status = 409;
      throw error;
    }
    const event = {
      id: eventId,
      sport: 'Football',
      league: 'Integration Test League',
      startTime: new Date(Date.now() + 3600000).toISOString(),
      live: status === 'LIVE',
      status,
      providerStatus,
      home: { name: 'Mock Home', score: score[0] },
      away: { name: 'Mock Away', score: score[1] },
      periodScores: { '1H': { home: 1, away: 0 } },
      _sources: ['sportmonks'],
      _settlementReadySources: ['sportmonks']
    };
    const market = {
      id: marketId,
      key: marketId,
      type: '1X2',
      label: '1X2',
      period: 'FT',
      line: null,
      source: 'sportmonks',
      suspended: false
    };
    const selection = {
      key: selectionId,
      label: 'Home',
      odds,
      line: null,
      priceVersion: priceVersion === null ? `price-${eventId}` : priceVersion,
      source: 'sportmonks',
      sourceSelectionId: `${marketId}:${selectionId}`,
      updatedAt: new Date().toISOString(),
      suspended: false
    };
    return {
      event,
      market,
      selection,
      feedFetchedAt: Date.now(),
      feedRevision: `fixture-${eventId}`,
      providerState: 'HEALTHY',
      tradingPolicy: { suspended: false }
    };
  }

  const resolver = options => snapshotFor(options);
  function selections(eventId = randomUUID()) {
    return [{
      eventId,
      marketId: `market-${eventId}`,
      selectionId: `selection-${eventId}`,
      acceptedOdds: 2,
      acceptedPriceVersion: `price-${eventId}`,
      provider: 'sportmonks'
    }];
  }

  async function quote(session, picks, { stake = 1000, betType = 'SINGLE', oddsChangePolicy = 'REJECT' } = {}, selectionSnapshot = resolver) {
    return createSportsbookQuote(session, {
      selections: picks,
      betType,
      stake,
      oddsChangePolicy
    }, { selectionSnapshot });
  }

  async function place(session, { picks = selections(), stake = 1000, idempotencyKey = `idem-${randomUUID()}`, betType = 'SINGLE', selectionSnapshot = resolver, oddsChangePolicy = 'REJECT' } = {}) {
    const q = await quote(session, picks, { stake, betType, oddsChangePolicy }, selectionSnapshot);
    const ticket = await createSportsbookBet(session, { idempotencyKey, quoteToken: q.quoteToken }, { selectionSnapshot });
    return { ticket, quote: q, picks };
  }

  async function assertLedgerBalanced() {
    const result = await tx(client => verifyLedger(client));
    assert.equal(result.balanced, true, JSON.stringify(result));
  }

  async function memberBalance(memberId) {
    const result = await query('SELECT current_balance FROM ledger_accounts WHERE owner_user_id=$1', [memberId]);
    return Number(result.rows[0].current_balance);
  }

  async function ticketCount(memberId) {
    const result = await query('SELECT COUNT(*)::int AS count FROM sportsbook_tickets WHERE member_id=$1', [memberId]);
    return result.rows[0].count;
  }

  await t.test('normal acceptance debits stake and atomically creates ticket and leg', async () => {
    const session = await member();
    const { ticket } = await place(session);
    assert.equal(ticket.status, 'OPEN');
    assert.equal(ticket.totalStake, 1000);
    assert.equal(await memberBalance(session.userId), 99000);
    const count = await query('SELECT COUNT(*)::int AS count FROM sportsbook_legs WHERE ticket_id=$1', [ticket.id]);
    assert.equal(count.rows[0].count, 1);
    await assertLedgerBalanced();
  });

  await t.test('same idempotency key and quote in parallel return one ticket; different keys cannot consume quote twice', async () => {
    const session = await member();
    const picks = selections();
    const q = await quote(session, picks);
    const results = await Promise.all([
      createSportsbookBet(session, { idempotencyKey: 'same-idempotency-key-0001', quoteToken: q.quoteToken }, { selectionSnapshot: resolver }),
      createSportsbookBet(session, { idempotencyKey: 'same-idempotency-key-0001', quoteToken: q.quoteToken }, { selectionSnapshot: resolver })
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(await ticketCount(session.userId), 1);
    assert.equal(await memberBalance(session.userId), 99000);

    const competingQuote = await quote(session, selections());
    const competingRequests = await Promise.all([
      createSportsbookBet(session, { idempotencyKey: `different-a-${randomUUID()}`, quoteToken: competingQuote.quoteToken }, { selectionSnapshot: resolver }),
      createSportsbookBet(session, { idempotencyKey: `different-b-${randomUUID()}`, quoteToken: competingQuote.quoteToken }, { selectionSnapshot: resolver })
    ]);
    assert.equal(competingRequests[0].id, competingRequests[1].id);
    assert.equal(await ticketCount(session.userId), 2);
    assert.equal(await memberBalance(session.userId), 98000);

    const replay = await createSportsbookBet(session, { idempotencyKey: `new-${randomUUID()}`, quoteToken: q.quoteToken }, { selectionSnapshot: resolver });
    assert.equal(replay.id, results[0].id);
    const another = await place(session, { picks: selections(), idempotencyKey: `other-${randomUUID()}` });
    assert.notEqual(another.ticket.id, competingRequests[0].id);
    assert.equal(await ticketCount(session.userId), 3);
    assert.equal(await memberBalance(session.userId), 97000);
    await assertLedgerBalanced();
  });

  await t.test('50 concurrent bets with limited balance and member exposure never make balance negative', async () => {
    const session = await member(10000);
    const attempts = await Promise.allSettled(Array.from({ length: 50 }, () =>
      place(session, { stake: 1000, picks: selections(), idempotencyKey: `parallel-${randomUUID()}` })
    ));
    const accepted = attempts.filter(result => result.status === 'fulfilled');
    const balance = await memberBalance(session.userId);
    assert.equal(accepted.length, 10, `expected balance, not member exposure, to cap accepted bets; got ${accepted.length}`);
    assert.ok(balance >= 0, `negative balance ${balance}`);
    const entries = await query(
      `SELECT COALESCE(SUM(e.amount_signed),0)::bigint AS total
       FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_user_id=$1`,
      [session.userId]
    );
    assert.equal(Number(entries.rows[0].total), balance);
    await assertLedgerBalanced();
  });

  await t.test('expired quote and changed/worsened odds are rejected under their acceptance policies', async () => {
    const session = await member();
    const picks = selections();
    const expiredToken = signSportsbookQuote({
      v: 2,
      quoteId: randomUUID(),
      memberId: session.userId,
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      betType: 'SINGLE',
      systemSize: null,
      stake: 1000,
      totalStake: 1000,
      totalOdds: 2,
      potentialPayout: 2000,
      oddsChangePolicy: 'REJECT',
      selections: picks.map(selection => ({
        eventId: selection.eventId,
        marketId: selection.marketId,
        selectionId: selection.selectionId,
        acceptedOdds: 2,
        acceptedPriceVersion: `price-${selection.eventId}`,
        provider: 'sportmonks'
      }))
    });
    await assert.rejects(
      createSportsbookBet(session, { idempotencyKey: `expired-${randomUUID()}`, quoteToken: expiredToken }, { selectionSnapshot: resolver }),
      error => error.code === 'SPORTSBOOK_QUOTE_EXPIRED'
    );

    const rejectedQuote = await quote(session, picks, { oddsChangePolicy: 'REJECT' });
    const changedResolver = options => snapshotFor(options, { odds: 2.2, priceVersion: 'changed-price-version' });
    await assert.rejects(
      createSportsbookBet(session, { idempotencyKey: `changed-${randomUUID()}`, quoteToken: rejectedQuote.quoteToken }, { selectionSnapshot: changedResolver }),
      error => error.code === 'SPORTSBOOK_ODDS_CHANGED'
    );

    const worseQuote = await quote(session, picks, { oddsChangePolicy: 'ACCEPT_BETTER' });
    const worseResolver = options => snapshotFor(options, { odds: 1.8, priceVersion: 'worse-price-version' });
    await assert.rejects(
      createSportsbookBet(session, { idempotencyKey: `worse-${randomUUID()}`, quoteToken: worseQuote.quoteToken }, { selectionSnapshot: worseResolver }),
      error => error.code === 'SPORTSBOOK_ODDS_WORSE_REJECTED'
    );
    assert.equal(await ticketCount(session.userId), 0);
    await assertLedgerBalanced();
  });

  await t.test('suspended market is rejected before any ledger write', async () => {
    const session = await member();
    const picks = selections();
    const suspended = options => snapshotFor(options, { suspended: true });
    await assert.rejects(
      quote(session, picks, {}, suspended),
      error => error.code === 'SPORTS_MARKET_SUSPENDED'
    );
    assert.equal(await ticketCount(session.userId), 0);
    assert.equal(await memberBalance(session.userId), 100000);
    await assertLedgerBalanced();
  });

  await t.test('loopback Sportmonks odds and official result use recognized settlement authority', async () => {
    const provider = await fetchSportmonks({ maxEvents: 10, maxPages: 1 });
    const fixture = provider.events.find(event => event._refs?.sportmonks === '987654321');
    assert.ok(fixture, 'local Sportmonks fixture was not parsed');
    const authority = eventSettlementAuthority(fixture);
    assert.equal(authority.automaticFt, true);
    assert.equal(authority.ht, true);
    assert.deepEqual(authority.sources, ['sportmonks']);
    const market = fixture.markets.find(item => item.type === '1X2' && item.period === 'FT');
    const selection = market?.selections.find(item => item.label === 'Home');
    assert.ok(selection, 'mock fixture did not contain a home selection');

    const priceVersion = `mock-provider-version-${fixture.id}`;
    const providerResolver = async ({ eventId, marketId, selectionId }) => {
      assert.equal(eventId, fixture.id);
      assert.equal(marketId, market.id);
      assert.equal(selectionId, selection.key);
      return {
        event: { ...fixture, startTime: new Date(Date.now() + 3600000).toISOString() },
        market,
        selection: { ...selection, priceVersion, updatedAt: new Date().toISOString() },
        feedFetchedAt: Date.now(),
        feedRevision: 'local-sportmonks-odds',
        providerState: 'HEALTHY',
        tradingPolicy: { suspended: false }
      };
    };
    const session = await member();
    const picks = [{
      eventId: fixture.id,
      marketId: market.id,
      selectionId: selection.key,
      acceptedOdds: selection.odds,
      acceptedPriceVersion: priceVersion,
      provider: 'sportmonks'
    }];
    const q = await quote(session, picks, {}, providerResolver);
    const ticket = await createSportsbookBet(session, {
      idempotencyKey: `mock-provider-${randomUUID()}`,
      quoteToken: q.quoteToken
    }, { selectionSnapshot: providerResolver });

    try {
      const control = await fetch('http://127.0.0.1:18081/_control/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'FT', home: 2, away: 0 })
      });
      assert.equal(control.status, 200);
      const resultResponse = await fetch(`http://127.0.0.1:18081/v3/football/fixtures/date/${new Date().toISOString().slice(0, 10)}`);
      assert.equal(resultResponse.status, 200);
      const payload = await resultResponse.json();
      const rawFixture = payload.data.find(item => item.id === 987654321);
      assert.equal(rawFixture.state.short_name, 'FT');
      const currentScore = rawFixture.scores.find(item => item.description === 'CURRENT').score;
      const legResult = evaluateSportsbookLeg({
        market_type: market.type,
        market_period: market.period,
        selection_label: selection.label,
        home_team: fixture.home.name,
        away_team: fixture.away.name,
        market_line: market.line
      }, {
        ...fixture,
        status: 'FINISHED',
        providerStatus: rawFixture.state.short_name,
        home: { ...fixture.home, score: currentScore.home },
        away: { ...fixture.away, score: currentScore.away },
        settlementAuthority: authority
      });
      assert.equal(legResult.status, 'WON');
      assert.equal(authority.sources[0], 'sportmonks');
      const settled = await settleSportsbookTicketAutomatic(ticket.id, [{ legNo: 1, ...legResult }], {
        sourceName: authority.sources[0],
        feedRevision: 'local-sportmonks-result'
      });
      assert.equal(settled.payout, 2000);
      assert.equal(await memberBalance(session.userId), 101000);
      await assertLedgerBalanced();
    } finally {
      await fetch('http://127.0.0.1:18081/_control/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'NS', home: 1, away: 0 })
      });
    }
  });

  await t.test('win, loss, void, push, half win and half loss settle to ledger and remain balanced', async () => {
    const session = await member();
    const cases = [
      ['WON', 2000],
      ['LOST', 0],
      ['VOID', 1000],
      ['PUSH', 1000],
      ['HALF_WON', 1500],
      ['HALF_LOST', 500]
    ];
    for (const [status, payout] of cases) {
      const { ticket } = await place(session);
      const settled = await settleSportsbookTicketAutomatic(ticket.id, [{ legNo: 1, status, resultValue: 'Mock authority result' }], {
        sourceName: 'sportmonks',
        feedRevision: `result-${status}-${randomUUID()}`
      });
      assert.equal(settled.payout, payout, `${status} payout`);
      await assertLedgerBalanced();
    }
  });

  await t.test('mock result authority keeps postponed events pending and cancels officially cancelled matches as void', async () => {
    const leg = { market_type: '1X2', selection_label: 'Home', market_period: 'FT', home_team: 'Mock Home', away_team: 'Mock Away' };
    assert.equal(evaluateSportsbookLeg(leg, {
      status: 'SUSPENDED', providerStatus: 'POSTP', settlementAuthority: { ft: true },
      home: { score: 0 }, away: { score: 0 }
    }), null);
    const cancelled = evaluateSportsbookLeg(leg, {
      status: 'SUSPENDED', providerStatus: 'CANC', settlementAuthority: { ft: true },
      home: { score: null }, away: { score: null }
    });
    assert.equal(cancelled.status, 'VOID');

    const session = await member();
    const { ticket } = await place(session);
    assert.equal(ticket.status, 'OPEN');
    assert.equal(await memberBalance(session.userId), 99000);
    await assertLedgerBalanced();
    const voided = await settleSportsbookTicketAutomatic(ticket.id, [{ legNo: 1, status: cancelled.status, resultValue: cancelled.resultValue }], {
      sourceName: 'sportmonks',
      feedRevision: `cancelled-${randomUUID()}`
    });
    assert.equal(voided.status, 'VOID');
    await assertLedgerBalanced();
  });

  await t.test('settlement replay does not pay twice; rollback creates a revision and debits the payout', async () => {
    const session = await member();
    const { ticket } = await place(session);
    const result = [{ legNo: 1, status: 'WON', resultValue: '2-0' }];
    const first = await settleSportsbookTicketAutomatic(ticket.id, result, { sourceName: 'sportmonks', feedRevision: 'winner-revision-1' });
    const replay = await settleSportsbookTicketAutomatic(ticket.id, result, { sourceName: 'sportmonks', feedRevision: 'winner-revision-1' });
    assert.equal(first.payout, replay.payout);
    assert.equal(await memberBalance(session.userId), 101000);
    await assertLedgerBalanced();
    const rolledBack = await rollbackSportsbookSettlement(session, ticket.id, { reason: 'Integration rollback', idempotencyKey: `rollback-${randomUUID()}` });
    assert.equal(rolledBack.status, 'OPEN');
    assert.equal(rolledBack.payout, 0);
    assert.equal(await memberBalance(session.userId), 99000);
    await assertLedgerBalanced();
  });

  await t.test('settlement correction with insufficient member funds is persisted as PENDING_FUNDS', async () => {
    const session = await member(10000);
    const { ticket } = await place(session);
    await settleSportsbookTicketAutomatic(ticket.id, [{ legNo: 1, status: 'WON', resultValue: '2-0' }], {
      sourceName: 'sportmonks',
      feedRevision: 'correction-win'
    });
    await tx(client => postTransfer(client, {
      memberId: session.userId,
      systemCode: SYSTEM_ACCOUNTS.CLEARING,
      memberDelta: -10000,
      type: 'TEST_MEMBER_SPEND',
      referenceType: 'TEST_MEMBER',
      referenceId: randomUUID(),
      idempotencyKey: `test-spend:${randomUUID()}`
    }));
    const rollback = await rollbackSportsbookSettlement(session, ticket.id, {
      reason: 'Insufficient funds correction fixture',
      idempotencyKey: `insufficient-rollback-${randomUUID()}`
    });
    assert.equal(rollback.settlementCorrectionPending, true);
    const revision = await query(
      `SELECT status FROM sportsbook_settlement_revisions WHERE ticket_id=$1 ORDER BY revision_no DESC LIMIT 1`,
      [ticket.id]
    );
    assert.equal(revision.rows[0].status, 'PENDING_FUNDS');
    await assertLedgerBalanced();
  });

  await t.test('cashout accepts unchanged odds once, rejects repriced/expired offers and cannot be accepted twice', async () => {
    const session = await member();
    const { ticket } = await place(session);
    const offer = await createSportsbookCashoutOffer(session.userId, ticket.id, { selectionSnapshot: resolver });
    const accepted = await acceptSportsbookCashout(session, ticket.id, {
      idempotencyKey: `cashout-${randomUUID()}`,
      offerToken: offer.offerToken
    }, { selectionSnapshot: resolver });
    assert.equal(accepted.status, 'CASHED_OUT');
    await assertLedgerBalanced();

    await assert.rejects(
      acceptSportsbookCashout(session, ticket.id, {
        idempotencyKey: `cashout-again-${randomUUID()}`,
        offerToken: offer.offerToken
      }, { selectionSnapshot: resolver }),
      error => error.code === 'SPORTSBOOK_CASHOUT_ALREADY_ACCEPTED'
    );
    const cashoutRow = await query('SELECT COUNT(*)::int AS count FROM sportsbook_cashouts WHERE ticket_id=$1', [ticket.id]);
    assert.equal(cashoutRow.rows[0].count, 1);

    const changedMember = await member();
    const changedBet = await place(changedMember);
    const changedOffer = await createSportsbookCashoutOffer(changedMember.userId, changedBet.ticket.id, { selectionSnapshot: resolver });
    const changedResolver = options => snapshotFor(options, { odds: 2.25, priceVersion: 'cashout-changed-price' });
    await assert.rejects(
      acceptSportsbookCashout(changedMember, changedBet.ticket.id, {
        idempotencyKey: `cashout-changed-${randomUUID()}`,
        offerToken: changedOffer.offerToken
      }, { selectionSnapshot: changedResolver }),
      error => error.code === 'SPORTSBOOK_CASHOUT_REPRICE_REQUIRED'
    );
    const [payload, signature] = changedOffer.offerToken.split('.');
    const expiredOffer = signCashoutOffer({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await assert.rejects(
      acceptSportsbookCashout(changedMember, changedBet.ticket.id, {
        idempotencyKey: `cashout-expired-${randomUUID()}`,
        offerToken: expiredOffer
      }, { selectionSnapshot: resolver }),
      error => error.code === 'SPORTSBOOK_CASHOUT_OFFER_EXPIRED'
    );
    assert.ok(signature);
    await assertLedgerBalanced();
  });

  await t.test('configured member cap blocks aggregate exposure across different markets', async () => {
    const session = await member(100000);
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () =>
      place(session, { picks: selections(), stake: 25000, idempotencyKey: `market-cap-${randomUUID()}` })
    ));
    const accepted = outcomes.filter(result => result.status === 'fulfilled');
    assert.equal(accepted.length, 2);
    const denied = outcomes.filter(result => result.status === 'rejected');
    assert.ok(denied.length >= 4);
    assert.ok(denied.some(result => result.reason.code === 'SPORTSBOOK_MEMBER_LIABILITY_LIMIT'));
    assert.equal(await memberBalance(session.userId), 50000);
    await assertLedgerBalanced();
  });
});
