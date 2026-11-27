import { randomUUID } from "node:crypto";
import { query, tx } from "../db.js";
import { AppError, assert } from "../errors.js";
import { audit } from "../audit.js";
import {
  ensureSystemAccounts,
  postSystemTransfer,
  postTransfer,
  SYSTEM_ACCOUNTS
} from "../ledger.js";
import { evaluateSoccer1x2Leg, evaluateTicketStatus } from "./settlement-rules.js";

const SUPPORTED_MARKET = "SOCCER_1X2_3WAY";
const SUPPORTED_RULE = "SOCCER_1X2_3WAY";
const SCALE = 1_000_000n;

function toOddsMicros(value) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value ?? "").trim());
  if (!match) throw new AppError(500, "Odds tiket tersimpan tidak valid.", "SPORTSBOOK_STORED_ODDS_INVALID");
  const micros = BigInt(match[1]) * SCALE + BigInt((match[2] || "").padEnd(6, "0") || "0");
  assert(micros > SCALE, 500, "Odds tiket tersimpan tidak valid.", "SPORTSBOOK_STORED_ODDS_INVALID");
  return micros;
}

export function evaluateSportsbookTicketResults(legs, results) {
  if (!Array.isArray(legs) || legs.length === 0 || !Array.isArray(results)) {
    return { ready: false, reason: "TICKET_DATA_INVALID", legStatuses: [] };
  }
  const resultByEvent = new Map(results.map(result => [result.provider_event_id ?? result.providerEventId, result]));
  const legStatuses = [];
  const resultPayloads = [];

  for (const leg of legs) {
    if (leg.market_code !== SUPPORTED_MARKET || leg.settlement_rule !== SUPPORTED_RULE ||
        !["HOME", "DRAW", "AWAY"].includes(String(leg.outcome_code || "").toUpperCase())) {
      return { ready: false, reason: "SETTLEMENT_MAPPING_UNSUPPORTED", legStatuses: [], manualReview: true };
    }
    const result = resultByEvent.get(leg.provider_event_id);
    if (!result || result.verified !== true) {
      return { ready: false, reason: "RESULT_NOT_VERIFIED", legStatuses: [] };
    }
    const status = String(result.event_status || "").toLowerCase();
    const scoreComplete = Number.isInteger(result.home_score) && result.home_score >= 0 &&
      Number.isInteger(result.away_score) && result.away_score >= 0;
    const isFinal = status === "cancelled" || (status === "closed" && scoreComplete);
    if (!isFinal) {
      return { ready: false, reason: "RESULT_NOT_FINAL", legStatuses: [] };
    }

    const resultStatus = evaluateSoccer1x2Leg({
      marketCode: leg.market_code,
      outcomeCode: leg.outcome_code,
      result: {
        status,
        homeScore: result.home_score,
        awayScore: result.away_score,
        isFinal,
        verified: result.verified === true
      }
    });
    if (!resultStatus) {
      return { ready: false, reason: "RESULT_MAPPING_UNRESOLVED", legStatuses: [], manualReview: true };
    }
    legStatuses.push({ legId: leg.id, resultStatus });
    resultPayloads.push({
      legId: leg.id,
      providerEventId: leg.provider_event_id,
      resultSource: result.result_source,
      eventStatus: status,
      homeScore: result.home_score,
      awayScore: result.away_score,
      providerGeneratedAt: result.source_updated_at ?? null,
      receivedAt: result.received_at ?? null,
      verified: true
    });
  }

  const ticketStatus = evaluateTicketStatus(legStatuses.map(item => item.resultStatus));
  if (!ticketStatus) return { ready: false, reason: "TICKET_RESULT_INCOMPLETE", legStatuses: [] };
  return { ready: true, ticketStatus, legStatuses, resultPayloads };
}

