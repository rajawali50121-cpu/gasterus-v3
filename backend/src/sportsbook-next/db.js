import pg from "pg";

const connectionString = String(process.env.DATABASE_URL || process.env.DATABASE_URL_OVERRIDE || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required for the sportsbook worker");

const pool = new pg.Pool({
  connectionString,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: String(process.env.DATABASE_SSL || "").toLowerCase() === "true" ? { rejectUnauthorized: false } : undefined,
  application_name: "gasterus-sportsbook-v2"
});
pool.on("error", error => process.stderr.write(JSON.stringify({
  ts: new Date().toISOString(), level: "error",
  message: "Sportsbook v2 PostgreSQL pool error", code: error?.code || "PG_POOL_ERROR"
})+"\n"));

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function closeDatabase() { await pool.end(); }
