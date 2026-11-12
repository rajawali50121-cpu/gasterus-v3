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
const providers = readFileSync(new URL('../src/sportsbook-providers.js', import.meta.url), 'utf8');

const INGEST_PATH = '/api/internal/sportsbook/ingest';
// Nilai env worker memakai bentuk `KEY: "value"`; bentuk preserve() di blok web
// tidak ikut tertangkap regex ini sehingga hasilnya eksplisit milik worker.
const railwayWorkerEnv = key => railway.match(new RegExp(`${key}: "([^"]*)"`))?.[1];

test('Railway scraper runs in its own slim service image with a hard heap ceiling', () => {
  assert.match(railway, /service\("sportsbook-render-worker"/);
  assert.match(railway, /dockerfilePath: "deploy\/Dockerfile\.sportsbook-render-worker"/);
  assert.match(railway, /NODE_OPTIONS: "--max-old-space-size=224"/);
  assert.match(railway, /resources: \[Postgres, web, sportsbookRenderWorker, Redis, postgresVolume, redisVolume\]/);

  // Secret diwariskan dari service web — tidak diduplikasi manual.
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_HMAC_SECRET'), '${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{web.SPORTSBOOK_INGEST_URL}}');
  assert.equal(railwayWorkerEnv('SPORTMONKS_API_KEY'), '${{web.SPORTMONKS_API_KEY}}');
  assert.equal(railwayWorkerEnv('SHARP_API_KEY'), '${{web.SHARP_API_KEY}}');

  // The Odds API harus juga dipetakan ke service worker agar adapter dapat diaktifkan.
  assert.equal(railwayWorkerEnv('THE_ODDS_API_ENABLED'), '${{web.THE_ODDS_API_ENABLED}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_KEY'), '${{web.THE_ODDS_API_KEY}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_BASE_URL'), '${{web.THE_ODDS_API_BASE_URL}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_REGIONS'), '${{web.THE_ODDS_API_REGIONS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_MARKETS'), '${{web.THE_ODDS_API_MARKETS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_REFRESH_SECONDS'), '${{web.THE_ODDS_API_REFRESH_SECONDS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_MAX_TOTAL_EVENTS'), '${{web.THE_ODDS_API_MAX_TOTAL_EVENTS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_SPORT_KEYS'), '${{web.THE_ODDS_API_SPORT_KEYS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MARKETS'), '${{web.THE_ODDS_API_EVENT_MARKETS}}');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MARKETS_ENABLED'), '${{web.THE_ODDS_API_EVENT_MARKETS_ENABLED}}');

  // Image hanya membawa backend/src — tanpa frontend/node_modules berat.
  assert.match(renderDockerfile, /^FROM node:22\./m);
  assert.match(renderDockerfile, /COPY backend\/src \.\/backend\/src/);
  assert.match(renderDockerfile, /CMD \["node", "backend\/src\/sportsbook-render-worker\.js"\]/);
});

