import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateMemoryGuard,
  registerChild,
  unregisterChild,
  registeredChildCount,
  treeMemory,
  startMemoryGuard,
  detectContainerMemoryMB,
  resolveRssLimitMB
} from '../src/memory-guard.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const readSrc = name => readFileSync(resolve(SRC, name), 'utf8');

test('recycle terjadi saat heap melewati batas (perilaku lama dipertahankan)', () => {
  const result = evaluateMemoryGuard({
    heapUsed: 200 * 1024 * 1024,
    rssBytes: 100 * 1024 * 1024,
    highWater: 180 * 1024 * 1024,
    rssHighWater: 900 * 1024 * 1024
  });
  assert.equal(result.heapHigh, true);
  assert.equal(result.rssHigh, false);
  assert.equal(result.breach, true);
});

test('recycle juga terjadi saat tree RSS lewat batas walau heap masih aman', () => {
  const result = evaluateMemoryGuard({
    heapUsed: 10 * 1024 * 1024,
    rssBytes: 950 * 1024 * 1024,
    highWater: 180 * 1024 * 1024,
    rssHighWater: 900 * 1024 * 1024
  });
  assert.equal(result.heapHigh, false);
  assert.equal(result.rssHigh, true);
  assert.equal(result.breach, true);
});

test('tidak ada breach saat heap dan tree RSS sama-sama di bawah batas', () => {
  const result = evaluateMemoryGuard({
    heapUsed: 10 * 1024 * 1024,
    rssBytes: 100 * 1024 * 1024,
    highWater: 180 * 1024 * 1024,
    rssHighWater: 900 * 1024 * 1024
  });
  assert.equal(result.breach, false);
});

test('registry anak memengaruhi perhitungan tree RSS dan bisa dilepas', () => {
  const before = treeMemory();
  const beforeCount = registeredChildCount();
  assert.ok(before.ownRssBytes > 0, 'RSS proses sendiri harus terbaca');

  assert.equal(registerChild(process.pid, 'selftest'), true);
  const withChild = treeMemory();
  assert.equal(withChild.childCount, beforeCount + 1);
  // PID self terdaftar sebagai "anak" supaya penjumlahan benar-benar teruji.
  assert.ok(withChild.childRssBytes > 0, 'RSS anak harus terbaca dari /proc');
  assert.equal(withChild.rssBytes, withChild.ownRssBytes + withChild.childRssBytes);

  assert.equal(unregisterChild(process.pid), true);
  const after = treeMemory();
  assert.equal(after.childCount, beforeCount);
  assert.equal(after.childRssBytes, 0);
});

test('registerChild menolak PID tidak valid', () => {
  assert.equal(registerChild(0), false);
  assert.equal(registerChild(-1), false);
  assert.equal(registerChild('abc'), false);
  assert.equal(registerChild(1.5), false);
});

test('startMemoryGuard mengembalikan batas heap dan batas tree RSS', () => {
  const guard = startMemoryGuard({ label: 'test-guard', intervalMs: 600000, rssLimitMb: 512 });
  try {
    assert.ok(guard.heapMB > 0);
    assert.ok(guard.highWater > 0);
    assert.equal(guard.rssLimitMB, 512);
    assert.equal(guard.rssHighWater, 512 * 1024 * 1024);
  } finally {
    guard.stop();
  }
});

// --- Batas RSS diturunkan otomatis dari cgroup container (tanpa env manual) ---

