import { query } from './db.js';
import { AppError } from './errors.js';
import { LOTTERY_GAMES, TOTO_ADVANCED_GAME_RATES, publicGameDefinition } from './lottery-games.js';
import { config } from './config.js';
import { logger } from './logger.js';

function bettingReadinessReason({ authorityReady, bettingStatus, bettingPeriod, closeAt }, now = Date.now()) {
  if (!authorityReady) return 'RESULT_AUTHORITY_NOT_READY';
  if (String(bettingStatus || '').toUpperCase() !== 'OPEN') return 'BETTING_NOT_OPEN';
  if (!String(bettingPeriod || '').trim()) return 'BETTING_PERIOD_NOT_READY';
  const closeMs = closeAt ? new Date(closeAt).getTime() : NaN;
  if (!Number.isFinite(closeMs)) return 'BETTING_CLOSE_NOT_READY';
  if (closeMs <= now) return 'BETTING_CLOSED';
  return null;
}

export function mapMarket(row,{includeHistorical=false}={}){
  const liveVerificationStatus=String(row.verification_status||'');
  const liveTrusted=['VERIFIED','MANUAL_RESOLUTION'].includes(liveVerificationStatus);
  // Single-source publication (display-only): angka asli dari 1 keluarga sumber boleh
  // ditampilkan; authority betting tetap butuh VERIFIED (authorityReady di bawah).
  const singleSourceDisplay=Boolean(config.totoPublishSingleSource)&&liveVerificationStatus==='SINGLE_SOURCE'&&/^\d{3,6}$/.test(String(row.result||''));
  const historyAvailable=includeHistorical&&!liveTrusted&&/^\d{3,6}$/.test(String(row.history_result||''));
  const resultTrusted=liveTrusted||historyAvailable||singleSourceDisplay;
  const candidate=liveTrusted?row.result:historyAvailable?row.history_result:row.result;
  const validNumericResult=/^\d{3,6}$/.test(String(candidate||''))?String(candidate):null;
  const result=resultTrusted?validNumericResult:null;
  const period=liveTrusted?row.period:historyAvailable?row.history_period:row.period;
  const drawDate=liveTrusted?row.draw_date:historyAvailable?row.history_draw_date:row.draw_date;
  const drawTime=liveTrusted?row.draw_time:historyAvailable?row.history_draw_time:row.draw_time;
  const sourceUpdatedAt=liveTrusted?row.source_updated_at:historyAvailable?(row.history_source_updated_at||row.history_created_at):row.source_updated_at;
  const rawBettingStatus=String(row.betting_status||'SUSPENDED').toUpperCase();
  const bettingPeriod=String(row.betting_period||'').trim()||null;
  const closeAt=row.close_at||null;
  const closeMs=closeAt?new Date(closeAt).getTime():NaN;
  // Real-time status: jika closeAt sudah lewati, status selalu CLOSED terlepas dari DB
  const bettingStatus = (rawBettingStatus === 'OPEN' && Number.isFinite(closeMs) && closeMs <= Date.now()) ? 'CLOSED' : rawBettingStatus;
  const authorityReady=liveVerificationStatus==='VERIFIED';
  const readinessReason=bettingReadinessReason({authorityReady,bettingStatus,bettingPeriod,closeAt});
  const bettingReady=readinessReason===null;
  // `stale` hanya boleh true ketika TIDAK ada hasil terpercaya DAN sumbernya basi.
  // Hasil VERIFIED / histori resmi tidak pernah stale — pasaran harian hanya berubah
  // saat undian, jadi threshold waktu (dulu 10 menit) selalu salah menandai stale
  // dan memicu label "MENUNGGU VERIFIKASI" yang tidak relevan bagi member.
  const stale=!resultTrusted&&(!sourceUpdatedAt||Date.now()-new Date(sourceUpdatedAt).getTime()>93600000);
  return {slug:row.slug,code:row.code,name:row.name,result,period,category:row.category,tags:row.tags||[],status:row.status,sortOrder:row.sort_order,sourceUpdatedAt,updatedAt:row.updated_at,stale,verificationStatus:historyAvailable?'VERIFIED_HISTORY':liveVerificationStatus,liveVerificationStatus,resultTrusted,resultHistorical:historyAvailable,drawDate,drawTime,lastCheckedAt:row.source_updated_at,bettingStatus,bettingPeriod,closeAt,authorityReady,bettingReady,readinessReason};
}
// ---------------------------------------------------------------------------
// Auto-open scheduler: membuka kembali pasaran harian untuk periode berikutnya.
// Latar belakang: startMarketCloseScheduler (app.js) hanya MENUTUP (CLOSED)
// ketika close_at lewat; tidak ada mekanisme MEMBUKA pasaran untuk periode
// berikutnya, sehingga pasaran tertutup tetap tertutup selamanya sampai
// migrasi SQL manual dijalankan (021/022/023). Fungsi ini melengkapi siklusnya.
//
// Asumsi jadwal (berdasarkan pola data live production 2026-09 + migrasi 021/023):
//   1. Pasaran TOTO di sini harian -> closeAt periode berikutnya = closeAt
//      sebelumnya + 24 jam (di-loop maju sampai > now). Pola ini persis seperti
//      KING KONG 4D / HONGKONG POOL (closeAt bergeser +24h tiap hari).
//   2. bettingPeriod = tanggal UTC dari closeAt baru (mis. closeAt
//      2026-09-20T09:43Z <-> bettingPeriod '2026-09-20', seperti data OPEN).
//   3. Hanya pasaran VERIFIED (authority siap) dan m.status='open' yang dibuka
//      (sesuai pola migrasi 021/022; otomatis mengecualikan NZ regional pools
//      yang memang dinonaktifkan produk via migrasi 020, status 'closed').
//   4. Pasaran SUSPENDED dengan close_at NULL dan betting_period NULL tidak
//      bisa disimpulkan jadwalnya -> dibiarkan (dicatat di log, tidak diubah).
//   5. Baris dengan auto_cash_window=TRUE DIMILIKI reconciler
//      (reconcileCashBettingWindows) dan TIDAK boleh disentuh scheduler ini.
//      Tanpa filter ini keduanya menulis betting_period ke baris yang sama:
//      reconciler memakai periode dari histori hasil terverifikasi, sedangkan
//      scheduler memakai tanggal hasil hitung ulang dari close_at. Akibatnya
//      periode berganti-ganti tiap menit. Scheduler hanya menangani pasar yang
//      belum dikelola oleh machinery cash-window otomatis.
let marketOpenInterval = null;
export async function runMarketOpenCheck() {
  try {
    const { rows } = await query(
      `SELECT c.market_id, m.slug, m.name, c.betting_status, c.betting_period, c.close_at
         FROM market_betting_configs c
         JOIN markets m ON m.id = c.market_id
        WHERE c.betting_status IN ('CLOSED','SUSPENDED')
          AND COALESCE(c.auto_reopen_blocked, FALSE) = FALSE
          AND COALESCE(c.auto_cash_window, FALSE) = FALSE
          AND m.status = 'open'
          AND m.verification_status = 'VERIFIED'
          AND (c.close_at IS NOT NULL OR (c.betting_period IS NOT NULL AND btrim(c.betting_period) <> ''))`
    );
    if (!rows.length) return;
    const now = Date.now();
    const opened = [];
    for (const row of rows) {
      // Hitung closeAt periode berikutnya.
      let nextCloseMs = NaN;
      if (row.close_at) {
        let t = new Date(row.close_at).getTime();
        if (!Number.isFinite(t) || t > now) continue; // jadwal valid / belum waktunya buka
        while (t <= now) t += 24 * 3600 * 1000; // loop maju per 24 jam (pasaran harian)
        nextCloseMs = t;
      } else {
        // Fallback: pakai betting_period sebagai tanggal draw; tutup akhir hari
        // UTC tanggal tersebut (pola migrasi 021: current_date + 1 day - 1 sec).
        const d = new Date(`${String(row.betting_period).trim()}T00:00:00Z`).getTime();
        if (!Number.isFinite(d)) continue;
        nextCloseMs = d + 24 * 3600 * 1000 - 1000;
        if (nextCloseMs <= now) continue; // periode itu sendiri sudah lewat total
      }
      const nextClose = new Date(nextCloseMs).toISOString();
      const nextPeriod = nextClose.slice(0, 10); // YYYY-MM-DD (tanggal UTC, pola data OPEN)
      await query(
        `UPDATE market_betting_configs
            SET betting_status='OPEN', betting_period=$2, close_at=$3,
                updated_by=NULL, updated_at=now()
          WHERE market_id=$1
            AND betting_status IN ('CLOSED','SUSPENDED')`,
        [row.market_id, nextPeriod, nextClose]
      );
      opened.push({ slug: row.slug, from: row.betting_status, period: nextPeriod, closeAt: nextClose });
    }
    if (opened.length) {
      logger.info('Auto-opened markets for next period', { count: opened.length, markets: opened });
    }
  } catch (err) {
    logger.error('Market open scheduler error', { error: err.message });
  }
}
export function startMarketOpenScheduler(intervalMs = 60000) {
  if (!config.marketAutoOpenEnabled) {
    logger.info('Market open scheduler disabled', { flag: 'MARKET_AUTO_OPEN_ENABLED=false' });
    return () => {};
  }
  if (marketOpenInterval) clearInterval(marketOpenInterval);
  runMarketOpenCheck();
  marketOpenInterval = setInterval(runMarketOpenCheck, intervalMs);
  logger.info('Market open scheduler started', { intervalMs });
  return () => { if (marketOpenInterval) { clearInterval(marketOpenInterval); marketOpenInterval = null; } };
}
export async function listMarkets({category,q,limit=100,offset=0,includeHistorical=false}={}){
  const values=[];const where=[];
  if(category){values.push(category);where.push(`category=$${values.length}`)}
  if(q){values.push(`%${String(q).slice(0,80)}%`);where.push(`name ILIKE $${values.length}`)}
  // Hide deactivated (NZ regional) pools from the active catalog. market_betting_configs
  // has no `status` column, so `status` is unambiguous here in both SELECT and COUNT.
  where.push("status<>'closed'");
  values.push(Math.min(Math.max(Number(limit)||100,1),100));const lp=values.length;values.push(Math.max(Number(offset)||0,0));const op=values.length;
  const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
  const bettingJoin=`LEFT JOIN market_betting_configs c ON c.market_id=m.id`;
  const historyJoin=includeHistorical?`LEFT JOIN LATERAL (SELECT h.result AS history_result,h.period AS history_period,h.draw_date AS history_draw_date,h.draw_time AS history_draw_time,h.source_updated_at AS history_source_updated_at,h.created_at AS history_created_at FROM market_result_history h WHERE h.market_id=m.id AND (h.source_name LIKE 'OFFICIAL:%' OR h.source_name LIKE 'CONSENSUS:%' OR h.source_name='APPROVED_RESULT') ORDER BY h.draw_date DESC NULLS LAST,h.draw_time DESC NULLS LAST,h.created_at DESC LIMIT 1) hist ON TRUE`:'';
  const select=includeHistorical?'m.*,c.betting_status,c.betting_period,c.close_at,hist.*':'m.*,c.betting_status,c.betting_period,c.close_at';
  const qualifiedClause=clause.replace(/\bcategory=/g,'m.category=').replace(/\bname ILIKE/g,'m.name ILIKE');
  const [items,total]=await Promise.all([query(`SELECT ${select} FROM markets m ${bettingJoin} ${historyJoin} ${qualifiedClause} ORDER BY m.sort_order LIMIT $${lp} OFFSET $${op}`,values),query(`SELECT COUNT(*)::int AS count FROM markets ${clause}`,values.slice(0,-2))]);
  return {items:items.rows.map(row=>mapMarket(row,{includeHistorical})),total:total.rows[0].count};
}

