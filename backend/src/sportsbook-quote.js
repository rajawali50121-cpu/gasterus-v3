import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { AppError, assert } from './errors.js';

function quoteSignature(encodedPayload) {
  return createHmac('sha256', config.sessionHmacKey)
    .update(`SBOTOTO_SPORTSBOOK_QUOTE_V1.${encodedPayload}`)
    .digest('base64url');
}

export function signSportsbookQuote(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${quoteSignature(encodedPayload)}`;
}

export function verifySportsbookQuoteToken(token, { memberId = '', now = Date.now() } = {}) {
  const raw = String(token || '').trim();
  assert(raw.length >= 40 && raw.length <= 24000, 400, 'Quote sportsbook tidak valid.', 'SPORTSBOOK_QUOTE_INVALID');
  const parts = raw.split('.');
  assert(parts.length === 2 && parts[0] && parts[1], 400, 'Quote sportsbook tidak valid.', 'SPORTSBOOK_QUOTE_INVALID');
  const expected = Buffer.from(quoteSignature(parts[0]));
  const supplied = Buffer.from(parts[1]);
  assert(expected.length === supplied.length && timingSafeEqual(expected, supplied), 400, 'Quote sportsbook tidak valid atau telah diubah.', 'SPORTSBOOK_QUOTE_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { throw new AppError(400, 'Quote sportsbook tidak valid.', 'SPORTSBOOK_QUOTE_INVALID'); }
  assert([1, 2].includes(Number(payload?.v)) && payload?.quoteId && payload?.memberId && Array.isArray(payload?.selections), 400, 'Payload quote sportsbook tidak lengkap.', 'SPORTSBOOK_QUOTE_INVALID');
  if (memberId) assert(payload.memberId === memberId, 403, 'Quote sportsbook bukan milik sesi ini.', 'SPORTSBOOK_QUOTE_OWNER_MISMATCH');
  const expiresAtMs = Date.parse(payload.expiresAt || '');
  assert(Number.isFinite(expiresAtMs), 400, 'Masa berlaku quote sportsbook tidak valid.', 'SPORTSBOOK_QUOTE_INVALID');
  if (now >= expiresAtMs) {
    throw new AppError(409, 'Quote sportsbook sudah kedaluwarsa. Minta harga terbaru.', 'SPORTSBOOK_QUOTE_EXPIRED', {
      quoteId: payload.quoteId,
      expiresAt: payload.expiresAt
    });
  }
  return payload;
}

export const __sportsbookQuote = { quoteSignature };
