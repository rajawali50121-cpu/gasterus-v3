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
  assert.equal(railwayWorkerEnv('THE_ODDS_API_KEY'), '${{web.THE_ODDS_API_KEY}}');

  // Image hanya membawa backend/src — tanpa frontend/node_modules berat.
  assert.match(renderDockerfile, /^FROM node:22\./m);
  assert.match(renderDockerfile, /COPY backend\/src \.\/backend\/src/);
  assert.match(renderDockerfile, /CMD \["node", "backend\/src\/sportsbook-render-worker\.js"\]/);
});

test('worker runs Sportmonks as primary with The Odds API fallback inside the quota/RAM budget', () => {
  assert.equal(railwayWorkerEnv('THE_ODDS_API_ENABLED'), 'true');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_REGIONS'), 'eu');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_MARKETS'), 'h2h');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MARKETS_ENABLED'), 'false');
  assert.equal(railwayWorkerEnv('THE_ODDS_API_EVENT_MAX_TOTAL_EVENTS'), '0');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_EVENTS'), '500');
  // Anggaran halaman penuh diteruskan ke fetchSportmonks agar snapshot ingest
  // mengambil cakupan luas (bukan terpotong ~17 match oleh pembagian statis).
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_PAGES'), '120');
  assert.match(worker, /maxPages: config\.sportsbookRenderMaxPages/);
  // Snapshot besar wajib selaras dengan anggaran payload ingest SEBELUM berangkat
  // (trim deterministik, bukan gagal 413 diam-diam yang membekukan feed).
  assert.match(worker, /maxPayloadBytes: config\.sportsbookIngestMaxPayloadBytes/);
  assert.match(worker, /fetchOddsApi:\s*fetchTheOddsApi/);

  // Sportmonks primer di worker yang sama: key diwariskan dari web (tanpa
  // service/platform baru) dan dibatasi 500 event agar heap 224MB aman.
  assert.equal(railwayWorkerEnv('SPORTMONKS_ENABLED'), 'true');
  assert.equal(railwayWorkerEnv('SPORTMONKS_API_KEY'), '${{web.SPORTMONKS_API_KEY}}');
  assert.equal(railwayWorkerEnv('SPORTMONKS_MAX_TOTAL_EVENTS'), '500');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REFRESH_SECONDS'), '300');
  assert.equal(railwayWorkerEnv('SPORTMONKS_REQUEST_DELAY_MS'), '0');
  assert.match(worker, /fetchSportmonks/);

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