function withoutEnv(name, fn) {
  const saved = process.env[name];
  delete process.env[name];
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

// Pembaca file palsu: hanya file yang ada di map yang bisa dibaca.
const fakeReader = map => file => {
  if (!(file in map)) throw new Error(`ENOENT: ${file}`);
  return map[file];
};
const V2 = '/sys/fs/cgroup/memory.max';
const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

test('batas memori container terbaca dari cgroup v2', () => {
  const reader = fakeReader({ [V2]: String(1024 * 1024 * 1024) });
  assert.equal(detectContainerMemoryMB(reader), 1024);
});

test('batas memori container terbaca dari cgroup v1 saat v2 tidak terbatas', () => {
  const reader = fakeReader({ [V2]: 'max', [V1]: String(512 * 1024 * 1024) });
  assert.equal(detectContainerMemoryMB(reader), 512);
});

test('limit tak terbatas dan nilai ganjil diabaikan', () => {
  // "max" (v2) dan sentinel v1 yang berarti infinite tidak boleh dipakai.
  assert.equal(detectContainerMemoryMB(fakeReader({ [V2]: 'max' })), null);
  assert.equal(detectContainerMemoryMB(fakeReader({ [V2]: 'max', [V1]: '9223372036854771712' })), null);
  // Di atas 64GB dianggap bukan limit container yang masuk akal.
  assert.equal(detectContainerMemoryMB(fakeReader({ [V2]: String(128 * 1024 * 1024 * 1024) })), null);
});

test('berkas cgroup yang tidak ada menghasilkan null', () => {
  assert.equal(detectContainerMemoryMB(fakeReader({})), null);
});

test('opsi eksplisit mengalahkan env dan cgroup', () => {
  const reader = fakeReader({ [V2]: String(1024 * 1024 * 1024) });
  const result = resolveRssLimitMB({ rssLimitMb: 700, readCgroup: reader });
  assert.equal(result.rssLimitMB, 700);
  assert.equal(result.source, 'option');
});

test('tanpa opsi/env batas diturunkan 75% dari limit container', () => {
  const reader = fakeReader({ [V2]: String(2048 * 1024 * 1024) });
  const result = withoutEnv('TREE_RSS_LIMIT_MB', () => resolveRssLimitMB({ readCgroup: reader }));
  assert.equal(result.rssLimitMB, 1536);
  assert.equal(result.source, 'cgroup:2048MB');
});

test('limit container kecil tetap punya lantai agar tidak recycle buta', () => {
  const reader = fakeReader({ [V2]: String(300 * 1024 * 1024) });
  const result = withoutEnv('TREE_RSS_LIMIT_MB', () => resolveRssLimitMB({ readCgroup: reader }));
  assert.equal(result.rssLimitMB, 256);
  assert.equal(result.source, 'cgroup:300MB');
});

test('env dipakai bila ada override eksplisit dari operator', () => {
  process.env.TREE_RSS_LIMIT_MB = '1234';
  try {
    const reader = fakeReader({ [V2]: String(2048 * 1024 * 1024) });
    const result = resolveRssLimitMB({ readCgroup: reader });
    assert.equal(result.rssLimitMB, 1234);
    assert.equal(result.source, 'env');
  } finally {
    delete process.env.TREE_RSS_LIMIT_MB;
  }
});

test('fallback ke default bila tidak ada cgroup maupun env', () => {
  const result = withoutEnv('TREE_RSS_LIMIT_MB', () => resolveRssLimitMB({ readCgroup: fakeReader({}) }));
  assert.equal(result.rssLimitMB, 900);
  assert.equal(result.source, 'default');
});

test('startMemoryGuard melaporkan sumber batas tree RSS', () => {
  const guard = startMemoryGuard({ label: 'test-guard-source', intervalMs: 600000, rssLimitMb: 640 });
  try {
    assert.equal(guard.rssLimitMB, 640);
    assert.equal(guard.rssLimitSource, 'option');
  } finally {
    guard.stop();
  }
});

test('renderer mendaftarkan anak dan membersihkan lewat process group', () => {
  const src = readSrc('browser-page-renderer.js');
  // Spawn harus detached agar kill(-pid) menyapu seluruh sub-proses Chromium.
  assert.match(src, /spawn\(executable, args, \{[^}]*detached: IS_POSIX/s);
  // Anak didaftarkan ke memory-guard supaya RSS-nya ikut dipantau.
  assert.match(src, /registerChild\(child\.pid, 'chromium'\)/);
  assert.match(src, /unregisterChild\(pid\)/);
  // Pembersihan memakai process group di POSIX.
  assert.match(src, /process\.kill\(-pid, signal\)/);
  // Hook 'exit' menutup celah orphan saat process.exit(0) dari memory-guard.
  assert.match(src, /process\.once\('exit', killOrphanedChildren\)/);
});