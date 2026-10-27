import { randomUUID } from 'node:crypto';
import { query, tx } from './db.js';
import { AppError, assert } from './errors.js';
import { bettingConfig, listBettingMarkets, marketByIdentifier } from './markets.js';
import { postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { audit } from './audit.js';
import { LOTTERY_GAME_MAP, TOTO_STANDARD_RULES, calculateLotteryPricing, legacyGameCode, normalizeLotterySelection, publicGameDefinition } from './lottery-games.js';
import { enforceResponsiblePlay } from './responsible-play.js';
import { bettingWindowReady } from './toto-betting-window.js';

const clean=(v,max=160)=>String(v??'').trim().slice(0,max);
function invoice(){return `A7B-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}-${randomUUID().slice(0,8).toUpperCase()}`;}

async function ensureLotteryGameConfigs(marketId,client){
  const db=client||{query};
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_2D',TRUE,discount_2d,payout_2d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_3D',TRUE,discount_3d,payout_3d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'STRAIGHT_4D',TRUE,discount_4d,payout_4d,max_stake_per_item FROM market_betting_configs WHERE market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'POSITION_2D_FRONT',TRUE,28,65,max_stake_per_item FROM market_betting_configs WHERE market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT market_id,'POSITION_2D_MIDDLE',TRUE,28,65,max_stake_per_item FROM market_betting_configs WHERE market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId]);
  const advanced=[...LOTTERY_GAME_MAP.values()].filter(x=>!x.defaultEnabled).map(x=>x.code);
  if(advanced.length){await db.query(`INSERT INTO lottery_game_configs(market_id,game_code,enabled,discount_percent,payout_multiplier,max_stake_per_selection)
    SELECT $1,x,FALSE,0,0,c.max_stake_per_item FROM unnest($2::text[]) AS x CROSS JOIN market_betting_configs c WHERE c.market_id=$1
    ON CONFLICT(market_id,game_code) DO NOTHING`,[marketId,advanced]);}
}

async function configInTx(marketId,client){
  await client.query("INSERT INTO market_betting_configs(market_id,betting_status) VALUES($1,'SUSPENDED') ON CONFLICT DO NOTHING",[marketId]);
  await ensureLotteryGameConfigs(marketId,client);
  const {rows}=await client.query(`SELECT c.*,m.slug,m.code,m.name,m.provider_path,m.period AS result_period,m.verification_status AS result_verification_status FROM market_betting_configs c JOIN markets m ON m.id=c.market_id WHERE c.market_id=$1 FOR UPDATE OF c`,[marketId]);
  const r=rows[0];
  const games=(await client.query(`SELECT * FROM lottery_game_configs WHERE market_id=$1 ORDER BY game_code`,[marketId])).rows;
  const gameMap=new Map(games.map(g=>[g.game_code,{gameCode:g.game_code,enabled:Boolean(g.enabled),discount:Number(g.discount_percent),payoutMultiplier:Number(g.payout_multiplier),maxStakePerSelection:Number(g.max_stake_per_selection),selectionOptions:Array.isArray(g.selection_options)?g.selection_options:[]} ]));
  const authorityReady=String(r.result_verification_status||'')==='VERIFIED';
  const closeMs=r.close_at?new Date(r.close_at).getTime():NaN;
  const rawBettingStatus=String(r.betting_status||'SUSPENDED').toUpperCase();
  // Real-time status: jika closeAt sudah lewati, status selalu CLOSED terlepas dari DB
  const bettingStatus = (rawBettingStatus === 'OPEN' && Number.isFinite(closeMs) && closeMs <= Date.now()) ? 'CLOSED' : rawBettingStatus;
  return{marketId:r.market_id,slug:r.slug,code:r.code,name:r.name,providerPath:r.provider_path,period:r.betting_period||null,resultPeriod:r.result_period||null,bettingStatus,closeAt:r.close_at,authorityReady,minStake:Number(r.min_stake),maxStakePerItem:Number(r.max_stake_per_item),maxOrderTotal:Number(r.max_order_total),maxPayoutPerOrder:Number(r.max_payout_per_order||2000000000),maxRows:r.max_rows,cancelWindowSeconds:r.cancel_window_seconds,gameMap};
}

