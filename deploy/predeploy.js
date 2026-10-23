// Normalize Railway environment variable aliases
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_PUBLIC_URL || '';
process.env.REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDIS_PUBLIC_URL || '';

import { validateSecuritySecrets } from './security-secrets.js';
validateSecuritySecrets();
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
try {
  await run('database migration', 'migrations/migrate.js', 3, 3000);
} catch (error) {
  console.error(JSON.stringify({
    service:'gasterus-predeploy',
    status:'aborted',
    phase:'database-migration',
    message:'Database migration failed after retries; deployment must not proceed. Existing service remains untouched.'
  }));
  throw error;
}
await run('database seed', 'migrations/seed.js', 3, 3000);
await run('ensure initial owner', 'migrations/ensure-owner.js', 2, 2000);
await run('schema readiness', 'migrations/schema-ready.js', 5, 2000);
console.log(JSON.stringify({ service:'gasterus-predeploy', version:'6.9.0', status:'ok' }));
