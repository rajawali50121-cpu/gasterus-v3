import { createServer } from 'node:http';
import { wrapGzip } from './gzip-response.js';
import { config } from './config.js';
import { isWorkerHeartbeatFresh } from './worker-health.js';
import { treeMemory } from './memory-guard.js';
import { connectRedis, checkRedis, redis } from './redis.js';
import { checkDatabase, query, tx } from './db.js';
import { AppError, assert } from './errors.js';
import { body, clientIp, fail, json, ok, securityHeaders } from './http.js';
import { acceptRules, authenticateApiKey, clearSessionCookie, loginMember, loginOwner, logout, registerMember, requireCsrf, requirePermission, session, sessionCookie, userById } from './auth.js';
import { createWalletRequest, listMemberRequests, numberHistory, numberHistoryMarkets, referralOverview } from './member.js';
import { bettingConfig, betReceipt, cancelBet, createBet, gameEvAudit, getAnyBet, getMemberBet, listAllBets, listBettingMarkets, listMemberBets, lotteryExposureSnapshot, quoteBet, submitDraft, updateBettingConfig, updateLotteryGameConfig, updateSelectionLimit, walletLedger } from './betting.js';
import { allWalletRequests, assignRole, auditList, confirmWithdrawalPayout, dashboard, decideApproval, listApprovals, listMembers, referrals, requestSettlement, requestWalletReversal, reviewWallet } from './owner.js';
import { listMarkets, memberLotteryResultDetails } from './markets.js';
import { verifyLedger } from './ledger.js';
import { logger } from './logger.js';
import { appendMarketHistory } from './member.js';
import { sportsbookSnapshot, sportsbookEventSnapshot, sportsbookOperationalStatus, sportsbookSourceStatus } from './sportsbook-feed.js';
import { runTotoCollector, totoCollectorStatus } from './toto-collector.js';
import { memberMarketVisible, MEMBER_HIDDEN_TOTO_MARKETS } from './toto-member-catalog.js';
import { cancelSportsbookSettlement, createSportsbookBet, createSportsbookQuote, getMemberSportsbookBet, listAllSportsbookBets, listManualSportsbookSettlementQueue, listMemberSportsbookBets, rollbackSportsbookSettlement, settleSportsbookBet } from './sportsbook-betting.js';
import { listSportsbookMarketLifecycleHistory, listSportsbookProviderIncidents, sportsbookRiskExposureSummary, sportsbookSettlementRevisionSummary } from './sportsbook-operations.js';
import { clearSportsbookTradingControl, listActiveSportsbookTradingControls, listSportsbookTradingControlHistory, upsertSportsbookTradingControl } from './sportsbook-trading-controls.js';
import { listMemberNotifications, markMemberNotificationRead, markAllMemberNotificationsRead, memberGamingHistory } from './notifications.js';
import { backofficeSummary, deleteBanner, deletePromotion, getMemberDetail, listBanners, listPaymentMethods, listPromotions, listSettings, publicDepositConfig, publicSiteConfig, resetMemberPassword, revokeMemberSessions, saveSetting, setMemberStatus, setPaymentMethodActive, updateMember, upsertBanner, upsertPaymentMethod, upsertPromotion } from './backoffice.js';
import { adminUpdateResponsiblePlay, createMemberSupportCase, createReconciliation, getPlayer360, getResponsiblePlay, listCompliance, listMemberSupportCases, listReconciliations, listRiskAlerts, listSecurityEvents, listSupportCases, operationsSummary, reportCenter, resolveRiskAlert, reviewKyc, runRiskScan, updateMemberResponsiblePlay, updateSupportCase } from './operations.js';
import { ingestProviderEvent, moneyIntegritySummary } from './money.js';
import { createQrisDeposit, handleQrisNotify, qrisOrderStatus, rawBody } from './qris.js';
import { createRegistrationCaptcha, registrationAccountNumberAvailability, registrationEmailAvailability, registrationUsernameAvailability, verifyRegistrationCaptcha } from './registration.js';
import { createSportsbookCashoutOffer, listMemberSportsbookCashoutOffers, acceptSportsbookCashout, sportsbookCashoutMetrics } from './sportsbook-cashout.js';
import { openSportsbookRealtimeStream, sportsbookRealtimeStatus } from './sportsbook-realtime.js';
import { totoMarketsHealth, totoMarketsDetail, simpleHealth } from './health-check.js';
import { requestMemberPasswordReset, resetMemberPasswordByToken } from './password-reset.js';
import { casinoProviders, casinoGames, casinoPassthrough, casinoRapidApiStatus, diagnoseCasinoUpstream, launchCasinoGame } from './casino-rapidapi.js';
import { processBetnexCallback } from './casino-wallet.js';
import { acceptSportsbookSnapshot, createStoredSportsbookSnapshot, SPORTSBOOK_INGEST_REDIS_KEY } from './sportsbook-ingestion.js';

const startedAt=Date.now();const metrics={requests:0,errors:0,rateLimited:0,latencyTotal:0};
const route=(method,pattern,handler,options={})=>({method,pattern,handler,...options});
const routes=[];
const add=(method,pattern,handler,options)=>routes.push(route(method,pattern,handler,options));
const asInt=(v,fallback,min=0,max=1000)=>{const n=Number(v);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback};
function internal(request,channel){const expected=channel==='member'?config.memberProxySecret:channel==='admin'?config.adminProxySecret:config.opsInternalSecret;assert(request.headers['x-internal-proxy-secret']===expected,404,'Not found','NOT_FOUND');}
async function rateLimit(request,key,limit,windowSec){const ip=clientIp(request);const redisKey=`rate:${key}:${ip}`;const count=await redis.incr(redisKey);if(count===1)await redis.expire(redisKey,windowSec);if(count>limit){metrics.rateLimited++;throw new AppError(429,'Terlalu banyak permintaan. Coba kembali beberapa saat lagi.','RATE_LIMITED');}}
async function memberSession(request){internal(request,'member');return session(request,'MEMBER');}
async function optionalMemberSession(request){internal(request,'member');try{return await session(request,'MEMBER');}catch{return null;}}
async function ownerSession(request,permission){internal(request,'admin');const s=await session(request,'OWNER');if(permission)requirePermission(s,permission);return s;}