function assertOpen(config,inputPeriod){
  assert(config.bettingStatus==='OPEN',409,'Pasaran sedang tidak menerima input angka.','MARKET_NOT_OPEN');
  assert(config.authorityReady===true,409,'Authority hasil pasaran belum siap. Pasaran otomatis ditahan untuk mencegah settlement tanpa sumber terverifikasi.','RESULT_AUTHORITY_NOT_READY');
  assert(config.period,409,'Periode betting belum ditetapkan.','BETTING_PERIOD_NOT_READY');
  const betPeriod=String(config.period||'').slice(0,10), resultPeriod=String(config.resultPeriod||'').slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}$/.test(betPeriod)&&/^\d{4}-\d{2}-\d{2}$/.test(resultPeriod)) assert(betPeriod>resultPeriod,409,'Periode betting tidak boleh sama atau lebih lama dari hasil terakhir.','BETTING_PERIOD_ALREADY_RESULTED');
  assert(config.closeAt,409,'Waktu tutup betting belum ditetapkan.','BETTING_CLOSE_NOT_READY');
  assert(new Date(config.closeAt).getTime()>Date.now(),409,'Waktu input angka untuk pasaran ini sudah ditutup.','MARKET_CLOSED');
  if(inputPeriod)assert(clean(inputPeriod,80)===String(config.period),409,'Periode pada halaman sudah berubah.','STALE_PERIOD');
}
async function assertPeriodUnsettled(client,marketId,period){
  const found=(await client.query(`SELECT 1 FROM market_result_history WHERE market_id=$1 AND period=$2 AND (source_name LIKE 'OFFICIAL:%' OR source_name LIKE 'CONSENSUS:%') LIMIT 1`,[marketId,String(period)])).rows[0];
  assert(!found,409,'Hasil untuk periode ini sudah tersedia. Betting ditutup sebelum saldo didebit.','BETTING_PERIOD_ALREADY_RESULTED');
}

async function selectionExposure(client,{marketId,period,gameCode,selectionValue,defaultLimit}){
  const override=(await client.query(`SELECT max_stake,status FROM lottery_selection_limits WHERE market_id=$1 AND period=$2 AND game_code=$3 AND selection_value=$4`,[marketId,period,gameCode,selectionValue])).rows[0];
  const current=Number((await client.query(`SELECT COALESCE(SUM(i.stake_after_discount),0)::bigint AS stake FROM bet_items i JOIN bet_orders o ON o.id=i.order_id WHERE o.market_id=$1 AND o.period=$2 AND o.wallet_mode='CASH' AND o.status IN ('ACCEPTED','SETTLEMENT_PENDING') AND i.game_code=$3 AND i.selection_value=$4`,[marketId,period,gameCode,selectionValue])).rows[0]?.stake||0);
  const limit=override?Number(override.max_stake):Number(defaultLimit||0);const forcedStatus=override?.status||'OPEN';
  const remaining=limit>0?Math.max(0,limit-current):null;
  const availability=forcedStatus==='SUSPENDED'?'SUSPENDED':forcedStatus==='SOLD_OUT'||remaining===0?'SOLD_OUT':forcedStatus==='LIMITED'||(remaining!==null&&remaining<limit*.25)?'LIMITED':'OPEN';
  return{current,limit,remaining,status:availability};
}

async function normalizeRows(inputRows,config,client,{checkExposure=true}={}){
  assert(Array.isArray(inputRows)&&inputRows.length>0,400,'Minimal satu baris pilihan wajib diisi.','BET_ROWS_REQUIRED');
  assert(inputRows.length<=config.maxRows,400,`Maksimal ${config.maxRows} baris per pesanan.`,'BET_ROWS_LIMIT');
  const seen=new Set();let total=0;let potentialPayout=0;const rows=[];
  for(let index=0;index<inputRows.length;index++){
    const raw=inputRows[index]||{};const legacyType=clean(raw.type,4).toUpperCase();const gameCode=clean(raw.gameCode||legacyGameCode(legacyType),40).toUpperCase();const game=LOTTERY_GAME_MAP.get(gameCode);
    assert(game,400,`Jenis permainan baris ${index+1} tidak dikenal.`,'BET_TYPE_INVALID');
    const gameConfig=config.gameMap.get(gameCode);assert(gameConfig,409,`${game.label} belum dikonfigurasi untuk pasaran ini.`,'LOTTERY_GAME_CONFIG_MISSING');
    assert(game.engineReady,409,`${game.label} belum memiliki kontrak settlement aktif.`,'LOTTERY_GAME_NOT_READY');
    assert(gameConfig.enabled&&gameConfig.payoutMultiplier>0,409,`${game.label} belum dibuka oleh operator.`,'LOTTERY_GAME_DISABLED');
    if(game.requiresOptions)assert(Array.isArray(gameConfig.selectionOptions)&&gameConfig.selectionOptions.length===12,409,'Mapping Shio untuk periode ini belum lengkap.','LOTTERY_SHIO_MAP_REQUIRED');
    const selection=normalizeLotterySelection(gameCode,raw.selection??raw.number);
    const amount=Number(raw.amount);assert(Number.isSafeInteger(amount)&&amount>=config.minStake&&amount<=config.maxStakePerItem,400,`Nominal baris ${index+1} harus antara ${config.minStake} dan ${config.maxStakePerItem}.`,'BET_AMOUNT_INVALID');
    const key=`${gameCode}:${selection}`;assert(!seen.has(key),409,`Pilihan ${game.label} ${selection} terduplikasi.`,'BET_DUPLICATE_LINE');seen.add(key);
    const discount=Number(gameConfig.discount||0);const payoutMultiplier=Number(gameConfig.payoutMultiplier);const pricing=calculateLotteryPricing(amount,discount,payoutMultiplier,Number(game.maxPayoutFactor||1));const stake=pricing.stake;const rowPayout=pricing.potentialPayout;
    let exposure={current:0,limit:Number(gameConfig.maxStakePerSelection||0),remaining:null,status:'OPEN'};
    if(checkExposure){exposure=await selectionExposure(client,{marketId:config.marketId,period:String(config.period),gameCode,selectionValue:selection,defaultLimit:gameConfig.maxStakePerSelection});assert(!['SUSPENDED','SOLD_OUT'].includes(exposure.status),409,`${game.label} ${selection} sedang ${exposure.status==='SOLD_OUT'?'sold out':'ditangguhkan'}.`,'LOTTERY_SELECTION_UNAVAILABLE');if(exposure.remaining!==null)assert(stake<=exposure.remaining,409,`Batas penerimaan ${game.label} ${selection} tersisa ${exposure.remaining}.`,'LOTTERY_SELECTION_LIMIT');}
    total+=stake;potentialPayout+=rowPayout;rows.push({type:game.baseType,gameCode,selection,number:selection,amount,discount,stake,payoutMultiplier,potentialPayout:rowPayout,exposure});
  }
  assert(total<=config.maxOrderTotal,400,`Total pesanan melebihi batas ${config.maxOrderTotal}.`,'BET_TOTAL_LIMIT');
  assert(potentialPayout<=config.maxPayoutPerOrder,400,`Potensi pembayaran melebihi batas pesanan ${config.maxPayoutPerOrder}.`,'BET_PAYOUT_LIMIT');
  return{rows,total,potentialPayout};
}

