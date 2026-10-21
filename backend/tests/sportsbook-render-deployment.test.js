import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderDockerfile = readFileSync(new URL('../../deploy/Dockerfile.sportsbook-render-worker', import.meta.url), 'utf8');
const railway = readFileSync(new URL('../../.railway/railway.ts', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../../deploy/member-server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');

const INGEST_PATH = '/api/internal/sportsbook/ingest';
// Nilai env worker memakai bentuk `KEY: "value"`; bentuk preserve() di blok backend
// tidak ikut tertangkap regex ini sehingga hasilnya eksplisit milik worker.
const workerConfig = railway.slice(railway.indexOf('const sportsbookRenderWorker = service('));
const railwayWorkerEnv = key => workerConfig.match(new RegExp(`${key}: "([^"]*)"`))?.[1];
const backendConfig = railway.slice(railway.indexOf('const backend = service('), railway.indexOf('// Scraper odds'));
const workerServiceConfig = railway.slice(railway.indexOf('const sportsbookRenderWorker = service('), railway.indexOf('return project('));
const railwayWorkerPreserves = key => new RegExp(`${key}: preserve\\(\\)`).test(workerServiceConfig);

test('Railway scraper runs in its own slim service image with a hard heap ceiling', () => {
  assert.match(railway, /service\("sportsbook-render-worker"/);
  assert.match(railway, /dockerfilePath: "deploy\/Dockerfile\.sportsbook-render-worker"/);
  assert.match(railway, /NODE_OPTIONS: "--max-old-space-size=224"/);
  assert.match(railway, /service\("gasterus-v3"/);
  assert.match(railway, /resources: \[Postgres, backend, sportsbookRenderWorker, Redis, postgresVolume, redisVolume\]/);
  assert.match(backendConfig,/build:\s*\{\s*builder:\s*"DOCKERFILE",\s*dockerfilePath:\s*"deploy\/Dockerfile"\s*\}/);
  assert.match(backendConfig,/preDeployCommand:\s*\[\s*"node deploy\/predeploy\.js"\s*\]/);
  assert.match(backendConfig,/healthcheckPath:\s*"\/healthz"/);
  assert.match(backendConfig,/healthcheckTimeout:\s*300/);
  assert.match(backendConfig,/restartPolicyType:\s*"ON_FAILURE"/);
  assert.match(backendConfig,/restartPolicyMaxRetries:\s*10/);
  assert.match(backendConfig,/drainingSeconds:\s*15/);
  assert.match(workerServiceConfig,/build:\s*\{\s*builder:\s*"DOCKERFILE",\s*dockerfilePath:\s*"deploy\/Dockerfile\.sportsbook-render-worker"\s*\}/);
  assert.match(workerServiceConfig,/restartPolicyType:\s*"ON_FAILURE"/);
  assert.match(workerServiceConfig,/restartPolicyMaxRetries:\s*10/);

  // Secret ingest diwariskan; Odds API credentials tetap dikelola langsung pada worker.
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_HMAC_SECRET'), '${{gasterus-v3.SPORTSBOOK_INGEST_HMAC_SECRET}}');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{gasterus-v3.SPORTSBOOK_INGEST_URL}}');
  assert.equal(railwayWorkerEnv('SPORTMONKS_API_KEY'), '${{gasterus-v3.SPORTMONKS_API_KEY}}');
  assert.equal(railwayWorkerEnv('SPORTMONKS_ENABLED'), 'true');
  assert.equal(railwayWorkerEnv('SPORTMONKS_BASE_URL'), 'https://api.sportmonks.com/v3');
  assert.equal(railwayWorkerEnv('SPORTMONKS_MAX_PAGES_PER_REFRESH'), '30');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REQUEST_DELAY_MS'), '1000');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REFRESH_SECONDS'), '60');
  assert.equal(railwayWorkerEnv('SPORTMONKS_ODDS_REFRESH_SECONDS'), '60');
  assert.match(backendConfig, /SPORTSBOOK_INGEST_HMAC_SECRET: preserve\(\)/);
  assert.match(backendConfig, /SPORTMONKS_API_KEY: preserve\(\)/);
  assert.match(backendConfig, /SPORTMONKS_ENABLED: "true"/);
  assert.match(backendConfig, /SPORTMONKS_BASE_URL: "https:\/\/api\.sportmonks\.com\/v3"/);
  assert.match(backendConfig, /SPORTMONKS_MAX_PAGES_PER_REFRESH: "30"/);
  assert.match(backendConfig, /SPORTMONKS_REQUEST_DELAY_MS: "1000"/);
  assert.equal(railwayWorkerPreserves('THE_ODDS_API_KEY'), true);
  assert.equal(railwayWorkerPreserves('THE_ODDS_API_KEY_2'), true);
  assert.equal(railwayWorkerPreserves('THE_ODDS_API_KEYS'), true);
  assert.equal(railwayWorkerPreserves('THE_ODDS_API_FAILOVER_REMAINING_THRESHOLD'), true);
  assert.match(backendConfig, /THE_ODDS_API_KEY: preserve\(\)/);
  assert.match(config, /optionalSecret\('THE_ODDS_API_KEY'\)/);
  assert.match(config, /theOddsApiKeys/);
  assert.match(envExample, /^THE_ODDS_API_KEY=replace-with-your-the-odds-api-key$/m);
  assert.match(config, /sportsbookIngestHmacSecret: optionalSecret\('SPORTSBOOK_INGEST_HMAC_SECRET'\)/);
  assert.match(config, /sportmonksBaseUrl: text\('SPORTMONKS_BASE_URL', 'https:\/\/api\.sportmonks\.com\/v3'\)/);
  assert.match(config, /sportmonksEnabled: bool\('SPORTMONKS_ENABLED', isProduction && Boolean\(sportmonksKey\)\)/);

  // Image hanya membawa backend/src — tanpa frontend/node_modules berat.
  assert.match(renderDockerfile, /^FROM node:22\./m);
  assert.match(renderDockerfile, /COPY backend\/src \.\/backend\/src/);
  assert.match(renderDockerfile, /CMD \["node", "backend\/src\/sportsbook-render-worker\.js"\]/);
});

test('worker polls The Odds API markets inside the quota/RAM budget', () => {
  assert.equal(railwayWorkerEnv('THE_ODDS_API_ENABLED'), 'true');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_REGIONS'), 'eu');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_MARKETS'), 'h2h,spreads,totals');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MARKETS_ENABLED'), 'false');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS'), '0');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_EVENTS'), '500');
  // Batas render diteruskan ke worker agar ukuran snapshot tetap terjaga.
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_PAGES'), '120');
  assert.match(worker, /maxPages: config\.sportsbookRenderMaxPages/);
  assert.match(worker, /maxSportmonksPages: config\.sportmonksMaxPagesPerRefresh/);
  // Snapshot besar wajib selaras dengan anggaran payload ingest SEBELUM berangkat
  // (trim deterministik, bukan gagal 413 diam-diam yang membekukan feed).
  assert.match(worker, /maxPayloadBytes: config\.sportsbookIngestMaxPayloadBytes/);
  assert.match(worker, /fetchOddsApi:\s*fetchTheOddsApi/);

  const sportKeys = (railwayWorkerEnv('THE_ODDS_API_SPORT_KEYS') || '').split(',').map(v => v.trim()).filter(Boolean);
  assert.ok(sportKeys.includes('soccer_epl'), 'Premier League wajib termasuk dalam cakupan scraper');
  assert.ok(sportKeys.length >= 1 && sportKeys.length <= 5, 'daftar sport dibatasi liga andalan agar RAM aman');

  // Refresh wajib lebih cepat dari jendela harga prematch agar taruhan tidak
  // pernah ditolak SPORTS_PRICE_STALE.
  const refreshSeconds = Number(railwayWorkerEnv('THE_ODDS_API_REFRESH_SECONDS'));
  const prematchWindow = Number(config.match(/sportsbookMaxPrematchPriceAgeSeconds: int\('SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS', (\d+)/)?.[1]);
  assert.ok(Number.isFinite(refreshSeconds) && Number.isFinite(prematchWindow));
  assert.ok(refreshSeconds < prematchWindow, `refresh ${refreshSeconds}s harus lebih cepat dari jendela prematch ${prematchWindow}s`);

  // Kuota Professional 667 kredit/hari; biaya per request = markets x regions.
  const creditsPerDay = sportKeys.length * Math.ceil(86400 / refreshSeconds)
    * railwayWorkerEnv('THE_ODDS_API_MARKETS').split(',').filter(Boolean).length
    * railwayWorkerEnv('THE_ODDS_API_REGIONS').split(',').filter(Boolean).length;
  assert.ok(creditsPerDay <= 667, `anggaran ${creditsPerDay} kredit/hari melebihi kuota Professional 667/hari`);
});

