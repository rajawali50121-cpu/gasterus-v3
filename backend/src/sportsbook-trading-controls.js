import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { audit } from './audit.js';
import { AppError, assert } from './errors.js';
import {
  normalizeSportsbookTradingScope,
  sportsbookTradingScopeKey,
  tradingPolicyFromControls,
  applySportsbookTradingControls
} from './sportsbook-trading-policy.js';

const CACHE_MS = 1000;
let cache = { loadedAt: 0, rows: [] };

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function nullablePositiveInteger(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_000_000_000, 400, `${label} tidak valid.`, 'SPORTSBOOK_TRADING_LIMIT_INVALID');
  return parsed;
}
function nullableExpiry(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp) && timestamp > Date.now(), 400, 'Masa berlaku trading control tidak valid.', 'SPORTSBOOK_TRADING_EXPIRY_INVALID');
  return new Date(timestamp).toISOString();
}
function mapRow(row) {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    scopeType: row.scope_type,
    eventId: row.event_id,
    marketId: row.market_id || null,
    selectionId: row.selection_id || null,
    suspended: Boolean(row.suspended),
    maxStake: row.max_stake === null || row.max_stake === undefined ? null : Number(row.max_stake),
    maxLiability: row.max_liability === null || row.max_liability === undefined ? null : Number(row.max_liability),
    reason: row.reason || null,
    expiresAt: row.expires_at || null,
    version: Number(row.version || 1),
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}
function controlPublicState(value) {
  const mapped = value?.scope_key ? mapRow(value) : value;
  if (!mapped) return null;
  return {
    id: mapped.id,
    scopeKey: mapped.scopeKey,
    scopeType: mapped.scopeType,
    eventId: mapped.eventId,
    marketId: mapped.marketId,
    selectionId: mapped.selectionId,
    suspended: mapped.suspended,
    maxStake: mapped.maxStake,
    maxLiability: mapped.maxLiability,
    reason: mapped.reason,
    expiresAt: mapped.expiresAt,
    version: mapped.version,
    updatedAt: mapped.updatedAt
  };
}
function invalidateCache() { cache = { loadedAt: 0, rows: [] }; }

export { sportsbookTradingScopeKey, tradingPolicyFromControls, applySportsbookTradingControls };

