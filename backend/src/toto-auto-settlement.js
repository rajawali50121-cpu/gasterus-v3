import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { audit } from './audit.js';

// Settlement TOTO otomatis.
//
// PlatformChloridehong mature membayar begitu result resmi terbit; operator tidak
// perlu menekan tombol. Modul ini membuat settlement_runs + job queue secara
// otomatis sehingga mesin settlement yang sudah ada (four-eyes owner tetap utuh
// untuk kasus VOID) yang melakukan pembayaran.
//
// Pengaman yang wajib:
//  1. Hanya pasar berstatus 'open'. Pasar yang ditutup/di-retire tidak dibayar.
//  2. Hanya result OFFICIAL:/CONSENSUS: (sumber tidak resmi diabaikan), dan
//     diverifikasi ulang di sini, bukan hanya di SQL.
//  3. Hanya periode yang jendela betting-nya sudah tutup.
//  4. Hanya order ACCEPTED/SETTLEMENT_PENDING. Order CANCELLED/VOID/DRAFT tidak.
//  5. FOR UPDATE pada baris config pasar + NOT EXISTS run -> dua siklus bersamaan
//     tidak mungkin membuat dua run untuk periode yang sama.
//  6. Result harus 4-6 digit, sama seperti format yang bisa dievaluasi engine.
//     Hasil di luar format itu dilewati (fail-closed), bukan dipaksakan.
//  7. Kill switch TOTO_AUTO_SETTLEMENT_ENABLED=false mematikan seluruh siklus ini
//     tanpa mengubah kode.
const AUTHORITATIVE_SOURCE=/^(OFFICIAL|CONSENSUS):/;
const SETTLEABLE_RESULT=/^\d{4,6}$/;

const CANDIDATE_SQL=`SELECT c.market_id,c.betting_period AS period,h.result,h.source_name,m.name,m.slug
FROM market_betting_configs c
JOIN markets m ON m.id=c.market_id
JOIN LATERAL (
  SELECT h2.result,h2.source_name FROM market_result_history h2
  WHERE h2.market_id=c.market_id AND h2.period=c.betting_period
    AND (h2.source_name LIKE 'OFFICIAL:%' OR h2.source_name LIKE 'CONSENSUS:%')
  ORDER BY h2.created_at DESC
  LIMIT 1
) h ON TRUE
WHERE m.status='open'
  AND m.verification_status='VERIFIED'
  AND c.betting_period IS NOT NULL AND btrim(c.betting_period)<>''
  AND c.close_at IS NOT NULL AND c.close_at<=now()
  AND EXISTS (SELECT 1 FROM bet_orders o WHERE o.market_id=c.market_id AND o.period=c.betting_period AND o.status IN('ACCEPTED','SETTLEMENT_PENDING'))
  AND NOT EXISTS (SELECT 1 FROM settlement_runs r WHERE r.market_id=c.market_id AND r.period=c.betting_period AND r.mode='SETTLE')
ORDER BY c.close_at
LIMIT $1`;

// CATCH-UP: periode yang SUDAH berganti betting_period.
//
// Jalur utama (CANDIDATE_SQL) sengaja berpatokan pada market_betting_configs.
// betting_period: begitu reconciler membuka periode berikutnya, baris itu tidak
// lagi cocok, sehingga order periode lama yang belum sempat di-queue akan hilang
// dari jangkauan forever — member menang tapi hadiah tidak pernah dibayar.
// Kueri ini mencari langsung dari bet_orders sehingga periode yang terlewat
// tetap tertangkap.
//
// Pengaman m.status='open' sengaja dipertahankan sesuai aturan produk: pasar yang
// sudah di-retire tidak dibayar lewat jalur otomatis. Kasus itu ditangani operator.
const CATCHUP_SQL=`SELECT o.market_id,o.period,h.result,h.source_name,m.name,m.slug
FROM bet_orders o
JOIN markets m ON m.id=o.market_id
JOIN LATERAL (
  SELECT h2.result,h2.source_name FROM market_result_history h2
  WHERE h2.market_id=o.market_id AND h2.period=o.period
    AND (h2.source_name LIKE 'OFFICIAL:%' OR h2.source_name LIKE 'CONSENSUS:%')
  ORDER BY h2.created_at DESC
  LIMIT 1
) h ON TRUE
WHERE m.status='open'
  AND m.verification_status='VERIFIED'
  AND o.period IS NOT NULL AND btrim(o.period)<>''
  AND o.status IN('ACCEPTED','SETTLEMENT_PENDING')
  AND NOT EXISTS (SELECT 1 FROM settlement_runs r WHERE r.market_id=o.market_id AND r.period=o.period AND r.mode='SETTLE')
ORDER BY o.period
LIMIT $1`;

