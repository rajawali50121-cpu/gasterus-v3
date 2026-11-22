import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const renderDockerfile = read('../../deploy/Dockerfile.sportsbook-render-worker');
const backendEnv = read('../.env.example');
const workerEnv = read('../.env.worker.example');
const app = read('../src/app.js');
const worker = read('../src/sportsbook-render-worker.js');
const workerCore = read('../src/sportsbook-render-worker-core.js');
const feed = read('../src/sportsbook-feed.js');
const feedSource = read('../src/sportsbook-feed-source.js');
const ingestion = read('../src/sportsbook-ingestion.js');
const ingestClient = read('../src/sportsbook-ingest-client.js');
const config = read('../src/config.js');
const architecture = read('../../docs/operations/RAILWAY-ARCHITECTURE.md');

test('worker has a separate minimal Node image and entrypoint', () => {
  assert.match(renderDockerfile, /^FROM node:22\./m);
  assert.match(renderDockerfile, /COPY backend\/package\*\.json \.\/backend\//);
  assert.match(renderDockerfile, /npm ci --omit=dev/);
  assert.match(renderDockerfile, /COPY backend\/src \.\/backend\/src/);
  assert.match(renderDockerfile, /CMD \["node", "backend\/src\/sportsbook-render-worker\.js"\]/);
});

test('Sportradar credential and base URL exist only in the worker environment example', () => {
  assert.doesNotMatch(backendEnv, /^SPORTRADAR_(API_KEY|BASE_URL|ENABLED)=/m);
  assert.match(workerEnv, /^SPORTRADAR_API_KEY=/m);
  assert.match(workerEnv, /^SPORTRADAR_BASE_URL=https:\/\/api\.sportradar\.com\/oddscomparison-prematch\/production\/v2\/en$/m);
  assert.match(workerEnv, /^SPORTSBOOK_INGEST_URL=http:\/\/gasterus-v3\.railway\.internal\/api\/internal\/sportsbook\/ingest$/m);
  assert.match(workerEnv, /^SPORTSBOOK_CRON_ONCE=false$/m);
  assert.match(worker, /MFA_ENCRYPTION_KEY_BASE64/);
});

test('backend is a consumer only and the worker is the only Sportradar fetch path', () => {
  assert.match(worker, /sportradar-provider\.js/);
  assert.match(worker, /buildSportsbookRenderSnapshot/);
  assert.doesNotMatch(worker, /sportsbook-providers\.js|fetchSportmonks|fetchSharpApi|fetchOddsPapi|fetchRapidApiOdds/);
  assert.doesNotMatch(feed, /fetchSportradar|fetchLocalProviders|fetchSportmonks|fetchSharpApi|fetchOddsPapi/);
  assert.match(feed, /resolveSportsbookProviderResults/);
  assert.match(feedSource, /SPORTS_SNAPSHOT_REQUIRED/);
  assert.match(ingestion, /const ALLOWED_PROVIDERS = new Set\(\['sportradar'\]\)/);
  assert.match(workerCore, /Sportradar must be the only sportsbook provider/);
});

test('ingest endpoint is signed and private-network HTTP is restricted to Railway internal DNS', () => {
  assert.match(ingestClient, /createHmac\('sha256'/);
  assert.match(ingestClient, /hostname\.endsWith\('\.railway\.internal'\)/);
  assert.match(ingestClient, /endpoint must use HTTPS/);
  assert.ok(app.includes('internal\\/sportsbook\\/ingest'));
});

test('stale, unexecutable Railway TypeScript snapshot is not kept in the repository', () => {
  assert.equal(existsSync(new URL('../../.railway/railway.ts', import.meta.url)), false);
  assert.match(architecture, /Canonical deployment source: `railway-migration-fix-039`/);
  assert.match(architecture, /Cloudflare remains the frontend platform/);
});

test('Sportradar trial access is always refused in production', () => {
  const result = spawnSync(process.execPath, ['src/sportsbook-render-worker.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SPORTRADAR_ENABLED: 'true',
      SPORTRADAR_API_KEY: 'test-sportradar-key',
      SPORTRADAR_BASE_URL: 'https://api.sportradar.com/oddscomparison-prematch/trial/v2/en',
      SPORTSBOOK_CRON_ONCE: 'true',
      SPORTRADAR_ALLOW_TRIAL_IN_PRODUCTION: 'true',
      SPORTSBOOK_INGEST_URL: 'http://gasterus-v3.railway.internal/api/internal/sportsbook/ingest',
      SPORTSBOOK_INGEST_HMAC_SECRET: 's'.repeat(48),
      DATABASE_URL: 'postgres://user:password@example.com/db',
      REDIS_URL: 'redis://example.com:6379',
      MEMBER_PROXY_SECRET: 'm'.repeat(48),
      ADMIN_PROXY_SECRET: 'a'.repeat(48),
      OPS_INTERNAL_SECRET: 'o'.repeat(48),
      SESSION_HMAC_KEY: 's'.repeat(48),
      API_KEY_PEPPER: 'p'.repeat(48)
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires production Sportradar access/);
});

test('automatic sportsbook settlement is disabled by default without an approved results authority', () => {
  assert.match(config, /sportsbookAutoSettlementEnabled: bool\('SPORTSBOOK_AUTO_SETTLEMENT_ENABLED', false\)/);
  assert.match(read('../src/sportsbook-settlement-authority.js'), /const automaticFt = false/);
  assert.match(read('../src/sportsbook-settlement-authority.js'), /const ht = false|ht: false/);
});
