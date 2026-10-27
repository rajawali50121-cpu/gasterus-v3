import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Root repo dihitung dari lokasi file test, bukan process.cwd(): test ini harus
// konsisten entah dijalankan dari root repo, dari backend/, atau dari CI/Docker.
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const read=p=>readFileSync(resolve(root,p),'utf8');

test('Railway uses Dockerfile lifecycle, predeploy, and health gate',()=>{
  const cfg=JSON.parse(read('railway.json'));
  assert.equal(cfg.build.builder,'DOCKERFILE');
  assert.equal(cfg.build.dockerfilePath,'deploy/Dockerfile');
  assert.equal(cfg.deploy.preDeployCommand,'node deploy/predeploy.js');
  assert.equal(cfg.deploy.healthcheckPath,'/healthz');
  assert.equal(cfg.deploy.startCommand,undefined);
  assert.equal(typeof cfg.deploy.healthcheckTimeout,'number');
  assert.equal(typeof cfg.deploy.restartPolicyMaxRetries,'number');
  assert.equal(typeof cfg.deploy.drainingSeconds,'number');
  assert.equal(cfg.deploy.drainingSeconds,15);
  assert.deepEqual(JSON.parse(read('railway.json')),cfg);
});



test('Railway public port is bound before dependency readiness to prevent edge 502 during cold start',()=>{
  const s=read('deploy/launcher.js');
  const gateway=s.indexOf("start('gateway'");
  const dependencies=s.indexOf("runWithRetry('dependency readiness'");
  assert.ok(gateway>=0 && dependencies>=0 && gateway<dependencies,'gateway must bind public PORT before dependency readiness');
  assert.match(s,/phase:'public-port-bound'/);
});

test('gateway proxy failure path never writes headers twice after a response has started',()=>{
  const s=read('deploy/gateway.js');
  assert.match(s,/if \(res\.writableEnded \|\| res\.destroyed\) return false;/);
  assert.match(s,/if \(res\.headersSent\) \{ res\.destroy\(\); return false; \}/);
  assert.match(s,/function proxyFailure\(res\)/);
  assert.match(s,/upstream\.on\('error',\(\)=>proxyFailure\(res\)\)/);
  assert.match(s,/upstreamRes\.on\('aborted'/);
  assert.match(s,/upstreamRes\.on\('error'/);
});

test('migration runner records each migration in the same transaction',()=>{
  const s=read('backend/migrations/migrate.js');
  const begin=s.indexOf("client.query('BEGIN')");
  const apply=s.indexOf('await client.query(sql)');
  const mark=s.indexOf('INSERT INTO schema_migrations(version)');
  const commit=s.indexOf("client.query('COMMIT')");
  assert.ok(begin>=0 && apply>=0 && mark>=0 && commit>=0 && begin<apply && apply<mark && mark<commit);
  assert.match(s,/ROLLBACK/);
  assert.match(s,/pg_advisory_lock/);
});

test('Railway launcher does not unconditionally seed on every restart',()=>{
  const s=read('deploy/launcher.js');
  assert.match(s,/const onRailway=/);
  assert.match(s,/RUN_STARTUP_MIGRATIONS/);
  assert.match(s,/if\(runStartupMigrations\)/);
  assert.match(s,/schema-ready\.js/);
});

test('Docker build executes the canonical deploy verification gate before image is accepted',()=>{
  const s=read('deploy/Dockerfile');
  assert.match(s,/node --check deploy\/launcher\.js/);
  assert.match(s,/node --check backend\/src\/sportsbook-browser-renderer\.js|node --check backend\/src\/sportsbook-feed\.js/);
  assert.match(s,/COPY backend \.\/backend/);
  assert.match(s,/ENTRYPOINT \["\/usr\/bin\/tini",\s*"--"\]/);
});


test('Docker image uses official Node 22.23.2 Trixie base, enforces security patch, and PostgreSQL 17 client',()=>{
  const s=read('deploy/Dockerfile');
  assert.match(s,/FROM node:22\.23\.2-trixie-slim/);
  assert.match(s,/Node runtime must be >=22\.23\.2/);
  assert.match(s,/postgresql-client-17/);
});

test('worker can recover durable dispatched outbox jobs after ephemeral Redis restart',()=>{
  const s=read('backend/src/worker.js');
  assert.match(s,/recoverLostDispatchedOutbox/);
  assert.match(s,/outboxId/);
  assert.match(s,/outboxMarkerKey/);
  assert.match(s,/redis\.eval/);
  assert.match(s,/EXISTS/);
  assert.match(s,/status='DISPATCHED'/);
  assert.match(s,/r\.status='QUEUED'/);
});

test('predeploy guarantees a usable owner exists without rotating an existing owner',()=>{
  const pre=read('deploy/predeploy.js');
  const ensure=read('backend/migrations/ensure-owner.js');
  assert.match(pre,/ensure initial owner/);
  assert.match(ensure,/role_code='OWNER'/);
  assert.match(ensure,/OWNER_PASSWORD/);
  assert.match(ensure,/OWNER_TOTP_SECRET/);
  assert.match(ensure,/Owner already exists; bootstrap skipped/);
  assert.doesNotMatch(ensure,/UPDATE users SET password_hash/);
});


test('admin assets remain compatible with /admin path-mode gateway',()=>{
  for(const name of ['index.html','members.html','payments.html','compliance.html','risk.html','support.html','reports.html','security.html','player360.html','content.html']){
    const path=`admin/public/${name}`;
    let html='';
    try{html=read(path);}catch{continue;}
    assert.doesNotMatch(html,/(?:src|href|action)=["']\/[A-Za-z]/i,`${name} has absolute-root asset/form URL`);
    assert.doesNotMatch(html,/fetch\(["']\//i,`${name} has absolute-root fetch URL`);
  }
});

test('production deployment uses explicit runtime configuration and pinned Node image',()=>{
  const config=read('backend/src/config.js');
  const docker=read('deploy/Dockerfile');
  assert.match(config,/DATABASE_URL/);
  assert.match(config,/REDIS_URL/);
  assert.match(docker,/FROM node:22\.23\.2-trixie-slim/);
});
