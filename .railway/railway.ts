// STALE LEGACY SNAPSHOT — DO NOT RUN railway config plan/apply with this file.
// Verified live target differs: project unique-possibility / production, region iad,
// backend service gasterus-v3 on railway-migration-fix-039, a deployed Sportradar-only
// worker, and a live one-shot gasterus-db-migration service. This file still contains
// legacy web/master/sfo/provider configuration and omits live resources. Regenerate
// from the NEW Railway project with `railway config pull`, then review all diffs,
// volumes and deletions before enabling IaC. See docs/operations/RAILWAY-ARCHITECTURE.md.
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
      FRONTEND_RESET_URL: preserve(),
      GATEWAY_HEAP_MB: preserve(),
      JWT_SECRET: preserve(),
      MEMBER_PROXY_SECRET: preserve(),
      MEMBER_HEAP_MB: preserve(),
      MY_API_TOKEN: preserve(),
      NODE_ENV: preserve(),
      NODE_OPTIONS: preserve(),
      OPS_INTERNAL_SECRET: preserve(),
      OWNER_PASSWORD: preserve(),
      OWNER_USERNAME: preserve(),
      RAPIDAPI_CASINO_ENABLED: preserve(),
      RAPIDAPI_CASINO_KEY: preserve(),
      REDIS_URL: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_FROM_EMAIL: preserve(),
      RUN_STARTUP_MIGRATIONS: preserve(),
      SESSION_HMAC_KEY: preserve(),
      SPORTS_SOURCE_BACKGROUND_POLL_ENABLED: preserve(),
      SPORTSBOOK_INGEST_HMAC_SECRET: preserve(),
      SPORTSBOOK_INGEST_MAX_AGE_SECONDS: "600",
      SPORTSBOOK_DAILY_REFRESH_ENABLED: "true",
      SPORTSBOOK_STORED_SNAPSHOT_MAX_AGE_SECONDS: "172800",
      SPORTSBOOK_PREMATCH_WINDOW_DAYS: "7",
      SPORTS_FEED_MAX_EVENTS: "0",
      SPORTS_FEED_MAX_CACHE_BYTES: "0",
      SPORTSBOOK_INGEST_URL: preserve(),
      SPORTSBOOK_RENDER_MAX_EVENTS: preserve(),
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
      cronSchedule: "5 17 * * *",
      restartPolicyType: "NEVER"
    },
    replicas: { "sfo": 1 },
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=224",
      DATABASE_URL: "${{web.DATABASE_URL}}",
      REDIS_URL: "${{web.REDIS_URL}}",
      SPORTRADAR_ENABLED: "true",
      SPORTRADAR_API_KEY: preserve(),
      SPORTRADAR_BASE_URL: "https://api.sportradar.com/oddscomparison-prematch/trial/v2/en",
      SPORTRADAR_SPORT_IDS: "sr:sport:1",
      SPORTRADAR_ALLOW_TRIAL_IN_PRODUCTION: "true",
      SPORTSBOOK_CRON_ONCE: "true",
      SPORTRADAR_DAYS_AHEAD: "7",
      SPORTRADAR_MAX_PAGES: "0",
      SPORTRADAR_MAX_EVENTS: "0",
      SPORTRADAR_MAX_CALLS_PER_HOUR: "20",
      SPORTRADAR_MIN_INTERVAL_MS: "1100",
      SPORTRADAR_REFRESH_SECONDS: "300",
      SPORTSBOOK_DAILY_REFRESH_ENABLED: "false",
      SPORTSBOOK_PREMATCH_WINDOW_DAYS: "7",
      SPORTSBOOK_INGEST_URL: "${{web.SPORTSBOOK_INGEST_URL}}",
      SPORTSBOOK_INGEST_HMAC_SECRET: "${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}",
      SPORTSBOOK_INGEST_MAX_AGE_SECONDS: "${{web.SPORTSBOOK_INGEST_MAX_AGE_SECONDS}}",
      SPORTSBOOK_RENDER_MAX_EVENTS: "0",
      SPORTSBOOK_RENDER_MAX_PAGES: "0"
    }
  });

  return project("gasterus-v3", {
    resources: [Postgres, web, sportsbookRenderWorker, Redis, postgresVolume, redisVolume],
  });
});
