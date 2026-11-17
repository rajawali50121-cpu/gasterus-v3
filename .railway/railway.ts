import { defineRailway, github, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const Redis = redis("Redis", { region: "sfo" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --maxmemory 128mb --maxmemory-policy volatile-lru --maxmemory-samples 5 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 500 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 500 });
  const web = service("web", {
    source: github("rajawali50121-cpu/gasterus-v3", { branch: "master", checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/Dockerfile" },
    preDeploy: "node deploy/predeploy.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    replicas: { "sfo": 1 },
    env: {
      ADMIN_PASSWORD: preserve(),
      ADMIN_PROXY_SECRET: preserve(),
      API_KEY_PEPPER: preserve(),
      APP_URL: preserve(),
      CORS_ORIGIN: preserve(),
      CORE_HEAP_MB: preserve(),
      DATABASE_URL: preserve(),
      FEED_WORKER_ENABLED: preserve(),
      FEED_WORKER_HEAP_MB: preserve(),
      FOOTBALLDATA_IO_BASE_URL: preserve(),
      FOOTBALLDATA_IO_ENABLED: preserve(),
      FOOTBALLDATA_IO_KEY: preserve(),
      FOOTBALLDATA_IO_REFRESH_SECONDS: preserve(),
      FOOTBALLDATA_IO_UPCOMING_LIMIT: preserve(),
      FRONTEND_RESET_URL: preserve(),
      GATEWAY_HEAP_MB: preserve(),
      JWT_SECRET: preserve(),
      MEMBER_PROXY_SECRET: preserve(),
      MEMBER_HEAP_MB: preserve(),
      MFA_ENCRYPTION_KEY_BASE64: preserve(),
      MY_API_TOKEN: preserve(),
      NODE_ENV: preserve(),
      NODE_OPTIONS: preserve(),
      OPS_INTERNAL_SECRET: preserve(),
      OWNER_PASSWORD: preserve(),
      OWNER_TOTP_SECRET: preserve(),
      OWNER_USERNAME: preserve(),
      PUBLIC_MARKET_DERIVED_MARKETS_ENABLED: preserve(),
      PUBLIC_MARKET_OPENFOOTBALL_ENABLED: preserve(),
      RAPIDAPI_CASINO_ENABLED: preserve(),
      RAPIDAPI_CASINO_KEY: preserve(),
      REDIS_URL: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_FROM_EMAIL: preserve(),
      RUN_STARTUP_MIGRATIONS: preserve(),
      SESSION_HMAC_KEY: preserve(),
      SPORTRADAR_API_KEY: preserve(),
      SPORTRADAR_BASE_URL: preserve(),
      SHARP_API_BASE_URL: preserve(),
      SHARP_API_ENABLED: preserve(),
      SHARP_API_KEY: preserve(),
      SHARP_API_MARKETS: preserve(),
      SHARP_API_MAX_PAGES: preserve(),
      SHARP_API_PAGE_SIZE: preserve(),
      SHARP_API_REFRESH_SECONDS: preserve(),
      SHARP_API_SPORT: preserve(),
      SPORTS_SOURCE_BACKGROUND_POLL_ENABLED: preserve(),
      SPORTSBOOK_INGEST_HMAC_SECRET: preserve(),
      SPORTSBOOK_INGEST_MAX_AGE_SECONDS: preserve(),
      SPORTSBOOK_INGEST_URL: preserve(),
      SPORTSBOOK_RENDER_MAX_EVENTS: preserve(),
      SPORTMONKS_API_KEY: preserve(),
      SPORTMONKS_PASSTHROUGH: preserve(),
      SPORTMONKS_DAYS_AHEAD: preserve(),
      SPORTMONKS_ENABLED: preserve(),
      SPORTMONKS_MARKET_IDS: preserve(),
      SPORTMONKS_MAX_RESPONSE_BYTES: preserve(),
      SPORTMONKS_MAX_RETRIES: preserve(),
      SPORTMONKS_MAX_PAGES: preserve(),
      SPORTMONKS_MAX_TOTAL_EVENTS: preserve(),
      SPORTMONKS_LIVE_REFRESH_SECONDS: preserve(),
      SPORTMONKS_ODDS_REFRESH_SECONDS: preserve(),
      SPORTMONKS_PAGE_SIZE: preserve(),
      SPORTMONKS_REQUEST_DELAY_MS: preserve(),
      WORKER_HEAP_MB: preserve()
    }
  });
  // Scraper odds berjalan sebagai service TERPISAH agar beban scrape tidak
  // pernah menyentuh memori service web (anti-OOM). Pengaman:
  //   - heap V8 dikunci 224MB lewat NODE_OPTIONS (container ~512MB)
  //   - Sportradar adalah satu-satunya sumber odds produksi; seluruh halaman
  //     prematch dibaca sampai halaman terakhir, tanpa batas event/halaman buatan.
  //   - Hanya provider yang di-wire oleh worker dipanggil; provider lain tidak
  //     diaktifkan sebagai cadangan tersembunyi.
  //   - provider dijalankan sekuensial (satu payload pada satu waktu); data
  //     event valid tidak dipangkas diam-diam; kegagalan validasi membatalkan snapshot.
  const sportsbookRenderWorker = service("sportsbook-render-worker", {
    source: github("rajawali50121-cpu/gasterus-v3", { branch: "master", checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/Dockerfile.sportsbook-render-worker" },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10
    },
    replicas: { "sfo": 1 },
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=224",
      API_FOOTBALL_KEY: preserve(),
      DATABASE_URL: "${{web.DATABASE_URL}}",
      REDIS_URL: "${{web.REDIS_URL}}",
      SPORTRADAR_ENABLED: "true",
      SPORTRADAR_API_KEY: "${{web.SPORTRADAR_API_KEY}}",
      SPORTRADAR_BASE_URL: "${{web.SPORTRADAR_BASE_URL}}",
      SPORTRADAR_DAYS_AHEAD: "7",
      SPORTRADAR_MAX_PAGES: "0",
      SPORTRADAR_MAX_EVENTS: "0",
      SPORTRADAR_MAX_CALLS_PER_HOUR: "0",
      SPORTRADAR_MIN_INTERVAL_MS: "1100",
      SPORTRADAR_REFRESH_SECONDS: "300",
      SPORTSBOOK_DAILY_REFRESH_ENABLED: "false",
      SPORTSBOOK_PREMATCH_WINDOW_DAYS: "7",
      SPORTSBOOK_INGEST_URL: "${{web.SPORTSBOOK_INGEST_URL}}",
      SPORTSBOOK_INGEST_HMAC_SECRET: "${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}",
      SPORTSBOOK_RENDER_MAX_EVENTS: "0",
      SPORTSBOOK_RENDER_MAX_PAGES: "0"
    }
  });

  return project("gasterus-v3", {
    resources: [Postgres, web, sportsbookRenderWorker, Redis, postgresVolume, redisVolume],
  });
});
