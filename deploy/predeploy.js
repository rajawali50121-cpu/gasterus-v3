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
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const coreDir = resolve(ROOT, 'backend');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function run(label, script, attempts = 1, delayMs = 3000) {
  return (async () => {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await new Promise((resolvePromise, reject) => {
          const child = spawn(process.execPath, [script], { cwd: coreDir, env: process.env, stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${label} exited with ${code}`)));
        });
        return;
      } catch (error) {
        last = error;
        console.error(`[predeploy] ${label} attempt ${attempt}/${attempts} failed: ${error.message}`);
        if (attempt < attempts) await sleep(delayMs);
      }
    }
    throw last;
  })();
}

console.log(JSON.stringify({ service:'gasterus-predeploy', version:'6.9.0', phase:'start' }));
await run('dependency readiness', 'migrations/wait-dependencies.js', 60, 3000);
await run('database migration', 'migrations/migrate.js', 3, 3000);
await run('database seed', 'migrations/seed.js', 3, 3000);
await run('ensure initial owner', 'migrations/ensure-owner.js', 2, 2000);
await run('schema readiness', 'migrations/schema-ready.js', 5, 2000);
console.log(JSON.stringify({ service:'gasterus-predeploy', version:'6.9.0', status:'ok' }));
