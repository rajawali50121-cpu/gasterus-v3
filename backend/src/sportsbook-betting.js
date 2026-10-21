import { randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { AppError, assert } from './errors.js';
import { audit } from './audit.js';
import { enforceResponsiblePlay } from './responsible-play.js';
import { memberAccount, postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { sportsbookSelectionSnapshot } from './sportsbook-feed.js';
import { combinations, ticketCalculation, validateBetType } from './sportsbook-calculation.js';
import { legReturnMultiplier, settleCalculation } from './sportsbook-settlement-calculation.js';
import { createMemberNotification } from './notifications.js';
import { signSportsbookQuote, verifySportsbookQuoteToken } from './sportsbook-quote.js';
import { assertSportsbookBettingOpen } from './sportsbook-betting-controls.js';

const FINAL_LEG_RESULTS = new Set(['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
const ODDS_CHANGE_POLICIES = new Set(['REJECT', 'ACCEPT_BETTER', 'ACCEPT_ANY']);

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function integer(value, name, min, max) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, 400, `${name} tidak valid.`, 'SPORTSBOOK_INPUT_INVALID');
  return parsed;
}
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function serializableRetry(operation, attempts = 4) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tx(operation, { isolation: 'SERIALIZABLE' });
    } catch (error) {
      if (error?.code !== '40001' || attempt + 1 >= attempts) throw error;
      await wait(10 * (attempt + 1));
    }
  }
}
function odds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 && parsed <= 10000 ? Math.round(parsed * 10000) / 10000 : null;
}
function oddsChangePolicy(value) {
  const raw = clean(value || config.sportsbookOddsChangePolicyDefault || 'REJECT', 30).toUpperCase();
  return ODDS_CHANGE_POLICIES.has(raw) ? raw : 'REJECT';
}
function pricingProvider(snapshot) {
  return snapshot?.selection?.source || snapshot?.market?.source || snapshot?.event?._sources?.[0] || null;
}
function priceChanged(snapshot, acceptedPriceVersion, acceptedOdds) {
  return acceptedPriceVersion !== snapshot.selection.priceVersion || Math.abs(Number(acceptedOdds) - Number(snapshot.selection.odds)) > config.sportsbookOddsTolerance;
}
async function resolveLegForAcceptance(input, policy, selectionSnapshot = sportsbookSelectionSnapshot) {
  const eventId = clean(input.eventId, 80);
  const marketId = clean(input.marketId, 80);
  const selectionId = clean(input.selectionId, 80);
  const acceptedPriceVersion = clean(input.acceptedPriceVersion || input.priceVersion, 80);
  const acceptedOdds = odds(input.acceptedOdds);
  const quotedProvider = clean(input.provider, 80) || null;
  assert(eventId && marketId && selectionId, 400, 'Identitas pilihan tidak lengkap.', 'SPORTSBOOK_SELECTION_INVALID');
  assert(acceptedPriceVersion.length >= 12, 400, 'Versi harga odds tidak valid. Muat ulang Sportsbook.', 'SPORTSBOOK_PRICE_VERSION_REQUIRED');
  assert(acceptedOdds !== null, 400, 'Odds yang diterima tidak valid.', 'SPORTSBOOK_ACCEPTED_ODDS_INVALID');
  const snapshot = await selectionSnapshot({ eventId, marketId, selectionId });
  const latestProvider = pricingProvider(snapshot);
  const changed = priceChanged(snapshot, acceptedPriceVersion, acceptedOdds);
  if (!changed) return { snapshot, repriced: null };
  if (quotedProvider && latestProvider && quotedProvider !== latestProvider) {
    throw new AppError(409, 'Harga diperbarui saat tiket diproses. Minta quote baru sebelum melanjutkan.', 'SPORTSBOOK_PRICE_SOURCE_CHANGED', {
      eventId, marketId, selectionId,
      previousOdds: acceptedOdds, latestOdds: snapshot.selection.odds,
      previousPriceVersion: acceptedPriceVersion, latestPriceVersion: snapshot.selection.priceVersion
    });
  }
  if (policy === 'REJECT') {
    throw new AppError(409, 'Odds berubah. Tinjau harga terbaru sebelum memasang taruhan.', 'SPORTSBOOK_ODDS_CHANGED', {
      eventId, marketId, selectionId, previousOdds: acceptedOdds, latestOdds: snapshot.selection.odds,
      previousPriceVersion: acceptedPriceVersion, latestPriceVersion: snapshot.selection.priceVersion
    });
  }
  if (policy === 'ACCEPT_BETTER' && Number(snapshot.selection.odds) + config.sportsbookOddsTolerance < acceptedOdds) {
    throw new AppError(409, 'Odds bergerak turun. Kebijakan tiket hanya menerima odds yang sama atau lebih baik.', 'SPORTSBOOK_ODDS_WORSE_REJECTED', {
      eventId, marketId, selectionId, previousOdds: acceptedOdds, latestOdds: snapshot.selection.odds,
      previousPriceVersion: acceptedPriceVersion, latestPriceVersion: snapshot.selection.priceVersion
    });
  }
  return {
    snapshot,
    repriced: {
      eventId, marketId, selectionId,
      provider: latestProvider,
      previousOdds: acceptedOdds,
      latestOdds: snapshot.selection.odds,
      previousPriceVersion: acceptedPriceVersion,
      latestPriceVersion: snapshot.selection.priceVersion,
      policy
    }
  };
}
function invoice() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `SB-${date}-${randomBytes(5).toString('hex').toUpperCase()}`;
}
async function resolveLeg(input, selectionSnapshot = sportsbookSelectionSnapshot) {
  const eventId = clean(input.eventId, 80);
  const marketId = clean(input.marketId, 80);
  const selectionId = clean(input.selectionId, 80);
  const acceptedPriceVersion = clean(input.acceptedPriceVersion || input.priceVersion, 80);
  assert(eventId && marketId && selectionId, 400, 'Identitas pilihan tidak lengkap.', 'SPORTSBOOK_SELECTION_INVALID');
  assert(acceptedPriceVersion.length >= 12, 400, 'Versi harga odds tidak valid. Muat ulang Sportsbook.', 'SPORTSBOOK_PRICE_VERSION_REQUIRED');
  const snapshot = await selectionSnapshot({ eventId, marketId, selectionId });
  const acceptedOdds = odds(input.acceptedOdds);
  assert(acceptedOdds !== null, 400, 'Odds yang diterima tidak valid.', 'SPORTSBOOK_ACCEPTED_ODDS_INVALID');
  if (acceptedPriceVersion !== snapshot.selection.priceVersion) {
    throw new AppError(409, 'Versi odds telah berubah. Tinjau harga terbaru sebelum memasang taruhan.', 'SPORTSBOOK_ODDS_VERSION_CHANGED', {
      eventId,
      marketId,
      selectionId,
      previousPriceVersion: acceptedPriceVersion,
      latestPriceVersion: snapshot.selection.priceVersion,
      previousOdds: acceptedOdds,
      latestOdds: snapshot.selection.odds
    });
  }
  if (Math.abs(acceptedOdds - snapshot.selection.odds) > config.sportsbookOddsTolerance) {
    throw new AppError(409, 'Odds berubah. Tinjau harga terbaru sebelum memasang taruhan.', 'SPORTSBOOK_ODDS_CHANGED', {
      eventId,
      marketId,
      selectionId,
      previousOdds: acceptedOdds,
      latestOdds: snapshot.selection.odds,
      latestPriceVersion: snapshot.selection.priceVersion
    });
  }
  return snapshot;
}
async function revalidateResolvedLegs(legs, selectionSnapshot = sportsbookSelectionSnapshot) {
  const fresh = [];
  for (const leg of legs) {
    const latest = await selectionSnapshot({ eventId: leg.event.id, marketId: leg.market.id, selectionId: leg.selection.key });
    if (latest.event.live && !leg.event.live) {
      throw new AppError(409, 'Pertandingan baru dimulai. Tinjau quote live sebelum memasang taruhan.', 'SPORTSBOOK_EVENT_BECAME_LIVE');
    }
    if (latest.selection.priceVersion !== leg.selection.priceVersion) {
      throw new AppError(409, 'Odds berubah saat tiket diproses. Tinjau kembali harga terbaru.', 'SPORTSBOOK_ODDS_VERSION_CHANGED', {
        eventId: leg.event.id,
        marketId: leg.market.id,
        selectionId: leg.selection.key,
        previousPriceVersion: leg.selection.priceVersion,
        latestPriceVersion: latest.selection.priceVersion,
        previousOdds: leg.selection.odds,
        latestOdds: latest.selection.odds
      });
    }
    fresh.push(latest);
  }
  return fresh;
}
function riskMarketKey(leg) {
  return [leg.event.id, leg.market.type, leg.market.period || 'FT', leg.selection.line ?? leg.market.line ?? ''].join('|');
}
function riskSelectionKey(leg) {
  return [riskMarketKey(leg), clean(leg.selection.label, 120).toLowerCase()].join('|');
}
async function lockRiskKeys(client, legs) {
  const keys = new Set();
  for (const leg of legs) {
    keys.add(`event:${leg.event.id}`);
    keys.add(`market:${riskMarketKey(leg)}`);
    keys.add(`selection:${riskSelectionKey(leg)}`);
  }
  for (const key of [...keys].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sportsbook-risk:${key}`]);
}
async function liabilityFor(client, sql, values) {
  const value = String((await client.query(sql, values)).rows[0]?.liability ?? '0');
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}
function effectiveTradingStakeLimit(legs) {
  const limits = legs.map(leg => Number(leg.tradingPolicy?.maxStake)).filter(value => Number.isSafeInteger(value) && value > 0);
  return limits.length ? Math.min(...limits) : null;
}
function assertTradingStakeLimit(legs, totalStake) {
  const limit = effectiveTradingStakeLimit(legs);
  if (limit !== null) assert(totalStake <= limit, 409, `Trading desk membatasi total taruhan maksimum ${limit}.`, 'SPORTSBOOK_TRADING_STAKE_LIMIT');
  return limit;
}
async function assertRiskExposure(client, legs, ticketPotentialPayout) {
  const proposed = BigInt(Math.max(0, Math.trunc(Number(ticketPotentialPayout) || 0)));
  await lockRiskKeys(client, legs);
  for (const leg of legs) {
    const eventLimit = BigInt(leg.tradingPolicy?.eventMaxLiability ?? config.sportsbookMaxEventLiability);
    const marketLimit = BigInt(leg.tradingPolicy?.marketMaxLiability ?? config.sportsbookMaxMarketLiability);
    const selectionLimit = BigInt(leg.tradingPolicy?.selectionMaxLiability ?? config.sportsbookMaxSelectionLiability);
    const eventLiability = await liabilityFor(client, `SELECT COALESCE(SUM(x.potential_payout),0)::bigint liability FROM (SELECT DISTINCT t.id,t.potential_payout FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id WHERE t.status='OPEN' AND l.event_id=$1) x`, [leg.event.id]);
    assert(eventLiability + proposed <= eventLimit, 409, 'Batas risiko pertandingan telah tercapai. Coba nominal lebih kecil.', 'SPORTSBOOK_EVENT_LIABILITY_LIMIT');
    const line = String(leg.selection.line ?? leg.market.line ?? '');
    const marketLiability = await liabilityFor(client, `SELECT COALESCE(SUM(x.potential_payout),0)::bigint liability FROM (SELECT DISTINCT t.id,t.potential_payout FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id WHERE t.status='OPEN' AND l.event_id=$1 AND l.market_type=$2 AND l.market_period=$3 AND COALESCE(l.market_line,'')=$4) x`, [leg.event.id, leg.market.type, leg.market.period || 'FT', line]);
    assert(marketLiability + proposed <= marketLimit, 409, 'Batas risiko pasaran telah tercapai. Coba nominal lebih kecil.', 'SPORTSBOOK_MARKET_LIABILITY_LIMIT');
    const selectionLiability = await liabilityFor(client, `SELECT COALESCE(SUM(x.potential_payout),0)::bigint liability FROM (SELECT DISTINCT t.id,t.potential_payout FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id WHERE t.status='OPEN' AND l.event_id=$1 AND l.market_type=$2 AND l.market_period=$3 AND COALESCE(l.market_line,'')=$4 AND lower(l.selection_label)=lower($5)) x`, [leg.event.id, leg.market.type, leg.market.period || 'FT', line, leg.selection.label]);
    assert(selectionLiability + proposed <= selectionLimit, 409, 'Batas risiko pilihan telah tercapai. Coba nominal lebih kecil.', 'SPORTSBOOK_SELECTION_LIABILITY_LIMIT');
  }
}
export async function assertMemberLiability(client, memberId, proposedLiability) {
  const limit = Number(config.sportsbookMaxMemberLiability);
  if (!Number.isSafeInteger(limit) || limit <= 0) return;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sportsbook-member-risk:${memberId}`]);
  const current = await liabilityFor(client, `SELECT COALESCE(SUM(potential_payout),0)::bigint liability
    FROM sportsbook_tickets WHERE member_id=$1 AND status='OPEN'`, [memberId]);
  const proposed = BigInt(Math.max(0, Math.trunc(Number(proposedLiability) || 0)));
  assert(current + proposed <= BigInt(limit), 409,
    `Batas eksposur taruhan anggota ${limit} telah tercapai.`, 'SPORTSBOOK_MEMBER_LIABILITY_LIMIT');
}
export function assertLimitedTestAccess(memberId, totalStake) {
  if (!config.sportsbookLimitedTestModeEnabled) return;
  assert(config.sportsbookLimitedTestMemberIds.includes(String(memberId).toLowerCase()), 403,
    'Akun ini tidak termasuk daftar putih mode uji sportsbook.', 'SPORTSBOOK_LIMITED_TEST_MEMBER_NOT_ALLOWED');
  assert(totalStake <= config.sportsbookLimitedTestMaxStake, 400,
    `Total taruhan mode uji maksimum ${config.sportsbookLimitedTestMaxStake}.`, 'SPORTSBOOK_LIMITED_TEST_STAKE_LIMIT');
}
function validateLegs(legs) {
  const events = new Set();
  for (const leg of legs) {
    assert(!events.has(leg.event.id), 400, 'Satu pertandingan hanya boleh memiliki satu pilihan dalam tiket yang sama.', 'SPORTSBOOK_CORRELATED_SELECTIONS');
    events.add(leg.event.id);
  }
}
function mapTicket(row, legs = []) {
  return {
    id: row.id,
    invoice: row.invoice,
    betType: row.bet_type,
    systemSize: row.system_size,
    status: row.status,
    selectionCount: row.selection_count,
    combinationCount: row.combination_count,
    unitStake: Number(row.unit_stake),
    totalStake: Number(row.total_stake),
    totalOdds: Number(row.total_odds),
    potentialPayout: Number(row.potential_payout),
    payout: Number(row.payout),
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    acceptedAt: row.accepted_at,
    settledAt: row.settled_at,
    settlementRevision: Number(row.settlement_revision || 0),
    settlementCorrectionPending: Boolean(row.settlement_correction_pending),
    lastSettlementAction: row.last_settlement_action || null,
    lastSettlementFeedRevision: row.last_settlement_feed_revision || null,
    cashoutAmount: Number(row.cashout_amount || 0),
    cashoutAt: row.cashout_at || null,
    cashoutOfferId: row.cashout_offer_id || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    legs: legs.map(leg => ({
      id: leg.id,
      legNo: leg.leg_no,
      eventId: leg.event_id,
      sport: leg.sport,
      league: leg.league,
      eventStart: leg.event_start,
      liveAtBet: leg.event_live_at_bet,
      home: leg.home_team,
      away: leg.away_team,
      marketId: leg.market_id,
      marketType: leg.market_type,
      marketLabel: leg.market_label,
      marketPeriod: leg.market_period,
      marketLine: leg.market_line,
      selectionId: leg.selection_id,
      selectionLabel: leg.selection_label,
      acceptedOdds: Number(leg.accepted_odds),
      oddsVersion: leg.odds_version || null,
      provider: leg.provider_name || null,
      sourceUpdatedAt: leg.source_updated_at || null,
      acceptedFeedRevision: leg.accepted_feed_revision || null,
      providerStateAtAcceptance: leg.provider_state_at_acceptance || null,
      resultStatus: leg.result_status,
      resultValue: leg.result_value,
      settledAt: leg.settled_at,
      settlementRevision: Number(leg.settlement_revision || 0),
      settlementSource: leg.settlement_source || null,
      settlementFeedRevision: leg.settlement_feed_revision || null
    }))
  };
}
function memberTicket(ticket) {
  if (!ticket) return ticket;
  return {
    id: ticket.id,
    invoice: ticket.invoice,
    betType: ticket.betType,
    systemSize: ticket.systemSize,
    status: ticket.status,
    selectionCount: ticket.selectionCount,
    combinationCount: ticket.combinationCount,
    unitStake: ticket.unitStake,
    totalStake: ticket.totalStake,
    totalOdds: ticket.totalOdds,
    potentialPayout: ticket.potentialPayout,
    payout: ticket.payout,
    balanceBefore: ticket.balanceBefore,
    balanceAfter: ticket.balanceAfter,
    acceptedAt: ticket.acceptedAt,
    settledAt: ticket.settledAt,
    settlementRevision: ticket.settlementRevision,
    settlementCorrectionPending: ticket.settlementCorrectionPending,
    lastSettlementAction: ticket.lastSettlementAction,
    cashoutAmount: ticket.cashoutAmount,
    cashoutAt: ticket.cashoutAt,
    cashoutOfferId: ticket.cashoutOfferId,
    legs: (ticket.legs || []).map(leg => ({
      id: leg.id,
      legNo: leg.legNo,
      eventId: leg.eventId,
      sport: leg.sport,
      league: leg.league,
      eventStart: leg.eventStart,
      liveAtBet: leg.liveAtBet,
      home: leg.home,
      away: leg.away,
      marketId: leg.marketId,
      marketType: leg.marketType,
      marketLabel: leg.marketLabel,
      marketPeriod: leg.marketPeriod,
      marketLine: leg.marketLine,
      selectionId: leg.selectionId,
      selectionLabel: leg.selectionLabel,
      acceptedOdds: leg.acceptedOdds,
      oddsVersion: leg.oddsVersion,
      resultStatus: leg.resultStatus,
      resultValue: leg.resultValue,
      settledAt: leg.settledAt,
      settlementRevision: leg.settlementRevision
    }))
  };
}
async function ticketBy(client, clause, values) {
  const ticketResult = await client.query(`SELECT * FROM sportsbook_tickets WHERE ${clause} LIMIT 1`, values);
  const ticket = ticketResult.rows[0];
  if (!ticket) return null;
  const legs = await client.query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [ticket.id]);
  return mapTicket(ticket, legs.rows);
}

