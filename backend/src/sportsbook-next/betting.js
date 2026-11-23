import { randomUUID, createHash } from "node:crypto";
import { query, tx } from "../db.js";
import { AppError, assert } from "../errors.js";
import { postTransfer, postSystemTransfer, memberAccount, SYSTEM_ACCOUNTS } from "../ledger.js";
import { enforceResponsiblePlay } from "../operations.js";
import { redis } from "../redis.js";
import { loadSportsbookConfig } from "./config.js";
import { SportradarClient } from "./sportradar-client.js";
import { reserveSportradarCall } from "./quota.js";
import { evaluateSoccerLeg, evaluateTicketStatus, calculateTicketPayout } from "./settlement-rules.js";

const MAX_LEGS = 10;
const MAX_STAKE = 1_000_000_000;
const ODDS_EPSILON = 0.000001;
const invoice = () => `SBV2-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
const selectionKey = outcome => [outcome.id || outcome.type || outcome.name || "unknown", outcome.handicap ?? outcome.total ?? outcome.spread ?? outcome.line ?? ""].join("|");

function providerClient() {
  const config = loadSportsbookConfig();
  const client = new SportradarClient(config, {
    beforeRequest: () => reserveSportradarCall(redis, config)
  });
  return { config, client };
}

function validateLegs(legs) {
  assert(Array.isArray(legs) && legs.length >= 1 && legs.length <= MAX_LEGS, 400, "Jumlah pilihan harus 1 sampai 10.", "SPORTSBOOK_LEGS_INVALID");
  const seen = new Set();
  return legs.map((leg, index) => {
    const eventId = String(leg.eventId || "");
    const marketId = String(leg.marketId || "");
    const bookId = String(leg.bookId || "");
    const outcomeId = String(leg.outcomeId || "");
    const expectedOdds = Number(leg.expectedOdds);
    assert(/^sr:sport_event:\d+$/.test(eventId) && /^sr:market:\d+$/.test(marketId) && /^sr:book:\d+$/.test(bookId) && /^sr:outcome:\d+$/.test(outcomeId), 400, "Identitas event, market, book, atau outcome tidak valid.", "SPORTSBOOK_SELECTION_INVALID");
    assert(Number.isFinite(expectedOdds) && expectedOdds > 1 && expectedOdds <= 1000, 400, "Odds pilihan tidak valid.", "SPORTSBOOK_ODDS_INVALID");
    assert(!seen.has(eventId), 400, "Satu tiket hanya boleh memiliki satu pilihan per pertandingan.", "SPORTSBOOK_DUPLICATE_EVENT");
    seen.add(eventId);
    return { ...leg, eventId, marketId, bookId, outcomeId, expectedOdds, legNo: index + 1 };
  });
}

async function fetchFreshLegs(legs) {
  const { client } = providerClient();
  const verified = [];
  for (const leg of legs) {
    const catalogued = (await query("SELECT provider_event_id FROM sportsbook_v2_events WHERE provider_event_id=$1", [leg.eventId])).rows[0];
    assert(catalogued, 409, "Pertandingan belum masuk katalog Sportradar. Perbarui daftar pertandingan lalu coba lagi.", "SPORTSBOOK_EVENT_NOT_CATALOGUED");
    const response = await client.getSportEventMarkets(leg.eventId);
    const event = response.body?.sport_event;
    assert(event?.id === leg.eventId, 503, "Sportradar tidak mengembalikan pertandingan yang diminta.", "SPORTSBOOK_PROVIDER_EVENT_MISMATCH");
    assert(event.status === "not_started", 409, "Pertandingan sudah dimulai, ditunda, atau ditutup.", "SPORTSBOOK_EVENT_NOT_OPEN");
    const startAt = Date.parse(event.start_time || "");
    assert(Number.isFinite(startAt) && startAt > Date.now(), 409, "Waktu pertandingan tidak valid atau sudah dimulai.", "SPORTSBOOK_EVENT_NOT_OPEN");
    const market = (response.body?.markets || []).find(item => item.id === leg.marketId);
    assert(market && market.is_live !== true, 409, "Market tidak tersedia untuk taruhan prematch.", "SPORTSBOOK_MARKET_NOT_OPEN");
    const book = (market.books || []).find(item => item.id === leg.bookId);
    assert(book && book.removed !== true, 409, "Bookmaker telah menutup market ini.", "SPORTSBOOK_BOOK_CLOSED");
    const outcome = (book.outcomes || []).find(item => item.id === leg.outcomeId);
    assert(outcome && outcome.removed !== true, 409, "Pilihan sudah ditangguhkan atau dihapus.", "SPORTSBOOK_OUTCOME_CLOSED");
    const currentOdds = Number(outcome.odds_decimal);
    assert(Number.isFinite(currentOdds) && currentOdds > 1, 409, "Odds Sportradar tidak valid.", "SPORTSBOOK_ODDS_INVALID");
    assert(Math.abs(currentOdds - leg.expectedOdds) <= ODDS_EPSILON, 409, "Odds berubah. Perbarui slip sebelum mengirim taruhan.", "SPORTSBOOK_ODDS_CHANGED");
    verified.push({
      ...leg,
      marketKey: `${market.id}|${market.name || market.id}`,
      marketName: market.name || market.id,
      marketType: String(market.name || "").toLowerCase(),
      marketPayload: market,
      selectionKey: selectionKey(outcome),
      outcomeType: outcome.type || null,
      outcomeName: outcome.name || outcome.type || null,
      line: outcome.handicap ?? outcome.total ?? outcome.spread ?? outcome.line ?? null,
      acceptedOdds: currentOdds,
      sourceUpdatedAt: response.body.generated_at || new Date().toISOString(),
      eventStartAt: event.start_time
    });
  }
  return verified;
}

export async function placeSportsbookBet(memberSession, input) {
  assert(memberSession?.userId, 401, "Sesi member diperlukan.", "AUTH_REQUIRED");
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  assert(/^[A-Za-z0-9:_-]{16,100}$/.test(idempotencyKey), 400, "Idempotency-Key wajib 16-100 karakter.", "IDEMPOTENCY_KEY_INVALID");
  const stake = Number(input.stake);
  assert(Number.isSafeInteger(stake) && stake > 0 && stake <= MAX_STAKE, 400, "Nominal taruhan tidak valid.", "SPORTSBOOK_STAKE_INVALID");
  const requestedLegs = validateLegs(input.legs);
  const requestHash = createHash("sha256").update(JSON.stringify({ stake, legs: requestedLegs.map(({ eventId, marketId, bookId, outcomeId, expectedOdds }) => ({ eventId, marketId, bookId, outcomeId, expectedOdds })) })).digest("hex");
  const previous = (await query("SELECT * FROM sportsbook_v2_tickets WHERE member_id=$1 AND idempotency_key=$2", [memberSession.userId, idempotencyKey])).rows[0];
  if (previous) {
    assert(previous.metadata?.requestHash === requestHash, 409, "Idempotency-Key sudah dipakai untuk isi taruhan yang berbeda.", "IDEMPOTENCY_KEY_REUSED");
    return { duplicate: true, ticket: previous };
  }

  // The provider call is deliberately synchronous and occurs for every leg on submission.
  const legs = await fetchFreshLegs(requestedLegs);
  const totalOdds = legs.reduce((total, leg) => total * leg.acceptedOdds, 1);
  const potentialPayout = Math.floor(stake * totalOdds);
  assert(Number.isSafeInteger(potentialPayout) && potentialPayout >= stake, 400, "Potensi pembayaran melebihi batas sistem.", "SPORTSBOOK_PAYOUT_LIMIT");

  return tx(async client => {
    // Serialize retries for this member/key before checking the unique ticket key.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberSession.userId, idempotencyKey]);
    const prior = await client.query("SELECT * FROM sportsbook_v2_tickets WHERE member_id=$1 AND idempotency_key=$2 FOR UPDATE", [memberSession.userId, idempotencyKey]);
    if (prior.rows[0]) { assert(prior.rows[0].metadata?.requestHash === requestHash, 409, "Idempotency-Key sudah dipakai untuk isi taruhan yang berbeda.", "IDEMPOTENCY_KEY_REUSED"); return { duplicate: true, ticket: prior.rows[0] }; }

    await enforceResponsiblePlay(memberSession.userId, { kind: "BET", amount: stake, client, sessionCreatedAt: memberSession.createdAt });
    const ticketId = randomUUID();
    const inv = invoice();
    const ledger = await postTransfer(client, {
      memberId: memberSession.userId,
      systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
      memberDelta: -stake,
      type: "SPORTSBOOK_BET_PLACED",
      referenceType: "SPORTSBOOK_V2_TICKET",
      referenceId: ticketId,
      idempotencyKey: `sportsbook-v2:place:${memberSession.userId}:${idempotencyKey}`,
      metadata: { invoice: inv, stake, totalOdds, potentialPayout, provider: "sportradar-odds-comparison-prematch-v2" },
      actorId: memberSession.userId
    });
    assert(!ledger.duplicate, 409, "Permintaan taruhan sudah diproses.", "SPORTSBOOK_DUPLICATE_TRANSACTION");

    await client.query(`INSERT INTO sportsbook_v2_tickets
      (id,invoice,member_id,stake,total_odds,potential_payout,status,idempotency_key,ledger_transaction_id,balance_before,balance_after,metadata)
      VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11::jsonb)`,
    [ticketId, inv, memberSession.userId, stake, totalOdds, potentialPayout, idempotencyKey, ledger.transactionId, ledger.before, ledger.after,
      JSON.stringify({ provider: "sportradar-odds-comparison-prematch-v2", acceptedAt: new Date().toISOString(), requestHash })]);

    for (const leg of legs) {
      await client.query(`INSERT INTO sportsbook_v2_markets
        (provider_event_id,provider_market_key,provider_market_id,market_name,is_live,is_active,snapshot_at,provider_payload)
        VALUES($1,$2,$3,$4,$5,TRUE,$6,$7::jsonb)
        ON CONFLICT(provider_event_id,provider_market_key) DO UPDATE SET
          market_name=excluded.market_name,is_live=excluded.is_live,is_active=TRUE,
          snapshot_at=excluded.snapshot_at,provider_payload=excluded.provider_payload`,
      [leg.eventId,leg.marketKey,leg.marketId,leg.marketName,false,new Date(leg.sourceUpdatedAt),JSON.stringify(leg.marketPayload)]);
      await client.query(`INSERT INTO sportsbook_v2_ticket_legs
        (id,ticket_id,leg_no,provider_event_id,provider_market_key,provider_market_id,provider_book_id,provider_selection_key,accepted_odds,source_updated_at,result_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [randomUUID(), ticketId, leg.legNo, leg.eventId, leg.marketKey, leg.marketId, leg.bookId, leg.selectionKey,
        leg.acceptedOdds, new Date(leg.sourceUpdatedAt), JSON.stringify({
          marketName: leg.marketName, marketType: leg.marketType, outcomeType: leg.outcomeType,
          outcomeName: leg.outcomeName, line: leg.line, outcomeId: leg.outcomeId, eventStartAt: leg.eventStartAt
        })]);
    }
    const ticket = (await client.query("SELECT * FROM sportsbook_v2_tickets WHERE id=$1", [ticketId])).rows[0];
    return { duplicate: false, ticket, legs: legs.map(({ eventId, marketName, outcomeName, acceptedOdds }) => ({ eventId, marketName, outcomeName, acceptedOdds })) };
  }, { isolation: "SERIALIZABLE" });
}

