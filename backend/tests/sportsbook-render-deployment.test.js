import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const renderDockerfile = readFileSync(new URL('../../deploy/Dockerfile.sportsbook-render-worker', import.meta.url), 'utf8');
const railway = readFileSync(new URL('../../.railway/railway.ts', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../../deploy/member-server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/sportsbook-render-worker.js', import.meta.url), 'utf8');
const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const webServiceBlock = railway.match(/const web = service\("web", \{[\s\S]*?\n  \}\);/)?.[0] || '';
const workerServiceBlock = railway.match(/const sportsbookRenderWorker = service\("sportsbook-render-worker", \{[\s\S]*?\n  \}\);/)?.[0] || '';

const INGEST_PATH = '/api/internal/sportsbook/ingest';
// Nilai env worker memakai bentuk `KEY: "value"`; bentuk preserve() di blok web
// tidak ikut tertangkap regex ini sehingga hasilnya eksplisit milik worker.
const railwayWebEnv = key => webServiceBlock.match(new RegExp(`${key}: "([^"]*)"`))?.[1];
const railwayWorkerEnv = key => workerServiceBlock.match(new RegExp(`${key}: "([^"]*)"`))?.[1];

test('global railway.json does not override per-service Railway IaC Dockerfiles', () => {
  assert.equal(existsSync(new URL('../../railway.json', import.meta.url)), false);
});

test('Railway scraper runs in its own slim service image with a hard heap ceiling', () => {
  assert.match(railway, /service\("sportsbook-render-worker"/);
  assert.match(railway, /dockerfilePath: "deploy\/Dockerfile\.sportsbook-render-worker"/);
  assert.match(railway, /NODE_OPTIONS: "--max-old-space-size=224"/);
  assert.match(railway, /resources: \[Postgres, web, sportsbookRenderWorker, Redis, postgresVolume, redisVolume\]/);

  // Secret diwariskan dari service web — tidak diduplikasi manual.
  assert.match(workerServiceBlock, /API_FOOTBALL_KEY:\s*preserve\(\)/);
  assert.equal(railwayWorkerEnv('API_SPORTS_ENABLED'), undefined);
  assert.equal(railwayWorkerEnv('API_SPORTS_DAILY_QUOTA'), undefined);
  assert.equal(railwayWorkerEnv('API_SPORTS_MONTHLY_QUOTA'), undefined);
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_HMAC_SECRET'), '${{web.SPORTSBOOK_INGEST_HMAC_SECRET}}');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_INGEST_URL'), '${{web.SPORTSBOOK_INGEST_URL}}');
  assert.equal(railwayWorkerEnv('DATABASE_URL'), '${{web.DATABASE_URL}}');
  assert.equal(railwayWorkerEnv('REDIS_URL'), '${{web.REDIS_URL}}');
  assert.equal(railwayWorkerEnv('ODDSPAPI_ENABLED'), undefined);
  assert.equal(railwayWorkerEnv('ODDSPAPI_API_KEY'), undefined);
  assert.equal(railwayWorkerEnv('SPORTRADAR_ENABLED'), 'true');
  assert.match(workerServiceBlock, /SPORTRADAR_API_KEY:\s*preserve\(\)/);
  assert.doesNotMatch(webServiceBlock, /SPORTRADAR_API_KEY|SPORTRADAR_BASE_URL/, 'only the isolated worker may call Sportradar');
  assert.equal(railwayWorkerEnv('SPORTRADAR_BASE_URL'), 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en');
  assert.match(railway, /SPORTRADAR_API_KEY:\s*preserve\(\)/);
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

test('production sportsbook worker refuses trial Sportradar access before polling', () => {
  const result = spawnSync(process.execPath, ['src/sportsbook-render-worker.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SPORTRADAR_ENABLED: 'true',
      SPORTRADAR_API_KEY: 'test-sportradar-key',
      SPORTRADAR_BASE_URL: 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en',
      SPORTSBOOK_INGEST_URL: 'https://example.invalid/api/internal/sportsbook/ingest',
      SPORTSBOOK_INGEST_HMAC_SECRET: 's'.repeat(48),
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit trial access in one-shot cron mode/);
});

test('render worker uses Sportradar exclusively with no artificial event/page caps', () => {
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_EVENTS'), '0');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_RENDER_MAX_PAGES'), '0');
  assert.equal(railwayWorkerEnv('SPORTRADAR_MAX_EVENTS'), '0');
  assert.equal(railwayWorkerEnv('SPORTRADAR_MAX_PAGES'), '0');
  assert.equal(railwayWorkerEnv('SPORTRADAR_MAX_CALLS_PER_HOUR'), '0');
  assert.equal(railwayWorkerEnv('SPORTRADAR_SPORT_IDS'), 'sr:sport:1');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_DAILY_REFRESH_ENABLED'), 'false');
  assert.equal(railwayWorkerEnv('SPORTSBOOK_CRON_ONCE'), 'true');
  assert.equal(railwayWorkerEnv('SPORTRADAR_ALLOW_TRIAL_IN_PRODUCTION'), 'true');
  assert.ok(workerServiceBlock.includes('cronSchedule: "5 17 * * *"'));
  assert.match(worker, /SPORTSBOOK_CRON_ONCE/);
  assert.match(worker, /event: 'worker-config'/);
  assert.equal(railwayWorkerEnv('SPORTSBOOK_PREMATCH_WINDOW_DAYS'), '7');
  assert.equal(railwayWebEnv('SPORTS_FEED_MAX_EVENTS'), '0');
  assert.equal(railwayWebEnv('SPORTS_FEED_MAX_CACHE_BYTES'), '0');
  assert.equal(railwayWebEnv('SPORTSBOOK_DAILY_REFRESH_ENABLED'), 'true');
  assert.equal(railwayWebEnv('SPORTSBOOK_STORED_SNAPSHOT_MAX_AGE_SECONDS'), '172800');
  assert.equal(railwayWebEnv('SPORTSBOOK_INGEST_MAX_AGE_SECONDS'), '600');
  assert.match(worker, /fetchSportradar/);
  assert.match(worker, /config\.nodeEnv === 'production'/);
  assert.match(worker, /SPORTRADAR_API_KEY is required/);
  assert.match(worker, /production.*v2.*en/);
  assert.match(worker, /trial access in one-shot cron mode/);
  assert.doesNotMatch(worker, /fetchSportmonks|fetchSharpApi|fetchOddsPapi/);
  assert.match(feed, /fetchSportradar/);
  assert.match(feed, /config\.nodeEnv === 'production'/);
  assert.match(feed, /code: 'sportradar'/);
  assert.match(feed, /Number\(MAX_FEED_EVENTS\) > 0/, 'zero feed event limit must mean unlimited, not reject all cache reads');
  assert.equal(railwayWorkerEnv('SPORTMONKS_ENABLED'), undefined);
  assert.equal(railwayWorkerEnv('SPORTMONKS_API_KEY'), undefined);
  assert.equal(railwayWorkerEnv('ODDSPAPI_ENABLED'), undefined);
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
