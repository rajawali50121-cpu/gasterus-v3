// Normalize Railway environment variable aliases
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_PUBLIC_URL || '';
process.env.REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDIS_PUBLIC_URL || '';

// Production credentials must be explicitly provisioned in Railway.
// Never silently substitute predictable defaults: doing so would make a
// missing secret look healthy while weakening authentication and encryption.
const requiredSecrets = [
  'MEMBER_PROXY_SECRET',
  'ADMIN_PROXY_SECRET',
  'OPS_INTERNAL_SECRET',
  'SESSION_HMAC_KEY',
  'API_KEY_PEPPER',
  'MFA_ENCRYPTION_KEY_BASE64'
];
for (const name of requiredSecrets) {
  const value = String(process.env[name] || '').trim();
  if (value.length < 32) {
    throw new Error(`[security] ${name} is missing or too short; configure a unique secret in Railway.`);
  }
  if (name === 'MFA_ENCRYPTION_KEY_BASE64' && Buffer.from(value, 'base64').length !== 32) {
    throw new Error('[security] MFA_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.');
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