export async function createSportsbookQuote(session, input, { selectionSnapshot = sportsbookSelectionSnapshot } = {}) {
  await assertSportsbookBettingOpen();
  const rawSelections = Array.isArray(input.selections) ? input.selections : [];
  assert(rawSelections.length >= 1 && rawSelections.length <= config.sportsbookMaxLegs, 400, `Jumlah pilihan harus 1–${config.sportsbookMaxLegs}.`, 'SPORTSBOOK_LEGS_INVALID');
  const { type, systemSize } = validateBetType(input.betType, rawSelections.length, input.systemSize);
  const stake = integer(input.stake, 'Nominal taruhan', config.sportsbookMinStake, config.sportsbookMaxStake);
  const legs = await Promise.all(rawSelections.map(selection => resolveLeg(selection, selectionSnapshot)));
  validateLegs(legs);
  const calculation = ticketCalculation(type, stake, legs, systemSize, config.sportsbookMaxSystemCombinations);
  assert(calculation.totalStake <= config.sportsbookMaxStake, 400, `Total taruhan melewati batas ${config.sportsbookMaxStake}.`, 'SPORTSBOOK_STAKE_LIMIT');
  assert(calculation.potentialPayout <= config.sportsbookMaxPayout, 400, `Potensi kemenangan melewati batas ${config.sportsbookMaxPayout}.`, 'SPORTSBOOK_PAYOUT_LIMIT');
  assertLimitedTestAccess(session.userId, calculation.totalStake);
  const tradingMaxStake = assertTradingStakeLimit(legs, calculation.totalStake);
  const changePolicy = oddsChangePolicy(input.oddsChangePolicy);

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.sportsbookQuoteTtlSeconds * 1000);
  const quoteId = randomUUID();
  const selections = legs.map(leg => ({
    eventId: leg.event.id,
    marketId: leg.market.id,
    selectionId: leg.selection.key,
    acceptedOdds: leg.selection.odds,
    acceptedPriceVersion: leg.selection.priceVersion,
    provider: leg.selection.source || leg.market.source || leg.event._sources?.[0] || null,
    eventName: `${leg.event.home.name} vs ${leg.event.away.name}`,
    marketType: leg.market.type,
    marketPeriod: leg.market.period || 'FT',
    selectionLabel: leg.selection.label
  }));
  const feedRevisions = [...new Set(legs.map(leg => leg.feedRevision).filter(Boolean))];
  const providerStates = [...new Set(legs.map(leg => `${leg.selection.source || leg.market.source || 'unknown'}:${leg.providerState || 'UNKNOWN'}`))];
  const tradingControlVersions = [...new Set(legs.map(leg => leg.tradingPolicy?.versionToken).filter(value => value && value !== 'none'))];
  const payload = {
    v: 2,
    quoteId,
    memberId: session.userId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    betType: type,
    systemSize: calculation.systemSize,
    stake,
    totalStake: calculation.totalStake,
    totalOdds: calculation.totalOdds,
    potentialPayout: calculation.potentialPayout,
    oddsChangePolicy: changePolicy,
    feedRevisions,
    providerStates,
    tradingMaxStake,
    tradingControlVersions,
    selections: selections.map(({ eventId, marketId, selectionId, acceptedOdds, acceptedPriceVersion, provider }) => ({ eventId, marketId, selectionId, acceptedOdds, acceptedPriceVersion, provider }))
  };
  return {
    quoteId,
    quoteToken: signSportsbookQuote(payload),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    ttlSeconds: config.sportsbookQuoteTtlSeconds,
    betType: type,
    systemSize: calculation.systemSize,
    stake,
    selectionCount: selections.length,
    combinationCount: calculation.combinationCount,
    totalStake: calculation.totalStake,
    totalOdds: calculation.totalOdds,
    potentialPayout: calculation.potentialPayout,
    oddsChangePolicy: changePolicy,
    tradingMaxStake,
    selections: selections.map(({ eventId, marketId, selectionId, acceptedOdds, acceptedPriceVersion, eventName, marketType, marketPeriod, selectionLabel }) => ({
      eventId, marketId, selectionId, acceptedOdds, acceptedPriceVersion, eventName, marketType, marketPeriod, selectionLabel
    }))
  };
}

