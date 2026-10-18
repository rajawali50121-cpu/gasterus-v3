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
      API_SPORTS_BASE_URL: preserve(),
      API_SPORTS_DAILY_QUOTA: preserve(),
      API_SPORTS_DAYS_AHEAD: preserve(),
      API_SPORTS_ENABLED: preserve(),
      API_SPORTS_KEY: preserve(),
      API_SPORTS_LIVE_REFRESH_SECONDS: preserve(),
      API_SPORTS_ODDS_PAGES: preserve(),
      API_SPORTS_PREMATCH_REFRESH_SECONDS: preserve(),
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
      SPORTSBOOK_INGEST_URL: preserve(),
      SPORTSBOOK_RENDER_MAX_EVENTS: preserve(),
      SPORTMONKS_API_KEY: preserve(),
      SPORTMONKS_DAYS_AHEAD: preserve(),
      SPORTMONKS_ENABLED: preserve(),
      SPORTMONKS_MARKET_IDS: preserve(),
      SPORTMONKS_MAX_RESPONSE_BYTES: preserve(),
      SPORTMONKS_MAX_RETRIES: preserve(),
      SPORTMONKS_MAX_TOTAL_EVENTS: preserve(),
      SPORTMONKS_ODDS_REFRESH_SECONDS: preserve(),
      SPORTMONKS_PAGE_SIZE: preserve(),
      SPORTMONKS_REQUEST_DELAY_MS: preserve(),
      THE_ODDS_API_BASE_URL: preserve(),
      THE_ODDS_API_ENABLED: preserve(),
      THE_ODDS_API_EVENT_MARKETS_ENABLED: preserve(),
      THE_ODDS_API_EVENT_MARKETS: preserve(),
      THE_ODDS_API_KEY: preserve(),
      THE_ODDS_API_MARKETS: preserve(),
      THE_ODDS_API_MAX_TOTAL_EVENTS: preserve(),
      THE_ODDS_API_REGIONS: preserve(),
      THE_ODDS_API_SPORT_KEYS: preserve(),
      THE_ODDS_API_REFRESH_SECONDS: preserve(),
      WORKER_HEAP_MB: preserve()
    }
  });
  // Scraper odds berjalan sebagai service TERPISAH agar beban scrape tidak
  // pernah menyentuh memori service web (anti-OOM). Pengaman:
  //   - heap V8 dikunci 224MB lewat NODE_OPTIONS (container ~512MB)
  //   - Sportmonks SUMBER UTAMA cakupan luas: halaman dibatasi 30 x 20 = 600
  //     kandidat -> snapshot maks 500 event; key diwariskan dari web sehingga
  //     tidak perlu service/platform baru
  //   - The Odds API CADANGAN 5 liga andalan; h2h x eu = 1 kredit/request;
  //     refresh 720 dtk (di bawah jendela harga prematch 900 dtk)
  //   - provider dijalankan sekuensial (satu payload pada satu waktu), market
  //     per-event dimatikan (tanpa fetch tambahan), cache provider berbatas
  //     byte, snapshot berbatas 500 event / 6MB
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
      SPORTSBOOK_INGEST_URL: "${{web.SPORTSBOOK_INGEST_URL}}",
      SPORTSBOOK_INGEST_HMAC_SECRET: "${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}",
      SPORTSBOOK_RENDER_MAX_EVENTS: "500",
      THE_ODDS_API_ENABLED: "true",
      THE_ODDS_API_KEY: "${{web.THE_ODDS_API_KEY}}",
      THE_ODDS_API_REGIONS: "eu",
      THE_ODDS_API_MARKETS: "h2h",
      THE_ODDS_API_REFRESH_SECONDS: "720",
      THE_ODDS_API_MAX_TOTAL_EVENTS: "500",
      THE_ODDS_API_EVENT_MARKETS_ENABLED: "false",
      THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: "0",
      THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: "0",
      THE_ODDS_API_SPORT_KEYS: "soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_uefa_champs_league",
      // Sportmonks primer (cakupan luas). Key & batas diwariskan/diset di
      // worker yang sama — service web tetap bebas beban scrape Sportmonks.
      SPORTMONKS_ENABLED: "true",
      SPORTMONKS_API_KEY: "${{web.SPORTMONKS_API_KEY}}",
      SPORTMONKS_MAX_TOTAL_EVENTS: "500",
      SPORTMONKS_REFRESH_SECONDS: "300",
      SPORTMONKS_REQUEST_DELAY_MS: "0"
    }
  });

  return project("gasterus-v3", {
    resources: [Postgres, web, sportsbookRenderWorker, Redis, postgresVolume, redisVolume],
  });
});
