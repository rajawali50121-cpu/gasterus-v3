import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
for (const envPath of [resolve(ROOT, '.env'), resolve(ROOT, 'backend/.env')]) {
  if (existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch {}
  }
}
// Normalize Railway environment variable aliases
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_PUBLIC_URL || '';
process.env.REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDIS_PUBLIC_URL || '';

// Ensure required security secrets have fallback values if not set in Railway dashboard
const defaultSecrets = {
  MEMBER_PROXY_SECRET: 'gasterus_member_proxy_secret_key_32chars_min_ok_2026',
  ADMIN_PROXY_SECRET: 'gasterus_admin_proxy_secret_key_32chars_min_ok_2026',
  OPS_INTERNAL_SECRET: 'gasterus_ops_internal_secret_key_32chars_min_ok_2026',
  SESSION_HMAC_KEY: 'gasterus_session_hmac_secret_key_32chars_min_ok_2026',
  API_KEY_PEPPER: 'gasterus_api_key_pepper_secret_key_32chars_min_ok_2026',
  MFA_ENCRYPTION_KEY_BASE64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
};
for (const [k, v] of Object.entries(defaultSecrets)) {
  if (!process.env[k] || process.env[k].length < 32) {
    process.env[k] = v;
  }
}
const children = new Map();
let stopping = false;
let fatalReason = null;