export async function memberLotteryResultDetails(identifier,periodValue=null){
  const value=String(identifier||'').slice(0,180);
  const market=(await query(`SELECT id,period,verification_status FROM markets WHERE slug=$1 OR id::text=$1 LIMIT 1`,[value])).rows[0];
  if(!market)throw new AppError(404,'Pasaran tidak ditemukan.','MARKET_NOT_FOUND');
  if(!['VERIFIED','MANUAL_RESOLUTION'].includes(String(market.verification_status||'')))return null;
  const period=String(periodValue||market.period||'').slice(0,80);
  const detail=(await query(`SELECT period,first_prize,second_prize,third_prize,special_numbers,consolation_numbers,updated_at,verification_status FROM market_result_details WHERE market_id=$1 AND period=$2`,[market.id,period])).rows[0]||null;
  if(!detail||!['VERIFIED','MANUAL_RESOLUTION'].includes(String(detail.verification_status||'')))return null;
  return {period:detail.period,first_prize:detail.first_prize,second_prize:detail.second_prize,third_prize:detail.third_prize,special_numbers:detail.special_numbers,consolation_numbers:detail.consolation_numbers,updated_at:detail.updated_at};
}
export async function marketByIdentifier(identifier,client=null){const db=client||{query};const value=String(identifier||'').slice(0,180);const {rows}=await db.query(`SELECT * FROM markets WHERE slug=$1 OR provider_path=$1 OR id::text=$1 LIMIT 1`,[value]);if(!rows[0])throw new AppError(404,'Pasaran tidak ditemukan.','MARKET_NOT_FOUND');return rows[0];}

