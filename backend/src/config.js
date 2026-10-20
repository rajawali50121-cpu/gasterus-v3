import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, boundedInt, int, optionalSecret, requiredSecret, text } from './env.js';

// Local development: muat backend/.env (gitignored) jika ada. process.loadEnvFile
// TIDAK menimpa variabel yang sudah ada di process.env, jadi variabel produksi
// (Railway dashboard) selalu menang; file ini hanya pengisi celah saat dev lokal.
const localEnvFile = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(localEnvFile)) {
  try { process.loadEnvFile(localEnvFile); } catch { /* .env rusak tidak boleh menggagalkan boot */ }
}

const isProduction = process.env.NODE_ENV === 'production';
const apiSportsKey = optionalSecret('API_SPORTS_KEY');
const theOddsApiKey = optionalSecret('THE_ODDS_API_KEY');
const theOddsApiKey2 = optionalSecret('THE_ODDS_API_KEY_2');
const theOddsApiKeys = [...new Set([
  theOddsApiKey,
  theOddsApiKey2,
  ...optionalSecret('THE_ODDS_API_KEYS').split(',')
].map(key => key.trim()).filter(Boolean))];
const sharpApiKey = optionalSecret('SHARP_API_KEY');
const theSportsDbKey = optionalSecret('THESPORTSDB_API_KEY');
const sportmonksKey = optionalSecret('SPORTMONKS_API_KEY');
const rapidApiKey = optionalSecret('RAPIDAPI_CASINO_KEY') || optionalSecret('RAPIDAPI_KEY');
const betnexApiKey = optionalSecret('BETNEX_API_KEY');
const betnexCallbackKey = optionalSecret('BETNEX_CALLBACK_KEY') || betnexApiKey;
function pricedProviderEnabled(name, key) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return isProduction && Boolean(key);
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 8080, 1, 65535),
  databaseUrl: requiredSecret('DATABASE_URL', 12),
  databaseSsl: bool('DATABASE_SSL', false),
  pgPoolMax: int('PG_POOL_MAX', 15, 2, 100),
  redisUrl: requiredSecret('REDIS_URL', 12),
  memberProxySecret: requiredSecret('MEMBER_PROXY_SECRET', 32),
  adminProxySecret: requiredSecret('ADMIN_PROXY_SECRET', 32),
  opsInternalSecret: requiredSecret('OPS_INTERNAL_SECRET', 32),
  sessionHmacKey: requiredSecret('SESSION_HMAC_KEY', 32),
  apiKeyPepper: requiredSecret('API_KEY_PEPPER', 32),
  mfaEncryptionKeyBase64: requiredSecret('MFA_ENCRYPTION_KEY_BASE64', 40),
  sportsbookIngestHmacSecret: optionalSecret('SPORTSBOOK_INGEST_HMAC_SECRET'),
  sportsbookIngestMaxPayloadBytes: int('SPORTSBOOK_INGEST_MAX_PAYLOAD_BYTES', 6_291_456, 65_536, 8_388_608),
  sportsbookIngestMaxAgeSeconds: int('SPORTSBOOK_INGEST_MAX_AGE_SECONDS', 180, 30, 600),
  sportsbookRenderMaxEvents: int('SPORTSBOOK_RENDER_MAX_EVENTS', 500, 1, 500),
  sportsbookRenderMaxPages: int('SPORTSBOOK_RENDER_MAX_PAGES', 120, 12, 120),
  memberSessionTtl: int('MEMBER_SESSION_TTL_SECONDS', 43200, 900, 604800),
  ownerSessionTtl: int('OWNER_SESSION_TTL_SECONDS', 900, 900, 86400), // R6.94: 15-minute admin session (idle refresh)
  highValueThreshold: int('HIGH_VALUE_APPROVAL_THRESHOLD', 1000000, 10000, 200000000),
  approvalTtl: int('APPROVAL_TTL_SECONDS', 1800, 300, 86400),
  queueName: process.env.QUEUE_NAME || 'gasterus:settlement:queue',
  lockTtlMs: int('LOCK_TTL_MS', 120000, 5000, 900000),
  workerHeartbeatKey: text('WORKER_HEARTBEAT_KEY', 'gasterus:worker:heartbeat'),
  workerHeartbeatMaxAgeSeconds: int('WORKER_HEARTBEAT_MAX_AGE_SECONDS', 90, 20, 600),
  allowedMemberOrigin: process.env.ALLOWED_MEMBER_ORIGIN || '',
  allowedAdminOrigin: process.env.ALLOWED_ADMIN_ORIGIN || '',
  trustProxy: bool('TRUST_PROXY', true),
  cookieSecure: bool('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
  balanceUnitName: process.env.BALANCE_UNIT_NAME || 'Saldo',
  resendApiKey: optionalSecret('RESEND_API_KEY'),
  resendFromEmail: text('RESEND_FROM_EMAIL', ''),
  frontendResetUrl: text('FRONTEND_RESET_URL', 'https://gasterus.fun/reset-password'),

  // Public TOTO result aggregator. URLs are non-secret and can be overridden per environment.
  totoCollectorEnabled: bool('TOTO_COLLECTOR_ENABLED', true),
  totoCollectorIntervalSeconds: int('TOTO_COLLECTOR_INTERVAL_SECONDS', 60, 30, 3600),
  totoSourceTimeoutMs: int('TOTO_SOURCE_TIMEOUT_MS', 12000, 2000, 30000),
  totoCollectorUserAgent: text('TOTO_COLLECTOR_USER_AGENT', 'ASEAN777-Result-Collector/6.8.14'),
  totoPoskoPaitoUrl: text('TOTO_POSKOPAITO_URL', 'https://poskopaito.com/'),
  totoDataTotoUrl: text('TOTO_DATATOTO_URL', 'https://datatoto.pro/pasaran_lengkap_V2.php'),
  totoMasterLiveUrl: text('TOTO_MASTERLIVE_URL', 'https://masterlive.net/'),
  totoCindoTotoUrl: text('TOTO_CINDOTOTO_URL', 'https://cindototopusat.com/'),
  totoSumTotoUrl: text('TOTO_SUMTOTO_URL', 'https://sumtotoking.com/support'),
  totoMioTotoUrl: text('TOTO_MIOTOTO_URL', 'https://miototo.com/'),
  totoIkonTotoUrl: text('TOTO_IKONTOTO_URL', 'https://ikontoto.org/'),
  totoKiaTotoUrl: text('TOTO_KIATOTO_URL', 'https://kiatoto.net/'),
  totoKingkongInfoUrl: text('TOTO_KINGKONG_INFO_URL', 'https://kingkongtoto-info.com/'),
    totoBelizePoolsUrl: text('TOTO_BELIZE_POOLS_URL', 'https://belizepools.org/'),
  totoMeridaPoolsUrl: text('TOTO_MERIDA_POOLS_URL', 'https://meridapools.org/'),
  // Official Vegasnet live-result widget. Verified live at the widgets subdomain
  // (https://widgets.vegasnet.info/result.php). The bare https://vegasnet.info/result.php
  // returns 404, so it must NOT be used. Configurable per-deployment (Railway env).
  totoVegasnetUrl: text('TOTO_VEGASNET_URL', 'https://widgets.vegasnet.info/result.php'),
  // Chromium browser fallback DISABLED by default (0): TOTO results now come from the
  // light-weight Vegasnet HTTP widget source (see toto-source-fetch.js). Set the env
  // var explicitly to re-enable per-run Chromium rendering.
  totoBrowserFallbackMaxSources: int('TOTO_BROWSER_FALLBACK_MAX_SOURCES', 0, 0, 4),
  totoOfficialBrowserFallbackMaxSources: int('TOTO_OFFICIAL_BROWSER_FALLBACK_MAX_SOURCES', 2, 0, 4),
  totoBrowserFallbackCacheSeconds: int('TOTO_BROWSER_FALLBACK_CACHE_SECONDS', 900, 60, 3600),
  totoBrowserFallbackSettleMs: int('TOTO_BROWSER_FALLBACK_SETTLE_MS', 4500, 1000, 12000),
  totoMaxResultAgeDays: int('TOTO_MAX_RESULT_AGE_DAYS', 4, 1, 14),
  // Operator decision (diminta owner): pasaran pool yang hanya punya 1 keluarga sumber
  // tetap boleh jadi VERIFIED sehingga betting pools bisa dibuka. Angka tetap hasil scrape
  // sumber asli (bukan generator). Revert: set env TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED=false.
  totoSingleSourceCanPublishVerified: bool('TOTO_SINGLE_SOURCE_CAN_PUBLISH_VERIFIED', true),
  // Tampilkan hasil REAL single-source (1 keluarga sumber) ke member sebagai display-only.
  // Betting/settlement TETAP butuh VERIFIED (authorityReady). Matikan dengan TOTO_PUBLISH_SINGLE_SOURCE=false.
  totoPublishSingleSource: bool('TOTO_PUBLISH_SINGLE_SOURCE', true),
  // Sched auto-open eksperimental (markets.js). Default OFF: sistem lifecycle
  // native (toto-collector + reconcileCashBettingWindows) adalah satu-satunya
  // penulis status pasaran otomatis; scheduler ini hanya untuk situasi darurat
  // operator. Set MARKET_AUTO_OPEN_ENABLED=true untuk mengaktifkan (dapat
  // berbenturan dengan freshness gate collector -> status flap).
  marketAutoOpenEnabled: bool('MARKET_AUTO_OPEN_ENABLED', false),
  // Per-source health & auto-failover. Ketika sebuah sumber gagal memproduksi hasil
  // sebanyak failThreshold berturut-turut, ia ditandai "degraded" dan tidak lagi dibakar
  // usaha render/CSS; setelah cooldown berlalu ia di-probe ulang untuk auto-heal.
  // Hanya memengaruhi pemilihan sumber — TIDAK mengubah decision/verification/betting logic.
  totoSourceFailThreshold: int('TOTO_SOURCE_FAIL_THRESHOLD', 5, 2, 20),
  totoSourceFailCooldownSeconds: int('TOTO_SOURCE_FAIL_COOLDOWN_SECONDS', 300, 30, 3600),
  totoSourceRotationEnabled: bool('TOTO_SOURCE_ROTATION_ENABLED', true),

  // Background feed/collector process is separate from settlement (feed-worker.js).
  sportsSourceBackgroundPollEnabled: bool('SPORTS_SOURCE_BACKGROUND_POLL_ENABLED', true),
  feedWorkerEnabled: bool('FEED_WORKER_ENABLED', true),
  // Katalog penuh tetap dibatasi 500 fixture; cache byte dan batas market
  // per fixture menjadi pengaman memori untuk snapshot, Redis, dan SSE.
  sportsFeedMaxEvents: int('SPORTS_FEED_MAX_EVENTS', 500, 20, 500),
  sportsFeedMaxCacheBytes: int('SPORTS_FEED_MAX_CACHE_BYTES', 8_388_608, 262_144, 15_000_000),
  // Eviction agresif provider cache: entri lama langsung dibuang sebelum menumpuk di RAM.
  sportsProviderCacheMaxEntries: int('SPORTS_PROVIDER_CACHE_MAX_ENTRIES', 40, 1, 10000),
  sportsProviderCacheMaxEntryBytes: int('SPORTS_PROVIDER_CACHE_MAX_ENTRY_BYTES', 1_048_576, 1024, 100_000_000),
  sportsProviderCacheMaxTotalBytes: int('SPORTS_PROVIDER_CACHE_MAX_TOTAL_BYTES', 4_000_000, 1024, 100_000_000),

  // Provider credentials are read only by core and may be mounted as Docker secrets.
  apiSportsKey,
  apiSportsBaseUrl: text('API_SPORTS_BASE_URL', 'https://v3.football.api-sports.io'),
  apiSportsEnabled: pricedProviderEnabled('API_SPORTS_ENABLED', apiSportsKey),
  apiSportsDaysAhead: int('API_SPORTS_DAYS_AHEAD', 14, 0, 14),
  apiSportsOddsPages: int('API_SPORTS_ODDS_PAGES', 2, 1, 20),
  apiSportsLiveRefreshSeconds: int('API_SPORTS_LIVE_REFRESH_SECONDS', 30, 15, 300),
  apiSportsPrematchRefreshSeconds: int('API_SPORTS_PREMATCH_REFRESH_SECONDS', 300, 60, 1800),
  // API-Sports free plan = 100 request/hari (divalidasi via GET /status:
  // {"plan":"Free","requests":{"limit_day":100}}). Guard kuota di
  // sportsbook-providers.js memecah angka ini menjadi jeda minimum per endpoint
  // (live 75%, prematch 25%) sehingga loop refresh 30 detik tidak pernah
  // meledakkan kuota. Naikkan ke 7500 bila upgrade Pro ($19/bln): floor otomatis
  // jatuh di bawah TTL konfigurasi dan guard menjadi transparan.
  apiSportsDailyQuota: int('API_SPORTS_DAILY_QUOTA', 100, 10, 200000),
  sharpApiKey,
  sharpApiBaseUrl: text('SHARP_API_BASE_URL', 'https://api.sharpapi.io'),
  sharpApiEnabled: pricedProviderEnabled('SHARP_API_ENABLED', sharpApiKey),
  sharpApiSport: text('SHARP_API_SPORT', 'soccer'),
  // Production fetches the complete SharpAPI soccer catalog. Filtering to only main/spread/total/1st_half
  // silently discarded BTTS, Double Chance, team totals and other provider markets.
  sharpApiMarkets: isProduction ? '' : text('SHARP_API_MARKETS', 'main,spread,total,1st_half'),
  sharpApiSportsbook: text('SHARP_API_SPORTSBOOK', ''),
  sharpApiPreferredSportsbooks: text('SHARP_API_PREFERRED_SPORTSBOOKS', 'sbobet,pinnacle,bet365'),
  sharpApiRefreshSeconds: int('SHARP_API_REFRESH_SECONDS', isProduction ? 45 : 30, 15, 1800),
  sharpApiMaxPages: int('SHARP_API_MAX_PAGES', isProduction ? 5 : 3, 1, 10),
  sharpApiPageSize: int('SHARP_API_PAGE_SIZE', 200, 25, 200),
  sharpApiMainLinesOnly: bool('SHARP_API_MAIN_LINES_ONLY', false),
  theOddsApiKey: theOddsApiKeys[0] || '',
  theOddsApiKeys,
  theOddsApiFailoverRemainingThreshold: boundedInt('THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD', 10, 0, 500),
  theOddsApiBaseUrl: text('THE_ODDS_API_BASE_URL', 'https://api.the-odds-api.com/v4'),
  theOddsApiEnabled: pricedProviderEnabled('THE_ODDS_API_ENABLED', theOddsApiKeys[0] || ''),
  theOddsApiRegions: text('THE_ODDS_API_REGIONS', 'eu,uk'),
  theOddsApiMarkets: text('THE_ODDS_API_MARKETS', 'h2h,spreads,totals'),
  theOddsApiEventMarketsEnabled: bool('THE_ODDS_API_EVENT_MARKETS_ENABLED', isProduction && theOddsApiKeys.length > 0),
  theOddsApiEventMarkets: text('THE_ODDS_API_EVENT_MARKETS', 'h2h_3_way_h1,spreads_h1,totals_h1,btts,btts_h1,double_chance,double_chance_h1,halftime_fulltime'),
  theOddsApiEventMaxEventsPerSport: int('THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT', 25, 0, 50),
  theOddsApiEventMaxTotalEvents: int('THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS', 120, 0, 120),
  // Keep the configured provider catalog intact; the feed-level event and Redis byte
  // limits remain the final resource guards for the consolidated snapshot.
  theOddsApiMaxTotalEvents: int('THE_ODDS_API_MAX_TOTAL_EVENTS', 500, 0, 500),
  theOddsApiRefreshSeconds: int('THE_ODDS_API_REFRESH_SECONDS', 300, 60, 1800),
  theOddsApiEventRefreshSeconds: int('THE_ODDS_API_EVENT_REFRESH_SECONDS', 300, 60, 1800),
  theOddsApiBookmakers: text('THE_ODDS_API_BOOKMAKERS'),
  theOddsApiSportKeys: text('THE_ODDS_API_SPORT_KEYS', 'soccer_australia_aleague,soccer_austria_bundesliga,soccer_belgium_first_div,soccer_brazil_campeonato,soccer_china_superleague,soccer_conmebol_libertadores,soccer_conmebol_sudamericana,soccer_denmark_superliga,soccer_efl_champ,soccer_england_league1,soccer_england_league2,soccer_fa_cup,soccer_france_ligue_one,soccer_france_ligue_two,soccer_germany_bundesliga,soccer_germany_bundesliga2,soccer_germany_liga3,soccer_greece_super_league,soccer_italy_serie_a,soccer_italy_serie_b,soccer_japan_j_league,soccer_korea_kleague1,soccer_mexico_ligamx,soccer_netherlands_eredivisie,soccer_netherlands_eerste_divisie,soccer_norway_eliteserien,soccer_poland_ekstraklasa,soccer_portugal_primeira_liga,soccer_spain_la_liga,soccer_spain_segunda_division,soccer_sweden_allsvenskan,soccer_switzerland_superleague,soccer_turkey_super_league,soccer_usa_mls,soccer_uefa_champs_league,soccer_uefa_europa_league,soccer_uefa_europa_conference_league'),
  theSportsDbKey,
  theSportsDbBaseUrl: text('THESPORTSDB_BASE_URL', 'https://www.thesportsdb.com/api'),
  theSportsDbEnabled: bool('THESPORTSDB_ENABLED', false),
  theSportsDbLeagueIds: text('THESPORTSDB_LEAGUE_IDS', '4328,4335,4332,4331,4334,4387'),
  // Sportmonks is the sole sportsbook fixture and odds provider.
  sportmonksBaseUrl: text('SPORTMONKS_BASE_URL', 'https://api.sportmonks.com/v3'),
  sportmonksKey,
  sportmonksEnabled: bool('SPORTMONKS_ENABLED', isProduction && Boolean(sportmonksKey)),
  sportmonksDaysAhead: int('SPORTMONKS_DAYS_AHEAD', 30, 0, 30),
  sportmonksRefreshSeconds: int('SPORTMONKS_REFRESH_SECONDS', 300, 60, 1800),
  sportmonksOddsRefreshSeconds: int('SPORTMONKS_ODDS_REFRESH_SECONDS', 180, 30, 1800),
  sportmonksPriorityLeagues: text('SPORTMONKS_PRIORITY_LEAGUES', 'Premier League,La Liga,Serie A,Bundesliga,Ligue 1,UEFA Champions League,UEFA Europa League,UEFA Europa Conference League,Eredivisie,Primeira Liga,Major League Soccer'),
  // Cap per-provider normalized events independently from the larger aggregated feed.
  sportmonksMaxTotalEvents: boundedInt('SPORTMONKS_MAX_TOTAL_EVENTS', 500, 0, 500),
  sportmonksRequestDelayMs: int('SPORTMONKS_REQUEST_DELAY_MS', 0, 0, 60000),
  sportsbookArtworkEnabled: bool('SPORTSBOOK_ARTWORK_ENABLED', false),
  sportsbookArtworkBaseUrl: text('SPORTSBOOK_ARTWORK_BASE_URL', 'https://www.thesportsdb.com/api/v1/json'),
  // TheSportsDB publishes 123 as its current free V1 API key. Artwork is metadata-only and
  // never participates in pricing, bet acceptance or settlement authority.
  sportsbookArtworkApiKey: text('SPORTSBOOK_ARTWORK_API_KEY', '123'),
  sportsbookArtworkCacheSeconds: int('SPORTSBOOK_ARTWORK_CACHE_SECONDS', 86400, 3600, 2592000),
  sportsbookArtworkNegativeCacheSeconds: int('SPORTSBOOK_ARTWORK_NEGATIVE_CACHE_SECONDS', 21600, 300, 86400),
  sportsbookArtworkMaxLookupsPerMinute: int('SPORTSBOOK_ARTWORK_MAX_LOOKUPS_PER_MINUTE', 20, 1, 30),
  sportsbookArtworkMaxLookupsPerRefresh: int('SPORTSBOOK_ARTWORK_MAX_LOOKUPS_PER_REFRESH', 16, 1, 30),
  sportsbookArtworkTimeoutMs: int('SPORTSBOOK_ARTWORK_TIMEOUT_MS', 5000, 1000, 15000),
  // R6.9.0.15: Gasterus-owned public market feed. No commercial odds-provider credential is required.
  // Upcoming fixtures + bookmaker anchor prices are collected from Football-Data's downloadable public CSV,
  // then normalized and expanded by Gasterus's own probability/market engine.
  publicMarketEnabled: bool('PUBLIC_MARKET_ENABLED', true),
  publicMarketOpenFootballEnabled: isProduction ? false : bool('PUBLIC_MARKET_OPENFOOTBALL_ENABLED', true),
  publicMarketFixturesUrl: text('PUBLIC_MARKET_FIXTURES_URL', 'https://www.football-data.co.uk/fixtures.csv'),
  publicMarketExtraFixturesPageUrl: text('PUBLIC_MARKET_EXTRA_FIXTURES_PAGE_URL', 'https://www.football-data.co.uk/matches_new_leagues.php'),
  publicMarketLatestResultsUrl: text('PUBLIC_MARKET_LATEST_RESULTS_URL', 'https://www.football-data.co.uk/new/Latest_Results.csv'),
  publicMarketRefreshSeconds: int('PUBLIC_MARKET_REFRESH_SECONDS', 900, 300, 21600),
  publicMarketMaxStaleSeconds: int('PUBLIC_MARKET_MAX_STALE_SECONDS', 172800, 1800, 604800),
  publicMarketRequestTimeoutMs: int('PUBLIC_MARKET_REQUEST_TIMEOUT_MS', 12000, 2000, 30000),
  publicMarketMaxEvents: int('PUBLIC_MARKET_MAX_EVENTS', 100, 10, 500),
  publicMarketDerivedMarketsEnabled: bool('PUBLIC_MARKET_DERIVED_MARKETS_ENABLED', !isProduction),
  publicMarketDerivedMarginBps: int('PUBLIC_MARKET_DERIVED_MARGIN_BPS', 450, 100, 1200),
  publicMarketPriceMaxAgeSeconds: int('PUBLIC_MARKET_PRICE_MAX_AGE_SECONDS', 604800, 900, 604800),
  sportsbookRiskRepricingEnabled: bool('SPORTSBOOK_RISK_REPRICING_ENABLED', true),
  sportsbookRiskRepricingMaxShadeBps: int('SPORTSBOOK_RISK_REPRICING_MAX_SHADE_BPS', 600, 0, 2000),
  // Background poll diperlambat 30s -> 90s agar worker tidak request berturut-turut.
  // Volume event TETAP penuh (500); yang dikurangi hanya frekuensi refresh.
  sportsFeedRefreshSeconds: int('SPORTS_FEED_REFRESH_SECONDS', 90, 5, 300),
  sportsFeedStaleSeconds: int('SPORTS_FEED_STALE_SECONDS', 180, 30, 3600),
  sportsbookFinishedEventRetentionSeconds: int('SPORTSBOOK_FINISHED_EVENT_RETENTION_SECONDS', 21600, 3600, 86400),
  sportsbookMemberHorizonDays: int('SPORTSBOOK_MEMBER_HORIZON_DAYS', 30, 1, 60),
  sportsbookMemberMaxEvents: int('SPORTSBOOK_MEMBER_MAX_EVENTS', 500, 20, 500),
  sportsFeedRequestTimeoutMs: int('SPORTS_FEED_REQUEST_TIMEOUT_MS', 12000, 2000, 30000),
  sportsbookProviderFailureThreshold: int('SPORTSBOOK_PROVIDER_FAILURE_THRESHOLD', 3, 1, 20),
  sportsbookProviderRecoverySuccesses: int('SPORTSBOOK_PROVIDER_RECOVERY_SUCCESSES', 2, 1, 20),
  sportsbookProviderCooldownSeconds: int('SPORTSBOOK_PROVIDER_COOLDOWN_SECONDS', 30, 5, 3600),
  sportsbookProviderIncidentLimit: int('SPORTSBOOK_PROVIDER_INCIDENT_LIMIT', 100, 10, 500),
  sportsbookMarketReopenSuccesses: int('SPORTSBOOK_MARKET_REOPEN_SUCCESSES', 2, 1, 20),
  sportsbookMarketReopenObservationSeconds: int('SPORTSBOOK_MARKET_REOPEN_OBSERVATION_SECONDS', 30, 1, 3600),
  sportsbookMarketLifecycleRetentionSeconds: int('SPORTSBOOK_MARKET_LIFECYCLE_RETENTION_SECONDS', 86400, 300, 604800),
  sportsbookMinStake: int('SPORTSBOOK_MIN_STAKE', 1000, 100, 100000000),
  sportsbookMaxStake: int('SPORTSBOOK_MAX_STAKE', 50000000, 1000, 1000000000),
  sportsbookMaxPayout: int('SPORTSBOOK_MAX_PAYOUT', 500000000, 10000, 2000000000),
  sportsbookMaxLegs: int('SPORTSBOOK_MAX_LEGS', 12, 2, 30),
  sportsbookMaxSystemCombinations: int('SPORTSBOOK_MAX_SYSTEM_COMBINATIONS', 120, 1, 1000),
  sportsbookOddsTolerance: Number(text('SPORTSBOOK_ODDS_TOLERANCE', '0.001')),
  sportsbookOddsChangePolicyDefault: text('SPORTSBOOK_ODDS_CHANGE_POLICY_DEFAULT', 'REJECT').toUpperCase(),
  sportsbookLiveAcceptanceDelayMs: int('SPORTSBOOK_LIVE_ACCEPTANCE_DELAY_MS', 3000, 3000, 10000),
  sportsbookQuoteTtlSeconds: int('SPORTSBOOK_QUOTE_TTL_SECONDS', 15, 5, 60),
  sportsbookQuoteRequired: bool('SPORTSBOOK_QUOTE_REQUIRED', process.env.NODE_ENV === 'production'),
  sportsbookPrematchCloseGraceSeconds: int('SPORTSBOOK_PREMATCH_CLOSE_GRACE_SECONDS', 30, 0, 300),
  sportsbookMaxLivePriceAgeSeconds: int('SPORTSBOOK_MAX_LIVE_PRICE_AGE_SECONDS', 90, 15, 600),
  sportsbookMaxPrematchPriceAgeSeconds: int('SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS', 900, 60, 7200),
  sportsbookMaxEventLiability: int('SPORTSBOOK_MAX_EVENT_LIABILITY', 2000000000, 100000, 2000000000),
  sportsbookMaxMarketLiability: int('SPORTSBOOK_MAX_MARKET_LIABILITY', 1000000000, 100000, 2000000000),
  sportsbookMaxSelectionLiability: int('SPORTSBOOK_MAX_SELECTION_LIABILITY', 500000000, 100000, 2000000000),
  // R6.9.0.12: when autonomous FT result authority is unavailable, healthy prematch
  // SharpAPI prices may be accepted with an explicit operator-settlement guarantee.
  // This never applies to LIVE or 1H markets and never fabricates result scores.
  sportsbookManualFtSettlementFallbackEnabled: isProduction ? true : bool('SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED', false),
  sportsbookAutoSettlementEnabled: bool('SPORTSBOOK_AUTO_SETTLEMENT_ENABLED', true),
  sportsbookAutoSettlementSeconds: int('SPORTSBOOK_AUTO_SETTLEMENT_SECONDS', 30, 15, 600),
  // Settlement TOTO otomatis: begitu hasil OFFICIAL/CONSENSUS terbit dan betting
  // window tertutup, periodenya dibayar otomatis tanpa operator menekan tombol.
  // Set TOTO_AUTO_SETTLEMENT_ENABLED=false sebagai kill switch.
  totoAutoSettlementEnabled: bool('TOTO_AUTO_SETTLEMENT_ENABLED', true),
  totoAutoSettlementSeconds: int('TOTO_AUTO_SETTLEMENT_SECONDS', 30, 10, 600),
  sportsbookCashoutEnabled: bool('SPORTSBOOK_CASHOUT_ENABLED', true),
  sportsbookCashoutOfferTtlSeconds: int('SPORTSBOOK_CASHOUT_OFFER_TTL_SECONDS', 8, 3, 30),
  sportsbookCashoutFactorBps: int('SPORTSBOOK_CASHOUT_FACTOR_BPS', 9600, 5000, 10000),
  sportsbookCashoutMinOffer: int('SPORTSBOOK_CASHOUT_MIN_OFFER', 100, 1, 100000000),
  sportsbookRealtimeEnabled: bool('SPORTSBOOK_REALTIME_ENABLED', true),
  sportsbookRealtimePollMs: int('SPORTSBOOK_REALTIME_POLL_MS', 2000, 1000, 15000),
  sportsbookRealtimeHeartbeatSeconds: int('SPORTSBOOK_REALTIME_HEARTBEAT_SECONDS', 15, 5, 60),
  sportsbookRealtimeMaxClients: int('SPORTSBOOK_REALTIME_MAX_CLIENTS', 2500, 10, 20000),

  // QRIS auto deposit (DANA OpenAPI / QRIS Acquirer). When credentials are
  // absent the system automatically falls back to MANUAL mode (static QRIS +
  // existing admin approval flow), so deposits never break.
  qrisAutoProvider: text('QRIS_AUTO_PROVIDER', 'DANA'),
  danaApiUrl: text('DANA_API_URL', 'https://api.dana.id'),
  danaGenerateQrisPath: text('DANA_GENERATE_QRIS_PATH', '/dana-web/v1.0/qr/generate-qr'),
  danaMid: text('DANA_MID', ''),
  danaMerchantId: optionalSecret('DANA_MERCHANT_ID'),
  danaPrivateKeyPem: optionalSecret('DANA_PRIVATE_KEY'),
  danaWebhookSecret: optionalSecret('DANA_WEBHOOK_SECRET'),
  qrisOrderTtlMinutes: int('QRIS_ORDER_TTL_MINUTES', 30, 5, 1440),
  qrisProviderTimeoutMs: int('QRIS_PROVIDER_TIMEOUT_MS', 12000, 2000, 30000),
  qrisStaticPayload: text('QRIS_STATIC_PAYLOAD', ''),
  qrisStaticImageUrl: text('QRIS_STATIC_IMAGE_URL', ''),

  // Casino aggregator via RapidAPI (key hanya dari env, tidak pernah ke frontend).
  rapidApiKey,
  rapidApiCasinoEnabled: bool('RAPIDAPI_CASINO_ENABLED', Boolean(rapidApiKey)),
  rapidApiCasinoCacheSeconds: int('RAPIDAPI_CASINO_CACHE_SECONDS', 300, 15, 3600),
  rapidApiCasinoTimeoutMs: int('RAPIDAPI_CASINO_TIMEOUT_MS', 12000, 3000, 30000),
  betnexApiKey,
  betnexCallbackKey,
  betnexRealMoneyEnabled: bool('BETNEX_REAL_MONEY_ENABLED', false)
});

const mfaKey = Buffer.from(config.mfaEncryptionKeyBase64, 'base64');
if (mfaKey.length !== 32) throw new Error('MFA_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
export const mfaEncryptionKey = mfaKey;
