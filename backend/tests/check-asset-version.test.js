import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checker = readFileSync(new URL('../../scripts/check-asset-version.js', import.meta.url), 'utf8');

function runChecker({
  secondJs = '/js/app.js?v=v1',
  secondCss = '/css/app.css?v=v1'
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'asset-version-check-'));
  try {
    const frontend = join(root, 'frontend');
    const admin = join(root, 'admin', 'public');
    const scripts = join(root, 'scripts');
    mkdirSync(join(frontend, 'js'), { recursive: true });
    mkdirSync(join(frontend, 'css'), { recursive: true });
    mkdirSync(admin, { recursive: true });
    mkdirSync(scripts);
    writeFileSync(join(scripts, 'check-asset-version.js'), checker);
    writeFileSync(join(frontend, 'js', 'app.js'), '');
    writeFileSync(join(frontend, 'css', 'app.css'), '');
    writeFileSync(join(frontend, 'index.html'), `
      <script src="/js/app.js?v=v1"></script>
      <link rel="stylesheet" href="/css/app.css?v=v1">
    `);
    writeFileSync(join(frontend, 'other.html'), `
      <script src="${secondJs}"></script>
      <link rel="stylesheet" href="${secondCss}">
    `);
    return spawnSync(process.execPath, [join(scripts, 'check-asset-version.js')], {
      encoding: 'utf8',
      timeout: 5000
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('asset version checker accepts shared JS and CSS with consistent cache tokens', () => {
  const result = runChecker();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 referensi JS, 2 stylesheet lokal/);
});

test('asset version checker rejects inconsistent JS and CSS cache tokens', () => {
  const result = runChecker({
    secondJs: '/js/app.js?v=v2',
    secondCss: '/css/app.css?v=v2'
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\/js\/app\.js memakai versi cache berbeda: v1, v2/);
  assert.match(result.stderr, /\/css\/app\.css memakai versi cache berbeda: v1, v2/);
});

test('asset version checker rejects missing versions and missing local files', () => {
  const result = runChecker({
    secondJs: '/js/missing.js',
    secondCss: '/css/missing.css'
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\/js\/missing\.js tanpa \?v=/);
  assert.match(result.stderr, /\/js\/missing\.js tidak ada/);
  assert.match(result.stderr, /\/css\/missing\.css tanpa \?v=/);
  assert.match(result.stderr, /\/css\/missing\.css tidak ada/);
});