// ============================================================================
// PHASE 1 CRITICAL: Health Check Endpoints for Toto Markets
// ============================================================================
add('GET',new RegExp('^/api/health/toto-markets$'),totoMarketsHealth);
add('GET',new RegExp('^/api/health/toto-markets/detail$'),totoMarketsDetail);
add('GET',new RegExp('^/api/health/simple$'),simpleHealth);
add('GET',/^\/healthz$/,async({res})=>{let healthy=false;try{const raw=await redis.get(config.workerHeartbeatKey);healthy=isWorkerHeartbeatFresh(raw,{staleAfterSeconds:Math.max(config.workerHeartbeatMaxAgeSeconds*2,120)});}catch{healthy=false;}ok(res,{status:healthy?'ok':'degraded'},healthy?200:503);});
add('POST',/^\/api\/internal\/sportsbook\/ingest$/,async({req,res})=>{
  const result=await acceptSportsbookSnapshot(req,{
    storeSnapshot:(_snapshot,serialized,signature)=>redis.set(
      SPORTSBOOK_INGEST_REDIS_KEY,
      createStoredSportsbookSnapshot({
        serializedSnapshot:serialized,
        timestamp:signature.timestamp,
        signature:signature.signature,
        receivedAt:signature.receivedAt
      }),
      {EX:1800}
    )
  });
  ok(res,result,202);
});

add('GET',/^\/health$/,async({res})=>ok(res,{status:'ok',service:'core',uptimeSeconds:Math.floor((Date.now()-startedAt)/1000)}));
add('GET',/^\/ready$/,async({res})=>{
  const [database,cache]=await Promise.all([checkDatabase(),checkRedis()]);
  const ready=database.ok&&cache.ok;
  ok(res,{status:ready?'ready':'degraded',database,cache},ready?200:503);
});
add('GET',/^\/internal\/monitoring$/,async({req,res})=>{internal(req,'ops');const [database,cache,ledger,workerHeartbeat]=await Promise.all([checkDatabase(),checkRedis(),tx(c=>verifyLedger(c)),redis.get(config.workerHeartbeatKey)]);const workerHeartbeatAt=workerHeartbeat?new Date(workerHeartbeat):null;const workerHeartbeatAgeSeconds=workerHeartbeatAt&&Number.isFinite(workerHeartbeatAt.getTime())?Math.max(0,Math.floor((Date.now()-workerHeartbeatAt.getTime())/1000)):null;const workerHealthy=workerHeartbeatAgeSeconds!==null&&workerHeartbeatAgeSeconds<=config.workerHeartbeatMaxAgeSeconds;ok(res,{status:database.ok&&cache.ok&&ledger.balanced&&workerHealthy?'healthy':'degraded',database,cache,ledger,worker:{healthy:workerHealthy,heartbeatAt:workerHeartbeat||null,heartbeatAgeSeconds:workerHeartbeatAgeSeconds,maxAgeSeconds:config.workerHeartbeatMaxAgeSeconds},queueDepth:await redis.lLen(config.queueName),metrics:{...metrics,averageLatencyMs:metrics.requests?metrics.latencyTotal/metrics.requests:0},memory:{...process.memoryUsage(),...treeMemory()},sportsbook:sportsbookSourceStatus(),sportsbookRealtime:sportsbookRealtimeStatus(),sportsbookCashout:sportsbookCashoutMetrics(),build:{commit:process.env.RAILWAY_GIT_COMMIT_SHA||null,revision:process.env.RAILWAY_GIT_COMMIT_MESSAGE||null,startedAt:new Date().toISOString()},uptimeSeconds:Math.floor(process.uptime())});});
add('GET',/^\/internal\/sportsbook\/readiness$/,async({req,res})=>{internal(req,'ops');const feed=await sportsbookOperationalStatus();const realtime=sportsbookRealtimeStatus();const cashout=sportsbookCashoutMetrics();const tradingReady=!feed.readOnly&&!feed.snapshotFallback&&feed.bettableMarkets>0&&feed.providers.some(provider=>provider.enabled&&provider.bettingAllowed);const status=tradingReady?'ready':'degraded';ok(res,{status,tradingReady,feed,realtime,cashout},status==='ready'?200:503);});
add('GET',/^\/internal\/metrics$/,async({req,res})=>{internal(req,'ops');const q=await redis.lLen(config.queueName);const sportsbook=sportsbookSourceStatus();const text=[`gasterus_requests_total ${metrics.requests}`,`gasterus_errors_total ${metrics.errors}`,`gasterus_rate_limited_total ${metrics.rateLimited}`,`gasterus_queue_depth ${q}`,`gasterus_process_uptime_seconds ${Math.floor(process.uptime())}`,`gasterus_sportsbook_feed_healthy ${sportsbook.healthy?1:0}`,`gasterus_sportsbook_feed_stale ${sportsbook.stale?1:0}`,`gasterus_sportsbook_cached_events ${Number(sportsbook.cachedEvents||0)}`,`gasterus_sportsbook_realtime_clients ${sportsbookRealtimeStatus().connectedClients}`,`gasterus_sportsbook_realtime_broadcasts_total ${sportsbookRealtimeStatus().broadcasts}`,`gasterus_sportsbook_cashout_offers_total ${sportsbookCashoutMetrics().offersCreated}`,`gasterus_sportsbook_cashout_accepted_total ${sportsbookCashoutMetrics().accepted}`].join('\n')+'\n';res.writeHead(200,{'content-type':'text/plain; version=0.0.4','cache-control':'no-store'});res.end(text);});

add('GET',/^\/api\/member\/register\/username-availability$/,async({req,res,url})=>{internal(req,'member');await rateLimit(req,'member-register-username-check',90,60);ok(res,await registrationUsernameAvailability(url.searchParams.get('username')));});
  add('GET',/^\/api\/member\/register\/email-availability$/,async({req,res,url})=>{internal(req,'member');await rateLimit(req,'member-register-email-check',90,60);ok(res,await registrationEmailAvailability(url.searchParams.get('email')));});