function mapOrder(row,items){return {id:row.id,invoice:row.invoice,memberId:row.member_id,username:row.username,marketId:row.market_id,marketSlug:row.slug,marketName:row.market_name,providerPath:row.provider_path,period:row.period,gameName:row.game_name,status:row.status,totalStake:Number(row.total_stake),totalPayout:Number(row.total_payout),balanceBefore:row.balance_before===null?null:Number(row.balance_before),balanceAfter:row.balance_after===null?null:Number(row.balance_after),result:row.result_value,cancellableUntil:row.cancellable_until,placedAt:row.placed_at,settledAt:row.settled_at,createdAt:row.created_at,updatedAt:row.updated_at,itemCount:Number(row.item_count??items?.length??0),items};}
async function itemsFor(db,orderId){const {rows}=await db.query(`SELECT line_no,bet_type,number_value,game_code,selection_value,amount,discount_percent,stake_after_discount,payout_multiplier,payout_amount,result_match FROM bet_items WHERE order_id=$1 ORDER BY line_no`,[orderId]);return rows.map(x=>({lineNo:x.line_no,type:x.bet_type,gameCode:x.game_code||legacyGameCode(x.bet_type),number:x.number_value,selection:x.selection_value||x.number_value,amount:Number(x.amount),discount:x.discount_percent,stake:Number(x.stake_after_discount),payoutMultiplier:Number(x.payout_multiplier),payout:Number(x.payout_amount),won:Boolean(x.result_match)}));}
async function orderBy(db,where,values,includeItems=true){const {rows}=await db.query(`SELECT o.*,u.username,m.slug,(SELECT COUNT(*) FROM bet_items i WHERE i.order_id=o.id)::int AS item_count FROM bet_orders o JOIN users u ON u.id=o.member_id JOIN markets m ON m.id=o.market_id WHERE ${where} LIMIT 1`,values);if(!rows[0])throw new AppError(404,'Pesanan angka tidak ditemukan.','BET_NOT_FOUND');return mapOrder(rows[0],includeItems?await itemsFor(db,rows[0].id):undefined);}
async function insertItems(client,orderId,rows){for(let i=0;i<rows.length;i++){const r=rows[i];await client.query(`INSERT INTO bet_items(id,order_id,line_no,bet_type,number_value,game_code,selection_value,amount,discount_percent,stake_after_discount,payout_multiplier) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),orderId,i+1,r.type,r.number,r.gameCode,r.selection,r.amount,r.discount,r.stake,r.payoutMultiplier]);}}
async function resolveInputMarket(input,client){if(input.providerPath)return marketByIdentifier(input.providerPath,client);if(input.marketSlug)return marketByIdentifier(input.marketSlug,client);return marketByIdentifier(String(input.marketId||''),client);}

export async function quoteBet(session,input){return tx(async client=>{const market=await resolveInputMarket(input,client);const config=await configInTx(market.id,client);assertOpen(config,input.period);await assertPeriodUnsettled(client,market.id,config.period);const normalized=await normalizeRows(input.rows,config,client);return{marketId:market.id,marketSlug:market.slug,marketName:market.name,period:String(config.period),closeAt:config.closeAt,totalStake:normalized.total,potentialPayout:normalized.potentialPayout,rows:normalized.rows.map(r=>({gameCode:r.gameCode,label:LOTTERY_GAME_MAP.get(r.gameCode)?.label,selection:r.selection,amount:r.amount,discount:r.discount,stake:r.stake,payoutMultiplier:r.payoutMultiplier,potentialPayout:r.potentialPayout,availability:r.exposure.status,remaining:r.exposure.remaining}))};},{isolation:'REPEATABLE READ'});}

export async function createBet(session,input,{draft=false,ip=''}={}){
  const idempotencyKey=clean(input.idempotencyKey,100)||null;
  return tx(async client=>{
    if(idempotencyKey){const existing=await client.query('SELECT id FROM bet_orders WHERE member_id=$1 AND idempotency_key=$2',[session.userId,idempotencyKey]);if(existing.rows[0])return orderBy(client,'o.id=$1',[existing.rows[0].id]);}
    const market=await resolveInputMarket(input,client);const config=await configInTx(market.id,client);assertOpen(config,input.period);await assertPeriodUnsettled(client,market.id,config.period);const normalized=await normalizeRows(input.rows,config,client);const id=randomUUID(),inv=invoice(),gameName=clean(input.gameName||'Lottery',80);
    let before=null,after=null,status='DRAFT',placedAt=null,cancellableUntil=null;
    if(!draft){await enforceResponsiblePlay(session.userId,{kind:'BET',amount:normalized.total,client,sessionCreatedAt:session.createdAt});const ledger=await postTransfer(client,{memberId:session.userId,systemCode:SYSTEM_ACCOUNTS.BET_HOLD,memberDelta:-normalized.total,type:'BET_PLACED',referenceType:'BET_ORDER',referenceId:id,idempotencyKey:`bet:${session.userId}:${idempotencyKey||id}`,metadata:{marketId:market.id,period:config.period,potentialPayout:normalized.potentialPayout},actorId:session.userId});before=ledger.before;after=ledger.after;status='ACCEPTED';placedAt=new Date();cancellableUntil=new Date(Date.now()+config.cancelWindowSeconds*1000);}
    await client.query(`INSERT INTO bet_orders(id,invoice,member_id,market_id,market_name,provider_path,period,game_name,status,total_stake,balance_before,balance_after,idempotency_key,cancellable_until,placed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,inv,session.userId,market.id,market.name,market.provider_path,config.period,gameName,status,normalized.total,before,after,idempotencyKey,cancellableUntil,placedAt]);
    await insertItems(client,id,normalized.rows);
    await audit({actorId:session.userId,actorRole:'MEMBER',action:draft?'BET_DRAFT_CREATED':'BET_ACCEPTED',targetType:'BET_ORDER',targetId:id,details:{invoice:inv,total:normalized.total,potentialPayout:normalized.potentialPayout,market:market.name,period:config.period},ip,client});
    return orderBy(client,'o.id=$1',[id]);
  },{isolation:'SERIALIZABLE'});
}