export async function createSportsbookBet(session, input, { ip = '', selectionSnapshot = sportsbookSelectionSnapshot } = {}) {
  const idempotencyKey = clean(input.idempotencyKey ?? input.idempotency_key, 100);
  assert(idempotencyKey.length >= 12, 400, 'Idempotency key tidak valid.', 'SPORTSBOOK_IDEMPOTENCY_INVALID');
  // Enterprise idempotency: a network retry must recover an already accepted ticket
  // even when the original short-lived quote has expired after acceptance.
  const replay = await ticketBy({ query }, 'member_id=$1 AND idempotency_key=$2', [session.userId, idempotencyKey]);
  if (replay) return memberTicket(replay);
  const quoteToken = String(input.quoteToken || '').trim();
  if (config.sportsbookQuoteRequired) {
    assert(quoteToken, 400, 'Quote server wajib dibuat sebelum memasang taruhan.', 'SPORTSBOOK_QUOTE_REQUIRED');
  }
  const verifiedQuote = quoteToken ? verifySportsbookQuoteToken(quoteToken, { memberId: session.userId }) : null;
  if (verifiedQuote?.quoteId) {
    const acceptedQuote = await ticketBy({ query }, "member_id=$1 AND metadata->>'quoteId'=$2", [session.userId, verifiedQuote.quoteId]);
    if (acceptedQuote) return memberTicket(acceptedQuote);
  }
  const rawSelections = verifiedQuote?.selections || (Array.isArray(input.selections) ? input.selections : []);
  assert(rawSelections.length >= 1 && rawSelections.length <= config.sportsbookMaxLegs, 400, `Jumlah pilihan harus 1–${config.sportsbookMaxLegs}.`, 'SPORTSBOOK_LEGS_INVALID');
  const betTypeInput = verifiedQuote?.betType || input.betType;
  const systemSizeInput = verifiedQuote?.systemSize ?? input.systemSize;
  const { type, systemSize } = validateBetType(betTypeInput, rawSelections.length, systemSizeInput);
  const stake = integer(verifiedQuote?.stake ?? input.stake, 'Nominal taruhan', config.sportsbookMinStake, config.sportsbookMaxStake);

  const changePolicy = oddsChangePolicy(verifiedQuote?.oddsChangePolicy || input.oddsChangePolicy);
  const resolved = verifiedQuote
    ? await Promise.all(rawSelections.map(selection => resolveLegForAcceptance(selection, changePolicy, selectionSnapshot)))
    : await Promise.all(rawSelections.map(async selection => ({ snapshot: await resolveLeg(selection, selectionSnapshot), repriced: null })));
  const legs = resolved.map(item => item.snapshot);
  const repricedLegs = resolved.map(item => item.repriced).filter(Boolean);
  validateLegs(legs);
  const calculation = ticketCalculation(type, stake, legs, systemSize, config.sportsbookMaxSystemCombinations);
  assert(calculation.totalStake <= config.sportsbookMaxStake, 400, `Total taruhan melewati batas ${config.sportsbookMaxStake}.`, 'SPORTSBOOK_STAKE_LIMIT');
  assert(calculation.potentialPayout <= config.sportsbookMaxPayout, 400, `Potensi kemenangan melewati batas ${config.sportsbookMaxPayout}.`, 'SPORTSBOOK_PAYOUT_LIMIT');
  assertLimitedTestAccess(session.userId, calculation.totalStake);
  assertTradingStakeLimit(legs, calculation.totalStake);
  if (verifiedQuote) {
    assert(Number(verifiedQuote.totalStake) === calculation.totalStake, 409, 'Quote taruhan tidak lagi sesuai dengan kalkulasi server.', 'SPORTSBOOK_QUOTE_MISMATCH');
    if (!repricedLegs.length) assert(Number(verifiedQuote.potentialPayout) === calculation.potentialPayout, 409, 'Quote payout tidak lagi sesuai dengan harga server.', 'SPORTSBOOK_QUOTE_MISMATCH');
  }

  if (legs.some(leg => leg.event.live)) {
    await wait(config.sportsbookLiveAcceptanceDelayMs);
  }

  try {
    return await serializableRetry(async client => {
    if (quoteToken) verifySportsbookQuoteToken(quoteToken, { memberId: session.userId });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `SPORTSBOOK:${session.userId}:${idempotencyKey}`
    ]);
    const existing = await ticketBy(client, 'member_id=$1 AND idempotency_key=$2', [session.userId, idempotencyKey]);
    if (existing) return memberTicket(existing);
    if (verifiedQuote?.quoteId) {
      const acceptedQuote = await ticketBy(client, "member_id=$1 AND metadata->>'quoteId'=$2", [session.userId, verifiedQuote.quoteId]);
      if (acceptedQuote) return memberTicket(acceptedQuote);
    }

    assertLimitedTestAccess(session.userId, calculation.totalStake);
    await assertSportsbookBettingOpen(client, { lock: true });
    const freshLegs = await revalidateResolvedLegs(legs, selectionSnapshot);
    assertTradingStakeLimit(freshLegs, calculation.totalStake);
    await assertRiskExposure(client, freshLegs, calculation.potentialPayout);
    await assertMemberLiability(client, session.userId, calculation.potentialPayout);
    const id = randomUUID();
    const ticketInvoice = invoice();
    await enforceResponsiblePlay(session.userId,{kind:'BET',amount:calculation.totalStake,client,sessionCreatedAt:session.createdAt});
    const ledger = await postTransfer(client, {
      memberId: session.userId,
      systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
      memberDelta: -calculation.totalStake,
      type: 'SPORTSBOOK_BET_PLACED',
      referenceType: 'SPORTSBOOK_TICKET',
      referenceId: id,
      idempotencyKey: `sportsbook:${session.userId}:${idempotencyKey}`,
      metadata: { betType: type, selectionCount: legs.length, totalOdds: calculation.totalOdds },
      actorId: session.userId
    });

    await client.query(`INSERT INTO sportsbook_tickets(
      id,invoice,member_id,bet_type,system_size,status,selection_count,combination_count,unit_stake,total_stake,total_odds,potential_payout,payout,balance_before,balance_after,idempotency_key,metadata
    ) VALUES($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11,0,$12,$13,$14,$15::jsonb)`, [
      id, ticketInvoice, session.userId, type, calculation.systemSize, legs.length, calculation.combinationCount,
      calculation.unitStake, calculation.totalStake, calculation.totalOdds, calculation.potentialPayout,
      ledger.before, ledger.after, idempotencyKey,
      JSON.stringify({
        feedFetchedAt: freshLegs.map(leg => leg.feedFetchedAt).sort().at(-1) || null,
        feedRevisions: [...new Set(freshLegs.map(leg => leg.feedRevision).filter(Boolean))],
        providerStates: [...new Set(freshLegs.map(leg => `${leg.selection.source || leg.market.source || 'unknown'}:${leg.providerState || 'UNKNOWN'}`))],
        oddsVersions: freshLegs.map(leg => leg.selection.priceVersion),
        tradingControlVersions: [...new Set(freshLegs.map(leg => leg.tradingPolicy?.versionToken).filter(value => value && value !== 'none'))],
        tradingMaxStake: effectiveTradingStakeLimit(freshLegs),
        oddsChangePolicy: changePolicy,
        repricedLegs,
        quoteId: verifiedQuote?.quoteId || null,
        quoteIssuedAt: verifiedQuote?.issuedAt || null,
        quoteExpiresAt: verifiedQuote?.expiresAt || null,
        settlementModes: [...new Set(freshLegs.map(leg => leg.event?._settlementMode || null).filter(Boolean))],
        manualSettlementRequired: freshLegs.some(leg => leg.event?._settlementMode === 'MANUAL_FT_FALLBACK')
      })
    ]);

    for (const [index, leg] of freshLegs.entries()) {
      const selectedLine = (leg.selection.line ?? leg.market.line) === null ? null : String(leg.selection.line ?? leg.market.line);
      const providerName = leg.selection.source || leg.market.source || leg.event._sources?.[0] || null;
      await client.query(`INSERT INTO sportsbook_legs(
        id,ticket_id,leg_no,event_id,sport,league,event_start,event_live_at_bet,home_team,away_team,market_id,market_key,market_type,market_label,market_period,market_line,selection_id,selection_label,accepted_odds,provider_sources,odds_version,source_updated_at,provider_name,provider_market_id,provider_selection_id,accepted_feed_at,accepted_feed_revision,provider_state_at_acceptance
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28)`, [
        randomUUID(), id, index + 1, leg.event.id, leg.event.sport, leg.event.league, leg.event.startTime,
        leg.event.live, leg.event.home.name, leg.event.away.name, leg.market.id, leg.market.key,
        leg.market.type, leg.market.label, leg.market.period || 'FT', selectedLine,
        leg.selection.key, leg.selection.label, leg.selection.odds, JSON.stringify(leg.event._sources || []),
        leg.selection.priceVersion, leg.selection.updatedAt || leg.market.updatedAt || null, providerName,
        leg.market.sourceMarketId || leg.market.key || leg.market.id, leg.selection.sourceSelectionId || leg.selection.key,
        new Date(leg.feedFetchedAt), leg.feedRevision || null, leg.providerState || null
      ]);
    }

    await audit({
      actorId: session.userId,
      actorRole: 'MEMBER',
      action: 'SPORTSBOOK_BET_ACCEPTED',
      targetType: 'SPORTSBOOK_TICKET',
      targetId: id,
      details: { invoice: ticketInvoice, betType: type, totalStake: calculation.totalStake, potentialPayout: calculation.potentialPayout, legs: legs.length, quoteId: verifiedQuote?.quoteId || null, oddsChangePolicy: changePolicy, repricedLegs: repricedLegs.length },
      ip,
      client
    });
    return memberTicket(await ticketBy(client, 'id=$1', [id]));
    });
  } catch (error) {
    if (error?.code === '23505' && error?.constraint === 'sportsbook_tickets_quote_id_uq' && verifiedQuote?.quoteId) {
      const acceptedQuote = await ticketBy({ query }, "member_id=$1 AND metadata->>'quoteId'=$2", [session.userId, verifiedQuote.quoteId]);
      if (acceptedQuote) return memberTicket(acceptedQuote);
    }
    throw error;
  }
}

