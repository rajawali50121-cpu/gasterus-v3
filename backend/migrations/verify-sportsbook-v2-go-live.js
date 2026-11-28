import pg from "pg";

const { Pool } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required for sportsbook migration verification");

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const requiredMigrations = [
  "045_sportsbook_v2_result_receipt_times.sql",
  "046_sportsbook_v2_bet_acceptance.sql",
  "047_sportsbook_v2_result_correction_review.sql"
];
const requiredIndexes = [
  "sportsbook_v2_event_results_received_at_idx",
  "sportsbook_v2_result_revisions_receipt_version_uq",
  "sportsbook_v2_prices_bet_freshness_idx",
  "sportsbook_v2_open_tickets_idx",
  "sportsbook_v2_ticket_review_queue_idx"
];

try {
  const columns = await pool.query(`
    SELECT required.table_name, required.column_name
    FROM (VALUES
      ('sportsbook_v2_event_results','received_at'),
      ('sportsbook_v2_prices','received_at'),
      ('sportsbook_v2_prices','change_log_verified_at'),
      ('sportsbook_v2_tickets','settlement_ledger_transaction_id'),
      ('sportsbook_v2_tickets','review_required'),
      ('sportsbook_v2_tickets','review_reason'),
      ('sportsbook_v2_tickets','review_detected_at'),
      ('sportsbook_v2_tickets','reviewed_at'),
      ('sportsbook_v2_tickets','reviewed_by'),
      ('sportsbook_v2_tickets','review_note'),
      ('sportsbook_v2_ticket_legs','provider_market_name'),
      ('sportsbook_v2_ticket_legs','provider_book_name'),
      ('sportsbook_v2_ticket_legs','provider_outcome_name'),
      ('sportsbook_v2_ticket_legs','provider_outcome_type'),
      ('sportsbook_v2_ticket_legs','price_received_at'),
      ('sportsbook_v2_ticket_legs','market_code'),
      ('sportsbook_v2_ticket_legs','outcome_code'),
      ('sportsbook_v2_ticket_legs','settlement_rule'),
      ('sportsbook_v2_ticket_legs','mapping_version'),
      ('sportsbook_v2_events','schedule_verified_at')
    ) AS required(table_name, column_name)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema='public'
      AND actual.table_name=required.table_name
      AND actual.column_name=required.column_name
    WHERE actual.column_name IS NULL
  `);
  if (columns.rows.length) {
    throw new Error(`Missing sportsbook migration columns: ${columns.rows.map(row => `${row.table_name}.${row.column_name}`).join(", ")}`);
  }

  const migrations = await pool.query(
    "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
    [requiredMigrations]
  );
  const applied = new Set(migrations.rows.map(row => row.version));
  const missingMigrations = requiredMigrations.filter(version => !applied.has(version));
  if (missingMigrations.length) throw new Error(`Missing sportsbook migrations: ${missingMigrations.join(", ")}`);

  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])",
    [requiredIndexes]
  );
  const existingIndexes = new Set(indexes.rows.map(row => row.indexname));
  const missingIndexes = requiredIndexes.filter(name => !existingIndexes.has(name));
  if (missingIndexes.length) throw new Error(`Missing sportsbook migration indexes: ${missingIndexes.join(", ")}`);

  console.log(JSON.stringify({
    status: "verified",
    migrations: requiredMigrations.length,
    columns: 20,
    indexes: requiredIndexes.length
  }));
} finally {
  await pool.end();
}