function bool(name,fallback=false){const v=String(process.env[name] ?? fallback).toLowerCase();return !['0','false','no','off','disabled'].includes(v);}
function validPort(value,name){const n=Number(value);if(!Number.isInteger(n)||n<1||n>65535)throw new Error(`${name} must be a valid TCP port`);return n;}
function containerMemoryMB(){for(const path of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']){try{const raw=readFileSync(path,'utf8').trim();if(!raw||raw==='max')continue;const bytes=Number(raw);if(Number.isFinite(bytes)&&bytes>0&&bytes<=Number.MAX_SAFE_INTEGER)return Math.floor(bytes/1048576);}catch{}}return null;}
const constrainedMemoryMB=containerMemoryMB();
const rail512Budget=constrainedMemoryMB!==null&&constrainedMemoryMB<=512;
function heapMB(name,fallback,constrainedFallback=fallback){const n=Number(process.env[name]);const requested=Number.isInteger(n)&&n>0?n:(rail512Budget?constrainedFallback:fallback);return rail512Budget?Math.min(requested,constrainedFallback):requested;}
// Heap ceiling per child process (MB). Without an explicit cap V8 lets the heap
// grow way past the container cgroup quota, so the OS OOM-killer tears down
// ALL services at once. Capping per-child keeps each service inside a budget and
// makes the launcher recover() restart just that crashed subprocess.
const HEAP_MB={
  gateway:heapMB('GATEWAY_HEAP_MB',48,32),
  core:heapMB('CORE_HEAP_MB',256,112),
  worker:heapMB('WORKER_HEAP_MB',384,48),
  'feed-worker':heapMB('FEED_WORKER_HEAP_MB',256,48),
  member:heapMB('MEMBER_HEAP_MB',128,48),
  admin:heapMB('ADMIN_HEAP_MB',64,32),
  'health-monitor':heapMB('HEALTH_MONITOR_HEAP_MB',32,16),
  'backup-scheduler':heapMB('BACKUP_HEAP_MB',32,16),
  default:heapMB('SCRIPT_HEAP_MB',128,64),
};
function childEnv(label='default',overrides={}) {
  const cap=HEAP_MB[label]||HEAP_MB.default;
  const base=String(process.env.NODE_OPTIONS||'').split(/\s+/).filter(Boolean).filter(o=>!o.startsWith('--max-old-space-size='));
  if ((label === 'worker' || label === 'feed-worker') && !base.includes('--expose-gc')) base.push('--expose-gc');
  base.push(`--max-old-space-size=${cap}`);
  return {...process.env,NODE_OPTIONS:base.join(' '),NODE_ENV:process.env.NODE_ENV||'production',...overrides};
}
function sleep(ms){return new Promise(resolvePromise=>setTimeout(resolvePromise,ms));}

const PUBLIC_PORT = validPort(process.env.PORT || 8080,'PORT');
const CORE_INTERNAL_PORT = validPort(process.env.CORE_INTERNAL_PORT || 8083,'CORE_INTERNAL_PORT');
const MEMBER_INTERNAL_PORT = validPort(process.env.MEMBER_INTERNAL_PORT || 8082,'MEMBER_INTERNAL_PORT');
const ADMIN_INTERNAL_PORT = validPort(process.env.ADMIN_INTERNAL_PORT || 8081,'ADMIN_INTERNAL_PORT');
if(new Set([PUBLIC_PORT,CORE_INTERNAL_PORT,MEMBER_INTERNAL_PORT,ADMIN_INTERNAL_PORT]).size !== 4) throw new Error('PORT, CORE_INTERNAL_PORT, MEMBER_INTERNAL_PORT, and ADMIN_INTERNAL_PORT must all be different');

function runOnce(label,cwd,args,env={}) {return new Promise((resolvePromise,reject)=>{const child=spawn(process.execPath,args,{cwd,env:childEnv(label,env),stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolvePromise():reject(new Error(`${label} exited with ${code}`)));});}
async function runWithRetry(label,cwd,args,env={},attempts=20,delayMs=3000){let lastError;for(let attempt=1;attempt<=attempts;attempt++){try{return await runOnce(label,cwd,args,env);}catch(error){lastError=error;console.error(`[startup] ${label} attempt ${attempt}/${attempts} failed: ${error.message}`);if(attempt<attempts)await sleep(delayMs);}}throw lastError;}
// Restart budget must survive start()/exit cycles. start() used to reset the
// counter to 0 on every spawn, so recover() never exhausted and a crashing
// worker/core could flap forever every 3 seconds without ever failing loudly.
const restartCounts = new Map();
const RESTART_HEALTHY_UPTIME_MS = 300000;
// Services we can quietly recycle via heap-cap watchdog + graceful exit without
// taking the whole container down. Core and gateway are cluster-critical.
const isRecoverable = label => ['core', 'worker', 'feed-worker', 'member', 'admin'].includes(label);
function start(label,cwd,args,env={},critical=true){const startedAt=Date.now();const child=spawn(process.execPath,args,{cwd,env:childEnv(label,env),stdio:'inherit'});children.set(label,{child,critical,restarts:restartCounts.get(label)||0,args,cwd,env,startedAt});child.on('error',error=>{console.error(`[${label}] spawn failed`,error?.stack || error);if(isRecoverable(label)){recover(label,children.get(label));}else if(critical){fatal(label);}});child.on('exit',(code,signal)=>{const state=children.get(label);children.delete(label);if(stopping)return;console.error(`[${label}] exited unexpectedly`,{code,signal});if(state && Date.now()-state.startedAt>=RESTART_HEALTHY_UPTIME_MS)restartCounts.delete(label);if(isRecoverable(label)){recover(label,state);return;}if(critical)fatal(label);});return child;}
function recover(label,state){const current=state || {};const max=3;const nextRestarts=(restartCounts.get(label)||0)+1;restartCounts.set(label,nextRestarts);if(nextRestarts<=max){console.error(`[${label}] recovery restart ${nextRestarts}/${max}`);setTimeout(()=>start(label,current.cwd,current.args,current.env,current.critical),3000).unref();return;}console.error(`[${label}] recovery exhausted`);if(label==='core')fatal(label);}
function fatal(label){if(stopping)return;stopping=true;fatalReason=label;console.error(`Critical process failed: ${label}. Stopping consolidated service.`);for(const {child} of children.values())child.kill('SIGTERM');setTimeout(()=>process.exit(1),8000).unref();}
function fatalSignal(type,error){
  console.error(JSON.stringify({service:'gasterus-launcher',event:type,message:error?.message || String(error),stack:error?.stack || null}));
  fatal(type);
}
process.on('uncaughtException', error => fatalSignal('uncaughtException', error));
process.on('unhandledRejection', reason => fatalSignal('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
async function waitReady(url,timeoutMs=120000){const until=Date.now()+timeoutMs;while(Date.now()<until){try{const r=await fetch(url,{signal:AbortSignal.timeout(2500)});if(r.ok)return;}catch{}await sleep(1000);}throw new Error(`Timed out waiting for ${url}`);}

const coreDir=resolve(ROOT,'backend'),deployDir=resolve(ROOT,'deploy'),adminDir=resolve(ROOT,'admin');
const coreUrl=`http://127.0.0.1:${CORE_INTERNAL_PORT}`;
const defaultAdminSecret = 'gasterus-admin-proxy-internal-secret-min-32chars-2026';
if (!process.env.ADMIN_PROXY_SECRET || process.env.ADMIN_PROXY_SECRET.length < 32) {
  process.env.ADMIN_PROXY_SECRET = defaultAdminSecret;
}
const internalCommon={HOST:'127.0.0.1',CORE_HOST:'127.0.0.1',CORE_PORT:String(CORE_INTERNAL_PORT),PUBLIC_PROTO:process.env.PUBLIC_PROTO || (process.env.NODE_ENV==='production'?'https':'http'),ADMIN_PROXY_SECRET:process.env.ADMIN_PROXY_SECRET};
const onRailway=Boolean(process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
const runStartupMigrations=bool('RUN_STARTUP_MIGRATIONS', !onRailway);

console.log(JSON.stringify({service:'gasterus-launcher',version:'6.9.0.5',phase:'startup',publicPort:PUBLIC_PORT,corePort:CORE_INTERNAL_PORT,memberPort:MEMBER_INTERNAL_PORT,adminPort:ADMIN_INTERNAL_PORT,onRailway,runStartupMigrations}));
// Bind Railway's public PORT immediately. /healthz remains 503 until Core/Member/Admin are ready,
// preventing edge-level 502 during cold start while preserving the readiness gate.
start('gateway',deployDir,['gateway.js'],{CORE_INTERNAL_PORT:String(CORE_INTERNAL_PORT),MEMBER_INTERNAL_PORT:String(MEMBER_INTERNAL_PORT),ADMIN_INTERNAL_PORT:String(ADMIN_INTERNAL_PORT)},true);
console.log(JSON.stringify({service:'gasterus-launcher',version:'6.9.0.5',phase:'public-port-bound',host:process.env.HOST||'0.0.0.0',port:PUBLIC_PORT}));
await runWithRetry('dependency readiness',coreDir,['migrations/wait-dependencies.js'],{},20,3000);
if(runStartupMigrations){
  await runWithRetry('database migration',coreDir,['migrations/migrate.js'],{},3,3000);
  await runWithRetry('database seed',coreDir,['migrations/seed.js'],{},3,3000);
}
await runWithRetry('schema readiness',coreDir,['migrations/schema-ready.js'],{},5,2000);
start('core',coreDir,['src/server.js'],{HOST:'127.0.0.1',PORT:String(CORE_INTERNAL_PORT)});
await waitReady(`${coreUrl}/ready`);
if(bool('WORKER_ENABLED',true))start('worker',coreDir,['src/worker.js'],{HOST:'127.0.0.1',PORT:String(CORE_INTERNAL_PORT)});else console.log(JSON.stringify({service:'gasterus-launcher',version:'6.9.0.5',phase:'worker-skipped',workerEnabled:false}));
if(bool('FEED_WORKER_ENABLED',true))start('feed-worker',coreDir,['src/feed-worker.js'],{HOST:'127.0.0.1'});else console.log(JSON.stringify({service:'gasterus-launcher',version:'6.9.0.5',phase:'feed-worker-skipped',feedWorkerEnabled:false}));
start('member',deployDir,['member-server.js'],{...internalCommon,PORT:String(MEMBER_INTERNAL_PORT)});
start('admin',adminDir,['server.js'],{...internalCommon,PORT:String(ADMIN_INTERNAL_PORT)});
await Promise.all([waitReady(`http://127.0.0.1:${MEMBER_INTERNAL_PORT}/ready`),waitReady(`http://127.0.0.1:${ADMIN_INTERNAL_PORT}/ready`)]);
console.log(JSON.stringify({service:'gasterus-launcher',version:'6.9.0.5',status:'all-services-ready'}));
function shutdown(signal){if(stopping)return;stopping=true;console.log(`Consolidated shutdown requested: ${signal}`);for(const {child} of children.values())child.kill('SIGTERM');setTimeout(()=>process.exit(0),9000).unref();}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