export async function listMemberSportsbookBets(memberId, { status, limit = 50, offset = 0 } = {}) {
  const values = [memberId];
  const where = ['member_id=$1'];
  if (status) {
    values.push(clean(status, 30).toUpperCase());
    where.push(`status=$${values.length}`);
  }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const limitIndex = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const offsetIndex = values.length;
  const rows = await query(`SELECT * FROM sportsbook_tickets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`, values);
  const output = [];
  for (const row of rows.rows) {
    const legs = await query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [row.id]);
    output.push(memberTicket(mapTicket(row, legs.rows)));
  }
  return output;
}

export async function getMemberSportsbookBet(memberId, id) {
  const ticket = await ticketBy({ query }, 'id=$1 AND member_id=$2', [id, memberId]);
  assert(ticket, 404, 'Tiket sportsbook tidak ditemukan.', 'SPORTSBOOK_TICKET_NOT_FOUND');
  return memberTicket(ticket);
}

export async function listManualSportsbookSettlementQueue({ openLimit = 500, recentLimit = 100 } = {}) {
  const safeOpenLimit = Math.min(Math.max(Number(openLimit) || 500, 1), 500);
  const safeRecentLimit = Math.min(Math.max(Number(recentLimit) || 100, 1), 200);
  const loadRows = async rows => Promise.all(rows.map(async row => {
    const legs = await query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [row.id]);
    return { ...mapTicket(row, legs.rows), username: row.username };
  }));
  const [openResult, recentResult] = await Promise.all([
    query(`SELECT t.*,u.username FROM sportsbook_tickets t JOIN users u ON u.id=t.member_id
      WHERE t.status='OPEN' AND COALESCE(t.metadata->>'manualSettlementRequired','false')='true'
      ORDER BY t.accepted_at ASC LIMIT $1`, [safeOpenLimit]),
    query(`SELECT t.*,u.username FROM sportsbook_tickets t JOIN users u ON u.id=t.member_id
      WHERE t.status<>'OPEN' AND COALESCE(t.metadata->>'manualSettlementRequired','false')='true'
        AND t.settlement_revision>0
      ORDER BY t.settled_at DESC NULLS LAST,t.updated_at DESC LIMIT $1`, [safeRecentLimit])
  ]);
  return { open: await loadRows(openResult.rows), recent: await loadRows(recentResult.rows) };
}

