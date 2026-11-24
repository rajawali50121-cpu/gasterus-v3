import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { logger } from './logger.js';

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function recordSportsbookProviderTransitions(transitions = [], context = {}) {
  const changed = transitions.filter(Boolean);
  if (!changed.length) return { recorded: 0 };
  let recorded = 0;
  for (const transition of changed) {
    try {
      const reason = transition.lastError
        ? clean(transition.lastError)
        : transition.bettingAllowed
          ? 'Provider recovered and passed betting readiness gate.'
          : transition.state === 'OPEN_CIRCUIT'
            ? 'Provider circuit opened after consecutive transport failures.'
            : transition.state === 'RECOVERING'
              ? 'Provider recovery probe succeeded; confirmation streak still required.'
              : transition.state === 'DEGRADED'
                ? 'Provider transport degraded; markets fail closed until recovery.'
                : transition.state === 'DISABLED'
                  ? 'Provider disabled by configuration.'
                  : 'Provider lifecycle state changed.';
      await query(`INSERT INTO sportsbook_provider_incidents(
        id,provider_code,previous_state,state,previous_betting_allowed,betting_allowed,transport_healthy,pricing_ready,failure_streak,success_streak,reason,details
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`, [
        randomUUID(), transition.providerCode, transition.previousState || null, transition.state,
        Boolean(transition.previousBettingAllowed), Boolean(transition.bettingAllowed), Boolean(transition.transportHealthy), Boolean(transition.pricingReady),
        Number(transition.failureStreak || 0), Number(transition.successStreak || 0), reason,
        JSON.stringify({
          nextProbeAt: transition.nextProbeAt || null,
          occurredAt: transition.occurredAt ? new Date(transition.occurredAt).toISOString() : new Date().toISOString(),
          feedReason: context.reason || null,
          feedRevision: context.feedRevision || null,
          pricedMarkets: Number(context.pricedMarkets || 0),
          bettableMarkets: Number(context.bettableMarkets || 0)
        })
      ]);
      recorded += 1;
    } catch (error) {
      // Observability must never take the betting feed down. Predeploy runs the
      // migration before production traffic, but this remains fail-safe during rollouts.
      logger.warn('Sportsbook provider transition persistence failed', {
        provider: transition.providerCode,
        state: transition.state,
        error: error.message
      });
    }
  }
  return { recorded };
}

export async function listSportsbookProviderIncidents({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 10), 500);
  const { rows } = await query(`SELECT * FROM sportsbook_provider_incidents ORDER BY created_at DESC LIMIT $1`, [safeLimit]);
  return rows.map(row => ({
    id: row.id,
    providerCode: row.provider_code,
    previousState: row.previous_state,
    state: row.state,
    previousBettingAllowed: row.previous_betting_allowed,
    bettingAllowed: row.betting_allowed,
    transportHealthy: row.transport_healthy,
    pricingReady: row.pricing_ready,
    failureStreak: row.failure_streak,
    successStreak: row.success_streak,
    reason: row.reason,
    details: row.details || {},
    createdAt: row.created_at
  }));
}

function exactInteger(value) {
  const text = String(value ?? '0');
  return /^-?\d+$/.test(text) ? text : '0';
}