async function ensureLotteryConfigs(db,marketId){
  const advanced=LOTTERY_GAMES.filter(x=>!x.defaultEnabled).map(x=>x.code);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_2D',TRUE,discount_2d,payout_2d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1 ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_3D',TRUE,discount_3d,payout_3d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1 ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_4D',TRUE,discount_4d,payout_4d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1 ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'POSITION_2D_FRONT',TRUE,28,65,max_stake_per_item FROM market_betting_configs WHERE market_id=$1 ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'POSITION_2D_MIDDLE',TRUE,28,65,max_stake_per_item FROM market_betting_configs WHERE market_id=$1 ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  // Advanced games that the settlement engine truly supports (engineReady, has a
  // defined UI mode, and do not require operator-specific options like shio labels).
  // They are seeded live so members can bet immediately; operators can still tune
  // discount/payout via lottery-control. Rates live in lottery-games.js because they
  // are derived from the settlement probabilities, not from a static price list.
  const ADVANCED_DEFAULT = TOTO_ADVANCED_GAME_RATES;
  const seedable=LOTTERY_GAMES.filter(x=>ADVANCED_DEFAULT[x.code]&&x.engineReady&&!x.requiresOptions&&x.uiMode!=='unsupported');
  if(seedable.length){
    const values=seedable.map(x=>`('${x.code}',${ADVANCED_DEFAULT[x.code].discountPercent},${ADVANCED_DEFAULT[x.code].payoutMultiplier})`).join(',');
    await db.query(`UPDATE lottery_game_configs SET enabled=TRUE, discount_percent=v.d, payout_multiplier=v.p
      FROM (VALUES ${values}) AS v(game_code,d,p)
      WHERE market_id=$1 AND v.game_code=lottery_game_configs.game_code AND lottery_game_configs.payout_multiplier=0`,[marketId]);
  }
}