export async function listAllSportsbookBets({ status, username, limit = 100, offset = 0 } = {}) {
  const values = [];
  const where = [];
  if (status) {
    values.push(clean(status, 30).toUpperCase());
    where.push(`t.status=$${values.length}`);
  }
  if (username) {
    values.push(`%${clean(username, 40)}%`);
    where.push(`u.username ILIKE $${values.length}`);
  }
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const limitIndex = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const offsetIndex = values.length;
  const tickets = await query(`SELECT t.*,u.username FROM sportsbook_tickets t JOIN users u ON u.id=t.member_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`, values);
  return Promise.all(tickets.rows.map(async row => {
    const legs = await query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [row.id]);
    return { ...mapTicket(row, legs.rows), username: row.username };
  }));
}

function settlementStatus(ticket, legs, payout) {
  const hasVoid = legs.some(leg => ['VOID', 'PUSH'].includes(leg.result_status));
  const hasHalf = legs.some(leg => ['HALF_WON', 'HALF_LOST'].includes(leg.result_status));
  const allVoid = legs.every(leg => ['VOID', 'PUSH'].includes(leg.result_status));
  return allVoid ? 'VOID' : payout <= 0 ? 'LOST' : hasHalf ? (payout >= Number(ticket.total_stake) ? 'PARTIAL_WIN' : 'PARTIAL_LOSS') : hasVoid ? 'PARTIAL_VOID' : 'WON';
}
function legResultSnapshot(legs) {
  return legs.map(leg => ({
    legNo: Number(leg.leg_no),
    status: leg.result_status,
    resultValue: leg.result_value || null
  }));
}
function normalizeSettlementResults(legs, resultInputs, action) {
  if (action === 'ROLLBACK') return legs.map(leg => ({ legNo: Number(leg.leg_no), status: 'PENDING', resultValue: null }));
  if (action === 'CANCEL' && (!Array.isArray(resultInputs) || !resultInputs.length)) {
    return legs.map(leg => ({ legNo: Number(leg.leg_no), status: 'VOID', resultValue: 'Settlement cancelled / market voided' }));
  }
  assert(Array.isArray(resultInputs) && resultInputs.length === legs.length, 400, 'Hasil settlement harus mencakup seluruh leg.', 'SPORTSBOOK_SETTLEMENT_INCOMPLETE');
  const byLeg = new Map(resultInputs.map(item => [Number(item.legNo), item]));
  return legs.map(leg => {
    const result = byLeg.get(Number(leg.leg_no));
    const status = clean(result?.status, 20).toUpperCase();
    assert(FINAL_LEG_RESULTS.has(status), 400, `Hasil leg ${leg.leg_no} tidak valid.`, 'SPORTSBOOK_RESULT_INVALID');
    return { legNo: Number(leg.leg_no), status, resultValue: clean(result?.resultValue, 160) || null };
  });
}
function applyResultsToLegRows(legs, normalized) {
  const byLeg = new Map(normalized.map(item => [Number(item.legNo), item]));
  return legs.map(leg => {
    const result = byLeg.get(Number(leg.leg_no));
    return { ...leg, result_status: result.status, result_value: result.resultValue || null };
  });
}