export async function sportsbookRiskExposureSummary() {
  const [total, events, markets, selections] = await Promise.all([
    query(`SELECT COUNT(*)::int open_tickets,
      COALESCE(SUM(total_stake),0)::bigint open_stake,
      COALESCE(SUM(potential_payout),0)::bigint open_potential_payout
      FROM sportsbook_tickets WHERE status='OPEN'`),
    query(`SELECT event_id,league,home_team,away_team,COUNT(*)::int tickets,COALESCE(SUM(potential_payout),0)::bigint liability
      FROM (
        SELECT DISTINCT l.event_id,t.id,t.potential_payout,l.league,l.home_team,l.away_team
        FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id
        WHERE t.status='OPEN'
      ) x
      GROUP BY event_id,league,home_team,away_team
      ORDER BY liability DESC LIMIT 10`),
    query(`SELECT event_id,market_type,market_period,market_line,COUNT(*)::int tickets,COALESCE(SUM(potential_payout),0)::bigint liability
      FROM (
        SELECT DISTINCT l.event_id,l.market_type,l.market_period,COALESCE(l.market_line,'') market_line,t.id,t.potential_payout
        FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id
        WHERE t.status='OPEN'
      ) x
      GROUP BY event_id,market_type,market_period,market_line
      ORDER BY liability DESC LIMIT 10`),
    query(`SELECT event_id,market_type,market_period,market_line,selection_label,COUNT(*)::int tickets,COALESCE(SUM(potential_payout),0)::bigint liability
      FROM (
        SELECT DISTINCT l.event_id,l.market_type,l.market_period,COALESCE(l.market_line,'') market_line,l.selection_label,t.id,t.potential_payout
        FROM sportsbook_tickets t JOIN sportsbook_legs l ON l.ticket_id=t.id
        WHERE t.status='OPEN'
      ) x
      GROUP BY event_id,market_type,market_period,market_line,selection_label
      ORDER BY liability DESC LIMIT 10`)
  ]);
  const summary = total.rows[0] || {};
  return {
    openTickets: Number(summary.open_tickets || 0),
    openStake: exactInteger(summary.open_stake),
    openPotentialPayout: exactInteger(summary.open_potential_payout),
    topEvents: events.rows.map(row => ({
      eventId: row.event_id,
      league: row.league,
      home: row.home_team,
      away: row.away_team,
      tickets: Number(row.tickets || 0),
      liability: exactInteger(row.liability)
    })),
    topMarkets: markets.rows.map(row => ({
      eventId: row.event_id,
      marketType: row.market_type,
      period: row.market_period,
      line: row.market_line || null,
      tickets: Number(row.tickets || 0),
      liability: exactInteger(row.liability)
    })),
    topSelections: selections.rows.map(row => ({
      eventId: row.event_id,
      marketType: row.market_type,
      period: row.market_period,
      line: row.market_line || null,
      selection: row.selection_label,
      tickets: Number(row.tickets || 0),
      liability: exactInteger(row.liability)
    }))
  };
}

export async function recordSportsbookMarketTransitions(transitions = [], context = {}) {
  const changed = transitions.filter(Boolean);
  if (!changed.length) return { recorded: 0 };
  let recorded = 0;
  for (const transition of changed) {
    try {
      const lifecycleId = randomUUID();
      await query(`INSERT INTO sportsbook_market_lifecycle(
        id,scope_key,event_id,market_id,state,reopen_success_streak,reason,provider_source,last_observation_token,last_reopen_observation_at,last_seen_at,last_state_change_at,version,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10::double precision>0 THEN to_timestamp($10/1000.0) ELSE NULL END,to_timestamp($11/1000.0),to_timestamp($12/1000.0),1,now())
      ON CONFLICT(scope_key) DO UPDATE SET
        state=EXCLUDED.state,
        reopen_success_streak=EXCLUDED.reopen_success_streak,
        reason=EXCLUDED.reason,
        provider_source=EXCLUDED.provider_source,
        last_observation_token=EXCLUDED.last_observation_token,
        last_reopen_observation_at=EXCLUDED.last_reopen_observation_at,
        last_seen_at=EXCLUDED.last_seen_at,
        last_state_change_at=EXCLUDED.last_state_change_at,
        version=sportsbook_market_lifecycle.version+1,
        updated_at=now()`, [
        lifecycleId, transition.key, transition.eventId, transition.marketId, transition.state,
        Number(transition.reopenSuccessStreak || 0), clean(transition.reason || transition.action, 160),
        transition.source || null, transition.lastObservationToken || null, Number(transition.lastReopenObservationAt || 0),
        Number(transition.occurredAt || Date.now()), Number(transition.occurredAt || Date.now())
      ]);
      await query(`INSERT INTO sportsbook_market_lifecycle_history(
        id,scope_key,event_id,market_id,action,previous_state,state,reason,provider_source,feed_revision,details,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,to_timestamp($12/1000.0))`, [
        randomUUID(), transition.key, transition.eventId, transition.marketId, transition.action,
        transition.previousState || null, transition.state, clean(transition.reason || transition.action, 160),
        transition.source || null, context.feedRevision || null,
        JSON.stringify({
          feedReason: context.reason || null,
          reopenSuccessStreak: Number(transition.reopenSuccessStreak || 0),
          pricedMarkets: Number(context.pricedMarkets || 0),
          bettableMarkets: Number(context.bettableMarkets || 0)
        }),
        Number(transition.occurredAt || Date.now())
      ]);
      recorded += 1;
    } catch (error) {
      logger.warn('Sportsbook market lifecycle persistence failed', {
        eventId: transition.eventId,
        marketId: transition.marketId,
        state: transition.state,
        error: error.message
      });
    }
  }
  return { recorded };
}