export async function submitDraft(session,id,ip=''){return tx(async client=>{
  const {rows}=await client.query(`SELECT o.* FROM bet_orders o WHERE o.id=$1 AND o.member_id=$2 FOR UPDATE`,[id,session.userId]);const row=rows[0];assert(row,404,'Draft tidak ditemukan.','BET_NOT_FOUND');assert(row.status==='DRAFT',409,'Draft sudah pernah diproses.','BET_NOT_DRAFT');
  const config=await configInTx(row.market_id,client);assertOpen(config,row.period);await assertPeriodUnsettled(client,row.market_id,config.period);
  const draftItems=(await client.query(`SELECT bet_type,game_code,selection_value,number_value,amount,stake_after_discount,payout_multiplier FROM bet_items WHERE order_id=$1 ORDER BY line_no FOR UPDATE`,[id])).rows;const normalized=await normalizeRows(draftItems.map(i=>({type:i.bet_type,gameCode:i.game_code,selection:i.selection_value||i.number_value,amount:Number(i.amount)})),config,client);assert(normalized.total===Number(row.total_stake),409,'Harga atau diskon draft telah berubah. Buat ulang draft sebelum mengirim.','DRAFT_PRICING_CHANGED');for(let i=0;i<draftItems.length;i++){assert(Number(draftItems[i].stake_after_discount)===normalized.rows[i].stake&&Number(draftItems[i].payout_multiplier)===normalized.rows[i].payoutMultiplier,409,'Konfigurasi payout draft telah berubah. Buat ulang draft.','DRAFT_PRICING_CHANGED');}
  await enforceResponsiblePlay(session.userId,{kind:'BET',amount:Number(row.total_stake),client,sessionCreatedAt:session.createdAt});const ledger=await postTransfer(client,{memberId:session.userId,systemCode:SYSTEM_ACCOUNTS.BET_HOLD,memberDelta:-Number(row.total_stake),type:'BET_PLACED',referenceType:'BET_ORDER',referenceId:row.id,idempotencyKey:`draft-submit:${row.id}`,metadata:{marketId:row.market_id,period:config.period},actorId:session.userId});const until=new Date(Date.now()+config.cancelWindowSeconds*1000);await client.query(`UPDATE bet_orders SET status='ACCEPTED',balance_before=$1,balance_after=$2,cancellable_until=$3,placed_at=now(),updated_at=now() WHERE id=$4`,[ledger.before,ledger.after,until,row.id]);await audit({actorId:session.userId,actorRole:'MEMBER',action:'BET_DRAFT_SUBMITTED',targetType:'BET_ORDER',targetId:row.id,details:{period:config.period},ip,client});return orderBy(client,'o.id=$1',[row.id]);
},{isolation:'SERIALIZABLE'});}

