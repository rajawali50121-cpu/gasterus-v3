import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Root repo dihitung dari lokasi file test, bukan process.cwd(): test ini harus
// konsisten entah dijalankan dari root repo, dari backend/, atau dari CI/Docker.
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const read=p=>readFileSync(resolve(root,p),'utf8');

test('Railway uses Dockerfile lifecycle, predeploy, and health gate',()=>{
  const railway=read('.railway/railway.ts');
  const core=railway.slice(railway.indexOf('const backend = service("gasterus-v3"'),railway.indexOf('// Scraper odds'));
  assert.match(core,/build:\s*\{\s*builder:\s*"DOCKERFILE",\s*dockerfilePath:\s*"deploy\/Dockerfile"\s*\}/);
  assert.match(core,/preDeployCommand:\s*\[\s*"node deploy\/predeploy\.js"\s*\]/);
  assert.match(core,/healthcheckPath:\s*"\/healthz"/);
  assert.match(core,/healthcheckTimeout:\s*300/);
  assert.match(core,/restartPolicyType:\s*"ON_FAILURE"/);
  assert.match(core,/restartPolicyMaxRetries:\s*10/);
  assert.match(core,/drainingSeconds:\s*15/);
  assert.doesNotMatch(core,/startCommand\s*:/);
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

test('deployment entrypoints require security secrets instead of supplying public defaults',()=>{
  const validator=read('deploy/security-secrets.js');
  const moduleUrl=new URL('../../deploy/security-secrets.js',import.meta.url).href;
  const script=`import(${JSON.stringify(moduleUrl)}).then(({validateSecuritySecrets})=>validateSecuritySecrets())`;
  const runValidator=env=>execFileSync(process.execPath,['--input-type=module','--eval',script],{cwd:root,env:{PATH:process.env.PATH||'',...env}});
  for(const path of ['deploy/launcher.js','deploy/predeploy.js']){
    const source=read(path);
    assert.match(source,/validateSecuritySecrets\(\)/,`${path} must validate required secrets`);
    assert.doesNotMatch(source,/gasterus_(?:member|admin|ops|session|api_key)_.*secret|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=/,`${path} must not contain fallback secrets`);
  }
  for(const name of ['MEMBER_PROXY_SECRET','ADMIN_PROXY_SECRET','OPS_INTERNAL_SECRET','SESSION_HMAC_KEY','API_KEY_PEPPER','MFA_ENCRYPTION_KEY_BASE64']){
    assert.ok(validator.includes(name),`${name} must be validated`);
  }
  assert.throws(()=>runValidator({}),/MEMBER_PROXY_SECRET is required/);
  assert.throws(()=>runValidator({MEMBER_PROXY_SECRET:'too-short'}),/MEMBER_PROXY_SECRET.*at least 32 characters/);
  assert.doesNotThrow(()=>runValidator({
    MEMBER_PROXY_SECRET:'m'.repeat(32),
    ADMIN_PROXY_SECRET:'a'.repeat(32),
    OPS_INTERNAL_SECRET:'o'.repeat(32),
    SESSION_HMAC_KEY:'s'.repeat(32),
    API_KEY_PEPPER:'p'.repeat(32),
    MFA_ENCRYPTION_KEY_BASE64:Buffer.alloc(32).toString('base64'),
  }));
  assert.throws(()=>runValidator({
    MEMBER_PROXY_SECRET:'m'.repeat(32),
    ADMIN_PROXY_SECRET:'a'.repeat(32),
    OPS_INTERNAL_SECRET:'o'.repeat(32),
    SESSION_HMAC_KEY:'s'.repeat(32),
    API_KEY_PEPPER:'p'.repeat(32),
    MFA_ENCRYPTION_KEY_BASE64:'A'.repeat(40),
  }),/MFA_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes/);
});
