import { randomUUID } from 'node:crypto';
import { checkDatabase, closeDatabase, query } from '../src/db.js';
import { connectRedis, checkRedis, closeRedis, redis } from '../src/redis.js';
import { verifyLedger } from '../src/ledger.js';

const report = {
  database: null,
  redis: null,
  markets: 0,
  systemAccounts: 0,
  privilegedUsers: 0,
  ledgerBalanced: false,
  redisNx: false,
  fourEyesConstraint: false,
  appendOnlyAudit: false
};

try {
  report.database = await checkDatabase();
  await connectRedis();
  report.redis = await checkRedis();

  report.markets = Number((await query('SELECT COUNT(*)::int AS count FROM markets')).rows[0].count);
  report.systemAccounts = Number((await query(
    `SELECT COUNT(*)::int AS count FROM ledger_accounts WHERE account_type='SYSTEM'`
  )).rows[0].count);
  report.privilegedUsers = Number((await query(
    `SELECT COUNT(DISTINCT u.id)::int AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id=u.id
     WHERE ur.role_code IN ('OWNER','SUPERVISOR') AND u.mfa_enabled=true`
  )).rows[0].count);

  const ledger = await verifyLedger({ query });
  report.ledgerBalanced = ledger.balanced;

  const redisKey = `integration-smoke:${randomUUID()}`;
  const first = await redis.set(redisKey, '1', { NX: true, EX: 30 });
  const second = await redis.set(redisKey, '2', { NX: true, EX: 30 });
  report.redisNx = first === 'OK' && second === null;
  await redis.del(redisKey);

  const owner = (await query(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id=u.id
     WHERE ur.role_code='OWNER'
     ORDER BY u.created_at LIMIT 1`
  )).rows[0];
  if (!owner) throw new Error('OWNER account was not bootstrapped');

  try {
    await query(
      `INSERT INTO approval_requests(
         id,action_type,payload,requested_by,approved_by,status,expires_at
       ) VALUES($1,'INTEGRATION_CHECK','{}'::jsonb,$2,$2,'APPROVED',now()+interval '5 minutes')`,
      [randomUUID(), owner.id]
    );
  } catch (error) {
    report.fourEyesConstraint = error.code === '23514';
  }

  const auditId = randomUUID();
  await query(
    `INSERT INTO audit_logs(id,actor_id,actor_role,action,target_type,target_id,details)
     VALUES($1,$2,'OWNER','INTEGRATION_CHECK','SYSTEM',$1,'{}'::jsonb)`,
    [auditId, owner.id]
  );
  try {
    await query(`UPDATE audit_logs SET action='MUTATED' WHERE id=$1`, [auditId]);
  } catch (error) {
    report.appendOnlyAudit = /append-only/i.test(String(error.message));
  }

  const required = {
    markets: report.markets === 85,
    systemAccounts: report.systemAccounts >= 3,
    privilegedUsers: report.privilegedUsers >= 2,
    ledgerBalanced: report.ledgerBalanced,
    redisNx: report.redisNx,
    fourEyesConstraint: report.fourEyesConstraint,
    appendOnlyAudit: report.appendOnlyAudit
  };
  const failed = Object.entries(required).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Integration checks failed: ${failed.join(', ')}`);

  console.log(JSON.stringify({ status: 'passed', ...report }, null, 2));
} finally {
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
}
