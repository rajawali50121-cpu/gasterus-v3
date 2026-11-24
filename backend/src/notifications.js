import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { assert } from './errors.js';

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function createMemberNotification(client, {
  memberId,
  type,
  title,
  message,
  amount = null,
  referenceType = null,
  referenceId = null,
  actionUrl = null,
  priority = 'NORMAL',
  metadata = {}
}) {
  const id = randomUUID();
  const result = await client.query(`
    INSERT INTO member_notifications(
      id,member_id,notification_type,title,message,amount,
      reference_type,reference_id,action_url,priority,metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT(member_id,notification_type,reference_type,reference_id) DO NOTHING
    RETURNING *
  `, [
    id, memberId, clean(type, 50), clean(title, 140), clean(message, 700),
    amount === null ? null : Number(amount), clean(referenceType, 80) || null,
    clean(referenceId, 160) || null, clean(actionUrl, 240) || null,
    clean(priority, 20).toUpperCase(), JSON.stringify(metadata || {})
  ]);
  return result.rows[0] || null;
}

function mapNotification(row) {
  return {
    id: row.id,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    amount: row.amount === null ? null : Number(row.amount),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    actionUrl: row.action_url,
    priority: row.priority,
    metadata: row.metadata || {},
    read: Boolean(row.read_at),
    readAt: row.read_at,
    createdAt: row.created_at
  };
}

export async function listMemberNotifications(memberId, { limit = 40, unreadOnly = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const rows = await query(`
    SELECT * FROM member_notifications
    WHERE member_id=$1 AND ($2::boolean=FALSE OR read_at IS NULL)
    ORDER BY created_at DESC
    LIMIT $3
  `, [memberId, Boolean(unreadOnly), safeLimit]);
  const count = await query('SELECT COUNT(*)::int count FROM member_notifications WHERE member_id=$1 AND read_at IS NULL', [memberId]);
  return { items: rows.rows.map(mapNotification), unreadCount: Number(count.rows[0]?.count || 0) };
}

export async function markMemberNotificationRead(memberId, id) {
  const result = await query(`
    UPDATE member_notifications SET read_at=COALESCE(read_at,now())
    WHERE id=$1 AND member_id=$2
    RETURNING *
  `, [id, memberId]);
  assert(result.rows[0], 404, 'Notifikasi tidak ditemukan.', 'NOTIFICATION_NOT_FOUND');
  return mapNotification(result.rows[0]);
}

export async function markAllMemberNotificationsRead(memberId) {
  const result = await query('UPDATE member_notifications SET read_at=COALESCE(read_at,now()) WHERE member_id=$1 AND read_at IS NULL', [memberId]);
  return { updated: result.rowCount };
}

export async function memberGamingHistory(memberId, { limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const rows = await query(`
    SELECT * FROM (
      SELECT
        o.id,
        'TOGEL'::text AS game_type,
        o.invoice,
        o.market_name AS game_name,
        o.game_name AS bet_type,
        o.status,
        o.total_stake,
        o.total_payout AS payout,
        o.result_value AS result,
        o.balance_after,
        o.placed_at AS placed_at,
        o.settled_at,
        o.created_at
      FROM bet_orders o
      WHERE o.member_id=$1
    ) history
    ORDER BY created_at DESC
    LIMIT $2
  `, [memberId, safeLimit]);
  return rows.rows.map(row => ({
    id: row.id,
    gameType: row.game_type,
    invoice: row.invoice,
    gameName: row.game_name,
    betType: row.bet_type,
    status: row.status,
    totalStake: Number(row.total_stake),
    payout: Number(row.payout || 0),
    result: row.result,
    balanceAfter: row.balance_after === null ? null : Number(row.balance_after),
    placedAt: row.placed_at,
    settledAt: row.settled_at,
    createdAt: row.created_at
  }));
}