export async function cancelBet(session,id,ip=''){return tx(async client=>{const {rows}=await client.query('SELECT * FROM bet_orders WHERE id=$1 AND member_id=$2 FOR UPDATE',[id,session.userId]);const row=rows[0];assert(row,404,'Pesanan tidak ditemukan.','BET_NOT_FOUND');assert(row.status==='ACCEPTED',409,'Pesanan tidak dapat dibatalkan.','BET_NOT_CANCELLABLE');assert(row.cancellable_until&&new Date(row.cancellable_until)>new Date(),409,'Batas waktu pembatalan sudah berakhir.','BET_CANCEL_WINDOW_EXPIRED');const ledger=await postTransfer(client,{memberId:session.userId,systemCode:SYSTEM_ACCOUNTS.BET_HOLD,memberDelta:Number(row.total_stake),type:'BET_CANCELLED',referenceType:'BET_ORDER',referenceId:row.id,idempotencyKey:`cancel:${row.id}`,actorId:session.userId});await client.query(`UPDATE bet_orders SET status='CANCELLED',balance_after=$1,updated_at=now() WHERE id=$2`,[ledger.after,row.id]);await audit({actorId:session.userId,actorRole:'MEMBER',action:'BET_CANCELLED',targetType:'BET_ORDER',targetId:row.id,details:{refund:Number(row.total_stake)},ip,client});return orderBy(client,'o.id=$1',[row.id]);},{isolation:'SERIALIZABLE'});}

export async function listMemberBets(memberId,{status,limit=100,offset=0}={}){const values=[memberId];let clause="o.member_id=$1 AND o.wallet_mode='CASH'";if(status){values.push(String(status).toUpperCase());clause+=` AND o.status=$${values.length}`}values.push(Math.min(Number(limit)||100,500));const lp=values.length;values.push(Math.max(Number(offset)||0,0));const op=values.length;const {rows}=await query(`SELECT o.*,u.username,m.slug,(SELECT COUNT(*) FROM bet_items i WHERE i.order_id=o.id)::int AS item_count FROM bet_orders o JOIN users u ON u.id=o.member_id JOIN markets m ON m.id=o.market_id WHERE ${clause} ORDER BY o.created_at DESC LIMIT $${lp} OFFSET $${op}`,values);return rows.map(x=>mapOrder(x));}
export async function listAllBets({status,marketId,period,username,limit=200,offset=0}={}){const v=[];const w=[];if(status){v.push(String(status).toUpperCase());w.push(`o.status=$${v.length}`)}if(marketId){v.push(Number(marketId));w.push(`o.market_id=$${v.length}`)}if(period){v.push(clean(period,80));w.push(`o.period=$${v.length}`)}if(username){v.push(`%${clean(username,30)}%`);w.push(`u.username ILIKE $${v.length}`)}v.push(Math.min(Number(limit)||200,1000));const lp=v.length;v.push(Math.max(Number(offset)||0,0));const op=v.length;const {rows}=await query(`SELECT o.*,u.username,m.slug,(SELECT COUNT(*) FROM bet_items i WHERE i.order_id=o.id)::int AS item_count FROM bet_orders o JOIN users u ON u.id=o.member_id JOIN markets m ON m.id=o.market_id ${w.length?`WHERE ${w.join(' AND ')}`:''} ORDER BY o.created_at DESC LIMIT $${lp} OFFSET $${op}`,v);return rows.map(x=>mapOrder(x));}
export const getMemberBet=(memberId,id)=>orderBy({query},"o.id=$1 AND o.member_id=$2 AND o.wallet_mode='CASH'",[id,memberId]);

