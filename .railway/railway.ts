import { defineRailway, github, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "iad" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const Redis = redis("Redis", { region: "iad" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const backend = service("gasterus-v3", {
    source: github("rajawali50121-cpu/gasterus-v3", { branch: "master", checkSuites: false }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/Dockerfile" },
    deploy: {
      preDeployCommand: ["node deploy/predeploy.js"],
      healthcheckPath: "/healthz",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: 15
    },
    replicas: { "iad": 1 },
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
      SPORTS_FEED_MAX_CACHE_BYTES: "8388608",
      SPORTS_FEED_MAX_EVENTS: "500",
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
      SPORTSBOOK_INGEST_URL: "https://gasterus-v3-production.up.railway.app/api/internal/sportsbook/ingest",
      SPORTSBOOK_RENDER_MAX_EVENTS: preserve(),
      SPORTMONKS_API_KEY: preserve(),
      SPORTMONKS_BASE_URL: "https://api.sportmonks.com/v3",
      SPORTMONKS_DAYS_AHEAD: preserve(),
      SPORTMONKS_ENABLED: "true",
      SPORTMONKS_MARKET_IDS: preserve(),
      SPORTMONKS_MAX_RESPONSE_BYTES: preserve(),
      SPORTMONKS_MAX_RETRIES: preserve(),
      SPORTMONKS_MAX_TOTAL_EVENTS: preserve(),
      SPORTMONKS_REFRESH_SECONDS: "60",
      SPORTMONKS_ODDS_REFRESH_SECONDS: "60",
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
  //   - The Odds API: EPL + La Liga, h2h/spreads/totals x eu; refresh 840 dtk
  //     memakai maksimal 618 kredit/hari (batas 667), di bawah jendela harga
  //     prematch 900 dtk.
  //   - provider dijalankan sekuensial (satu payload pada satu waktu), market
  //     per-event dimatikan (tanpa fetch tambahan), cache provider berbatas
  //     byte, snapshot berbatas 500 event / 6MB
  const sportsbookRenderWorker = service("sportsbook-render-worker", {
    source: github("rajawali50121-cpu/gasterus-v3", { branch: "master", checkSuites: false }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/Dockerfile.sportsbook-render-worker" },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10
    },
    replicas: { "iad": 1 },
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=224",
      SPORTSBOOK_INGEST_URL: "${{gasterus-v3.SPORTSBOOK_INGEST_URL}}",
      SPORTSBOOK_INGEST_HMAC_SECRET: "${{gasterus-v3.SPORTSBOOK_INGEST_HMAC_SECRET}}",
      SPORTSBOOK_RENDER_MAX_EVENTS: "500",
      SPORTSBOOK_RENDER_MAX_PAGES: "120",
      SPORTMONKS_API_KEY: "${{gasterus-v3.SPORTMONKS_API_KEY}}",
      SPORTMONKS_ENABLED: "true",
      SPORTMONKS_BASE_URL: "https://api.sportmonks.com/v3",
      SPORTMONKS_REFRESH_SECONDS: "60",
      SPORTMONKS_ODDS_REFRESH_SECONDS: "60",
      THE_ODDS_API_ENABLED: "true",
      THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD: preserve(),
      THE_ODDS_API_KEY: preserve(),
      THE_ODDS_API_KEY_2: preserve(),
      THE_ODDS_API_KEYS: preserve(),
      THE_ODDS_API_REGIONS: "eu",
      THE_ODDS_API_MARKETS: "h2h,spreads,totals",
      THE_ODDS_API_REFRESH_SECONDS: "840",
      THE_ODDS_API_MAX_TOTAL_EVENTS: "500",
      THE_ODDS_API_EVENT_MARKETS_ENABLED: "false",
      THE_ODDS_API_EVENT_MAX_EVENTS_PER_SPORT: "0",
      THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS: "0",
      THE_ODDS_API_SPORT_KEYS: "soccer_epl,soccer_spain_la_liga",
    }
  });

  return project("gasterus-v3", {
    resources: [Postgres, backend, sportsbookRenderWorker, Redis, postgresVolume, redisVolume],
  });
});