export async function refreshAndSettleSportsbookEvent(eventId) {
  assert(/^sr:sport_event:\d+$/.test(String(eventId || "")), 400, "ID pertandingan tidak valid.", "SPORTSBOOK_EVENT_ID_INVALID");
  const eventRow = (await query("SELECT scheduled_at FROM sportsbook_v2_events WHERE provider_event_id=$1", [eventId])).rows[0];
  assert(eventRow?.scheduled_at, 404, "Pertandingan tidak ditemukan.", "SPORTSBOOK_EVENT_NOT_FOUND");
  const { client } = providerClient();
  const date = new Date(eventRow.scheduled_at).toISOString().slice(0, 10);
  const response = await client.getSoccerDailySummaries(date);
  const summaries = response.body?.summaries || [];
  const summary = summaries.find(item => item?.sport_event?.id === eventId);
  assert(summary, 404, "Hasil pertandingan belum tersedia pada feed Sportradar Soccer.", "SPORTSBOOK_RESULT_NOT_FOUND");
  const status = summary.sport_event_status?.status;
  assert(status === "closed" || status === "cancelled", 409, "Hasil belum berstatus closed atau cancelled dari Sportradar.", "SPORTSBOOK_RESULT_NOT_VERIFIED");
  const cancelled = status === "cancelled";
  const homeScore = summary.sport_event_status?.home_score ?? null;
  const awayScore = summary.sport_event_status?.away_score ?? null;
  assert(cancelled || (Number.isInteger(homeScore) && Number.isInteger(awayScore) && homeScore >= 0 && awayScore >= 0), 409, "Skor terverifikasi tidak lengkap.", "SPORTSBOOK_RESULT_INVALID");
  const sourceUpdatedAt = summary.generated_at || response.body.generated_at || new Date().toISOString();

  return tx(async clientTx => {
    await clientTx.query(`INSERT INTO sportsbook_v2_event_results
      (provider_event_id,result_source,event_status,home_score,away_score,source_updated_at,verified,provider_payload)
      VALUES($1,'sportradar-soccer-v4',$2,$3,$4,$5,TRUE,$6::jsonb)
      ON CONFLICT(provider_event_id) DO UPDATE SET event_status=excluded.event_status,home_score=excluded.home_score,
        away_score=excluded.away_score,source_updated_at=excluded.source_updated_at,verified=TRUE,provider_payload=excluded.provider_payload
      WHERE sportsbook_v2_event_results.source_updated_at<=excluded.source_updated_at`,
    [eventId, status, homeScore, awayScore, new Date(sourceUpdatedAt), JSON.stringify(summary)]);
    const tickets = await clientTx.query(`SELECT DISTINCT t.id FROM sportsbook_v2_tickets t
      JOIN sportsbook_v2_ticket_legs l ON l.ticket_id=t.id
      WHERE l.provider_event_id=$1 AND t.status='OPEN' ORDER BY t.id`, [eventId]);
    let settled = 0, pending = 0;
    for (const row of tickets.rows) {
      const locked = (await clientTx.query("SELECT * FROM sportsbook_v2_tickets WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (!locked || locked.status !== "OPEN") continue;
      const legs = (await clientTx.query(`SELECT l.*,m.market_name FROM sportsbook_v2_ticket_legs l
        LEFT JOIN sportsbook_v2_markets m ON m.provider_event_id=l.provider_event_id AND m.provider_market_key=l.provider_market_key
        WHERE l.ticket_id=$1 ORDER BY l.leg_no FOR UPDATE OF l`, [row.id])).rows;
      const target = legs.find(leg => leg.provider_event_id === eventId && leg.result_status === "PENDING");
      if (!target) continue;
      const mapped = evaluateSoccerLeg({ marketName: target.market_name || target.result_payload?.marketName, outcomeType: target.result_payload?.outcomeType, outcomeName: target.result_payload?.outcomeName, line: target.result_payload?.line, homeScore, awayScore, cancelled });
      if (!mapped) { pending++; continue; }
      await clientTx.query("UPDATE sportsbook_v2_ticket_legs SET result_status=$1,result_payload=result_payload||$2::jsonb WHERE id=$3",
        [mapped, JSON.stringify({ verifiedResult: { status, homeScore, awayScore, sourceUpdatedAt } }), target.id]);
      const settledLegs = legs.map(leg => leg.id === target.id ? { ...leg, result_status: mapped } : leg);
      const finalStatus = evaluateTicketStatus(settledLegs.map(leg => leg.result_status));
      if (!finalStatus) { pending++; continue; }
      const amount = finalStatus === "VOID" ? Number(locked.stake)
        : finalStatus === "WON" ? calculateTicketPayout(Number(locked.stake), settledLegs) : 0;
      if (finalStatus === "LOST") {
        const accounts = await clientTx.query("SELECT account_code,current_balance FROM ledger_accounts WHERE account_code=ANY($1::text[]) ORDER BY account_code FOR UPDATE", [[SYSTEM_ACCOUNTS.CLEARING, SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD]]);
        const holdAccount = accounts.rows.find(account => account.account_code === SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD);
        assert(holdAccount && Number(holdAccount.current_balance) >= Number(locked.stake), 409, "Saldo dana sportsbook hold tidak mencukupi untuk settlement.", "SPORTSBOOK_HOLD_INSUFFICIENT");
        const transfer = await postSystemTransfer(clientTx, {
          fromCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD, toCode: SYSTEM_ACCOUNTS.CLEARING, amount: Number(locked.stake),
          type: "SPORTSBOOK_BET_LOST", referenceType: "SPORTSBOOK_V2_TICKET", referenceId: locked.id,
          idempotencyKey: `sportsbook-v2:settle:${locked.id}:LOST`, metadata: { eventId, result: { homeScore, awayScore } }
        });
        assert(!transfer.duplicate, 409, "Settlement loss sudah pernah diproses.", "SPORTSBOOK_SETTLEMENT_DUPLICATE");
      } else {
        await memberAccount(clientTx, locked.member_id, true);
        const hold = await clientTx.query("SELECT current_balance FROM ledger_accounts WHERE account_code=$1 FOR UPDATE", [SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD]);
        assert(hold.rows[0] && Number(hold.rows[0].current_balance) >= amount, 409, "Saldo dana sportsbook hold tidak mencukupi untuk payout/refund.", "SPORTSBOOK_HOLD_INSUFFICIENT");
        const transfer = await postTransfer(clientTx, {
          memberId: locked.member_id, systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD, memberDelta: amount,
          type: finalStatus === "WON" ? "SPORTSBOOK_PAYOUT" : "SPORTSBOOK_VOID_REFUND",
          referenceType: "SPORTSBOOK_V2_TICKET", referenceId: locked.id,
          idempotencyKey: `sportsbook-v2:settle:${locked.id}:${finalStatus}`,
          metadata: { eventId, result: { homeScore, awayScore }, amount }
        });
        assert(!transfer.duplicate, 409, "Settlement payout/refund sudah pernah diproses.", "SPORTSBOOK_SETTLEMENT_DUPLICATE");
      }
      await clientTx.query("UPDATE sportsbook_v2_tickets SET status=$1,settled_at=now(),metadata=metadata||$2::jsonb WHERE id=$3",
        [finalStatus, JSON.stringify({ settlement: { eventId, status, homeScore, awayScore, amount } }), locked.id]);
      settled++;
    }
    return { eventId, verified: true, status, homeScore, awayScore, settled, pending };
  });
}
