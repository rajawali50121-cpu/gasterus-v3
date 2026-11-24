import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { AppError, assert } from './errors.js';
import { fairCashoutValue, offerAmount, signCashoutOffer, verifyCashoutOfferToken } from './sportsbook-cashout-policy.js';
import { audit } from './audit.js';
import { postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { sportsbookSelectionSnapshot } from './sportsbook-feed.js';
import { createMemberNotification } from './notifications.js';
import { getMemberSportsbookBet } from './sportsbook-betting.js';

const cashoutMetrics = {
  offersRequested: 0,
  offersCreated: 0,
  offerUnavailable: 0,
  acceptAttempts: 0,
  accepted: 0,
  repricedRejected: 0
};

function clean(value, max = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
async function rawTicket(memberId, ticketId) {
  const ticket = (await query('SELECT * FROM sportsbook_tickets WHERE id=$1 AND member_id=$2 LIMIT 1', [ticketId, memberId])).rows[0];
  assert(ticket, 404, 'Tiket sportsbook tidak ditemukan.', 'SPORTSBOOK_TICKET_NOT_FOUND');
  const legs = (await query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [ticketId])).rows;
  return { ticket, legs };
}
function assertCashoutEligible(ticket, legs) {
  assert(config.sportsbookCashoutEnabled, 409, 'Cash Out sedang dinonaktifkan.', 'SPORTSBOOK_CASHOUT_DISABLED');
  assert(ticket.status === 'OPEN', 409, 'Tiket tidak lagi terbuka untuk Cash Out.', 'SPORTSBOOK_CASHOUT_TICKET_CLOSED');
  assert(!ticket.settlement_correction_pending, 409, 'Tiket sedang memiliki koreksi settlement dan tidak dapat di-Cash Out.', 'SPORTSBOOK_CASHOUT_SETTLEMENT_PENDING');
  assert(legs.length > 0 && legs.every(leg => leg.result_status === 'PENDING'), 409, 'Cash Out hanya tersedia sebelum hasil leg diproses.', 'SPORTSBOOK_CASHOUT_RESULTS_STARTED');
}
async function currentPricing(legs) {
  const snapshots = await Promise.all(legs.map(leg => sportsbookSelectionSnapshot({
    eventId: leg.event_id,
    marketId: leg.market_id,
    selectionId: leg.selection_id
  })));
  return snapshots.map((snapshot, index) => {
    const leg = legs[index];
    return {
      legNo: Number(leg.leg_no),
      eventId: leg.event_id,
      marketId: leg.market_id,
      selectionId: leg.selection_id,
      acceptedOdds: Number(leg.accepted_odds),
      currentOdds: Number(snapshot.selection.odds),
      priceVersion: snapshot.selection.priceVersion,
      provider: snapshot.selection.source || snapshot.market.source || snapshot.event?._sources?.[0] || null,
      feedRevision: snapshot.feedRevision || null,
      priceUpdatedAt: snapshot.priceUpdatedAt || null
    };
  });
}
export async function createSportsbookCashoutOffer(memberId, ticketId) {
  cashoutMetrics.offersRequested += 1;
  try {
    const { ticket, legs } = await rawTicket(memberId, ticketId);
    assertCashoutEligible(ticket, legs);
    const pricing = await currentPricing(legs);
    const fairValue = fairCashoutValue(ticket, pricing);
    const amount = offerAmount(ticket, fairValue);
    assert(fairValue > 0 && amount >= config.sportsbookCashoutMinOffer, 409, 'Belum ada nilai Cash Out yang dapat ditawarkan untuk tiket ini.', 'SPORTSBOOK_CASHOUT_OFFER_UNAVAILABLE');
    const offeredAt = new Date();
    const expiresAt = new Date(offeredAt.getTime() + config.sportsbookCashoutOfferTtlSeconds * 1000);
    const offerId = randomUUID();
    const feedRevisions = [...new Set(pricing.map(item => item.feedRevision).filter(Boolean))];
    const payload = {
      v: 1,
      offerId,
      memberId,
      ticketId,
      invoice: ticket.invoice,
      amount,
      fairValue,
      factorBps: config.sportsbookCashoutFactorBps,
      offeredAt: offeredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      feedRevisions,
      pricing
    };
    cashoutMetrics.offersCreated += 1;
    return {
      offerId,
      ticketId,
      invoice: ticket.invoice,
      amount,
      fairValue,
      factorBps: config.sportsbookCashoutFactorBps,
      offeredAt: payload.offeredAt,
      expiresAt: payload.expiresAt,
      ttlSeconds: config.sportsbookCashoutOfferTtlSeconds,
      feedRevisions,
      offerToken: signCashoutOffer(payload)
    };
  } catch (error) {
    cashoutMetrics.offerUnavailable += 1;
    throw error;
  }
}

export async function listMemberSportsbookCashoutOffers(memberId, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const rows = await query(`SELECT id FROM sportsbook_tickets WHERE member_id=$1 AND status='OPEN' AND settlement_correction_pending=false ORDER BY created_at DESC LIMIT $2`, [memberId, safeLimit]);
  const offers = [];
  for (const row of rows.rows) {
    try { offers.push(await createSportsbookCashoutOffer(memberId, row.id)); }
    catch (error) {
      if ((error?.status || 500) >= 500) throw error;
    }
  }
  return offers;
}

async function verifyOfferStillCurrent(payload) {
  for (const item of payload.pricing) {
    const latest = await sportsbookSelectionSnapshot({ eventId: item.eventId, marketId: item.marketId, selectionId: item.selectionId });
    const latestProvider = latest.selection.source || latest.market.source || latest.event?._sources?.[0] || null;
    const changed = latest.selection.priceVersion !== item.priceVersion || Math.abs(Number(latest.selection.odds) - Number(item.currentOdds)) > config.sportsbookOddsTolerance || (item.provider && latestProvider && item.provider !== latestProvider);
    if (changed) {
      cashoutMetrics.repricedRejected += 1;
      throw new AppError(409, 'Harga Cash Out berubah. Minta penawaran terbaru.', 'SPORTSBOOK_CASHOUT_REPRICE_REQUIRED', {
        ticketId: payload.ticketId,
        eventId: item.eventId,
        marketId: item.marketId,
        selectionId: item.selectionId,
        previousOdds: Number(item.currentOdds),
        latestOdds: Number(latest.selection.odds),
        previousPriceVersion: item.priceVersion,
        latestPriceVersion: latest.selection.priceVersion
      });
    }
  }
}

export async function acceptSportsbookCashout(session, ticketId, input, { ip = '' } = {}) {
  cashoutMetrics.acceptAttempts += 1;
  const idempotencyKey = clean(input?.idempotencyKey, 120);
  assert(idempotencyKey.length >= 12, 400, 'Idempotency key Cash Out tidak valid.', 'SPORTSBOOK_CASHOUT_IDEMPOTENCY_INVALID');
  const replay = (await query('SELECT ticket_id FROM sportsbook_cashouts WHERE member_id=$1 AND idempotency_key=$2 LIMIT 1', [session.userId, idempotencyKey])).rows[0];
  if (replay) {
    assert(replay.ticket_id === ticketId, 409, 'Idempotency key Cash Out sudah dipakai untuk tiket lain.', 'SPORTSBOOK_CASHOUT_IDEMPOTENCY_CONFLICT');
    return getMemberSportsbookBet(session.userId, replay.ticket_id);
  }

  const payload = verifyCashoutOfferToken(input?.offerToken, { memberId: session.userId, ticketId });
  await verifyOfferStillCurrent(payload);

  await tx(async client => {
    const ticket = (await client.query('SELECT * FROM sportsbook_tickets WHERE id=$1 AND member_id=$2 FOR UPDATE', [ticketId, session.userId])).rows[0];
    assert(ticket, 404, 'Tiket sportsbook tidak ditemukan.', 'SPORTSBOOK_TICKET_NOT_FOUND');
    const existing = (await client.query('SELECT * FROM sportsbook_cashouts WHERE member_id=$1 AND idempotency_key=$2 FOR UPDATE', [session.userId, idempotencyKey])).rows[0];
    if (existing) {
      assert(existing.ticket_id === ticketId, 409, 'Idempotency key Cash Out sudah dipakai untuk tiket lain.', 'SPORTSBOOK_CASHOUT_IDEMPOTENCY_CONFLICT');
      return;
    }
    const previousCashout = (await client.query('SELECT id FROM sportsbook_cashouts WHERE ticket_id=$1 FOR UPDATE', [ticketId])).rows[0];
    assert(!previousCashout, 409, 'Tiket ini sudah di-Cash Out.', 'SPORTSBOOK_CASHOUT_ALREADY_ACCEPTED');
    const legs = (await client.query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no FOR UPDATE', [ticketId])).rows;
    assertCashoutEligible(ticket, legs);
    const lockedPayload = verifyCashoutOfferToken(input?.offerToken, { memberId: session.userId, ticketId });
    assert(Number(lockedPayload.amount) === Number(payload.amount), 409, 'Nilai Cash Out tidak konsisten.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');

    const cashoutId = randomUUID();
    const ledger = await postTransfer(client, {
      memberId: session.userId,
      systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
      memberDelta: Number(payload.amount),
      type: 'SPORTSBOOK_CASHOUT_ACCEPTED',
      referenceType: 'SPORTSBOOK_CASHOUT',
      referenceId: cashoutId,
      idempotencyKey: `sportsbook-cashout:${session.userId}:${idempotencyKey}`,
      metadata: { ticketId, offerId: payload.offerId, fairValue: payload.fairValue, factorBps: payload.factorBps, feedRevisions: payload.feedRevisions },
      actorId: session.userId
    });

    await client.query(`INSERT INTO sportsbook_cashouts(
      id,ticket_id,member_id,offer_amount,fair_value,factor_bps,offered_at,expires_at,source_feed_revision,pricing_snapshot,idempotency_key,balance_before,balance_after,metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb)`, [
      cashoutId, ticketId, session.userId, Number(payload.amount), Number(payload.fairValue), Number(payload.factorBps),
      payload.offeredAt, payload.expiresAt, (payload.feedRevisions || []).join(','), JSON.stringify(payload.pricing || []), idempotencyKey,
      ledger.before, ledger.after, JSON.stringify({ offerId: payload.offerId, acceptedFromIp: clean(ip, 100) })
    ]);
    await client.query(`UPDATE sportsbook_tickets SET
      status='CASHED_OUT',payout=$1,balance_after=$2,settled_at=now(),updated_at=now(),cashout_amount=$1,cashout_at=now(),cashout_offer_id=$3,
      last_settlement_action='CASHOUT',metadata=metadata || $4::jsonb WHERE id=$5`, [
      Number(payload.amount), ledger.after, payload.offerId,
      JSON.stringify({ cashoutId, cashoutOfferId: payload.offerId, cashoutAmount: Number(payload.amount), cashoutFairValue: Number(payload.fairValue), cashoutFactorBps: Number(payload.factorBps), cashoutFeedRevisions: payload.feedRevisions || [] }),
      ticketId
    ]);

    await createMemberNotification(client, {
      memberId: session.userId,
      type: 'BET_SETTLED',
      title: 'Cash Out Sportsbook Berhasil',
      message: `Tiket ${ticket.invoice} berhasil di-Cash Out sebesar IDR ${Number(payload.amount).toLocaleString('id-ID')}.`,
      amount: Number(payload.amount),
      referenceType: 'SPORTSBOOK_CASHOUT',
      referenceId: cashoutId,
      actionUrl: 'sportsbook.html',
      priority: 'HIGH',
      metadata: { ticketId, invoice: ticket.invoice, offerId: payload.offerId, balanceAfter: ledger.after }
    });
    await audit({
      actorId: session.userId,
      actorRole: 'MEMBER',
      action: 'SPORTSBOOK_CASHOUT_ACCEPTED',
      targetType: 'SPORTSBOOK_TICKET',
      targetId: ticketId,
      details: { cashoutId, offerId: payload.offerId, amount: Number(payload.amount), fairValue: Number(payload.fairValue), factorBps: Number(payload.factorBps), balanceAfter: ledger.after },
      ip,
      client
    });
  }, { isolation: 'SERIALIZABLE' });

  cashoutMetrics.accepted += 1;
  return getMemberSportsbookBet(session.userId, ticketId);
}

export function sportsbookCashoutMetrics() {
  return { ...cashoutMetrics, enabled: Boolean(config.sportsbookCashoutEnabled), factorBps: config.sportsbookCashoutFactorBps, offerTtlSeconds: config.sportsbookCashoutOfferTtlSeconds };
}

export const __sportsbookCashout = { fairCashoutValue, offerAmount, signCashoutOffer, verifyCashoutOfferToken };