// Bukti betting untuk member. Data diambil ulang dari server (bukan dari cache
// browser) dan tetap ter-filter ke milik member itu sendiri lewat getMemberBet.
export async function betReceipt(memberId,id){
  const order=await getMemberBet(memberId,id);
  const rows=(order.items||[]).map((item,index)=>({
    no:index+1,
    gameCode:item.gameCode,
    label:LOTTERY_GAME_MAP.get(item.gameCode)?.label||item.gameCode,
    selection:item.selection,
    amount:item.amount,
    discount:item.discount,
    stake:item.stake,
    payoutMultiplier:item.payoutMultiplier,
    payout:item.payout,
    won:item.won
  }));
  return {
    invoice:order.invoice,
    receiptNumber:`RCP-${String(order.invoice||order.id||'').slice(-10).toUpperCase()}`,
    market:{name:order.marketName,slug:order.marketSlug,period:order.period,result:order.result},
    status:order.status,
    placedAt:order.placedAt,
    settledAt:order.settledAt,
    totals:{
      lineCount:rows.length,
      stake:order.totalStake,
      payout:order.totalPayout,
      balanceBefore:order.balanceBefore,
      balanceAfter:order.balanceAfter
    },
    rows
  };
}
export const getAnyBet=identifier=>orderBy({query},'(o.id::text=$1 OR o.invoice=$1)',[clean(identifier,100)]);
export async function walletLedger(memberId,limit=100){const {rows}=await query(`SELECT e.amount_signed,e.balance_before,e.balance_after,e.created_at,t.transaction_type,t.reference_type,t.reference_id FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_user_id=$1 ORDER BY e.created_at DESC LIMIT $2`,[memberId,Math.min(Number(limit)||100,500)]);return rows.map(x=>({direction:Number(x.amount_signed)<0?'DEBIT':'CREDIT',amount:Math.abs(Number(x.amount_signed)),balanceBefore:Number(x.balance_before),balanceAfter:Number(x.balance_after),reason:x.transaction_type,referenceType:x.reference_type,referenceId:x.reference_id,createdAt:x.created_at}));}

export async function updateBettingConfig(session,identifier,input,ip=''){
  const current=await bettingConfig(identifier);const status=clean(input.bettingStatus??current.bettingStatus,20).toUpperCase();assert(['OPEN','CLOSED','SUSPENDED'].includes(status),400,'Status pasaran tidak valid.','BETTING_STATUS_INVALID');const bettingPeriod=clean(input.bettingPeriod??current.period,80)||null;const closeAt=input.closeAt?new Date(input.closeAt):null;if(closeAt)assert(!Number.isNaN(closeAt.getTime()),400,'Waktu penutupan tidak valid.','CLOSE_AT_INVALID');if(status==='OPEN'){
    assert(current.authorityReady===true,409,'Authority hasil pasaran belum siap. Pasaran tidak dapat dibuka sebelum hasil terverifikasi.','RESULT_AUTHORITY_NOT_READY');assert(bettingPeriod,400,'Periode betting wajib ditetapkan sebelum pasaran dibuka.','BETTING_PERIOD_REQUIRED');assert(closeAt&&closeAt.getTime()>Date.now(),400,'Waktu tutup betting wajib berada di masa depan.','BETTING_CLOSE_REQUIRED');}const val=(name,min,max,fallback)=>{const n=Number(input[name]);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback};const x={minStake:100,maxStakePerItem:val('maxStakePerItem',100,200000000,current.maxStakePerItem),maxOrderTotal:val('maxOrderTotal',100,1000000000,current.maxOrderTotal),maxPayoutPerOrder:val('maxPayoutPerOrder',1000,9000000000000,current.maxPayoutPerOrder||2000000000),maxRows:val('maxRows',1,100,current.maxRows),cancelWindowSeconds:val('cancelWindowSeconds',0,3600,current.cancelWindowSeconds),discount2d:TOTO_STANDARD_RULES.STRAIGHT_2D.discountPercent,discount3d:TOTO_STANDARD_RULES.STRAIGHT_3D.discountPercent,discount4d:TOTO_STANDARD_RULES.STRAIGHT_4D.discountPercent,payout2d:TOTO_STANDARD_RULES.STRAIGHT_2D.payoutMultiplier,payout3d:TOTO_STANDARD_RULES.STRAIGHT_3D.payoutMultiplier,payout4d:TOTO_STANDARD_RULES.STRAIGHT_4D.payoutMultiplier};assert(x.maxStakePerItem>=x.minStake&&x.maxOrderTotal>=x.minStake,400,'Batas nominal tidak konsisten.','LIMIT_INVALID');await query(`UPDATE market_betting_configs SET betting_status=$1,betting_period=$2,close_at=$3,min_stake=$4,max_stake_per_item=$5,max_order_total=$6,max_payout_per_order=$7,max_rows=$8,cancel_window_seconds=$9,discount_2d=$10,discount_3d=$11,discount_4d=$12,payout_2d=$13,payout_3d=$14,payout_4d=$15,auto_cash_window=FALSE,auto_cash_window_basis='{}'::jsonb,auto_reopen_blocked=CASE WHEN $1 IN ('SUSPENDED','CLOSED') THEN TRUE ELSE FALSE END,updated_by=$16,updated_at=now() WHERE market_id=$17`,[status,bettingPeriod,closeAt,x.minStake,x.maxStakePerItem,x.maxOrderTotal,x.maxPayoutPerOrder,x.maxRows,x.cancelWindowSeconds,x.discount2d,x.discount3d,x.discount4d,x.payout2d,x.payout3d,x.payout4d,session.userId,current.marketId]);await query(`UPDATE lottery_game_configs SET discount_percent=CASE game_code WHEN 'STRAIGHT_2D' THEN $1 WHEN 'STRAIGHT_3D' THEN $2 ELSE $3 END,payout_multiplier=CASE game_code WHEN 'STRAIGHT_2D' THEN $4 WHEN 'STRAIGHT_3D' THEN $5 ELSE $6 END,max_stake_per_selection=$7,updated_by=$8,updated_at=now() WHERE market_id=$9 AND game_code IN ('STRAIGHT_2D','STRAIGHT_3D','STRAIGHT_4D')`,[x.discount2d,x.discount3d,x.discount4d,x.payout2d,x.payout3d,x.payout4d,x.maxStakePerItem,session.userId,current.marketId]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'BETTING_CONFIG_UPDATED',targetType:'MARKET',targetId:current.marketId,details:{status,bettingPeriod,closeAt:closeAt?.toISOString()||null,...x},ip});return bettingConfig(String(current.marketId));
}

