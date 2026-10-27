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
export async function tx(fn, { isolation = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function checkDatabase() {
  const started = performance.now();
  const result = await query('SELECT now() AS now, current_database() AS database');
  return { ok: true, latencyMs: Math.round((performance.now()-started)*100)/100, ...result.rows[0] };
}
export async function closeDatabase() { await pool.end(); }
