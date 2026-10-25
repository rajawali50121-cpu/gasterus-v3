import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';
import { configurePostgresTypeParsers } from './postgres-types.js';
const { Pool, types } = pg;
// BIGINT values are safe here because all configured limits remain below Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, value => Number(value));
// Keep PostgreSQL DATE values as YYYY-MM-DD strings. DATE is a calendar value, not an instant.
configurePostgresTypeParsers(types);
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL_OVERRIDE || config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  application_name: 'gasterus-core'
});
pool.on('error', error => logger.error('Unexpected PostgreSQL pool error', { error: error.message }));
export const query = (text, values = []) => pool.query(text, values);
const DEADLOCK_ERROR_CODE = '40P01';
const MAX_DEADLOCK_RETRIES = 3;
const DEADLOCK_RETRY_BASE_MS = 50;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ALLOWED_ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

export async function tx(fn, { isolation = 'READ COMMITTED' } = {}) {
  if (ALLOWED_ISOLATION_LEVELS.has(isolation) === false) {
    throw new Error('Unsupported transaction isolation level: ' + isolation);
  }
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    let retryDelay = 0;
    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      // Deadlock retries rerun the entire callback, so it must keep side effects transactional.
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const isDeadlock = error.code === DEADLOCK_ERROR_CODE
        || error.message?.includes('deadlock detected');
      if (!isDeadlock || attempt >= MAX_DEADLOCK_RETRIES) {
        throw error;
      }
      retryDelay = DEADLOCK_RETRY_BASE_MS * (2 ** attempt);
      logger.warn('Deadlock detected; retrying complete database transaction', {
        attempt: attempt + 1,
        maxRetries: MAX_DEADLOCK_RETRIES,
        delay: retryDelay
      });
    } finally {
      client.release();
    }
    await sleep(retryDelay);
  }
}
export async function checkDatabase() {
  const started = performance.now();
  const result = await query('SELECT now() AS now, current_database() AS database');
  return { ok: true, latencyMs: Math.round((performance.now()-started)*100)/100, ...result.rows[0] };
}
export async function closeDatabase() { await pool.end(); }