export async function updateLotteryGameConfig(session,identifier,gameCode,input,ip=''){
  const market=await marketByIdentifier(identifier);const code=clean(gameCode,40).toUpperCase();const game=LOTTERY_GAME_MAP.get(code);assert(game,404,'Jenis permainan tidak ditemukan.','LOTTERY_GAME_UNKNOWN');await ensureLotteryGameConfigs(market.id);const current=(await query(`SELECT * FROM lottery_game_configs WHERE market_id=$1 AND game_code=$2`,[market.id,code])).rows[0];assert(current,404,'Konfigurasi permainan tidak ditemukan.','LOTTERY_GAME_CONFIG_MISSING');const enabled=input.enabled===undefined?Boolean(current.enabled):Boolean(input.enabled);assert(!enabled||game.engineReady,409,'Permainan belum memiliki kontrak settlement yang aman.','LOTTERY_GAME_NOT_READY');const standardRule=TOTO_STANDARD_RULES[code];const discount=standardRule?standardRule.discountPercent:Number(input.discountPercent??current.discount_percent),payout=standardRule?standardRule.payoutMultiplier:Number(input.payoutMultiplier??current.payout_multiplier),maxStake=Number(input.maxStakePerSelection??current.max_stake_per_selection);assert(Number.isInteger(discount)&&discount>=0&&discount<=90,400,'Diskon permainan tidak valid.','LOTTERY_DISCOUNT_INVALID');assert(Number.isFinite(payout)&&payout>=0&&payout<=100000,400,'Payout multiplier tidak valid.','LOTTERY_PAYOUT_INVALID');assert(Number.isSafeInteger(maxStake)&&maxStake>=0&&maxStake<=1000000000,400,'Batas exposure tidak valid.','LOTTERY_EXPOSURE_INVALID');if(enabled){assert(payout>0,400,'Payout wajib diisi sebelum permainan dibuka.','LOTTERY_PAYOUT_REQUIRED');assert(maxStake>0,400,'Batas exposure wajib diisi sebelum permainan dibuka.','LOTTERY_EXPOSURE_REQUIRED');}
  let options=Array.isArray(input.selectionOptions)?input.selectionOptions:current.selection_options;if(code==='SHIO'&&enabled){assert(Array.isArray(options)&&options.length===12,400,'Shio membutuhkan 12 mapping label aktif.','LOTTERY_SHIO_MAP_REQUIRED');options=options.map((x,i)=>({index:i+1,label:clean(typeof x==='string'?x:x?.label,40)||`SHIO ${i+1}`}));}
  await query(`UPDATE lottery_game_configs SET enabled=$1,discount_percent=$2,payout_multiplier=$3,max_stake_per_selection=$4,selection_options=$5::jsonb,updated_by=$6,updated_at=now() WHERE market_id=$7 AND game_code=$8`,[enabled,discount,payout,maxStake,JSON.stringify(options||[]),session.userId,market.id,code]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'LOTTERY_GAME_CONFIG_UPDATED',targetType:'MARKET',targetId:market.id,details:{gameCode:code,enabled,discount,payout,maxStake},ip});return bettingConfig(String(market.id));
}

// Audit untung-rugi riil per game, ditulis worker setiap settlement selesai.
// Dipakai back office untuk melihat platform benar-benar untung atau tidak per game.
export async function gameEvAudit(identifier,{period,limit=40}={}){
  const market=await marketByIdentifier(identifier);
  const values=[market.id];
  let clause='';
  if(period){values.push(clean(period,80));clause=` AND period=$${values.length}`;}
  values.push(Math.min(Math.max(Number(limit)||40,1),200));
  const {rows}=await query(`SELECT period,game_code,line_count,total_stake,total_payout,realized_ev,theoretical_ev,anomaly,recorded_at FROM game_settlement_audit WHERE market_id=$1${clause} ORDER BY recorded_at DESC LIMIT $${values.length}`,values);
  return {
    marketId:market.id,
    marketName:market.name,
    slug:market.slug,
    anomalies:rows.filter(row=>row.anomaly).length,
    items:rows.map(row=>({
      period:row.period,
      gameCode:row.game_code,
      lineCount:Number(row.line_count),
      totalStake:Number(row.total_stake),
      totalPayout:Number(row.total_payout),
      realizedEv:Number(row.realized_ev),
      theoreticalEv:row.theoretical_ev===null?null:Number(row.theoretical_ev),
      anomaly:Boolean(row.anomaly),
      recordedAt:row.recorded_at
    }))
  };
}