// Satu-satunya jalan untuk membuat settlement_runs. Semua jalur (utama maupun
// catch-up) wajib lewat sini supaya pengaman tidak bisa bocor di salah satu sisi.
async function queueSettlementRun(client, { marketId, period, result, sourceName }) {
  const locked = await client.query('SELECT 1 FROM market_betting_configs WHERE market_id=$1 FOR UPDATE', [marketId]);
  if (!locked.rowCount) return false;
  const existing = await client.query(`SELECT 1 FROM settlement_runs WHERE market_id=$1 AND period=$2 AND mode='SETTLE' LIMIT 1`, [marketId, period]);
  if (existing.rowCount) return false;
  const runId = randomUUID();
  await client.query(
    `INSERT INTO settlement_runs(id,market_id,period,result_value,mode,status,requested_by,approved_by,started_at)
     VALUES($1,$2,$3,$4,'SETTLE','QUEUED',NULL,NULL,now())`,
    [runId, marketId, period, result]
  );
  await client.query(
    'INSERT INTO job_outbox(id,queue_name,payload) VALUES($1,$2,$3::jsonb)',
    [randomUUID(), config.queueName, JSON.stringify({ runId, mode: 'SETTLEMENT', marketId, period, result, source: 'AUTO' })]
  );
  await audit({
    actorId: null,
    actorRole: 'SYSTEM',
    action: 'SETTLEMENT_AUTO_QUEUED',
    targetType: 'SETTLEMENT_RUN',
    targetId: runId,
    details: { marketId, period, result, authoritySource: sourceName },
    client
  });
  return runId;
}

export async function autoSettleTotoPeriods({ limit = 20 } = {}) {
  if (!config.totoAutoSettlementEnabled) return { enabled: false, queued: 0, skipped: 0, checked: 0 };
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { rows } = await query(CANDIDATE_SQL, [cap]);
  const catchup = await query(CATCHUP_SQL, [cap]);
  // Gabungkan kedua sumber lalu dedupe per (market, periode) supaya periode yang
  // muncul di kedua kueri tidak di-queue dua kali.
  const merged = new Map();
  for (const row of [...rows, ...catchup.rows]) {
    const key = `${row.market_id}@${row.period}`;
    if (!merged.has(key)) merged.set(key, row);
  }
  const summary = { enabled: true, checked: merged.size, queued: 0, skipped: 0, catchUpFound: catchup.rows.length, periods: [] };
  for (const candidate of merged.values()) {
    const sourceName = String(candidate.source_name || '');
    const result = String(candidate.result || '').trim();
    if (!AUTHORITATIVE_SOURCE.test(sourceName) || !SETTLEABLE_RESULT.test(result)) {
      summary.skipped += 1;
      logger.warn('Auto settlement dilewati: sumber atau format result tidak memenuhi syarat', { market: candidate.slug, period: candidate.period, source: sourceName, result });
      continue;
    }
    const queued = await tx(async client => {
      // Kunci baris config pasar supaya dua siklus bersamaan tidak mungkin membuat
      // dua run settlement untuk periode yang sama.
      return Boolean(await queueSettlementRun(client, {
        marketId: candidate.market_id,
        period: candidate.period,
        result,
        sourceName
      }));
    }, { isolation: 'SERIALIZABLE' });
    if (queued) {
      summary.queued += 1;
      summary.periods.push({ market: candidate.slug, period: candidate.period, result });
    }
  }
  if (summary.catchUpFound) logger.warn('TOTO auto-settlement menemukan periode terlewat (betting_period sudah maju)', { periods: summary.catchUpFound });
  if (summary.queued) logger.info('TOTO auto-settlement queued', { queued: summary.queued, periods: summary.periods });
  return summary;
}