export async function listSportsbookMarketLifecycleHistory({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 10), 500);
  const { rows } = await query(`SELECT * FROM sportsbook_market_lifecycle_history ORDER BY created_at DESC LIMIT $1`, [safeLimit]);
  return rows.map(row => ({
    id: row.id,
    scopeKey: row.scope_key,
    eventId: row.event_id,
    marketId: row.market_id,
    action: row.action,
    previousState: row.previous_state,
    state: row.state,
    reason: row.reason,
    providerSource: row.provider_source,
    feedRevision: row.feed_revision,
    details: row.details || {},
    createdAt: row.created_at
  }));
}

export async function sportsbookSettlementRevisionSummary({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 200);
  const [summary, recent] = await Promise.all([
    query(`SELECT
      COUNT(*) FILTER (WHERE action='SETTLE')::int settled_revisions,
      COUNT(*) FILTER (WHERE action='ROLLBACK')::int rollbacks,
      COUNT(*) FILTER (WHERE action='CANCEL')::int cancellations,
      COUNT(*) FILTER (WHERE status='PENDING_FUNDS')::int pending_funds,
      COALESCE(SUM(payout_delta),0)::bigint payout_delta
      FROM sportsbook_settlement_revisions`),
    query(`SELECT id,ticket_id,revision_no,action,status,previous_ticket_status,next_ticket_status,previous_payout,next_payout,payout_delta,reason,source_feed_revision,created_at,completed_at
      FROM sportsbook_settlement_revisions ORDER BY created_at DESC LIMIT $1`, [safeLimit])
  ]);
  const row = summary.rows[0] || {};
  return {
    settledRevisions: Number(row.settled_revisions || 0),
    rollbacks: Number(row.rollbacks || 0),
    cancellations: Number(row.cancellations || 0),
    pendingFunds: Number(row.pending_funds || 0),
    payoutDelta: exactInteger(row.payout_delta),
    recent: recent.rows.map(item => ({
      id: item.id,
      ticketId: item.ticket_id,
      revisionNo: Number(item.revision_no || 0),
      action: item.action,
      status: item.status,
      previousTicketStatus: item.previous_ticket_status,
      nextTicketStatus: item.next_ticket_status,
      previousPayout: exactInteger(item.previous_payout),
      nextPayout: exactInteger(item.next_payout),
      payoutDelta: exactInteger(item.payout_delta),
      reason: item.reason,
      sourceFeedRevision: item.source_feed_revision,
      createdAt: item.created_at,
      completedAt: item.completed_at
    }))
  };
}

export async function sportsbookPricingExposureSnapshot({ limit = 5000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 100), 10000);
  const { rows } = await query(`SELECT l.event_id,l.market_id,l.selection_id,l.selection_label,
      COUNT(DISTINCT t.id)::int tickets,COALESCE(SUM(t.potential_payout),0)::bigint liability
    FROM sportsbook_tickets t
    JOIN sportsbook_legs l ON l.ticket_id=t.id
    WHERE t.status='OPEN'
    GROUP BY l.event_id,l.market_id,l.selection_id,l.selection_label
    HAVING COALESCE(SUM(t.potential_payout),0) > 0
    ORDER BY liability DESC
    LIMIT $1`, [safeLimit]);
  return rows.map(row => ({
    eventId: row.event_id,
    marketId: row.market_id,
    selectionId: row.selection_id,
    selectionLabel: row.selection_label,
    tickets: Number(row.tickets || 0),
    liability: exactInteger(row.liability)
  }));
}