async function applySportsbookSettlementRevision(id, resultInputs, {
  action = 'SETTLE', actorId = null, actorRole = 'SYSTEM', ip = '',
  feedRevision = null, sourceName = null, reason = null, idempotencyKey = null
} = {}) {
  const normalizedAction = clean(action, 20).toUpperCase();
  assert(['SETTLE', 'ROLLBACK', 'CANCEL'].includes(normalizedAction), 400, 'Aksi settlement tidak valid.', 'SPORTSBOOK_SETTLEMENT_ACTION_INVALID');
  return tx(async client => {
    const ticketResult = await client.query('SELECT * FROM sportsbook_tickets WHERE id=$1 FOR UPDATE', [id]);
    const ticket = ticketResult.rows[0];
    assert(ticket, 404, 'Tiket sportsbook tidak ditemukan.', 'SPORTSBOOK_TICKET_NOT_FOUND');
    const legsResult = await client.query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no FOR UPDATE', [id]);
    const legs = legsResult.rows;

    const pendingRevision = (await client.query(`SELECT id,idempotency_key,revision_no,action FROM sportsbook_settlement_revisions WHERE ticket_id=$1 AND status='PENDING_FUNDS' ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`, [ticket.id])).rows[0];
    if (ticket.settlement_correction_pending || pendingRevision) {
      const requestedIdempotencyKey = clean(idempotencyKey, 180);
      const isRetry = Boolean(pendingRevision && requestedIdempotencyKey && requestedIdempotencyKey === pendingRevision.idempotency_key && normalizedAction === pendingRevision.action);
      if (!isRetry) {
        throw new AppError(409, 'Tiket memiliki koreksi settlement yang masih menunggu dana. Selesaikan koreksi tersebut sebelum membuat revision baru.', 'SPORTSBOOK_SETTLEMENT_CORRECTION_PENDING', {
          ticketId: ticket.id, revisionId: pendingRevision?.id || null, revisionNo: pendingRevision?.revision_no || null, action: pendingRevision?.action || null
        });
      }
    }

    if (normalizedAction === 'SETTLE' && ticket.status !== 'OPEN') return ticketBy(client, 'id=$1', [ticket.id]);
    if (normalizedAction === 'ROLLBACK' && ticket.status === 'OPEN' && Number(ticket.payout || 0) === 0 && legs.every(leg => leg.result_status === 'PENDING')) return ticketBy(client, 'id=$1', [ticket.id]);
    if (normalizedAction === 'CANCEL' && ticket.status === 'VOID' && legs.every(leg => ['VOID', 'PUSH'].includes(leg.result_status))) return ticketBy(client, 'id=$1', [ticket.id]);

    const revisionNo = Number(ticket.settlement_revision || 0) + 1;
    const revisionKey = clean(idempotencyKey, 180) || `sportsbook-settlement:${normalizedAction.toLowerCase()}:${ticket.id}:r${revisionNo}`;
    const existingRevision = (await client.query('SELECT * FROM sportsbook_settlement_revisions WHERE idempotency_key=$1 FOR UPDATE', [revisionKey])).rows[0];
    if (existingRevision?.status === 'APPLIED') return ticketBy(client, 'id=$1', [ticket.id]);

    const previousSnapshot = legResultSnapshot(legs);
    const normalizedResults = existingRevision?.result_snapshot?.length
      ? existingRevision.result_snapshot
      : normalizeSettlementResults(legs, resultInputs, normalizedAction);
    const targetLegs = applyResultsToLegRows(legs, normalizedResults);
    const previousPayout = Number(ticket.payout || 0);
    const nextPayout = normalizedAction === 'ROLLBACK' ? 0 : settleCalculation(ticket, targetLegs);
    const nextStatus = normalizedAction === 'ROLLBACK' ? 'OPEN' : settlementStatus(ticket, targetLegs, nextPayout);
    const payoutDelta = nextPayout - previousPayout;
    const member = await memberAccount(client, ticket.member_id, true);
    const memberBalance = Number(member.current_balance);
    const effectiveRevisionNo = existingRevision ? Number(existingRevision.revision_no) : revisionNo;
    const revisionId = existingRevision?.id || randomUUID();

    if (payoutDelta < 0 && memberBalance + payoutDelta < 0) {
      if (existingRevision) {
        await client.query(`UPDATE sportsbook_settlement_revisions SET status='PENDING_FUNDS',reason=$1,details=details || $2::jsonb WHERE id=$3`, [
          clean(reason || 'Member balance is insufficient to reverse the previous settlement.', 500),
          JSON.stringify({ requiredDebit: Math.abs(payoutDelta), availableBalance: memberBalance, retriedAt: new Date().toISOString() }), revisionId
        ]);
      } else {
        await client.query(`INSERT INTO sportsbook_settlement_revisions(
          id,ticket_id,revision_no,action,status,previous_ticket_status,next_ticket_status,previous_payout,next_payout,payout_delta,result_snapshot,previous_result_snapshot,source_feed_revision,source_name,reason,idempotency_key,actor_id,actor_role,details
        ) VALUES($1,$2,$3,$4,'PENDING_FUNDS',$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb)`, [
          revisionId, ticket.id, effectiveRevisionNo, normalizedAction, ticket.status, nextStatus, previousPayout, nextPayout, payoutDelta,
          JSON.stringify(normalizedResults), JSON.stringify(previousSnapshot), feedRevision || null, sourceName || null,
          clean(reason || 'Member balance is insufficient to reverse the previous settlement.', 500), revisionKey, actorId, actorRole,
          JSON.stringify({ requiredDebit: Math.abs(payoutDelta), availableBalance: memberBalance })
        ]);
      }
      await client.query(`UPDATE sportsbook_tickets SET settlement_correction_pending=true,updated_at=now(),metadata=metadata || $1::jsonb WHERE id=$2`, [
        JSON.stringify({ settlementCorrectionPending: true, pendingSettlementRevisionId: revisionId }), ticket.id
      ]);
      await audit({
        actorId, actorRole, action: 'SPORTSBOOK_SETTLEMENT_CORRECTION_PENDING', targetType: 'SPORTSBOOK_TICKET', targetId: ticket.id,
        details: { revisionId, revisionNo: effectiveRevisionNo, settlementAction: normalizedAction, payoutDelta, memberBalance }, ip, client
      });
      return ticketBy(client, 'id=$1', [ticket.id]);
    }

    let balanceAfter = memberBalance;
    if (payoutDelta !== 0) {
      const ledger = await postTransfer(client, {
        memberId: ticket.member_id,
        systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
        memberDelta: payoutDelta,
        type: normalizedAction === 'SETTLE' ? 'SPORTSBOOK_BET_SETTLED' : normalizedAction === 'ROLLBACK' ? 'SPORTSBOOK_SETTLEMENT_ROLLBACK' : 'SPORTSBOOK_SETTLEMENT_CANCELLED',
        referenceType: 'SPORTSBOOK_SETTLEMENT_REVISION',
        referenceId: revisionId,
        idempotencyKey: `sportsbook-settlement-ledger:${revisionId}`,
        metadata: { ticketId: ticket.id, action: normalizedAction, revisionNo: effectiveRevisionNo, previousPayout, nextPayout, payoutDelta, feedRevision },
        actorId
      });
      balanceAfter = ledger.after;
    }

    for (const leg of targetLegs) {
      const result = normalizedResults.find(item => Number(item.legNo) === Number(leg.leg_no));
      await client.query(`UPDATE sportsbook_legs SET
        result_status=$1,result_value=$2,settled_at=$3,settlement_revision=$4,settlement_source=$5,settlement_feed_revision=$6
        WHERE id=$7`, [
        result.status, result.resultValue || null, result.status === 'PENDING' ? null : new Date(), effectiveRevisionNo,
        sourceName || (actorRole === 'SYSTEM' ? 'AUTO' : 'MANUAL'), feedRevision || null, leg.id
      ]);
    }

    const settledAt = nextStatus === 'OPEN' ? null : new Date();
    await client.query(`UPDATE sportsbook_tickets SET
      status=$1,payout=$2,balance_after=$3,settled_at=$4,updated_at=now(),settlement_revision=$5,
      settlement_correction_pending=false,last_settlement_action=$6,last_settlement_feed_revision=$7,
      metadata=metadata || $8::jsonb WHERE id=$9`, [
      nextStatus, nextPayout, balanceAfter, settledAt, effectiveRevisionNo, normalizedAction, feedRevision || null,
      JSON.stringify({ settlementBalanceAfter: balanceAfter, settlementMode: actorRole === 'SYSTEM' ? 'AUTO' : 'MANUAL', settlementRevision: effectiveRevisionNo, settlementAction: normalizedAction, settlementCorrectionPending: false }), ticket.id
    ]);

    if (existingRevision) {
      await client.query(`UPDATE sportsbook_settlement_revisions SET
        status='APPLIED',previous_ticket_status=$1,next_ticket_status=$2,previous_payout=$3,next_payout=$4,payout_delta=$5,
        source_feed_revision=COALESCE($6,source_feed_revision),source_name=COALESCE($7,source_name),reason=COALESCE($8,reason),
        details=details || $9::jsonb,completed_at=now() WHERE id=$10`, [
        ticket.status, nextStatus, previousPayout, nextPayout, payoutDelta, feedRevision || null, sourceName || null, clean(reason, 500) || null,
        JSON.stringify({ appliedAt: new Date().toISOString(), balanceAfter }), revisionId
      ]);
    } else {
      await client.query(`INSERT INTO sportsbook_settlement_revisions(
        id,ticket_id,revision_no,action,status,previous_ticket_status,next_ticket_status,previous_payout,next_payout,payout_delta,result_snapshot,previous_result_snapshot,source_feed_revision,source_name,reason,idempotency_key,actor_id,actor_role,details,completed_at
      ) VALUES($1,$2,$3,$4,'APPLIED',$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,now())`, [
        revisionId, ticket.id, effectiveRevisionNo, normalizedAction, ticket.status, nextStatus, previousPayout, nextPayout, payoutDelta,
        JSON.stringify(normalizedResults), JSON.stringify(previousSnapshot), feedRevision || null, sourceName || null, clean(reason, 500) || null,
        revisionKey, actorId, actorRole, JSON.stringify({ balanceAfter })
      ]);
    }

    if (nextPayout > 0 && normalizedAction !== 'ROLLBACK') {
      const netWin = nextPayout > Number(ticket.total_stake);
      await createMemberNotification(client, {
        memberId: ticket.member_id,
        type: netWin ? 'SPORTSBOOK_WIN' : 'BET_SETTLED',
        title: normalizedAction === 'CANCEL' ? 'Taruhan Sportsbook Dibatalkan' : netWin ? 'Taruhan Sportsbook Menang' : 'Taruhan Sportsbook Diselesaikan',
        message: normalizedAction === 'CANCEL'
          ? `Tiket ${ticket.invoice} dibatalkan/void. Saldo setelah koreksi IDR ${balanceAfter.toLocaleString('id-ID')}.`
          : netWin ? `Tiket ${ticket.invoice} selesai. Pembayaran IDR ${nextPayout.toLocaleString('id-ID')} otomatis masuk ke saldo Anda.` : `Tiket ${ticket.invoice} selesai dengan pembayaran/refund IDR ${nextPayout.toLocaleString('id-ID')}.`,
        amount: Math.max(0, payoutDelta), referenceType: 'SPORTSBOOK_TICKET', referenceId: ticket.id,
        actionUrl: 'bet-history.html?game=sportsbook', priority: 'HIGH',
        metadata: { invoice: ticket.invoice, betType: ticket.bet_type, balanceAfter, settlementAction: normalizedAction, settlementRevision: effectiveRevisionNo }
      });
    }

    await audit({
      actorId, actorRole,
      action: normalizedAction === 'SETTLE' ? (actorRole === 'SYSTEM' ? 'SPORTSBOOK_BET_AUTO_SETTLED' : 'SPORTSBOOK_BET_SETTLED') : `SPORTSBOOK_SETTLEMENT_${normalizedAction}`,
      targetType: 'SPORTSBOOK_TICKET', targetId: ticket.id,
      details: { status: nextStatus, previousPayout, payout: nextPayout, payoutDelta, revisionNo: effectiveRevisionNo, feedRevision, sourceName }, ip, client
    });
    return ticketBy(client, 'id=$1', [ticket.id]);
  }, { isolation: 'SERIALIZABLE' });
}

