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
  databaseSsl: bool('DATABASE_SSL', false),
  pgPoolMax: int('PG_POOL_MAX', 15, 2, 100),
  memberProxySecret: testSecret('MEMBER_PROXY_SECRET', 32, 'test-member-proxy-secret-0123456789'),
  adminProxySecret: testSecret('ADMIN_PROXY_SECRET', 32, 'test-admin-proxy-secret-0123456789'),
  opsInternalSecret: testSecret('OPS_INTERNAL_SECRET', 32, 'test-ops-internal-secret-0123456789'),
  sessionHmacKey: testSecret('SESSION_HMAC_KEY', 32, 'test-session-hmac-key-passphrase-123'),
  apiKeyPepper: testSecret('API_KEY_PEPPER', 32, 'test-api-key-pepper-passphrase-1234'),
  mfaEncryptionKeyBase64: testSecret('MFA_ENCRYPTION_KEY_BASE64', 40, Buffer.alloc(32, 7).toString('base64')),
  // Snapshot render data must expire within 4 hours; ingest request signature freshness
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
  feedWorkerEnabled: bool('FEED_WORKER_ENABLED', true),
  // Event dan payload TIDAK dibatasi di sisi feed; semua event dari provider
  // lewat tanpa potongan. Batas fisik (memori worker, Redis) tetap berlaku.
  // Zero = no cap; pagination dihabiskan sampai halaman terakhir API.

  // never participates in pricing, bet acceptance or settlement authority.
  // Settlement TOTO otomatis: begitu hasil OFFICIAL/CONSENSUS terbit dan betting
  // window tertutup, periodenya dibayar otomatis tanpa operator menekan tombol.
  // Set TOTO_AUTO_SETTLEMENT_ENABLED=false sebagai kill switch.
  totoAutoSettlementEnabled: bool('TOTO_AUTO_SETTLEMENT_ENABLED', true),
  totoAutoSettlementSeconds: int('TOTO_AUTO_SETTLEMENT_SECONDS', 30, 10, 600),

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

