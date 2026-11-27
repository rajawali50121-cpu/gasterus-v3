import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tx, closeDatabase } from '../src/db.js';
import { ensureSystemAccounts } from '../src/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(HERE, '../data/markets.seed.json');
const markets = JSON.parse(await readFile(dataPath, 'utf8'));

await tx(async client => {
  await ensureSystemAccounts(client);
  for (const m of markets) {
    await client.query(`
      INSERT INTO markets(slug, code, name, result, period, draw_date, category, tags, status, provider_path, source_key, sort_order, verification_status, source_updated_at)
      VALUES($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9, $10, $11, $12, $13, now())
      ON CONFLICT(provider_path) DO UPDATE SET
        slug = EXCLUDED.slug,
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        result = EXCLUDED.result,
        period = COALESCE(EXCLUDED.period, markets.period),
        draw_date = COALESCE(EXCLUDED.draw_date, markets.draw_date),
        category = EXCLUDED.category,
        tags = EXCLUDED.tags,
        status = EXCLUDED.status,
        source_key = EXCLUDED.source_key,
        sort_order = EXCLUDED.sort_order,
        verification_status = EXCLUDED.verification_status,
        source_updated_at = now()
      WHERE COALESCE(NULLIF(BTRIM(markets.result), ''), '----') = '----'
        AND UPPER(BTRIM(markets.verification_status)) NOT IN ('VERIFIED', 'MANUAL_RESOLUTION', 'RETIRED')
    `, [
      m.slug, m.code, m.name, m.result || '0000', m.period || '1001',
      m.drawDate || '2026-09-07', m.category, JSON.stringify(m.tags || []),
      m.status, m.providerPath, m.sourceKey, m.sortOrder, m.verificationStatus || 'UNMAPPED'
    ]);
  }
  await client.query(`INSERT INTO market_betting_configs(market_id) SELECT id FROM markets ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection) SELECT market_id,'STRAIGHT_2D',TRUE,discount_2d,payout_2d,max_stake_per_item FROM market_betting_configs ON CONFLICT(market_id,game_code) DO NOTHING`);
  await client.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection) SELECT market_id,'STRAIGHT_3D',TRUE,discount_3d,payout_3d,max_stake_per_item FROM market_betting_configs ON CONFLICT(market_id,game_code) DO NOTHING`);
  await client.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection) SELECT market_id,'STRAIGHT_4D',TRUE,discount_4d,payout_4d,max_stake_per_item FROM market_betting_configs ON CONFLICT(market_id,game_code) DO NOTHING`);
  await client.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection) SELECT c.market_id,g.game_code,FALSE,0,0,c.max_stake_per_item FROM market_betting_configs c CROSS JOIN (VALUES ('POSITION_2D_FRONT'),('POSITION_2D_MIDDLE'),('COLOK_BEBAS'),('COLOK_2D'),('COLOK_NAGA'),('COLOK_JITU'),('TENGAH_TEPI'),('DASAR'),('SILANG_HOMO'),('KEMBANG_KEMPIS'),('KOMBINASI'),('SHIO'),('MACAU_SHIO'),('FIFTY_GENERAL')) AS g(game_code) ON CONFLICT(market_id,game_code) DO NOTHING`);
});
console.log(JSON.stringify({ seededMarkets: markets.length, runId: randomUUID() }));
await closeDatabase();