export async function settleSportsbookBet(session, id, input, { ip = '' } = {}) {
  const resultInputs = Array.isArray(input.results) ? input.results : [];
  return applySportsbookSettlementRevision(id, resultInputs, {
    action: 'SETTLE', actorId: session.userId, actorRole: session.roles?.join(',') || 'OWNER', ip,
    feedRevision: clean(input.feedRevision, 120) || null, sourceName: clean(input.sourceName, 120) || 'MANUAL',
    reason: clean(input.reason, 500) || null, idempotencyKey: clean(input.idempotencyKey, 180) || null
  });
}

export async function rollbackSportsbookSettlement(session, id, input = {}, { ip = '' } = {}) {
  return applySportsbookSettlementRevision(id, [], {
    action: 'ROLLBACK', actorId: session.userId, actorRole: session.roles?.join(',') || 'OWNER', ip,
    feedRevision: clean(input.feedRevision, 120) || null, sourceName: clean(input.sourceName, 120) || 'MANUAL',
    reason: clean(input.reason, 500) || 'Settlement rollback requested by operator.', idempotencyKey: clean(input.idempotencyKey, 180) || null
  });
}

export async function cancelSportsbookSettlement(session, id, input = {}, { ip = '' } = {}) {
  return applySportsbookSettlementRevision(id, [], {
    action: 'CANCEL', actorId: session.userId, actorRole: session.roles?.join(',') || 'OWNER', ip,
    feedRevision: clean(input.feedRevision, 120) || null, sourceName: clean(input.sourceName, 120) || 'MANUAL',
    reason: clean(input.reason, 500) || 'Settlement cancelled / market voided by operator.', idempotencyKey: clean(input.idempotencyKey, 180) || null
  });
}