export async function bettingConfig(identifier,client=null){
  const db=client||{query};const m=await marketByIdentifier(identifier,client);await db.query(`INSERT INTO market_betting_configs(market_id,betting_status) VALUES($1,'SUSPENDED') ON CONFLICT(market_id) DO NOTHING`,[m.id]);await ensureLotteryConfigs(db,m.id);
  const {rows}=await db.query(`SELECT c.*,m.slug,m.code,m.name,m.provider_path,m.period AS result_period,m.status AS source_status,m.verification_status AS result_verification_status FROM market_betting_configs c JOIN markets m ON m.id=c.market_id WHERE m.id=$1`,[m.id]);
  const games=(await db.query(`SELECT * FROM lottery_game_configs WHERE market_id=$1`,[m.id])).rows;
  return mapConfig(rows[0],games);
}
export function mapConfig(r,games=[]){
  const byCode=new Map(games.map(g=>[g.game_code,g]));
  const gameList=LOTTERY_GAMES.map(def=>{const g=byCode.get(def.code);return {...publicGameDefinition(def),enabled:Boolean(g?.enabled),discountPercent:Number(g?.discount_percent||0),payoutMultiplier:Number(g?.payout_multiplier||0),maxStakePerSelection:Number(g?.max_stake_per_selection||0),selectionOptions:Array.isArray(g?.selection_options)?g.selection_options:[]};});
  const authorityReady=String(r.result_verification_status||'')==='VERIFIED';
  const closeMs=r.close_at?new Date(r.close_at).getTime():NaN;
  const rawBettingStatus=String(r.betting_status||'SUSPENDED').toUpperCase();
  // Real-time status: jika closeAt sudah lewati, status selalu CLOSED terlepas dari DB
  const bettingStatus = (rawBettingStatus === 'OPEN' && Number.isFinite(closeMs) && closeMs <= Date.now()) ? 'CLOSED' : rawBettingStatus;
  const readinessReason=bettingReadinessReason({authorityReady,bettingStatus,bettingPeriod:r.betting_period,closeAt:r.close_at});
  const bettingReady=readinessReason===null;
  return {marketId:r.market_id,slug:r.slug,code:r.code,name:r.name,providerPath:r.provider_path,period:r.betting_period||null,resultPeriod:r.result_period||null,bettingStatus,closeAt:r.close_at,authorityReady,bettingReady,readinessReason,minStake:Number(r.min_stake),maxStakePerItem:Number(r.max_stake_per_item),maxOrderTotal:Number(r.max_order_total),maxPayoutPerOrder:Number(r.max_payout_per_order||2000000000),maxRows:r.max_rows,cancelWindowSeconds:r.cancel_window_seconds,discounts:{'2D':r.discount_2d,'3D':r.discount_3d,'4D':r.discount_4d},payouts:{'2D':r.payout_2d,'3D':r.payout_3d,'4D':r.payout_4d},games:gameList,updatedAt:r.updated_at};
}
export async function listBettingMarkets({status,q,limit=200}={}){const values=[];const where=[];if(status){values.push(String(status).toUpperCase());where.push(`c.betting_status=$${values.length}`)}if(q){values.push(`%${String(q).slice(0,80)}%`);where.push(`m.name ILIKE $${values.length}`)}values.push(Math.min(Number(limit)||200,500));const clause=where.length?`WHERE ${where.join(' AND ')}`:'';await query(`INSERT INTO market_betting_configs(market_id,betting_status) SELECT id,'SUSPENDED' FROM markets ON CONFLICT DO NOTHING`);const result=await query(`SELECT c.*,m.slug,m.code,m.name,m.provider_path,m.period AS result_period,m.status AS source_status,m.verification_status AS result_verification_status FROM market_betting_configs c JOIN markets m ON m.id=c.market_id ${clause} ORDER BY m.sort_order LIMIT $${values.length}`,values);const output=[];for(const row of result.rows){await ensureLotteryConfigs({query},row.market_id);const games=(await query(`SELECT * FROM lottery_game_configs WHERE market_id=$1`,[row.market_id])).rows;output.push(mapConfig(row,games));}return output;}
