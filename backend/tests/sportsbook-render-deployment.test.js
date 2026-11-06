import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderDockerfile = readFileSync(new URL('../../deploy/Dockerfile.sportsbook-render-worker', import.meta.url), 'utf8');
const railway = readFileSync(new URL('../../.railway/railway.ts', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../../deploy/member-server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8');
const workerServiceBlock = railway.match(/const sportsbookRenderWorker = service\("sportsbook-render-worker", \{[\s\S]*?\n  \}\);/)?.[0] || '';

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
  assert.match(workerServiceBlock, /API_FOOTBALL_KEY:\s*preserve\(\)/);
  assert.equal(railwayWorkerEnv('API_SPORTS_ENABLED'), 'true');
  assert.equal(railwayWorkerEnv('API_SPORTS_DAILY_QUOTA'), '100');
  assert.equal(railwayWorkerEnv('API_SPORTS_MONTHLY_QUOTA'), '3100');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_HMAC_SECRET'), '${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{web.SPORTSBOOK_INGEST_URL}}');
  assert.equal(railwayWorkerEnv('DATABASE_URL'), '${{web.DATABASE_URL}}');
  assert.equal(railwayWorkerEnv('REDIS_URL'), '${{web.REDIS_URL}}');
  assert.equal(railwayWorkerEnv('ODDSPAPI_ENABLED'), 'true');
  assert.match(workerServiceBlock, /ODDSPAPI_API_KEY:\s*preserve\(\)/);
  assert.match(workerServiceBlock, /ODDSPAPI_BASE_URL:\s*preserve\(\)/);
  assert.equal(railwayWorkerEnv('ODDSPAPI_DAILY_REQUEST_BUDGET'), '8');
  assert.equal(railwayWorkerEnv('ODDSPAPI_MONTHLY_REQUEST_BUDGET'), '240');
  assert.doesNotMatch(worker, /127\.0\.0\.1:1|localhost/);
  assert.equal(railwayWorkerEnv('THE_ODDS_API_KEY'), undefined);

  // Image includes only production backend dependencies, not frontend assets.
  assert.match(renderDockerfile, /^FROM node:22\./m);
  assert.match(renderDockerfile, /COPY backend\/package\*\.json \.\/backend\//);
  assert.match(renderDockerfile, /npm ci --omit=dev/);
  assert.match(renderDockerfile, /COPY backend\/src \.\/backend\/src/);
  assert.match(renderDockerfile, /CMD \["node", "backend\/src\/sportsbook-render-worker\.js"\]/);
});

test('render worker is not wired to The Odds API', () => {
  assert.equal(railwayWorkerEnv('THE_ODDS_API_ENABLED'), undefined);
  assert.equal(railwayWorkerEnv('THE_ODDS_API_KEY'), undefined);
  assert.doesNotMatch(worker, /fetchTheOddsApi|fetchOddsApi/);
  assert.doesNotMatch(railway, /^\s*THE_ODDS_API_ENABLED:\s*"true"/m);
  assert.doesNotMatch(envExample, /^THE_ODDS_API_/m);
});

test('render worker keeps provider/page/payload limits and Sportmonks coverage', () => {
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_EVENTS'), '500');
  // Anggaran halaman penuh diteruskan ke fetchSportmonks agar snapshot ingest
  // mengambil cakupan luas (bukan terpotong ~17 match oleh pembagian statis).
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_PAGES'), '120');
  assert.match(worker, /maxPages: config\.sportsbookRenderMaxPages/);
  // Snapshot besar wajib selaras dengan anggaran payload ingest SEBELUM berangkat
  // (trim deterministik, bukan gagal 413 diam-diam yang membekukan feed).
  assert.match(worker, /maxPayloadBytes: config\.sportsbookIngestMaxPayloadBytes/);
  assert.match(worker, /fetchSportmonks/);
  assert.match(worker, /fetchSharpApi/);
  assert.match(worker, /fetchApiSports/);

  // Sportmonks primer di worker yang sama: key diwariskan dari web (tanpa
  // service/platform baru) dan dibatasi 500 event agar heap 224MB aman.
  assert.equal(railwayWorkerEnv('SPORTMONKS_ENABLED'), 'false');
  assert.equal(railwayWorkerEnv('SPORTMONKS_API_KEY'), '${{web.SPORTMONKS_API_KEY}}');
  assert.equal(railwayWorkerEnv('SPORTMONKS_MAX_TOTAL_EVENTS'), '500');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REFRESH_SECONDS'), '300');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REQUEST_DELAY_MS'), '0');
  assert.match(worker, /fetchSportmonks/);

});

test('ingest URL, env example, both proxies and backend route stay aligned', () => {
  const envUrl = envExample.match(/^SPORTSBOOK_INGEST_URL=(\S+)$/m)?.[1];
  assert.ok(envUrl?.endsWith(INGEST_PATH), 'URL ingest menunjuk ke /api/internal/sportsbook/ingest');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{web.SPORTSBOOK_INGEST_URL}}');
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