add('GET',/^\/api\/member\/register\/account-availability$/,async({req,res,url})=>{internal(req,'member');await rateLimit(req,'member-register-account-check',60,60);ok(res,await registrationAccountNumberAvailability(url.searchParams.get('account')));});
add('GET',/^\/api\/member\/register\/captcha$/,async({req,res})=>{internal(req,'member');await rateLimit(req,'member-register-captcha',30,60);ok(res,await createRegistrationCaptcha());});
add('POST',/^\/api\/member\/register$/,async({req,res,ip})=>{internal(req,'member');await rateLimit(req,'member-register',8,600);const input=await body(req);await verifyRegistrationCaptcha(input);const user=await registerMember(input,ip);const result=await loginMember({username:user.username,password:input.password},ip,String(req.headers['user-agent']||''));ok(res,{user:result.user,csrfToken:result.csrfToken,token:result.token,sessionToken:result.sessionToken},201,{'set-cookie':sessionCookie('MEMBER',result.token,result.ttl)});});
add('POST',/^\/api\/member\/login$/,async({req,res,ip})=>{internal(req,'member');await rateLimit(req,'member-login',10,600);const result=await loginMember(await body(req),ip,String(req.headers['user-agent']||''));ok(res,{user:result.user,csrfToken:result.csrfToken,token:result.token,sessionToken:result.sessionToken},200,{'set-cookie':sessionCookie('MEMBER',result.token,result.ttl)});});
add('POST',/^\/api\/member\/forgot-password$/,async({req,res,ip})=>{internal(req,'member');await rateLimit(req,'member-forgot-password-ip',10,900);ok(res,await requestMemberPasswordReset(await body(req),ip,String(req.headers['user-agent']||'')));});
add('POST',/^\/api\/member\/reset-password$/,async({req,res,ip})=>{internal(req,'member');await rateLimit(req,'member-reset-password',5,900);ok(res,await resetMemberPasswordByToken(await body(req),ip));});
add('GET',/^\/api\/member\/me$/,async({req,res})=>{const s=await memberSession(req);ok(res,{user:await userById(s.userId),csrfToken:s.csrf});});
add('GET',/^\/api\/member\/site-config$/,async({req,res})=>{internal(req,'member');ok(res,await publicSiteConfig());});
add('GET',/^\/api\/member\/deposit-config$/,async({req,res})=>{await memberSession(req);ok(res,await publicDepositConfig());});
add('GET',/^\/api\/member\/payment-methods$/,async({req,res})=>{await memberSession(req);ok(res,await listPaymentMethods(false));});
add('POST',/^\/api\/member\/logout$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);await logout(req,'MEMBER');ok(res,{ok:true},200,{'set-cookie':clearSessionCookie('MEMBER')});});
add('POST',/^\/api\/member\/rules\/accept$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,{acceptedAt:await acceptRules(s.userId)});});
add('GET',/^\/api\/member\/wallet-requests$/,async({req,res})=>{const s=await memberSession(req);ok(res,await listMemberRequests(s.userId));});
add('POST',/^\/api\/member\/qris\/create-order$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'member-qris-create',10,60);ok(res,await createQrisDeposit(s,await body(req),ip),201);});
add('GET',/^\/api\/member\/qris\/(?<id>[0-9a-f-]+)\/status$/,async({req,res,params})=>{const s=await memberSession(req);ok(res,await qrisOrderStatus(s,params.id));});
// External payment provider webhook (DANA Finish Notify). Signature-verified;
// no member session / CSRF required by design.
add('POST',/^\/api\/payment\/qris\/notify$/,async({req,res})=>{const raw=await rawBody(req);ok(res,await handleQrisNotify(raw,req.headers));});
add('POST',/^\/api\/member\/wallet-requests$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'member-wallet',12,60);ok(res,await createWalletRequest(s,await body(req,2600000),ip),201);});

