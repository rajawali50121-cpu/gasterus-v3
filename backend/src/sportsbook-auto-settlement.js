import { query } from './db.js';
import { logger } from './logger.js';
import { sportsbookSettlementSnapshot } from './sportsbook-feed.js';
import { settleSportsbookTicketAutomatic } from './sportsbook-betting.js';
import { evaluateSportsbookLeg } from './sportsbook-result-evaluator.js';
import { fetchSportmonksFixtureById } from './sportsbook-providers.js';

const finishedFixtureCache = new Map();
const FINISHED_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadFinishedFixtureEvent(eventId) {
  const cached = finishedFixtureCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < FINISHED_CACHE_TTL_MS) return cached.event;
  try {
    const result = await fetchSportmonksFixtureById(eventId);
    const event = result?.event || null;
    if (event) finishedFixtureCache.set(eventId, { event, fetchedAt: Date.now() });
    return event;
  } catch (error) {
    logger.warn('Sportsbook finished fixture fetch failed', { eventId, error: error.message });
    return null;
  }
}

export async function autoSettleSportsbookTickets({ limit = 200 } = {}) {
  const open = await query(`
    SELECT DISTINCT t.id
    FROM sportsbook_tickets t
    JOIN sportsbook_legs l ON l.ticket_id=t.id
    WHERE t.status='OPEN' AND ((l.market_period='1H' AND l.event_start < now() - interval '40 minutes') OR (l.market_period<>'1H' AND l.event_start < now() - interval '75 minutes'))
    ORDER BY t.id
    LIMIT $1
  `, [Math.min(Math.max(Number(limit) || 200, 1), 500)]);
  if (!open.rowCount) return { checked: 0, settled: 0, skipped: 0 };

  let snapshot = null;
  try { snapshot = await sportsbookSettlementSnapshot(); } catch (error) { logger.warn('Settlement snapshot unavailable', { error: error.message }); }
  const events = new Map(snapshot ? snapshot.events.map(event => [event.id, event]) : []);

  let settled = 0;
  let skipped = 0;

  for (const ticketRow of open.rows) {
    try {
      const legsResult = await query('SELECT * FROM sportsbook_legs WHERE ticket_id=$1 ORDER BY leg_no', [ticketRow.id]);
      const distinctEventIds = [...new Set(legsResult.rows.map(leg => String(leg.event_id)))];
      for (const eventId of distinctEventIds) {
        if (events.has(eventId)) continue;
        const finishedEvent = await loadFinishedFixtureEvent(eventId);
        if (finishedEvent && String(finishedEvent.state || '').toUpperCase() === 'FINISHED') {
          events.set(eventId, finishedEvent);
        }
      }

      const results = [];
      let ready = true;
      for (const leg of legsResult.rows) {
        const evaluated = evaluateSportsbookLeg(leg, events.get(leg.event_id));
        if (!evaluated) { ready = false; break; }
        results.push({ legNo: Number(leg.leg_no), ...evaluated });
      }
      if (!ready || !results.length) { skipped += 1; continue; }
      await settleSportsbookTicketAutomatic(ticketRow.id, results, {
        feedRevision: snapshot?.feedRevision || null,
        sourceName: snapshot?.sourceName || 'AUTO_RESULT_AUTHORITY',
        reason: 'Automatic HT/FT settlement from authoritative live-feed snapshot.'
      });
      settled += 1;
    } catch (error) {
      skipped += 1;
      logger.warn('Sportsbook auto-settlement skipped ticket', { ticketId: ticketRow.id, error: error.message });
    }
  }
  return { checked: open.rowCount, settled, skipped, feedFetchedAt: snapshot?.fetchedAt, feedRevision: snapshot?.feedRevision || null, settlementSources: snapshot?.settlementSources || [] };
}
