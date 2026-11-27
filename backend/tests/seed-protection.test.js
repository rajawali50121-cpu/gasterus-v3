import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const seedPath = fileURLToPath(new URL('../migrations/seed.js', import.meta.url));
const seed = readFileSync(seedPath, 'utf8');
const conflictStart = seed.indexOf('ON CONFLICT(provider_path)');
const paramsStart = seed.indexOf('`, [', conflictStart);
const conflictClause = seed.slice(conflictStart, paramsStart);

test('seed upsert only updates rows whose existing result is a placeholder and status is non-final', () => {
  assert.ok(conflictStart >= 0, 'provider_path conflict clause must exist');
  assert.match(conflictClause, /WHERE\s+COALESCE\(NULLIF\(BTRIM\(markets\.result\),\s*''\),\s*'----'\)\s*=\s*'----'/i);
  assert.match(conflictClause, /UPPER\(BTRIM\(markets\.verification_status\)\)\s+NOT\s+IN\s*\(\s*'VERIFIED'\s*,\s*'MANUAL_RESOLUTION'\s*,\s*'RETIRED'\s*\)/i);
});

test('seed INSERT uses the verificationStatus supplied by markets.seed.json', () => {
  assert.match(seed, /VALUES\([^\n]*\$12,\s*\$13,\s*now\(\)\)/);
  assert.match(conflictClause, /verification_status\s*=\s*EXCLUDED\.verification_status/i);
  assert.match(seed, /m\.verificationStatus\s*\|\|\s*'UNMAPPED'/);
  assert.doesNotMatch(seed, /\$12,\s*'VERIFIED',\s*now\(\)/);
});

test('seed protection test does not require a database connection', () => {
  assert.doesNotMatch(seed, /connect\(\)|pool\.connect\(/);
});

test('seed migration passes Node syntax validation', () => {
  execFileSync(process.execPath, ['--check', seedPath], { stdio: 'pipe' });
});