add('GET',/^\/api\/member\/responsible-play$/,async({req,res})=>{const s=await memberSession(req);ok(res,await getResponsiblePlay(s.userId));});
add('POST',/^\/api\/member\/responsible-play$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await updateMemberResponsiblePlay(s,await body(req),ip));});
add('GET',/^\/api\/member\/support-cases$/,async({req,res})=>{const s=await memberSession(req);ok(res,await listMemberSupportCases(s.userId));});
add('POST',/^\/api\/member\/support-cases$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await createMemberSupportCase(s,await body(req),ip),201);});
add('GET',/^\/api\/member\/referral$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await referralOverview(s.userId,url.searchParams.get('limit')));});
add('GET',/^\/api\/member\/number-history\/markets$/,async({req,res})=>{await memberSession(req);const items=(await numberHistoryMarkets()).filter(memberMarketVisible);ok(res,items);});
add('GET',/^\/api\/member\/number-history\/(?<identifier>[^/]+)$/,async({req,res,url,params})=>{await memberSession(req);if(MEMBER_HIDDEN_TOTO_MARKETS.has(String(params.identifier||'')))return fail(res,404,'Pasaran tidak tersedia.');const result=await numberHistory(params.identifier,{limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')});if(!memberMarketVisible(result.market))return fail(res,404,'Pasaran tidak tersedia.');respondEnvelope(res,result.items,{total:result.total,market:result.market,limit:asInt(url.searchParams.get('limit'),20,1,100),offset:asInt(url.searchParams.get('offset'),0,0,1000000)});});
add('GET',/^\/api\/member\/betting-markets\/(?<identifier>[^/]+)$/,async({req,res,params})=>{await memberSession(req);ok(res,await bettingConfig(params.identifier));});
add('POST',/^\/api\/member\/lottery\/quote$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'lottery-quote',60,60);ok(res,await quoteBet(s,await body(req)));});
add('GET',/^\/api\/member\/lottery\/result-details\/(?<identifier>[^/]+)$/,async({req,res,params,url})=>{await memberSession(req);ok(res,await memberLotteryResultDetails(params.identifier,url.searchParams.get('period')));});
add('GET',/^\/api\/member\/bets$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await listMemberBets(s.userId,{status:url.searchParams.get('status'),limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));});
add('POST',/^\/api\/member\/bets$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'member-bet',30,60);ok(res,await createBet(s,await body(req),{draft:false,ip}),201);});
add('POST',/^\/api\/member\/bets\/drafts$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await createBet(s,await body(req),{draft:true,ip}),201);});
add('GET',/^\/api\/member\/bets\/(?<id>[0-9a-f-]+)$/,async({req,res,params})=>{const s=await memberSession(req);ok(res,await getMemberBet(s.userId,params.id));});
add('GET',/^\/api\/member\/bets\/(?<id>[0-9a-f-]+)\/receipt$/,async({req,res,params})=>{const s=await memberSession(req);ok(res,await betReceipt(s.userId,params.id));});
add('POST',/^\/api\/member\/bets\/(?<id>[0-9a-f-]+)\/submit$/,async({req,res,params,ip})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await submitDraft(s,params.id,ip));});
add('POST',/^\/api\/member\/bets\/(?<id>[0-9a-f-]+)\/cancel$/,async({req,res,params,ip})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await cancelBet(s,params.id,ip));});
add('GET',/^\/api\/member\/wallet-ledger$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await walletLedger(s.userId,url.searchParams.get('limit')));});
add('GET',/^\/api\/member\/notifications$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await listMemberNotifications(s.userId,{limit:url.searchParams.get('limit'),unreadOnly:url.searchParams.get('unreadOnly')==='true'}));});
add('POST',/^\/api\/member\/notifications\/read-all$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await markAllMemberNotificationsRead(s.userId));});
add('POST',/^\/api\/member\/notifications\/(?<id>[0-9a-f-]+)\/read$/,async({req,res,params})=>{const s=await memberSession(req);requireCsrf(req,s);ok(res,await markMemberNotificationRead(s.userId,params.id));});
add('GET',/^\/api\/member\/gaming-history$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await memberGamingHistory(s.userId,{limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/member\/sportsbook\/events$/,async({req,res,url})=>{await optionalMemberSession(req);await rateLimit(req,'sportsbook-feed',180,60);ok(res,await sportsbookSnapshot({sport:url.searchParams.get('sport'),live:url.searchParams.get('live'),q:url.searchParams.get('q'),tab:url.searchParams.get('tab'),league:url.searchParams.get('league'),leagues:url.searchParams.has('leagues')?url.searchParams.get('leagues'):null,country:url.searchParams.get('country'),offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/member\/casino\/providers$/,async({req,res})=>{await optionalMemberSession(req);await rateLimit(req,'casino-providers',60,60);ok(res,await casinoProviders());});
add('GET',/^\/api\/member\/casino\/games$/,async({req,res,url})=>{await optionalMemberSession(req);await rateLimit(req,'casino-games',60,60);ok(res,await casinoGames(url.searchParams.get('provider')||''));});
add('POST',/^\/api\/member\/casino\/launch$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'casino-launch',12,60);const member=await userById(s.userId);assert(member.status==='ACTIVE',403,'Akun tidak aktif.','ACCOUNT_INACTIVE');ok(res,await launchCasinoGame(member,await body(req)));});
add('POST',/^\/api\/member\/casino\/callback$/,async({req,res})=>{internal(req,'member');let input;try{input=await body(req,65536);}catch{return json(res,200,{success:false,msg:'Callback payload tidak valid.',handle:false,money:0});}try{const result=await processBetnexCallback(input);return json(res,result.status,result.body);}catch(error){logger.error('Betnex callback route failed',{code:error?.code||'CALLBACK_FAILED',message:error?.message||'unknown'});return json(res,500,{success:false,msg:'Callback belum dapat diproses.',handle:false,money:0});}});
add('GET',/^\/api\/member\/casino\/status$/,async({req,res})=>{await optionalMemberSession(req);ok(res,casinoRapidApiStatus());});
add('GET',/^\/api\/member\/sportsbook\/stream$/,async({req,res,url})=>{await memberSession(req);await rateLimit(req,'sportsbook-stream',20,60);openSportsbookRealtimeStream(req,res,{sport:url.searchParams.get('sport'),live:url.searchParams.get('live'),q:url.searchParams.get('q'),tab:url.searchParams.get('tab'),league:url.searchParams.get('league'),leagues:url.searchParams.has('leagues')?url.searchParams.get('leagues'):null,country:url.searchParams.get('country'),offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')});});
add('GET',/^\/api\/member\/sportsbook\/events\/(?<id>[^/]+)$/,async({req,res,params})=>{await optionalMemberSession(req);await rateLimit(req,'sportsbook-event-detail',120,60);ok(res,await sportsbookEventSnapshot(params.id));});
add('GET',/^\/api\/member\/sportsbook\/bets$/,async({req,res,url})=>{const s=await memberSession(req);ok(res,await listMemberSportsbookBets(s.userId,{status:url.searchParams.get('status'),limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));});
add('POST',/^\/api\/member\/sportsbook\/quotes$/,async({req,res})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'sportsbook-quote',60,60);ok(res,await createSportsbookQuote(s,await body(req)));});
add('POST',/^\/api\/member\/sportsbook\/bets$/,async({req,res,ip})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'sportsbook-bet',20,60);ok(res,await createSportsbookBet(s,await body(req),{ip}),201);});
add('GET',/^\/api\/member\/sportsbook\/bets\/(?<id>[0-9a-f-]+)$/,async({req,res,params})=>{const s=await memberSession(req);ok(res,await getMemberSportsbookBet(s.userId,params.id));});
add('GET',/^\/api\/member\/sportsbook\/cashout\/offers$/,async({req,res,url})=>{const s=await memberSession(req);await rateLimit(req,'sportsbook-cashout-offers',30,60);ok(res,await listMemberSportsbookCashoutOffers(s.userId,{limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/member\/sportsbook\/bets\/(?<id>[0-9a-f-]+)\/cashout-offer$/,async({req,res,params})=>{const s=await memberSession(req);await rateLimit(req,'sportsbook-cashout-offer',45,60);ok(res,await createSportsbookCashoutOffer(s.userId,params.id));});
add('POST',/^\/api\/member\/sportsbook\/bets\/(?<id>[0-9a-f-]+)\/cashout$/,async({req,res,params,ip})=>{const s=await memberSession(req);requireCsrf(req,s);await rateLimit(req,'sportsbook-cashout-accept',15,60);ok(res,await acceptSportsbookCashout(s,params.id,await body(req),{ip}));});
add('GET',/^\/member-api\/markets$/,async({req,res,url})=>{internal(req,'member');const limit=asInt(url.searchParams.get('limit'),100,1,100),offset=asInt(url.searchParams.get('offset'),0,0,10000),includeHistorical=url.searchParams.get('includeHistorical')==='1';const result=await listMarkets({category:url.searchParams.get('category'),q:url.searchParams.get('q'),limit:100,offset:0,includeHistorical});const visible=result.items.filter(memberMarketVisible);const page=visible.slice(offset,offset+limit);const items=page.map(x=>({slug:x.slug,code:x.code,name:x.name,result:(x.result&&/^\d{3,6}$/.test(x.result))?x.result:(x.resultTrusted?x.result:null),period:x.period,category:x.category,tags:x.tags,status:x.status,sortOrder:x.sortOrder,updatedAt:x.updatedAt,drawDate:x.drawDate,drawTime:x.drawTime,resultHistorical:Boolean(x.resultHistorical),liveVerificationStatus:x.liveVerificationStatus||null,stale:Boolean(x.stale||false),bettingStatus:x.bettingStatus||'SUSPENDED',bettingPeriod:x.bettingPeriod||null,closeAt:x.closeAt||null,bettingReady:Boolean(x.bettingReady),readinessReason:x.readinessReason||null}));respondEnvelope(res,items,{total:visible.length,limit,offset,updatedAt:items.map(x=>x.updatedAt).filter(Boolean).sort().at(-1)||null});});
// Public bank status endpoint (no auth required) — homepage bank status from payment_methods (READ-ONLY)
add('GET',/^\/api\/public\/bank-status$/,async({req,res})=>{await rateLimit(req,'public-bank-status',60,60);const {rows}=await query(`SELECT code,method_type,name,is_active,updated_at FROM payment_methods ORDER BY sort_order,name`);respondEnvelope(res,rows.map(x=>({code:x.code,name:x.name,methodType:x.method_type,active:x.is_active===true,updatedAt:x.updated_at||null})),{total:rows.length,updatedAt:rows.map(x=>x.updated_at).filter(Boolean).sort().at(-1)||null});});

// Public withdrawal ticker (no auth required) — recent APPROVED withdrawals only, names masked (READ-ONLY)
function maskTickerName(value){const s=String(value||'').trim();if(!s)return 'Anonim';return s.split(/[\s._-]+/).filter(Boolean).map(part=>part.slice(0,1)+'***').join(' ').slice(0,40);}
add('GET',/^\/api\/public\/withdrawal-ticker$/,async({req,res})=>{await rateLimit(req,'public-withdrawal-ticker',60,60);const {rows}=await query(`SELECT w.amount,w.created_at,u.username FROM wallet_requests w JOIN users u ON u.id=w.member_id WHERE w.request_type='WITHDRAW' AND w.status='APPROVED' ORDER BY w.created_at DESC LIMIT 20`);respondEnvelope(res,rows.map(x=>({name:maskTickerName(x.username),amount:Number(x.amount),status:'success',createdAt:x.created_at})),{total:rows.length,updatedAt:rows.map(x=>x.created_at).filter(Boolean).sort().at(-1)||null});});

// Public markets endpoint (no auth required) — for homepage live draw display
add('GET',/^\/api\/public\/markets$/,async({req,res,url})=>{const limit=asInt(url.searchParams.get('limit'),100,1,100),offset=asInt(url.searchParams.get('offset'),0,0,10000),includeHistorical=url.searchParams.get('includeHistorical')==='1';const result=await listMarkets({category:url.searchParams.get('category'),q:url.searchParams.get('q'),limit:100,offset:0,includeHistorical});const visible=result.items.filter(memberMarketVisible);const page=visible.slice(offset,offset+limit);const items=page.map(x=>({slug:x.slug,code:x.code,name:x.name,result:(x.result&&/^\d{3,6}$/.test(x.result))?x.result:(x.resultTrusted?x.result:null),period:x.period,category:x.category,tags:x.tags,status:x.status,sortOrder:x.sortOrder,updatedAt:x.updatedAt,drawDate:x.drawDate,drawTime:x.drawTime,resultHistorical:Boolean(x.resultHistorical),liveVerificationStatus:x.liveVerificationStatus||null,stale:Boolean(x.stale||false),bettingStatus:x.bettingStatus||'SUSPENDED',bettingPeriod:x.bettingPeriod||null,closeAt:x.closeAt||null,bettingReady:Boolean(x.bettingReady),readinessReason:x.readinessReason||null}));respondEnvelope(res,items,{total:visible.length,limit,offset,updatedAt:items.map(x=>x.updatedAt).filter(Boolean).sort().at(-1)||null});});

add('POST',/^\/api\/owner\/login$/,async({req,res,ip})=>{internal(req,'admin');await rateLimit(req,'owner-login',5,900);const result=await loginOwner(await body(req),ip,String(req.headers['user-agent']||''));ok(res,{user:result.user,csrfToken:result.csrfToken},200,{'set-cookie':sessionCookie('OWNER',result.token,result.ttl)});});
add('GET',/^\/api\/owner\/me$/,async({req,res})=>{const s=await ownerSession(req);ok(res,{user:await userById(s.userId),csrfToken:s.csrf,roles:s.roles});});
add('POST',/^\/api\/owner\/logout$/,async({req,res})=>{const s=await ownerSession(req);requireCsrf(req,s);await logout(req,'OWNER');ok(res,{ok:true},200,{'set-cookie':clearSessionCookie('OWNER')});});
add('GET',/^\/api\/owner\/dashboard$/,async({req,res})=>{await ownerSession(req,'members:read');ok(res,await dashboard());});
add('GET',/^\/api\/owner\/wallet-requests$/,async({req,res,url})=>{await ownerSession(req,'wallet:read');ok(res,await allWalletRequests({status:url.searchParams.get('status'),type:url.searchParams.get('type'),limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/wallet-requests\/(?<id>[0-9a-f-]+)\/review$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'wallet:review');requireCsrf(req,s);ok(res,await reviewWallet(s,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/wallet-requests\/(?<id>[0-9a-f-]+)\/payout$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'wallet:review');requireCsrf(req,s);await rateLimit(req,'admin-payout',30,60);ok(res,await confirmWithdrawalPayout(s,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/wallet-requests\/(?<id>[0-9a-f-]+)\/reversal$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'money:reverse');requireCsrf(req,s);ok(res,await requestWalletReversal(s,params.id,await body(req),ip),202);});
add('GET',/^\/api\/owner\/money-integrity$/,async({req,res})=>{const s=await ownerSession(req,'money:read');ok(res,await moneyIntegritySummary(s));});
add('GET',/^\/api\/owner\/members$/,async({req,res,url})=>{await ownerSession(req,'members:read');ok(res,await listMembers(url.searchParams.get('limit')));});
add('GET',/^\/api\/owner\/backoffice-summary$/,async({req,res})=>{await ownerSession(req,'members:read');ok(res,await backofficeSummary());});

add('GET',/^\/api\/owner\/operations-summary$/,async({req,res})=>{const st=await ownerSession(req,'members:read');ok(res,await operationsSummary(st));});
add('GET',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/player360$/,async({req,res,params})=>{const st=await ownerSession(req,'members:read');ok(res,await getPlayer360(st,params.id));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/kyc$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'compliance:write');requireCsrf(req,st);ok(res,await reviewKyc(st,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/responsible-play$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'responsible:write');requireCsrf(req,st);ok(res,await adminUpdateResponsiblePlay(st,params.id,await body(req),ip));});
add('GET',/^\/api\/owner\/compliance$/,async({req,res,url})=>{const st=await ownerSession(req,'compliance:read');ok(res,await listCompliance(st,{status:url.searchParams.get('status'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/owner\/risk-alerts$/,async({req,res,url})=>{const st=await ownerSession(req,'risk:read');ok(res,await listRiskAlerts(st,{status:url.searchParams.get('status')??'OPEN',limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/risk-scan$/,async({req,res,ip})=>{const st=await ownerSession(req,'risk:write');requireCsrf(req,st);ok(res,await runRiskScan(st,ip));});
add('POST',/^\/api\/owner\/risk-alerts\/(?<id>[0-9a-f-]+)$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'risk:write');requireCsrf(req,st);ok(res,await resolveRiskAlert(st,params.id,await body(req),ip));});
add('GET',/^\/api\/owner\/support-cases$/,async({req,res,url})=>{const st=await ownerSession(req,'support:write');ok(res,await listSupportCases(st,{status:url.searchParams.get('status'),limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/support-cases\/(?<id>[0-9a-f-]+)$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'support:write');requireCsrf(req,st);ok(res,await updateSupportCase(st,params.id,await body(req),ip));});
add('GET',/^\/api\/owner\/reconciliations$/,async({req,res,url})=>{const st=await ownerSession(req,'reconciliation:write');ok(res,await listReconciliations(st,{limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/reconciliations$/,async({req,res,ip})=>{const st=await ownerSession(req,'reconciliation:write');requireCsrf(req,st);ok(res,await createReconciliation(st,await body(req),ip),201);});
add('GET',/^\/api\/owner\/reports$/,async({req,res,url})=>{const st=await ownerSession(req,'reports:read');ok(res,await reportCenter(st,{days:url.searchParams.get('days')}));});
add('GET',/^\/api\/owner\/security-events$/,async({req,res,url})=>{const st=await ownerSession(req,'security:read');ok(res,await listSecurityEvents(st,{severity:url.searchParams.get('severity'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)$/,async({req,res,params})=>{const st=await ownerSession(req,'members:read');ok(res,await getMemberDetail(st,params.id));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/profile$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'members:write');requireCsrf(req,st);ok(res,await updateMember(st,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/status$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'members:write');requireCsrf(req,st);ok(res,await setMemberStatus(st,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/reset-password$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'members:credential-reset');requireCsrf(req,st);ok(res,await resetMemberPassword(st,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/members\/(?<id>[0-9a-f-]+)\/revoke-sessions$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'sessions:revoke');requireCsrf(req,st);ok(res,await revokeMemberSessions(st,params.id,ip));});
add('GET',/^\/api\/owner\/payment-methods$/,async({req,res})=>{await ownerSession(req,'wallet:read');ok(res,await listPaymentMethods(true));});
add('POST',/^\/api\/owner\/payment-methods$/,async({req,res,ip})=>{const st=await ownerSession(req,'payments:write');requireCsrf(req,st);ok(res,await upsertPaymentMethod(st,await body(req,2600000),ip),201);});
add('POST',/^\/api\/owner\/payment-methods\/(?<id>[0-9a-f-]+)\/status$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'payments:write');requireCsrf(req,st);ok(res,await setPaymentMethodActive(st,params.id,await body(req),ip));});
add('GET',/^\/api\/owner\/banners$/,async({req,res,url})=>{await ownerSession(req,'members:read');ok(res,await listBanners(true,url.searchParams.get('placement')||''));});
add('POST',/^\/api\/owner\/banners$/,async({req,res,ip})=>{const st=await ownerSession(req,'content:write');requireCsrf(req,st);ok(res,await upsertBanner(st,await body(req,2600000),ip),201);});
add('POST',/^\/api\/owner\/banners\/(?<id>[0-9a-f-]+)\/delete$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'content:write');requireCsrf(req,st);ok(res,await deleteBanner(st,params.id,ip));});
add('GET',/^\/api\/owner\/promotions$/,async({req,res})=>{await ownerSession(req,'members:read');ok(res,await listPromotions(true));});
add('POST',/^\/api\/owner\/promotions$/,async({req,res,ip})=>{const st=await ownerSession(req,'content:write');requireCsrf(req,st);ok(res,await upsertPromotion(st,await body(req,2600000),ip),201);});
add('POST',/^\/api\/owner\/promotions\/(?<id>[0-9a-f-]+)\/delete$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'content:write');requireCsrf(req,st);ok(res,await deletePromotion(st,params.id,ip));});
add('GET',/^\/api\/owner\/settings$/,async({req,res})=>{const st=await ownerSession(req,'settings:write');ok(res,await listSettings(st));});
add('POST',/^\/api\/owner\/settings\/(?<key>[a-zA-Z0-9._-]+)$/,async({req,res,params,ip})=>{const st=await ownerSession(req,'settings:write');requireCsrf(req,st);ok(res,await saveSetting(st,params.key,await body(req),ip));});
add('GET',/^\/api\/owner\/audit$/,async({req,res,url})=>{await ownerSession(req,'audit:read');ok(res,await auditList(url.searchParams.get('limit')));});
add('GET',/^\/api\/owner\/referrals$/,async({req,res,url})=>{await ownerSession(req,'members:read');ok(res,await referrals(url.searchParams.get('limit')));});
add('GET',/^\/api\/owner\/collector\/status$/,async({req,res})=>{await ownerSession(req,'bets:read');const summary=await query(`SELECT verification_status,COUNT(*)::int count,MAX(source_updated_at) max_source_updated_at FROM markets GROUP BY verification_status`);const counts=Object.fromEntries(summary.rows.map(x=>[x.verification_status,x.count]));const latest=summary.rows.map(x=>x.max_source_updated_at).filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0]||null;ok(res,{reference:{summary:{verified:counts.VERIFIED||0,singleSource:counts.SINGLE_SOURCE||0,conflict:counts.CONFLICT||0,sourceUnavailable:counts.SOURCE_UNAVAILABLE||0,unmapped:counts.UNMAPPED||0},mode:'AUTO_MULTI_SOURCE_COLLECTOR',ingestionEndpoint:'/api/v1/results',lastDatabaseSourceUpdateAt:latest,collector:await totoCollectorStatus()}});});
add('POST',/^\/api\/owner\/collector\/run$/,async({req,res})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);const result=await runTotoCollector({reason:'owner-manual'});ok(res,{accepted:true,summary:result.summary,sources:result.sources,lastSuccessAt:result.lastSuccessAt},200);});
add('GET',/^\/api\/owner\/bets$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listAllBets({status:url.searchParams.get('status'),marketId:url.searchParams.get('marketId'),period:url.searchParams.get('period'),username:url.searchParams.get('username'),limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));});
add('GET',/^\/api\/owner\/bets\/(?<identifier>[^/]+)$/,async({req,res,params})=>{await ownerSession(req,'bets:read');ok(res,await getAnyBet(params.identifier));});
add('GET',/^\/api\/owner\/betting-markets$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listBettingMarkets({status:url.searchParams.get('status'),q:url.searchParams.get('q'),limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/betting-markets\/(?<identifier>[^/]+)$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);ok(res,await updateBettingConfig(s,params.identifier,await body(req),ip));});
add('POST',/^\/api\/owner\/lottery-games\/(?<identifier>[^/]+)\/(?<gameCode>[^/]+)$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);ok(res,await updateLotteryGameConfig(s,params.identifier,params.gameCode,await body(req),ip));});
add('GET',/^\/api\/owner\/game-ev-audit\/(?<identifier>[^/]+)$/,async({req,res,params,url})=>{await ownerSession(req,'bets:read');ok(res,await gameEvAudit(params.identifier,{period:url.searchParams.get('period'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/owner\/lottery-exposure\/(?<identifier>[^/]+)$/,async({req,res,params,url})=>{await ownerSession(req,'bets:read');ok(res,await lotteryExposureSnapshot(params.identifier,{period:url.searchParams.get('period'),gameCode:url.searchParams.get('gameCode'),limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/lottery-selection-limits\/(?<identifier>[^/]+)$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);ok(res,await updateSelectionLimit(s,params.identifier,await body(req),ip));});
add('POST',/^\/api\/owner\/bets\/settle$/,async({req,res,ip})=>{const s=await ownerSession(req,'settlements:request');requireCsrf(req,s);ok(res,await requestSettlement(s,await body(req),'SETTLEMENT',ip),202);});
add('POST',/^\/api\/owner\/bets\/void$/,async({req,res,ip})=>{const s=await ownerSession(req,'settlements:request');requireCsrf(req,s);ok(res,await requestSettlement(s,await body(req),'VOID',ip),202);});
add('GET',/^\/api\/owner\/sportsbook\/health$/,async({req,res,url})=>{await ownerSession(req,'bets:read');const [feed,risk,incidents,controls,marketLifecycle,settlements]=await Promise.all([sportsbookOperationalStatus(),sportsbookRiskExposureSummary(),listSportsbookProviderIncidents({limit:url.searchParams.get('incidents')||config.sportsbookProviderIncidentLimit}),listActiveSportsbookTradingControls({limit:500}),listSportsbookMarketLifecycleHistory({limit:url.searchParams.get('lifecycle')||100}),sportsbookSettlementRevisionSummary({limit:url.searchParams.get('settlements')||50})]);ok(res,{feed,risk,incidents,controls,marketLifecycle,settlements});});
add('GET',/^\/api\/owner\/sportsbook\/events$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await sportsbookSnapshot({sport:url.searchParams.get('sport'),live:url.searchParams.get('live'),q:url.searchParams.get('q'),tab:url.searchParams.get('tab'),league:url.searchParams.get('league'),leagues:url.searchParams.has('leagues')?url.searchParams.get('leagues'):null,country:url.searchParams.get('country'),offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')},{memberView:false}));});
add('GET',/^\/internal\/casino\/diagnose$/,async({req,res,url})=>{internal(req,'ops');ok(res,await diagnoseCasinoUpstream(url.searchParams.get('provider')||'PGSOFT'));});
add('GET',/^\/api\/owner\/sportsbook\/provider-incidents$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listSportsbookProviderIncidents({limit:url.searchParams.get('limit')||config.sportsbookProviderIncidentLimit}));});
add('GET',/^\/api\/owner\/sportsbook\/controls$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listActiveSportsbookTradingControls({eventId:url.searchParams.get('eventId')||'',limit:url.searchParams.get('limit')||1000}));});
add('GET',/^\/api\/owner\/sportsbook\/controls\/history$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listSportsbookTradingControlHistory({scopeKey:url.searchParams.get('scopeKey')||'',limit:url.searchParams.get('limit')||100}));});
add('POST',/^\/api\/owner\/sportsbook\/controls$/,async({req,res,ip})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);ok(res,await upsertSportsbookTradingControl(s,await body(req),{ip}),201);});
add('DELETE',/^\/api\/owner\/sportsbook\/controls\/(?<id>[0-9a-f-]+)$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'markets:write');requireCsrf(req,s);ok(res,await clearSportsbookTradingControl(s,params.id,{ip}));});
add('GET',/^\/api\/owner\/sportsbook\/manual-settlement-queue$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listManualSportsbookSettlementQueue({openLimit:url.searchParams.get('openLimit'),recentLimit:url.searchParams.get('recentLimit')}));});
add('GET',/^\/api\/owner\/sportsbook\/bets$/,async({req,res,url})=>{await ownerSession(req,'bets:read');ok(res,await listAllSportsbookBets({status:url.searchParams.get('status'),username:url.searchParams.get('username'),limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));});
add('POST',/^\/api\/owner\/sportsbook\/bets\/(?<id>[0-9a-f-]+)\/settle$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'settlements:request');requireCsrf(req,s);ok(res,await settleSportsbookBet(s,params.id,await body(req),{ip}));});
add('POST',/^\/api\/owner\/sportsbook\/bets\/(?<id>[0-9a-f-]+)\/rollback$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'settlements:request');requireCsrf(req,s);ok(res,await rollbackSportsbookSettlement(s,params.id,await body(req),{ip}));});
add('POST',/^\/api\/owner\/sportsbook\/bets\/(?<id>[0-9a-f-]+)\/cancel$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'settlements:request');requireCsrf(req,s);ok(res,await cancelSportsbookSettlement(s,params.id,await body(req),{ip}));});
add('GET',/^\/api\/owner\/approvals$/,async({req,res,url})=>{const s=await ownerSession(req,'approvals:read');ok(res,await listApprovals(s,{status:url.searchParams.get('status')||'PENDING',limit:url.searchParams.get('limit')}));});
add('POST',/^\/api\/owner\/approvals\/(?<id>[0-9a-f-]+)\/decision$/,async({req,res,params,ip})=>{const s=await ownerSession(req,'approvals:approve');requireCsrf(req,s);ok(res,await decideApproval(s,params.id,await body(req),ip));});
add('POST',/^\/api\/owner\/roles\/assign$/,async({req,res,ip})=>{const s=await ownerSession(req,'roles:write');requireCsrf(req,s);ok(res,await assignRole(s,await body(req),ip),202);});

add('GET',/^\/api\/v1\/sportsbook\/feed$/,async({req,res,url})=>{await authenticateApiKey(req,'sportsbook:feed');ok(res,await sportsbookSnapshot({sport:url.searchParams.get('sport'),live:url.searchParams.get('live'),q:url.searchParams.get('q'),tab:url.searchParams.get('tab'),league:url.searchParams.get('league'),leagues:url.searchParams.has('leagues')?url.searchParams.get('leagues'):null,country:url.searchParams.get('country'),offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/v1\/sportsbook\/events\/(?<id>[^/]+)$/,async({req,res,params})=>{await authenticateApiKey(req,'sportsbook:feed');ok(res,await sportsbookEventSnapshot(params.id));});
add('GET',/^\/api\/v1\/sportsbook\/stream$/,async({req,res,url})=>{await authenticateApiKey(req,'sportsbook:feed');openSportsbookRealtimeStream(req,res,{sport:url.searchParams.get('sport'),live:url.searchParams.get('live'),q:url.searchParams.get('q'),tab:url.searchParams.get('tab'),league:url.searchParams.get('league'),leagues:url.searchParams.has('leagues')?url.searchParams.get('leagues'):null,country:url.searchParams.get('country'),offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')});});
add('GET',/^\/api\/v1\/betting-markets$/,async({req,res,url})=>{await authenticateApiKey(req,'bets:read');ok(res,await listBettingMarkets({status:url.searchParams.get('status'),q:url.searchParams.get('q'),limit:url.searchParams.get('limit')}));});
add('GET',/^\/api\/v1\/bets$/,async({req,res,url})=>{await authenticateApiKey(req,'bets:read');ok(res,await listAllBets({status:url.searchParams.get('status'),marketId:url.searchParams.get('marketId'),period:url.searchParams.get('period'),username:url.searchParams.get('username'),limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));});
add('GET',/^\/api\/v1\/bets\/(?<identifier>[^/]+)$/,async({req,res,params})=>{await authenticateApiKey(req,'bets:read');ok(res,await getAnyBet(params.identifier));});
add('POST',/^\/api\/v1\/payment-events\/(?<provider>[A-Za-z0-9_-]+)$/,async({req,res,params,ip})=>{const key=await authenticateApiKey(req,'payments:callback');ok(res,await ingestProviderEvent(key,params.provider,await body(req,300000),ip),202);});
add('POST',/^\/api\/v1\/results$/,async({req,res})=>{const key=await authenticateApiKey(req,'results:write');const input=await body(req);const m=(await query(`SELECT * FROM markets WHERE slug=$1 OR code=$1 OR id::text=$1 LIMIT 1`,[String(input.market||'')])).rows[0];assert(m,404,'Pasaran tidak ditemukan.','MARKET_NOT_FOUND');assert(/^\d{3,6}$/.test(String(input.result||'')),400,'Format hasil tidak valid.','RESULT_INVALID');const period=String(input.period||'').trim().slice(0,80);assert(period,400,'Periode hasil wajib dikirim oleh source eksternal.','RESULT_PERIOD_REQUIRED');const drawDate=String(input.drawDate||'').trim();if(drawDate)assert(/^\d{4}-\d{2}-\d{2}$/.test(drawDate),400,'Tanggal hasil tidak valid.','RESULT_DRAW_DATE_INVALID');const sourceName=`INGESTED:${String(key.name||'api-key').replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80)}`;await appendMarketHistory({marketId:m.id,period,result:String(input.result),drawDate:drawDate||null,drawTime:input.drawTime||null,sourceName,sourceUpdatedAt:new Date()});const details=input.resultDetails;if(details&&typeof details==='object'){const digits=v=>v==null?null:String(v).replace(/\D/g,'').slice(0,6)||null;const list=v=>Array.isArray(v)?v.map(x=>digits(x)).filter(Boolean).slice(0,50):[];await query(`INSERT INTO market_result_details(market_id,period,first_prize,second_prize,third_prize,special_numbers,consolation_numbers,raw_payload,verification_status,source_name,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,'SINGLE_SOURCE',$9,now()) ON CONFLICT(market_id,period) DO UPDATE SET first_prize=excluded.first_prize,second_prize=excluded.second_prize,third_prize=excluded.third_prize,special_numbers=excluded.special_numbers,consolation_numbers=excluded.consolation_numbers,raw_payload=excluded.raw_payload,verification_status='SINGLE_SOURCE',source_name=excluded.source_name,updated_at=now()`,[m.id,period,digits(details.firstPrize),digits(details.secondPrize),digits(details.thirdPrize),JSON.stringify(list(details.special)),JSON.stringify(list(details.consolation)),JSON.stringify(details),sourceName]);}ok(res,{market:m.slug,period,result:String(input.result),verificationStatus:'SINGLE_SOURCE',published:false,resultDetailsStored:Boolean(details)},202);});

function respondEnvelope(res,data,meta){const payload=Buffer.from(JSON.stringify({data,meta}));res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':payload.length,'cache-control':'no-store'});res.end(payload);}
function matchRoute(method,path){for(const r of routes){if(r.method!==method)continue;const m=r.pattern.exec(path);if(m)return{route:r,params:m.groups||{}};}return null;}
// ---------------------------------------------------------------------------
// CORS middleware — central cross-origin handler.
// Railway deploy exposes core (port 8080) behind the gateway/static Pages, so
// the core HTTP layer is the authoritative place where cross-origin member
// requests must be allowed. The list of allowed origins is built from:
//  1. FORCED_MEMBER_ORIGINS — always-on fallback (first-party + preview). Never
//     removed by env so a fresh deploy works with zero env tuning.
//  2. ALLOWED_MEMBER_ORIGIN — optional comma-separated env override, MERGED
//     with the fallback (not replacing it).
//  3. ALLOWED_ADMIN_ORIGIN  — optional admin-side override (merged too).
const FORCED_MEMBER_ORIGINS = new Set([
  'https://www.gasterus.fun',
  'https://gasterus.fun',
  'https://preview.gasterus.fun',
]);
function memberAllowedOrigins(){
  const extra = String(config.allowedMemberOrigin || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const set = new Set(FORCED_MEMBER_ORIGINS);
  for (const origin of extra) set.add(origin);
  return set;
}
function corsOriginFor(req){
  const origin = String(req.headers.origin || '');
  if (!origin) return null;
  if (FORCED_MEMBER_ORIGINS.has(origin)) return origin;
  if (config.allowedMemberOrigin && memberAllowedOrigins().has(origin)) return origin;
  if (config.allowedAdminOrigin && String(config.allowedAdminOrigin || '').split(',').map(v => v.trim()).filter(Boolean).includes(origin)) return origin;
  return null;
}
function corsHeaders(req){
  const origin = corsOriginFor(req);
  if (!origin) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-csrf-token, x-api-key',
    'access-control-max-age': '600',
  };
}
export function createApp(){return createServer(async(req,res)=>{securityHeaders(res);const cors=corsHeaders(req);if(req.method==='OPTIONS'&&cors){res.writeHead(204,{...cors,'content-length':'0'});res.end();return;}if(cors){for(const[key,value]of Object.entries(cors))res.setHeader(key,value);}wrapGzip(req,res);const began=performance.now();metrics.requests++;const url=new URL(req.url||'/','http://internal');const match=matchRoute(req.method||'GET',url.pathname);if(!match){return fail(res,new AppError(404,'Not found','NOT_FOUND'));}try{await match.route.handler({req,res,url,params:match.params,ip:clientIp(req)})}catch(error){metrics.errors++;logger.error('Request failed',{method:req.method,path:url.pathname,status:error.status||500,code:error.code,error:error.message});fail(res,error);}finally{metrics.latencyTotal+=performance.now()-began;}});}
export async function initialize(){await connectRedis();await checkDatabase();}

// Cron-like scheduler: checks every 30 seconds for markets whose closeAt has passed
// and automatically sets bettingStatus to CLOSED without waiting for iframe
let marketCloseInterval = null;
async function runMarketCloseCheck(){
  try{
    const result=await query(`UPDATE market_betting_configs SET betting_status='CLOSED',updated_at=now() WHERE betting_status='OPEN' AND close_at IS NOT NULL AND close_at<=now() RETURNING market_id`);
    if(result.rowCount>0){
      logger.info('Auto-closed markets',{count:result.rowCount,marketIds:result.rows.map(r=>r.market_id)});
    }
  }catch(err){
    logger.error('Market close scheduler error',{error:err.message});
  }
}
export function startMarketCloseScheduler(){
  if(marketCloseInterval) clearInterval(marketCloseInterval);
  // Run immediately on start, then every 30 seconds
  runMarketCloseCheck();
  marketCloseInterval=setInterval(runMarketCloseCheck,30000);
  logger.info('Market close scheduler started',{intervalMs:30000});
  return ()=>{if(marketCloseInterval){clearInterval(marketCloseInterval);marketCloseInterval=null;}};
}
