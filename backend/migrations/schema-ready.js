import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool, closeDatabase } from '../src/db.js';
import { createClient } from 'redis';
import { config } from '../src/config.js';

const migrationDir = resolve(process.cwd(), 'migrations');
const expected = (await readdir(migrationDir)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } });

try {
  const table = await pool.query("SELECT to_regclass('public.schema_migrations') AS table_name");
  if (!table.rows[0].table_name) throw new Error('schema_migrations table is missing; pre-deploy migration did not run');
  const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const appliedSet = new Set(applied.rows.map(row => row.version));
  const missing = expected.filter(file => !appliedSet.has(file));
  if (missing.length) throw new Error(`Missing database migrations: ${missing.join(', ')}`);

  const requiredTables = ['users','markets','ledger_accounts','ledger_transactions','ledger_entries','wallet_requests','payment_methods','money_transaction_events','payment_provider_events'];
  const existing = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`, [requiredTables]);
  const tableSet = new Set(existing.rows.map(row => row.tablename));
  const missingTables = requiredTables.filter(name => !tableSet.has(name));
  if (missingTables.length) throw new Error(`Required tables missing: ${missingTables.join(', ')}`);

  await redis.connect();
  if (await redis.ping() !== 'PONG') throw new Error('Redis readiness check failed');
  console.log(JSON.stringify({ status:'ready', migrations: expected.length, postgres:true, redis:true }));
} finally {
  await Promise.allSettled([
    closeDatabase(),
    redis.isOpen ? redis.quit() : Promise.resolve()
  ]);
}
