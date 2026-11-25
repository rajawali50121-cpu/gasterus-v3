import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { AppError, assert } from './errors.js';
import { combinations } from './sportsbook-calculation.js';

function cashoutSignature(encodedPayload) {
  return createHmac('sha256', config.sessionHmacKey)
    .update(`SBOTOTO_SPORTSBOOK_CASHOUT_V1.${encodedPayload}`)
    .digest('base64url');
}

export function signCashoutOffer(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${cashoutSignature(encodedPayload)}`;
}

export function verifyCashoutOfferToken(token, { memberId = '', ticketId = '', now = Date.now() } = {}) {
  const raw = String(token || '').trim();
  assert(raw.length >= 40 && raw.length <= 24000, 400, 'Penawaran Cash Out tidak valid.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');
  const parts = raw.split('.');
  assert(parts.length === 2 && parts[0] && parts[1], 400, 'Penawaran Cash Out tidak valid.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');
  const expected = Buffer.from(cashoutSignature(parts[0]));
  const supplied = Buffer.from(parts[1]);
  assert(expected.length === supplied.length && timingSafeEqual(expected, supplied), 400, 'Penawaran Cash Out tidak valid atau telah diubah.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { throw new AppError(400, 'Penawaran Cash Out tidak valid.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID'); }
  assert(payload?.v === 1 && payload?.offerId && payload?.memberId && payload?.ticketId && Number.isSafeInteger(payload?.amount) && Array.isArray(payload?.pricing), 400, 'Payload penawaran Cash Out tidak lengkap.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');
  if (memberId) assert(payload.memberId === memberId, 403, 'Penawaran Cash Out bukan milik sesi ini.', 'SPORTSBOOK_CASHOUT_OWNER_MISMATCH');
  if (ticketId) assert(payload.ticketId === ticketId, 409, 'Penawaran Cash Out tidak sesuai tiket.', 'SPORTSBOOK_CASHOUT_TICKET_MISMATCH');
  const expiresAtMs = Date.parse(payload.expiresAt || '');
  assert(Number.isFinite(expiresAtMs), 400, 'Masa berlaku Cash Out tidak valid.', 'SPORTSBOOK_CASHOUT_OFFER_INVALID');
  if (now >= expiresAtMs) {
    throw new AppError(409, 'Penawaran Cash Out sudah kedaluwarsa. Minta harga terbaru.', 'SPORTSBOOK_CASHOUT_OFFER_EXPIRED', {
      offerId: payload.offerId,
      expiresAt: payload.expiresAt
    });
  }
  return payload;
}

export function fairCashoutValue(ticket, pricing) {
  if (!pricing.length) return 0;
  if (ticket.bet_type !== 'SYSTEM') {
    const currentCombinedOdds = pricing.reduce((product, item) => product * Number(item.currentOdds), 1);
    if (!Number.isFinite(currentCombinedOdds) || currentCombinedOdds <= 1) return 0;
    return Math.floor(Number(ticket.potential_payout) / currentCombinedOdds);
  }
  const size = Number(ticket.system_size);
  const unitStake = Number(ticket.unit_stake);
  if (!Number.isSafeInteger(size) || size < 2 || !Number.isSafeInteger(unitStake) || unitStake <= 0) return 0;
  return combinations(pricing, size).reduce((total, group) => {
    const acceptedProduct = group.reduce((product, item) => product * Number(item.acceptedOdds), 1);
    const currentProduct = group.reduce((product, item) => product * Number(item.currentOdds), 1);
    if (!Number.isFinite(acceptedProduct) || !Number.isFinite(currentProduct) || currentProduct <= 1) return total;
    const originalComboPayout = Math.floor(unitStake * acceptedProduct);
    return total + Math.floor(originalComboPayout / currentProduct);
  }, 0);
}

export function offerAmount(ticket, fairValue) {
  const discounted = Math.floor(fairValue * config.sportsbookCashoutFactorBps / 10000);
  return Math.min(Math.max(0, discounted), Number(ticket.potential_payout));
}

export const __sportsbookCashoutPolicy = { cashoutSignature };
