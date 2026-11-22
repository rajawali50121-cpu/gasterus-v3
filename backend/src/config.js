import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, boundedInt, int, naturalInt, optionalSecret, requiredSecret, text, unboundedInt } from './env.js';

// Local development: muat backend/.env (gitignored) jika ada. process.loadEnvFile
// TIDAK menimpa variabel yang sudah ada di process.env, jadi variabel produksi
// (Railway dashboard) selalu menang; file ini hanya pengisi celah saat dev lokal.
const localEnvFile = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(localEnvFile)) {
  try { process.loadEnvFile(localEnvFile); } catch { /* .env rusak tidak boleh menggagalkan boot */ }
}

const isRailwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_DEPLOYMENT_ID);
const isProduction = process.env.NODE_ENV === 'production' || isRailwayRuntime;
const isTestRuntime = process.env.NODE_ENV === 'test' || (!process.env.NODE_ENV && !isRailwayRuntime);
const isSportsbookRenderWorker = process.env.SPORTSBOOK_RENDER_WORKER === 'true';
const testSecret = (name, min, fallback) => {
  if (!isTestRuntime) return requiredSecret(name, min);
  const value = String(process.env[name] ?? fallback).trim();
  return value.length >= min ? value : fallback;
};
const theSportsDbKey = optionalSecret('THESPORTSDB_API_KEY');
const rapidApiKey = optionalSecret('RAPIDAPI_CASINO_KEY') || optionalSecret('RAPIDAPI_KEY');
const betnexApiKey = optionalSecret('BETNEX_API_KEY');
const betnexCallbackKey = optionalSecret('BETNEX_CALLBACK_KEY') || betnexApiKey;
const betnexProtocolVerified = bool('BETNEX_SEAMLESS_WALLET_PROTOCOL_VERIFIED', false);