export async function lotteryExposureSnapshot(identifier,{period,gameCode,limit=100}={}){
  const market=await marketByIdentifier(identifier);const active=await bettingConfig(identifier);const drawPeriod=clean(period||active.period,80);assert(drawPeriod,400,'Periode wajib diisi.','PERIOD_REQUIRED');const code=clean(gameCode,40).toUpperCase();if(code)assert(LOTTERY_GAME_MAP.has(code),400,'Jenis permainan tidak dikenal.','LOTTERY_GAME_UNKNOWN');const values=[market.id,drawPeriod];let gameClause='';if(code){values.push(code);gameClause=` AND i.game_code=$${values.length}`;}values.push(Math.min(Math.max(Number(limit)||100,1),500));const limitPos=values.length;
  const {rows}=await query(`SELECT i.game_code,i.selection_value,COALESCE(SUM(i.stake_after_discount),0)::bigint AS current_stake,MAX(l.max_stake)::bigint AS custom_max_stake,MAX(l.status) AS custom_status,MAX(g.max_stake_per_selection)::bigint AS default_max_stake FROM bet_items i JOIN bet_orders o ON o.id=i.order_id JOIN lottery_game_configs g ON g.market_id=o.market_id AND g.game_code=i.game_code LEFT JOIN lottery_selection_limits l ON l.market_id=o.market_id AND l.period=o.period AND l.game_code=i.game_code AND l.selection_value=i.selection_value WHERE o.market_id=$1 AND o.period=$2 AND o.wallet_mode='CASH' AND o.status IN ('ACCEPTED','SETTLEMENT_PENDING')${gameClause} GROUP BY i.game_code,i.selection_value ORDER BY current_stake DESC LIMIT $${limitPos}`,values);
  const items=rows.map(r=>{const current=Number(r.current_stake||0),maximum=r.custom_max_stake===null?Number(r.default_max_stake||0):Number(r.custom_max_stake);const status=r.custom_status||'OPEN';return{gameCode:r.game_code,selection:r.selection_value,currentStake:current,maxStake:maximum,remaining:maximum>0?Math.max(0,maximum-current):null,status:status==='OPEN'&&maximum>0&&current>=maximum?'SOLD_OUT':status};});
  return{marketId:market.id,marketSlug:market.slug,marketName:market.name,period:drawPeriod,items};
}

export async function updateSelectionLimit(session,identifier,input,ip=''){
  const market=await marketByIdentifier(identifier);const active=await bettingConfig(identifier);const gameCode=clean(input.gameCode,40).toUpperCase();const game=LOTTERY_GAME_MAP.get(gameCode);assert(game,404,'Jenis permainan tidak ditemukan.','LOTTERY_GAME_UNKNOWN');const selection=normalizeLotterySelection(gameCode,input.selection);const period=clean(input.period||active.period,80);assert(period,400,'Periode wajib diisi.','PERIOD_REQUIRED');const maxStake=Number(input.maxStake);assert(Number.isSafeInteger(maxStake)&&maxStake>=0&&maxStake<=1000000000,400,'Batas selection tidak valid.','LOTTERY_EXPOSURE_INVALID');const status=clean(input.status||'OPEN',20).toUpperCase();assert(['OPEN','LIMITED','SOLD_OUT','SUSPENDED'].includes(status),400,'Status selection tidak valid.','LOTTERY_SELECTION_STATUS_INVALID');await query(`INSERT INTO lottery_selection_limits(market_id,period,game_code,selection_value,max_stake,status,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(market_id,period,game_code,selection_value) DO UPDATE SET max_stake=excluded.max_stake,status=excluded.status,updated_by=excluded.updated_by,updated_at=now()`,[market.id,period,gameCode,selection,maxStake,status,session.userId]);await audit({actorId:session.userId,actorRole:session.roles.join(','),action:'LOTTERY_SELECTION_LIMIT_UPDATED',targetType:'MARKET',targetId:market.id,details:{period,gameCode,selection,maxStake,status},ip});return{marketId:market.id,period,gameCode,selection,maxStake,status};
}

export async function bettingSummary(){const {rows}=await query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='ACCEPTED')::int AS accepted,COUNT(*) FILTER(WHERE status='SETTLED_WON')::int AS won,COALESCE(SUM(total_stake) FILTER(WHERE status='ACCEPTED'),0)::bigint AS open_stake,COALESCE(SUM(total_payout),0)::bigint AS total_payout FROM bet_orders WHERE wallet_mode='CASH'`);const r=rows[0];return{total:r.total,accepted:r.accepted,won:r.won,openStake:Number(r.open_stake),totalPayout:Number(r.total_payout)};}
export { listBettingMarkets, bettingConfig, publicGameDefinition };