test('ingest URL, env example, both proxies and backend route stay aligned', () => {
  const envUrl = envExample.match(/^SPORTSBOOK_INGEST_URL=(\S+)$/m)?.[1];
  assert.ok(envUrl?.endsWith(INGEST_PATH), 'URL ingest menunjuk ke /api/internal/sportsbook/ingest');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{gasterus-v3.SPORTSBOOK_INGEST_URL}}');
  assert.match(envExample, /^THE_ODDS_API_MARKETS=h2h,spreads,totals$/m);
  assert.match(envExample, /^THE_ODDS_API_REFRESH_SECONDS=840$/m);
  assert.match(envExample, /^THE_ODDS_API_SPORT_KEYS=soccer_epl,/m);

  assert.match(proxy, /url\.pathname === '\/api\/internal\/sportsbook\/ingest'/);
  assert.match(proxy, /request\.method !== 'POST'/);
  assert.match(proxy, /x-sportsbook-timestamp/);
  assert.match(proxy, /x-sportsbook-signature/);
  assert.ok(app.includes(String.raw`\/api\/internal\/sportsbook\/ingest`), 'backend app.js wajib mendaftarkan rute ingest internal');
});

test('Railway Redis persistence settings match the running service', () => {
  assert.match(railway, /--save 60 1/);
  assert.match(railway, /--dir \$RAILWAY_VOLUME_MOUNT_PATH/);
});

