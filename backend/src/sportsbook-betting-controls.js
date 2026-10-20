import { config } from './config.js';
import { query, tx } from './db.js';
import { assert } from './errors.js';
import { audit } from './audit.js';

const SETTING_KEY = 'sportsbook.betting.acceptance';

async function storedSwitch(db, { lock = false } = {}) {
  const result = await db.query(
    `SELECT setting_value FROM system_settings WHERE setting_key=$1${lock ? ' FOR SHARE' : ''}`,
    [SETTING_KEY]
  );
  return result.rows[0]?.setting_value?.closed === true;
}

function assertOpen(closed) {
  assert(!closed, 409, 'Penerimaan taruhan sportsbook sedang dihentikan oleh operator.', 'SPORTSBOOK_BETTING_CLOSED');
}

export async function assertSportsbookBettingOpen(db = { query }, { lock = false } = {}) {
  assertOpen(config.sportsbookBettingKillSwitchEnabled);
  assertOpen(await storedSwitch(db, { lock }));
}

export async function sportsbookBettingSwitchStatus() {
  return {
    closed: config.sportsbookBettingKillSwitchEnabled || await storedSwitch({ query }),
    environmentKillSwitch: config.sportsbookBettingKillSwitchEnabled
  };
}

export async function setSportsbookBettingSwitch(session, input, { ip = '' } = {}) {
  assert(typeof input?.closed === 'boolean', 400, 'Status kill switch harus berupa boolean.', 'SPORTSBOOK_BETTING_SWITCH_INVALID');
  return tx(async client => {
    await client.query('SELECT setting_key FROM system_settings WHERE setting_key=$1 FOR UPDATE', [SETTING_KEY]);
    await client.query(`INSERT INTO system_settings(setting_key,setting_value,description,is_public,updated_by)
      VALUES($1,$2::jsonb,'Kill switch penerimaan tiket sportsbook',FALSE,$3)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,
        description=excluded.description,is_public=FALSE,updated_by=excluded.updated_by,updated_at=now()`,
    [SETTING_KEY, JSON.stringify({ closed: input.closed }), session.userId]);
    await audit({
      actorId: session.userId,
      actorRole: session.roles.join(','),
      action: input.closed ? 'SPORTSBOOK_BET_ACCEPTANCE_CLOSED' : 'SPORTSBOOK_BET_ACCEPTANCE_OPENED',
      targetType: 'SYSTEM_SETTING',
      targetId: SETTING_KEY,
      details: { closed: input.closed },
      ip,
      client
    });
    return {
      closed: config.sportsbookBettingKillSwitchEnabled || input.closed,
      environmentKillSwitch: config.sportsbookBettingKillSwitchEnabled
    };
  });
}