export const config = Object.freeze({
  nodeEnv: isProduction ? 'production' : (process.env.NODE_ENV || 'development'),
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 8080, 1, 65535),
  databaseUrl: isSportsbookRenderWorker ? optionalSecret('DATABASE_URL') : testSecret('DATABASE_URL', 12, 'postgresql://user:pass@localhost:5432/gasterus_test'),
  databaseSsl: bool('DATABASE_SSL', false),
  pgPoolMax: int('PG_POOL_MAX', 15, 2, 100),
  redisUrl: isSportsbookRenderWorker ? optionalSecret('REDIS_URL') : testSecret('REDIS_URL', 12, 'redis://localhost:6379/0'),
  memberProxySecret: testSecret('MEMBER_PROXY_SECRET', 32, 'test-member-proxy-secret-0123456789'),
  adminProxySecret: testSecret('ADMIN_PROXY_SECRET', 32, 'test-admin-proxy-secret-0123456789'),
  opsInternalSecret: testSecret('OPS_INTERNAL_SECRET', 32, 'test-ops-internal-secret-0123456789'),
  sessionHmacKey: testSecret('SESSION_HMAC_KEY', 32, 'test-session-hmac-key-passphrase-123'),
  apiKeyPepper: testSecret('API_KEY_PEPPER', 32, 'test-api-key-pepper-passphrase-1234'),
  mfaEncryptionKeyBase64: testSecret('MFA_ENCRYPTION_KEY_BASE64', 40, Buffer.alloc(32, 7).toString('base64')),
  sportsbookIngestHmacSecret: optionalSecret('SPORTSBOOK_INGEST_HMAC_SECRET'),
  sportsbookIngestMaxAgeSeconds: int('SPORTSBOOK_INGEST_MAX_AGE_SECONDS', 180, 30, 3600),
  // Snapshot render data must expire within 4 hours; ingest request signature freshness
  // remains governed separately by sportsbookIngestMaxAgeSeconds.
  sportsbookStoredSnapshotMaxAgeSeconds: int('SPORTSBOOK_STORED_SNAPSHOT_MAX_AGE_SECONDS', 14400, 180, 604800),
  sportsbookDailyRefreshEnabled: bool('SPORTSBOOK_DAILY_REFRESH_ENABLED', true),
  sportsbookDailyRefreshHourWib: int('SPORTSBOOK_DAILY_REFRESH_HOUR_WIB', 0, 0, 23),
  sportsbookDailyRefreshMinuteWib: int('SPORTSBOOK_DAILY_REFRESH_MINUTE_WIB', 5, 0, 59),
  sportsbookPrematchWindowDays: int('SPORTSBOOK_PREMATCH_WINDOW_DAYS', 7, 1, 365),
  // No artificial event/page caps: pagination is exhausted to the last page
  // returned by the API. Zero = unlimited (API quota is the only real ceiling).
  sportsbookRenderMaxEvents: unboundedInt('SPORTSBOOK_RENDER_MAX_EVENTS', 0, 0),
  sportsbookRenderMaxPages: unboundedInt('SPORTSBOOK_RENDER_MAX_PAGES', 0, 0),
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
  // Explicit feed cadence/freshness settings consumed by sportsbook-feed.js.
  sportsFeedRefreshSeconds: int('SPORTS_FEED_REFRESH_SECONDS', 90, 15, 3600),
  sportsFeedStaleSeconds: int('SPORTS_FEED_STALE_SECONDS', 900, 60, 7200),
  // Event dan payload TIDAK dibatasi di sisi feed; semua event dari provider
  // lewat tanpa potongan. Batas fisik (memori worker, Redis) tetap berlaku.
  // Zero = no cap; pagination dihabiskan sampai halaman terakhir API.
  sportsFeedMaxEvents: unboundedInt('SPORTS_FEED_MAX_EVENTS', 0, 0),
  sportsFeedMaxCacheBytes: unboundedInt('SPORTS_FEED_MAX_CACHE_BYTES', 0, 0),
  // Provider cache tidak dibatasi jumlah entri atau byte; eviction diatur TTL saja.
  sportsProviderCacheMaxEntries: unboundedInt('SPORTS_PROVIDER_CACHE_MAX_ENTRIES', 0, 0),
  sportsProviderCacheMaxEntryBytes: unboundedInt('SPORTS_PROVIDER_CACHE_MAX_ENTRY_BYTES', 0, 0),
  sportsProviderCacheMaxTotalBytes: unboundedInt('SPORTS_PROVIDER_CACHE_MAX_TOTAL_BYTES', 0, 0),

  // Sportradar is the sole sportsbook odds provider. Its credential exists only on the isolated worker.
  // Sportradar is the sole production sportsbook fixtures and odds provider.
  sportradarApiKey: optionalSecret('SPORTRADAR_API_KEY'),
  sportradarEnabled: bool('SPORTRADAR_ENABLED', true),
  sportradarBaseUrl: text('SPORTRADAR_BASE_URL', 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en'),
  sportradarSportIds: text('SPORTRADAR_SPORT_IDS', 'sr:sport:1'),
  sportradarDaysAhead: int('SPORTRADAR_DAYS_AHEAD', 7, 1, 365),
  sportradarMinIntervalMs: int('SPORTRADAR_MIN_INTERVAL_MS', 1100, 100, 30000),
  // Zero disables the local ceiling; the provider account's actual quota and HTTP 429 remain authoritative.
  sportradarMaxCallsPerHour: unboundedInt('SPORTRADAR_MAX_CALLS_PER_HOUR', 0, 0),
  sportradarSharedMaxCallsPerHour: boundedInt('SPORTRADAR_MAX_CALLS_PER_HOUR', 20, 1, 1000),
  // Fail-closed: must be populated from the actual Sportradar contract/current account usage before live calls.
  sportradarMaxCallsPer30Days: naturalInt('SPORTRADAR_MAX_CALLS_PER_30_DAYS', 0, 0),
  sportradarInitial30DayUsage: naturalInt('SPORTRADAR_INITIAL_30_DAY_USAGE', 0, 0),
  sportradarRefreshSeconds: int('SPORTRADAR_REFRESH_SECONDS', 60, 30, 3600),
  sportradarRequestTimeoutMs: int('SPORTRADAR_REQUEST_TIMEOUT_MS', 30000, 5000, 120000),
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
  // Member visibility horizon for verified Sportradar prematch events.
  sportsbookMemberHorizonDays: int('SPORTSBOOK_MEMBER_HORIZON_DAYS', 30, 1, 60),
  sportsbookProviderFailureThreshold: int('SPORTSBOOK_PROVIDER_FAILURE_THRESHOLD', 3, 1, 20),
  sportsbookProviderRecoverySuccesses: int('SPORTSBOOK_PROVIDER_RECOVERY_SUCCESSES', 2, 1, 20),
  sportsbookProviderCooldownSeconds: int('SPORTSBOOK_PROVIDER_COOLDOWN_SECONDS', 30, 5, 3600),
  sportsbookProviderIncidentLimit: int('SPORTSBOOK_PROVIDER_INCIDENT_LIMIT', 100, 10, 500),
  sportsbookMarketReopenSuccesses: int('SPORTSBOOK_MARKET_REOPEN_SUCCESSES', 2, 1, 20),
  sportsbookMarketReopenObservationSeconds: int('SPORTSBOOK_MARKET_REOPEN_OBSERVATION_SECONDS', 30, 1, 3600),
  sportsbookMarketLifecycleRetentionSeconds: int('SPORTSBOOK_MARKET_LIFECYCLE_RETENTION_SECONDS', 86400, 300, 604800),
  sportsbookFinishedEventRetentionSeconds: int('SPORTSBOOK_FINISHED_EVENT_RETENTION_SECONDS', 21600, 3600, 86400),
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
  sportsbookRiskRepricingEnabled: bool('SPORTSBOOK_RISK_REPRICING_ENABLED', true),
  sportsbookRiskRepricingMaxShadeBps: int('SPORTSBOOK_RISK_REPRICING_MAX_SHADE_BPS', 600, 0, 2000),
  // Sportradar supplies odds only. FT settlement requires an explicit operator authority;
  // HT settlement remains unavailable without a separately approved results authority.
  sportsbookManualFtSettlementFallbackEnabled: isProduction ? true : bool('SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED', false),
  sportsbookAutoSettlementEnabled: bool('SPORTSBOOK_AUTO_SETTLEMENT_ENABLED', false),
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
  betnexProtocolVerified,
  betnexRealMoneyEnabled: bool('BETNEX_REAL_MONEY_ENABLED', false) && betnexProtocolVerified
});

const mfaKey = Buffer.from(config.mfaEncryptionKeyBase64, 'base64');
if (mfaKey.length !== 32) throw new Error('MFA_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
export const mfaEncryptionKey = mfaKey;