export function calculateSportsbookSettlementPayout(stake, ticketStatus, legs) {
  if (!Number.isSafeInteger(stake) || stake <= 0 || !Array.isArray(legs) || legs.length === 0) {
    throw new AppError(500, "Data payout tiket tidak valid.", "SPORTSBOOK_SETTLEMENT_PAYOUT_INVALID");
  }
  if (ticketStatus === "LOST") return 0;
  assert(ticketStatus === "WON" || ticketStatus === "VOID", 500,
    "Status settlement tidak dikenal.", "SPORTSBOOK_SETTLEMENT_STATUS_INVALID");
  const winningLegs = legs.filter(leg => leg.resultStatus === "WON");
  if (ticketStatus === "VOID" || winningLegs.length === 0) return stake;
  const micros = winningLegs.map(leg => toOddsMicros(leg.accepted_odds));
  const numerator = micros.reduce((product, value) => product * value, 1n);
  const totalOddsMicros = numerator / (SCALE ** BigInt(micros.length - 1));
  const payout = (BigInt(stake) * totalOddsMicros) / SCALE;
  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(500, "Payout melebihi batas numerik.", "SPORTSBOOK_SETTLEMENT_PAYOUT_OVERFLOW");
  }
  return Number(payout);
}

async function loadResultRevisionIds(client, eventIds) {
  if (!eventIds.length) return [];
  const result = await client.query(`
    SELECT DISTINCT ON (provider_event_id) id
    FROM sportsbook_v2_event_result_revisions
    WHERE provider_event_id = ANY($1::text[])
    ORDER BY provider_event_id, received_at DESC, id DESC
  `, [eventIds]);
  return result.rows.map(row => String(row.id));
}

async function detectSettledResultCorrections(client) {
  const result = await client.query(`
    WITH latest_settlement AS (
      SELECT DISTINCT ON (ticket_id) ticket_id,metadata
      FROM sportsbook_v2_settlement_revisions
      ORDER BY ticket_id,revision_no DESC
    ), changed_tickets AS (
      SELECT DISTINCT t.id
      FROM sportsbook_v2_tickets t
      JOIN latest_settlement ls ON ls.ticket_id=t.id
      JOIN sportsbook_v2_ticket_legs l ON l.ticket_id=t.id
      JOIN sportsbook_v2_event_results r ON r.provider_event_id=l.provider_event_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(ls.metadata->'resultPayloads','[]'::jsonb)
      ) prior
      WHERE t.status <> 'OPEN'
        AND t.settled_at IS NOT NULL
        AND prior->>'providerEventId'=l.provider_event_id
        AND r.received_at > t.settled_at
        AND (
          prior->>'resultSource' IS DISTINCT FROM r.result_source
          OR prior->>'eventStatus' IS DISTINCT FROM r.event_status
          OR NULLIF(prior->>'homeScore','')::integer IS DISTINCT FROM r.home_score
          OR NULLIF(prior->>'awayScore','')::integer IS DISTINCT FROM r.away_score
          OR COALESCE(prior->>'verified','false') <> r.verified::text
        )
        AND (t.reviewed_at IS NULL OR t.reviewed_at < r.received_at)
    )
    UPDATE sportsbook_v2_tickets t
    SET review_required=TRUE,
        review_reason='PROVIDER_RESULT_CHANGED_AFTER_SETTLEMENT',
        review_detected_at=COALESCE(t.review_detected_at,now())
    FROM changed_tickets changed
    WHERE t.id=changed.id
    RETURNING t.id
  `);
  return result.rowCount || 0;
}