export async function listActiveSportsbookTradingControls({ eventId = '', limit = 1000 } = {}) {
  const now = Date.now();
  if (!eventId && cache.loadedAt && now - cache.loadedAt <= CACHE_MS) return cache.rows.slice(0, limit);
  const values = [];
  const where = ['(expires_at IS NULL OR expires_at > now())'];
  if (eventId) {
    values.push(clean(eventId, 120));
    where.push(`event_id=$${values.length}`);
  }
  values.push(Math.min(Math.max(Number(limit) || 1000, 1), 5000));
  const { rows } = await query(`SELECT * FROM sportsbook_trading_controls WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
  const mapped = rows.map(mapRow);
  if (!eventId) cache = { loadedAt: now, rows: mapped };
  return mapped;
}

export async function listSportsbookTradingControlHistory({ scopeKey = '', limit = 100 } = {}) {
  const values = [];
  const where = [];
  if (scopeKey) {
    values.push(clean(scopeKey, 500));
    where.push(`scope_key=$${values.length}`);
  }
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await query(`SELECT * FROM sportsbook_trading_control_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
  return rows.map(row => ({
    id: row.id,
    controlId: row.control_id || null,
    scopeKey: row.scope_key,
    action: row.action,
    actorId: row.actor_id || null,
    previousState: row.previous_state || null,
    nextState: row.next_state || null,
    reason: row.reason || null,
    createdAt: row.created_at
  }));
}

export async function resolveSportsbookTradingPolicy(identity) {
  const controls = await listActiveSportsbookTradingControls();
  return tradingPolicyFromControls(controls, identity);
}

export async function upsertSportsbookTradingControl(session, input, { ip = '' } = {}) {
  const identity = normalizeSportsbookTradingScope(input);
  const scopeKey = sportsbookTradingScopeKey(identity);
  const suspended = input.suspended === true;
  const maxStake = nullablePositiveInteger(input.maxStake, 'Batas stake');
  const maxLiability = nullablePositiveInteger(input.maxLiability, 'Batas liability');
  const expiresAt = nullableExpiry(input.expiresAt);
  const reason = clean(input.reason, 500) || null;
  assert(suspended || maxStake !== null || maxLiability !== null || input.suspended === false, 400, 'Trading control tidak memiliki perubahan.', 'SPORTSBOOK_TRADING_CONTROL_EMPTY');

  const result = await tx(async client => {
    const currentResult = await client.query('SELECT * FROM sportsbook_trading_controls WHERE scope_key=$1 FOR UPDATE', [scopeKey]);
    const current = currentResult.rows[0] || null;
    const id = current?.id || randomUUID();
    const nextResult = await client.query(`INSERT INTO sportsbook_trading_controls(
      id,scope_key,scope_type,event_id,market_id,selection_id,suspended,max_stake,max_liability,reason,expires_at,version,updated_by
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)
    ON CONFLICT(scope_key) DO UPDATE SET
      suspended=EXCLUDED.suspended,
      max_stake=EXCLUDED.max_stake,
      max_liability=EXCLUDED.max_liability,
      reason=EXCLUDED.reason,
      expires_at=EXCLUDED.expires_at,
      version=sportsbook_trading_controls.version+1,
      updated_by=EXCLUDED.updated_by,
      updated_at=now()
    RETURNING *`, [
      id, scopeKey, identity.scopeType, identity.eventId, identity.marketId, identity.selectionId,
      suspended, maxStake, maxLiability, reason, expiresAt, session.userId
    ]);
    const next = nextResult.rows[0];
    await client.query(`INSERT INTO sportsbook_trading_control_history(id,control_id,scope_key,action,actor_id,previous_state,next_state,reason)
      VALUES($1,$2,$3,'UPSERT',$4,$5::jsonb,$6::jsonb,$7)`, [
      randomUUID(), next.id, scopeKey, session.userId,
      current ? JSON.stringify(controlPublicState(current)) : null,
      JSON.stringify(controlPublicState(next)), reason
    ]);
    await audit({
      actorId: session.userId,
      actorRole: (session.roles || []).join(','),
      action: suspended ? 'SPORTSBOOK_TRADING_SUSPEND_OR_LIMIT' : 'SPORTSBOOK_TRADING_REOPEN_OR_LIMIT',
      targetType: 'SPORTSBOOK_TRADING_CONTROL',
      targetId: next.id,
      details: { scopeKey, scopeType: identity.scopeType, suspended, maxStake, maxLiability, expiresAt, reason },
      ip,
      client
    });
    return mapRow(next);
  }, { isolation: 'SERIALIZABLE' });
  invalidateCache();
  return result;
}

export async function clearSportsbookTradingControl(session, id, { ip = '' } = {}) {
  const controlId = clean(id, 80);
  assert(controlId, 400, 'Trading control ID wajib diisi.', 'SPORTSBOOK_TRADING_CONTROL_ID_REQUIRED');
  const result = await tx(async client => {
    const currentResult = await client.query('SELECT * FROM sportsbook_trading_controls WHERE id=$1 FOR UPDATE', [controlId]);
    const current = currentResult.rows[0];
    if (!current) throw new AppError(404, 'Trading control tidak ditemukan.', 'SPORTSBOOK_TRADING_CONTROL_NOT_FOUND');
    await client.query('DELETE FROM sportsbook_trading_controls WHERE id=$1', [controlId]);
    await client.query(`INSERT INTO sportsbook_trading_control_history(id,control_id,scope_key,action,actor_id,previous_state,next_state,reason)
      VALUES($1,$2,$3,'CLEAR',$4,$5::jsonb,NULL,$6)`, [
      randomUUID(), current.id, current.scope_key, session.userId, JSON.stringify(controlPublicState(current)), clean(current.reason, 500) || null
    ]);
    await audit({
      actorId: session.userId,
      actorRole: (session.roles || []).join(','),
      action: 'SPORTSBOOK_TRADING_CONTROL_CLEARED',
      targetType: 'SPORTSBOOK_TRADING_CONTROL',
      targetId: current.id,
      details: { scopeKey: current.scope_key, scopeType: current.scope_type },
      ip,
      client
    });
    return { id: current.id, scopeKey: current.scope_key, cleared: true };
  }, { isolation: 'SERIALIZABLE' });
  invalidateCache();
  return result;
}

export const __sportsbookTradingControls = {
  normalizeSportsbookTradingScope,
  tradingPolicyFromControls,
  applySportsbookTradingControls
};