test('worker uses Sportmonks, MoviOdds and SharpAPI provider adapters', () => {
  assert.equal(railwayWorkerEnv('SPORTMONKS_ENABLED'), '${{web.SPORTMONKS_ENABLED}}');
  assert.equal(railwayWorkerEnv('SHARP_API_ENABLED'), '${{web.SHARP_API_ENABLED}}');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_EVENTS'), '5000');
  assert.match(worker, /fetchMoviOdds,\s*fetchSharpApi,\s*fetchSportmonks/);
  assert.match(worker, /fetchMoviOdds,/);
  assert.match(worker, /config\.sportmonksRefreshSeconds/);
  assert.match(worker, /config\.movioddsRefreshSeconds/);
  assert.match(worker, /config\.sharpApiRefreshSeconds/);
  assert.match(config, /movioddsGroupIds:[\s\S]*text\('MOVIODDS_GROUP_IDS', '40'\)/);
  assert.match(config, /movioddsMaxStaleSeconds: int\('MOVIODDS_MAX_STALE_SECONDS', 180/);
  assert.match(config, /movioddsTotalsGroupPriority:[\s\S]*'981,10202,10143,50139'/);
  assert.match(config, /decimal\('MOVIODDS_1X2_MIN_IMPLIED_PROBABILITY', 1\.005/);
  assert.match(config, /decimal\('MOVIODDS_1X2_MAX_IMPLIED_PROBABILITY', 1\.2/);
  assert.doesNotMatch(providers, /'11': Object\.freeze\(\{ type: 'HANDICAP_3WAY'/);
  assert.doesNotMatch(providers, /'50264': Object\.freeze\(\{ type: 'HANDICAP_3WAY'/);
  assert.match(providers, /MOVIODDS_FORBIDDEN_GROUPS = new Set\(\['1777', '4001'\]\)/);

  const prematchWindow = Number(config.match(/sportsbookMaxPrematchPriceAgeSeconds: int\('SPORTSBOOK_MAX_PREMATCH_PRICE_AGE_SECONDS', (\d+)/)?.[1]);
  assert.ok(Number.isFinite(prematchWindow));
  assert.ok(config.includes("sportmonksRefreshSeconds: int('SPORTMONKS_REFRESH_SECONDS', 300"));
  assert.ok(config.includes("sharpApiRefreshSeconds: int('SHARP_API_REFRESH_SECONDS', isProduction ? 45"));
});

test('ingest URL, env example, both proxies and backend route stay aligned', () => {
  const envUrl = envExample.match(/^SPORTSBOOK_INGEST_URL=(\S+)$/m)?.[1];
  assert.ok(envUrl?.endsWith(INGEST_PATH), 'URL ingest menunjuk ke /api/internal/sportsbook/ingest');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{web.SPORTSBOOK_INGEST_URL}}');
  assert.match(envExample, /^THE_ODDS_API_REFRESH_SECONDS=720$/m);
  assert.match(envExample, /^THE_ODDS_API_SPORT_KEYS=soccer_epl,/m);

  assert.match(proxy, /url\.pathname === '\/api\/internal\/sportsbook\/ingest'/);
  assert.match(proxy, /request\.method !== 'POST'/);
  assert.match(proxy, /x-sportsbook-timestamp/);
  assert.match(proxy, /x-sportsbook-signature/);
  assert.ok(app.includes(String.raw`\/api\/internal\/sportsbook\/ingest`), 'backend app.js wajib mendaftarkan rute ingest internal');
});

test('Railway Redis keeps a hard memory ceiling to prevent instance OOM', () => {
  assert.match(railway, /--maxmemory 128mb/);
  assert.match(railway, /--maxmemory-policy volatile-lru/);
  assert.match(railway, /--maxmemory-samples 5/);
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

test('configureProviderOnlyRuntime requires DATABASE_URL and REDIS_URL in production, tidak boleh dummy fallback', () => {
  const workerSource = worker;
  // Fungsi harus memeriksa NODE_ENV === 'production' sebelum melempar kesalahan koneksi.
  assert.match(workerSource, /NODE_ENV === 'production'/);
  // Jika DATABASE_URL hilang di production, harus throw error.
  assert.match(workerSource, /missing\.push\('DATABASE_URL'\)/);
  assert.match(workerSource, /missing\.push\('REDIS_URL'\)/);
  // Jika semua variabel terpenuhi, fungsi harus return tanpa override dummy.
  assert.match(workerSource, /return;/);
  // Test/development path hanya isi dummy jika belum ada.
  assert.match(workerSource, /if \(!process\.env\.DATABASE_URL\)/);
  assert.match(workerSource, /if \(!process\.env\.REDIS_URL\)/);
  // Dummy URL harus mengandung tanda tidak valid agar tidak tertukar dengan production.
  assert.match(workerSource, /unused\.invalid/);
  assert.match(workerSource, /127\.0\.0\.1:1/);
});