export async function settleReadySportsbookTickets({ limit = 50, actorId = null } = {}) {
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 250, 400,
    "Batas settlement batch tidak valid.", "SPORTSBOOK_SETTLEMENT_BATCH_INVALID");

  return tx(async client => {
    const candidates = await client.query(`
      SELECT t.id,t.invoice,t.member_id,t.stake,t.status,t.potential_payout
      FROM sportsbook_v2_tickets t
      WHERE t.status = 'OPEN'
        AND EXISTS (
          SELECT 1
          FROM sportsbook_v2_ticket_legs candidate_leg
          JOIN sportsbook_v2_event_results candidate_result
            ON candidate_result.provider_event_id = candidate_leg.provider_event_id
          WHERE candidate_leg.ticket_id = t.id
            AND candidate_result.verified = TRUE
            AND candidate_result.event_status IN ('closed','cancelled')
        )
      ORDER BY t.accepted_at ASC
      LIMIT $1
      FOR UPDATE OF t SKIP LOCKED
    `, [limit]);

    const summary = {
      scanned: candidates.rows.length, settled: 0, won: 0, lost: 0, void: 0,
      waiting: 0, manualReview: 0, liquidityBlocked: 0, correctionsDetected: 0
    };
    summary.correctionsDetected = await detectSettledResultCorrections(client);

    await ensureSystemAccounts(client);
    for (const ticket of candidates.rows) {
      const legResult = await client.query(`
        SELECT id,provider_event_id,provider_market_key,market_code,outcome_code,
               settlement_rule,accepted_odds::text AS accepted_odds,result_status
        FROM sportsbook_v2_ticket_legs
        WHERE ticket_id = $1
        ORDER BY leg_no ASC
        FOR UPDATE
      `, [ticket.id]);
      const legs = legResult.rows;
      if (!legs.length) {
        summary.manualReview += 1;
        continue;
      }

      const eventIds = legs.map(leg => leg.provider_event_id);
      const providerResults = await client.query(`
        SELECT provider_event_id,result_source,event_status,home_score,away_score,
               source_updated_at,received_at,verified,provider_payload
        FROM sportsbook_v2_event_results
        WHERE provider_event_id = ANY($1::text[])
        FOR SHARE
      `, [eventIds]);

      const evaluation = evaluateSportsbookTicketResults(legs, providerResults.rows);
      if (!evaluation.ready) {
        if (evaluation.manualReview) summary.manualReview += 1;
        else summary.waiting += 1;
        continue;
      }

      const settlementLegs = legs.map(leg => ({
        accepted_odds: leg.accepted_odds,
        resultStatus: evaluation.legStatuses.find(item => item.legId === leg.id)?.resultStatus
      }));
      const payout = calculateSportsbookSettlementPayout(
        Number(ticket.stake), evaluation.ticketStatus, settlementLegs
      );
      assert(payout <= Number(ticket.potential_payout) || evaluation.ticketStatus === "VOID", 500,
        "Payout settlement melebihi potensi payout saat diterima.", "SPORTSBOOK_SETTLEMENT_PAYOUT_EXCEEDS_ACCEPTED");

      let ledger;
      const profitReserve = Number(ticket.potential_payout) - Number(ticket.stake);
      assert(profitReserve >= 0, 500, "Cadangan payout tiket tidak valid.", "SPORTSBOOK_RISK_RESERVE_INVALID");

      if (evaluation.ticketStatus === "LOST") {
        ledger = await postSystemTransfer(client, {
          fromCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
          toCode: SYSTEM_ACCOUNTS.CLEARING,
          amount: Number(ticket.stake),
          type: "SPORTSBOOK_BET_LOST",
          referenceType: "SPORTSBOOK_TICKET_SETTLEMENT",
          referenceId: ticket.id,
          idempotencyKey: `sportsbook:settlement:${ticket.id}:lost-stake:v1`,
          metadata: { invoice: ticket.invoice, payout: 0 },
          actorId,
          requireFromAvailable: true
        });
        if (profitReserve > 0) {
          const released = await postSystemTransfer(client, {
            fromCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
            toCode: SYSTEM_ACCOUNTS.SPORTSBOOK_RISK_RESERVE,
            amount: profitReserve,
            type: "SPORTSBOOK_PAYOUT_RESERVE_RELEASE",
            referenceType: "SPORTSBOOK_TICKET_SETTLEMENT",
            referenceId: ticket.id,
            idempotencyKey: `sportsbook:settlement:${ticket.id}:reserve-release:v1`,
            metadata: { invoice: ticket.invoice, reason: "LOST", released: profitReserve },
            actorId,
            requireFromAvailable: true
          });
          assert(released?.duplicate !== true && released?.transactionId, 500,
            "Pelepasan risk reserve gagal.", "SPORTSBOOK_RISK_RESERVE_RELEASE_FAILED");
        }
      } else {
        ledger = await postTransfer(client, {
          memberId: ticket.member_id,
          systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
          memberDelta: payout,
          type: evaluation.ticketStatus === "VOID" ? "SPORTSBOOK_BET_VOID_REFUND" : "SPORTSBOOK_BET_PAYOUT",
          referenceType: "SPORTSBOOK_TICKET_SETTLEMENT",
          referenceId: ticket.id,
          idempotencyKey: `sportsbook:settlement:${ticket.id}:payout:v1`,
          metadata: { invoice: ticket.invoice, payout, resultStatus: evaluation.ticketStatus },
          actorId,
          requireSystemAvailable: true
        });
        const unusedReserve = Number(ticket.potential_payout) - payout;
        assert(unusedReserve >= 0, 500,
          "Payout melebihi cadangan tiket.", "SPORTSBOOK_RISK_RESERVE_UNDERFUNDED");
        if (unusedReserve > 0) {
          const released = await postSystemTransfer(client, {
            fromCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
            toCode: SYSTEM_ACCOUNTS.SPORTSBOOK_RISK_RESERVE,
            amount: unusedReserve,
            type: "SPORTSBOOK_PAYOUT_RESERVE_RELEASE",
            referenceType: "SPORTSBOOK_TICKET_SETTLEMENT",
            referenceId: ticket.id,
            idempotencyKey: `sportsbook:settlement:${ticket.id}:reserve-release:v1`,
            metadata: { invoice: ticket.invoice, reason: evaluation.ticketStatus, released: unusedReserve },
            actorId,
            requireFromAvailable: true
          });
          assert(released?.duplicate !== true && released?.transactionId, 500,
            "Pelepasan risk reserve gagal.", "SPORTSBOOK_RISK_RESERVE_RELEASE_FAILED");
        }
      }
      assert(ledger?.duplicate !== true && ledger?.transactionId, 500,
        "Settlement menemukan transaksi ledger duplikat yang tidak diharapkan.", "SPORTSBOOK_SETTLEMENT_LEDGER_CONFLICT");

      for (const item of evaluation.legStatuses) {
        const payload = evaluation.resultPayloads.find(value => value.legId === item.legId);
        await client.query(`
          UPDATE sportsbook_v2_ticket_legs
          SET result_status = $1, result_payload = $2::jsonb
          WHERE id = $3 AND ticket_id = $4 AND result_status = 'PENDING'
        `, [item.resultStatus, JSON.stringify(payload ?? {}), item.legId, ticket.id]);
      }

      const revisionNoResult = await client.query(`
        SELECT COALESCE(MAX(revision_no),0) + 1 AS revision_no
        FROM sportsbook_v2_settlement_revisions
        WHERE ticket_id = $1
      `, [ticket.id]);
      const revisionNo = Number(revisionNoResult.rows[0].revision_no);
      const resultRevisionIds = await loadResultRevisionIds(client, eventIds);
      const revisionId = randomUUID();
      await client.query(`
        INSERT INTO sportsbook_v2_settlement_revisions(
          id,ticket_id,revision_no,previous_status,new_status,payout_amount,
          ledger_transaction_id,result_revision_ids,actor_type,actor_id,reason,metadata
        ) VALUES($1,$2,$3,'OPEN',$4,$5,$6,$7::jsonb,'SYSTEM',$8,$9,$10::jsonb)
      `, [
        revisionId,ticket.id,revisionNo,evaluation.ticketStatus,payout,ledger.transactionId,
        JSON.stringify(resultRevisionIds),actorId,
        `PROVIDER_CONFIRMED_SOCCER_1X2_${evaluation.ticketStatus}`,
        JSON.stringify({
          invoice: ticket.invoice,
          legs: evaluation.legStatuses,
          resultPayloads: evaluation.resultPayloads
        })
      ]);

      const updated = await client.query(`
        UPDATE sportsbook_v2_tickets
        SET status = $1, settled_at = now(), settlement_ledger_transaction_id = $2
        WHERE id = $3 AND status = 'OPEN'
        RETURNING id
      `, [evaluation.ticketStatus,ledger.transactionId,ticket.id]);
      assert(updated.rowCount === 1, 500,
        "Status tiket berubah selama settlement.", "SPORTSBOOK_SETTLEMENT_STATE_CONFLICT");

      await audit({
        actorId, actorRole: "SYSTEM", action: "SPORTSBOOK_TICKET_SETTLED",
        targetType: "SPORTSBOOK_TICKET", targetId: ticket.id,
        details: {
          invoice: ticket.invoice, status: evaluation.ticketStatus,
          payout, settlementRevisionId: revisionId, ledgerTransactionId: ledger.transactionId,
          resultRevisionIds
        },
        client
      });
      summary.settled += 1;
      summary[evaluation.ticketStatus.toLowerCase()] += 1;
    }
    return summary;
  });
}