test('member sportsbook endpoints stay clean and fast behind the Cloudflare frontend', () => {
  assert.match(proxy, /url\.pathname\.startsWith\('\/api\/member\/'\)/);
  assert.match(proxy, /request\.method === 'OPTIONS'/);
  assert.match(proxy, /access-control-max-age/);
  assert.match(proxy, /server\.keepAliveTimeout = 65000/);
  assert.match(proxy, /server\.requestTimeout = 30000/);

  // Core menyajikan feed & detail event dari cache Redis (sportsbookSnapshot).
  assert.ok(app.includes(String.raw`\/api\/member\/sportsbook\/events`), 'rute snapshot member wajib terdaftar');
  assert.ok(app.includes(String.raw`\/api\/member\/sportsbook\/stream`), 'rute SSE member wajib terdaftar');
  assert.ok(app.includes('ok(res,await sportsbookSnapshot('), 'feed disajikan dari cache');
  assert.ok(app.includes('ok(res,await sportsbookEventSnapshot('), 'detail event disajikan dari cache');
  // Snapshot worker masuk lewat POST internal saja; keamanannya dijamin
  // validasi HMAC + jendela timestamp + cap payload di acceptSportsbookSnapshot.
  assert.ok(app.includes(String.raw`\/api\/internal\/sportsbook\/ingest`), 'rute ingest internal wajib terdaftar');
});

test('member feed catalog and Redis cache use explicit bounded Railway budgets', () => {
  const backendEnv = railway.slice(railway.indexOf('const backend = service('), railway.indexOf('// Scraper odds'));
  assert.match(backendEnv, /SPORTS_FEED_MAX_EVENTS: "500"/);
  assert.match(backendEnv, /SPORTS_FEED_MAX_CACHE_BYTES: "8388608"/);
  assert.match(config, /sportsFeedMaxEvents: int\('SPORTS_FEED_MAX_EVENTS', 500, 20, 500\)/);
  assert.match(config, /sportsFeedMaxCacheBytes: int\('SPORTS_FEED_MAX_CACHE_BYTES', 8_388_608, 262_144, 15_000_000\)/);
});