export async function settleSportsbookTicketAutomatic(id, results, context = {}) {
  return applySportsbookSettlementRevision(id, results, {
    action: 'SETTLE', actorId: null, actorRole: 'SYSTEM', ip: 'worker',
    feedRevision: clean(context.feedRevision, 120) || null,
    sourceName: clean(context.sourceName, 120) || 'AUTO_RESULT_AUTHORITY',
    reason: clean(context.reason, 500) || 'Automatic authoritative result settlement.',
    idempotencyKey: clean(context.idempotencyKey, 180) || null
  });
}

export async function retryPendingSportsbookSettlementCorrections({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pending = await query(`SELECT * FROM sportsbook_settlement_revisions WHERE status='PENDING_FUNDS' ORDER BY created_at LIMIT $1`, [safeLimit]);
  let applied = 0;
  let pendingFunds = 0;
  for (const revision of pending.rows) {
    try {
      await applySportsbookSettlementRevision(revision.ticket_id, revision.result_snapshot || [], {
        action: revision.action,
        actorId: revision.actor_id || null,
        actorRole: revision.actor_role || 'SYSTEM',
        ip: 'worker-correction-retry',
        feedRevision: revision.source_feed_revision || null,
        sourceName: revision.source_name || 'SETTLEMENT_CORRECTION_RETRY',
        reason: revision.reason || 'Retry pending sportsbook settlement correction.',
        idempotencyKey: revision.idempotency_key
      });
      const current = await query('SELECT status FROM sportsbook_settlement_revisions WHERE id=$1', [revision.id]);
      if (current.rows[0]?.status === 'APPLIED') applied += 1;
      else pendingFunds += 1;
    } catch {
      pendingFunds += 1;
    }
  }
  return { checked: pending.rowCount, applied, pendingFunds };
}

export const __sportsbookBetting = { combinations, ticketCalculation, settleCalculation, legReturnMultiplier, validateBetType, riskMarketKey, riskSelectionKey, oddsChangePolicy, priceChanged };