export const __sportsbookSettlement = {
  SUPPORTED_MARKET, SUPPORTED_RULE, SCALE
};


export async function listSportsbookResultCorrectionReviews({ limit = 50 } = {}) {
  const safeLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
  const result = await query(`
    SELECT t.id,t.invoice,t.status,t.review_reason,t.review_detected_at,
           t.reviewed_at,t.review_note,
           settlement.settled_results,
           COALESCE(jsonb_agg(jsonb_build_object(
             'eventId',l.provider_event_id,
             'home',e.home_name,
             'away',e.away_name,
             'market',l.provider_market_name,
             'selection',l.provider_outcome_name,
             'acceptedOdds',l.accepted_odds::text,
             'currentResult',jsonb_build_object(
               'status',r.event_status,'homeScore',r.home_score,
               'awayScore',r.away_score,'receivedAt',r.received_at
             )
           ) ORDER BY l.leg_no),'[]'::jsonb) AS legs
    FROM sportsbook_v2_tickets t
    JOIN sportsbook_v2_ticket_legs l ON l.ticket_id=t.id
    LEFT JOIN sportsbook_v2_events e ON e.provider_event_id=l.provider_event_id
    LEFT JOIN sportsbook_v2_event_results r ON r.provider_event_id=l.provider_event_id
    LEFT JOIN LATERAL (
      SELECT metadata->'resultPayloads' AS settled_results
      FROM sportsbook_v2_settlement_revisions sr
      WHERE sr.ticket_id=t.id
      ORDER BY sr.revision_no DESC
      LIMIT 1
    ) settlement ON TRUE
    WHERE t.review_required=TRUE
    GROUP BY t.id
    ORDER BY t.review_detected_at ASC
    LIMIT $1
  `, [safeLimit]);
  return { reviews: result.rows, limit: safeLimit };
}

