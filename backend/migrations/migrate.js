import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool, closeDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';

const dir = resolve(process.cwd(), 'migrations');
const files = (await readdir(dir)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const lockName = 'gasterus-schema-migrations-v2';

function unwrapTransaction(sql) {
  let body = String(sql).replace(/^\s*BEGIN\s*;\s*/i, '');
  body = body.replace(/\s*COMMIT\s*;\s*$/i, '');
  return body.trim();
}

const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);

  for (const file of files) {
    const table = await client.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    if (table.rows[0].table_name) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
      if (done.rowCount) continue;
    }

    const raw = await readFile(resolve(dir, file), 'utf8');
    const sql = unwrapTransaction(raw);
    if (!sql) throw new Error(`Migration ${file} is empty`);

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
      );
      await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      logger.info('Migration applied', { file });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {});
  client.release();
  await closeDatabase();
}