export async function acknowledgeSportsbookResultCorrection({
  ticketId, actorId, note, financiallyReconciled
}) {
  assert(typeof ticketId === "string" && /^[0-9a-f-]{36}$/i.test(ticketId), 400,
    "ID tiket tidak valid.", "SPORTSBOOK_REVIEW_TICKET_ID_INVALID");
  assert(financiallyReconciled === true, 400,
    "Owner harus menyatakan rekonsiliasi finansial sudah dilakukan.", "SPORTSBOOK_REVIEW_FINANCIAL_ATTESTATION_REQUIRED");
  const cleanNote = String(note || "").trim();
  assert(cleanNote.length >= 30 && cleanNote.length <= 1000, 400,
    "Catatan rekonsiliasi wajib 30–1000 karakter.", "SPORTSBOOK_REVIEW_NOTE_INVALID");

  return tx(async client => {
    const current = await client.query(`
      SELECT id,invoice,review_required,review_reason
      FROM sportsbook_v2_tickets
      WHERE id=$1
      FOR UPDATE
    `, [ticketId]);
    assert(current.rows[0], 404, "Tiket tidak ditemukan.", "SPORTSBOOK_REVIEW_TICKET_NOT_FOUND");
    assert(current.rows[0].review_required === true, 409,
      "Tiket tidak sedang berada dalam antrean review.", "SPORTSBOOK_REVIEW_NOT_PENDING");

    const updated = await client.query(`
      UPDATE sportsbook_v2_tickets
      SET review_required=FALSE,reviewed_at=now(),reviewed_by=$2,review_note=$3
      WHERE id=$1 AND review_required=TRUE
      RETURNING id,invoice,reviewed_at
    `, [ticketId, actorId, cleanNote]);
    assert(updated.rowCount === 1, 409,
      "Tiket berubah saat review.", "SPORTSBOOK_REVIEW_STATE_CONFLICT");
    await audit({
      actorId, actorRole: "OWNER", action: "SPORTSBOOK_RESULT_CORRECTION_REVIEWED",
      targetType: "SPORTSBOOK_TICKET", targetId: ticketId,
      details: {
        invoice: current.rows[0].invoice,
        previousReason: current.rows[0].review_reason,
        financiallyReconciled: true,
        note: cleanNote
      },
      client
    });
    return updated.rows[0];
  });
}
