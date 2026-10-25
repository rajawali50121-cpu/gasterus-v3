import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { registerChild, unregisterChild } from './memory-guard.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const renderCache = new Map();
let queue = Promise.resolve();
let queuePendingCount = 0;
const persistentProfileDir = path.join(os.tmpdir(), `gasterus-sportsbook-chromium-profile-${process.pid}`);
let renderSequence = 0;

const IS_POSIX = process.platform !== 'win32';
// Batas kesabaran menunggu DevTools siap. Start-up Chromium saat dingin bisa
// memakan waktu lebih dari 8 detik bila container sedang sibuk; batas lama
// membuat render fallback gagal dan status pasar turun dari VERIFIED. Batas ini
// tetap dibatasi oleh timeout pemanggil.
const DEVTOOLS_READY_TIMEOUT_CAP_MS = 15000;
// PID proses Chromium yang sedang hidup. Dipakai untuk membersihkan anak yatim
// ketika proses Node keluar mendadak (mis. memory-guard recycle via exit(0)).
const liveChildren = new Set();

function killGroup(pid, signal) {
  try {
    // PID negatif = seluruh process group. Di POSIX semua sub-proses Chromium
    // (browser, renderer, gpu, zygote, utility) ikut mati; proses Node sendiri
    // bukan anggota group tersebut sehingga tidak ikut tersentuh.
    if (IS_POSIX) process.kill(-pid, signal);
    else process.kill(pid, signal);
    return true;
  } catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

function killOrphanedChildren() {
  for (const pid of liveChildren) killGroup(pid, 'SIGKILL');
  liveChildren.clear();
}

// process.exit(0) dari memory-guard MELOMPATI blok finally renderOnce, sehingga
// tanpa hook ini Chromium yang sedang render akan yatim dan terus menahan RSS
// sampai container dibunuh OOM. Handler 'exit' harus sinkron; process.kill sinkron.
process.once('exit', killOrphanedChildren);

function nextProfileDir() {
  renderSequence += 1;
  return path.join(persistentProfileDir, `render-${Date.now()}-${renderSequence}`);
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateChild(child) {
  if (!child) return;
  const pid = child.pid;
  if (pid) { liveChildren.delete(pid); unregisterChild(pid); }
  if (child.exitCode === null && child.signalCode === null) {
    if (pid) killGroup(pid, 'SIGTERM');
    else { try { child.kill('SIGTERM'); } catch {} }
    if (!(await waitForChildExit(child, 1200))) {
      if (pid) killGroup(pid, 'SIGKILL');
      else { try { child.kill('SIGKILL'); } catch {} }
      await waitForChildExit(child, 1200);
    }
  }
  if (process.platform === 'win32' && pid) {
    const script = [
      `$root = ${pid}`,
      '$all = @(Get-CimInstance Win32_Process)',
      '$children = New-Object System.Collections.Generic.List[int]',
      'function Add-Descendants([int]$parent) {',
      '  foreach ($proc in $all | Where-Object { $_.ParentProcessId -eq $parent }) {',
      '    $children.Add([int]$proc.ProcessId)',
      '    Add-Descendants([int]$proc.ProcessId)',
      '  }',
      '}',
      'Add-Descendants $root',
      'foreach ($id in ($children | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }'
    ].join(';');
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5000
    }).catch(() => {});
  }
}

function executableCandidates(explicit = '') {
  return [
    explicit,
    process.env.SPORTS_SOURCE_BROWSER_EXECUTABLE,
    process.platform === 'win32' ? process.env.CHROME_PATH : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'
  ].filter(Boolean);
}

async function fileExists(file) {
  try { await readFile(file); return true; } catch { return false; }
}

export async function browserBinaryAvailable(explicit = '') {
  for (const candidate of executableCandidates(explicit)) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (await fileExists(candidate)) return true;
      continue;
    }
    return true;
  }
  return false;
}

async function resolveExecutable(explicit = '') {
  for (const candidate of executableCandidates(explicit)) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (await fileExists(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('Chromium/Chrome executable tidak ditemukan untuk browser-rendered Sportsbook source.');
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const events = new Map();
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolve, reject) => { openedResolve = resolve; openedReject = reject; });

  ws.addEventListener('open', () => openedResolve());
  ws.addEventListener('error', event => openedReject(event?.error || new Error('CDP WebSocket gagal dibuka.')));
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
      else resolve(message.result || {});
      return;
    }
    if (message.method) {
      for (const listener of events.get(message.method) || []) listener(message.params || {});
    }
  });
  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP WebSocket tertutup.'));
    pending.clear();
  });

  return {
    opened,
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      if (!events.has(method)) events.set(method, new Set());
      events.get(method).add(listener);
      return () => events.get(method)?.delete(listener);
    },
    close() { try { ws.close(); } catch {} }
  };
}

async function fetchDevtools(url, options = {}, timeoutMs = 750) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDevtools(profileDir, child, timeoutMs) {
  const activeFile = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  let lastPort = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const lines = (await readFile(activeFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) {
        lastPort = port;
        try {
          const response = await fetchDevtools(`http://127.0.0.1:${port}/json/version`, {}, 500);
          if (response.ok) return port;
          lastError = new Error(`Chromium DevTools readiness HTTP ${response.status}.`);
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const detail = lastPort ? ` port=${lastPort}` : '';
  const reason = lastError?.message ? ` (${lastError.message})` : '';
  throw new Error(`Chromium DevTools tidak aktif sebelum timeout.${detail}${reason}`);
}

async function createPage(port, child, timeoutMs = 3000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchDevtools(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }, 750);
      if (response.ok) return response.json();
      lastError = new Error(`Gagal membuat Chromium tab (${response.status}).`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Gagal membuat Chromium tab setelah retry: ${lastError?.message || 'DevTools tidak merespons.'}`);
}

async function closePage(port, id) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`); } catch {}
}

async function renderOnce(url, options = {}) {
  const executable = await resolveExecutable(options.executable || '');
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || 25000));
  const settleMs = Math.max(1000, Number(options.settleMs || 9000));
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes || 8 * 1024 * 1024));
  // One fresh profile per render prevents Windows ProcessSingleton/DevTools state from
  // leaking across sequential Chromium launches. The parent directory remains
  // process-scoped so cleanup is bounded to this Gasterus worker.
  const profileDir = nextProfileDir();
  await mkdir(profileDir, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'
  ];
  if (options.userAgent) args.splice(args.length - 1, 0, `--user-agent=${options.userAgent}`);
  // detached: Chromium menjadi process group sendiri, sehingga seluruh sub-prosesnya
  // bisa dibersihkan lewat kill(-pid) di POSIX dan RSS-nya bisa dipantau guard.
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: IS_POSIX });
  if (child.pid) { liveChildren.add(child.pid); registerChild(child.pid, 'chromium'); }
  let stderr = '';
  child.stderr?.on('data', chunk => { if (stderr.length < 12000) stderr += String(chunk); });
  let client = null;
  let page = null;
  const startedAt = Date.now();
  try {
    const port = await waitForDevtools(profileDir, child, Math.min(timeoutMs, DEVTOOLS_READY_TIMEOUT_CAP_MS));
    page = await createPage(port, child, Math.min(timeoutMs, 4000));
    client = createCdpClient(page.webSocketDebuggerUrl);
    await client.opened;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    if (options.referer) await client.send('Network.setExtraHTTPHeaders', { headers: { Referer: options.referer } });

    let loaded = false;
    const offLoad = client.on('Page.loadEventFired', () => { loaded = true; });
    if (options.fixtureHtml) {
      const tree = await client.send('Page.getFrameTree');
      const frameId = tree?.frameTree?.frame?.id;
      if (!frameId) throw new Error('Chromium fixture frame tidak tersedia.');
      await client.send('Page.setDocumentContent', { frameId, html: String(options.fixtureHtml) });
      loaded = true;
    } else {
      await client.send('Page.navigate', { url: String(url) });
    }
    const deadline = Date.now() + timeoutMs;
    let html = '';
    let markerReady = false;
    while (Date.now() < deadline) {
      if (!loaded) { await sleep(250); continue; }
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
        awaitPromise: true
      });
      html = String(result?.result?.value || '');
      if (Buffer.byteLength(html) > maxBytes) throw new Error('DOM hasil render Chromium melebihi batas ukuran Sportsbook source.');
      markerReady = /\bOddsTab[LR]?\b|bu:od:(?:afa:ev|go:ev):\d+|"(?:odds|markets?|selections?)"\s*:/i.test(html);
      if (markerReady) break;
      if (Date.now() - startedAt >= settleMs) break;
      await sleep(500);
    }
    offLoad();
    if (!html) throw new Error('Chromium tidak menghasilkan DOM untuk Sportsbook source.');
    const locationResult = await client.send('Runtime.evaluate', {
      expression: 'String(location.href || "")', returnByValue: true, awaitPromise: true
    });
    const finalUrl = String(locationResult?.result?.value || url);
    return {
      html,
      finalUrl,
      renderer: 'CHROMIUM_CDP',
      markerReady,
      renderedAt: new Date().toISOString(),
      renderMs: Date.now() - startedAt,
      executable
    };
  } finally {
    try { client?.close(); } catch {}
    try {
      if (page?.id) {
        const active = await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
        const port = Number(String(active).split(/\r?\n/)[0]);
        if (port) await closePage(port, page.id);
      }
    } catch {}
    await terminateChild(child);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 125 }).catch(() => {});
    void stderr;
  }
}

// Expired-sweep (bukan count-prune): nilai entri adalah HTML mentah yang bisa besar,
// jadi memangkas berdasarkan jumlah berisiko. Kunci render bersifat statis per sumber
// sehingga menyapu entri yang sudah lewat TTL cukup untuk melepas page basi tanpa
// pernah menyentuh entri yang sedang di-render (inFlight) maupun entri masih hidup.
const RENDER_CACHE_SWEEP_THRESHOLD = 20;
const RENDER_CACHE_SWEEP_GRACE_MS = 60_000;
// Batas keras jumlah entri cache render. Nilai entri adalah HTML mentah (sampai
// batas byte pemanggil), jadi tanpa cap jumlah entri cache bisa tumbuh tanpa
// batas pada workload dengan banyak URL unik dan menyebabkan OOM.
const RENDER_CACHE_MAX_ENTRIES = 100;
// Batas agregat byte untuk HTML yang benar-benar tersimpan di cache render.
// Nilai konservatif: worst-case 100 entri x ~1.5MB (batas pemanggil TOTO) dapat
// mencapai ~150MB, sedangkan batas memori Railway aktual belum diketahui. Batas
// ini bukan nilai optimal dan dapat disesuaikan setelah pengukuran RSS/heap.
const RENDER_CACHE_MAX_BYTES = 16 * 1024 * 1024;
// Batas pekerjaan yang menunggu di antrean render, tidak termasuk pekerjaan yang
// sedang berjalan. Nilai ini membatasi flood request tanpa memblokir render aktif.
const RENDER_QUEUE_MAX_PENDING = 50;

function renderCacheEntryBytes(entry) {
  const sizeBytes = Number(entry?.sizeBytes);
  if (Number.isFinite(sizeBytes) && sizeBytes >= 0) return sizeBytes;
  if (entry?.value && typeof entry.value.html === 'string') {
    return Buffer.byteLength(entry.value.html, 'utf8');
  }
  return 0;
}

function renderCacheTotalBytes() {
  let total = 0;
  for (const entry of renderCache.values()) total += renderCacheEntryBytes(entry);
  return total;
}

function evictOldestRenderCacheEntry(cache, now = Date.now()) {
  let oldestKey = null;
  let oldestExpiresAt = Number.POSITIVE_INFINITY;
  let hasNonInFlight = false;
  for (const [key, entry] of cache) {
    if (!entry) continue;
    if (entry.inFlight) continue;
    hasNonInFlight = true;
    const expiresAt = Number(entry.expiresAt) || 0;
    if (expiresAt < oldestExpiresAt) {
      oldestKey = key;
      oldestExpiresAt = expiresAt;
    }
  }
  if (!hasNonInFlight) {
    oldestKey = null;
    oldestExpiresAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) {
      if (!entry) continue;
      const expiresAt = Number(entry.expiresAt) || 0;
      if (expiresAt < oldestExpiresAt) {
        oldestKey = key;
        oldestExpiresAt = expiresAt;
      }
    }
  }
  if (oldestKey !== null) {
    cache.delete(oldestKey);
    return oldestKey;
  }
  return null;
}

function sweepExpiredRenderCache(now = Date.now(), graceMs = RENDER_CACHE_SWEEP_GRACE_MS) {
  if (renderCache.size <= RENDER_CACHE_SWEEP_THRESHOLD) return 0;
  let removed = 0;
  for (const [key, entry] of [...renderCache]) {
    if (!entry) { renderCache.delete(key); removed += 1; continue; }
    if (entry.inFlight) continue; // render sedang berjalan; jangan ganggu
    if (!entry.value || entry.expiresAt + graceMs <= now) { renderCache.delete(key); removed += 1; }
  }
  return removed;
}

// Start-up Chromium bisa gagal sesaat saat CPU sedang sibuk (container Railway di
// bawah tekanan, atau banyak proses lain hors). Failure seperti itu tidak akan
// membaik dengan menunggu, tapi akan dengan mencoba lagi. Hanya kegagalan
// start-up yang diulang; kegagalan render/parsing dibiarkan apa adanya.
const RETRYABLE_STARTUP_ERROR = /DevTools tidak aktif|DevToolsActivePort|Chromium/;
let renderImplementation = renderOnceWithRetry;

async function renderOnceWithRetry(url, options = {}, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await renderOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !RETRYABLE_STARTUP_ERROR.test(String(error?.message || ''))) throw error;
      await sleep(750);
    }
  }
  throw lastError;
}

export async function renderSportsbookPage(url, options = {}) {
  const key = String(url);
  const now = Date.now();
  sweepExpiredRenderCache(now);
  const ttlMs = Math.max(1000, Number(options.cacheSeconds || 20) * 1000);
  const cached = renderCache.get(key);
  if (cached?.value && now < cached.expiresAt) return { ...cached.value, cacheHit: true };
  if (cached?.inFlight) return cached.inFlight;

  // Backpressure: batasi pekerjaan yang menunggu, bukan pekerjaan yang sedang
  // berjalan. Request yang sudah deduplikasi di atas tidak ikut ditolak.
  if (queuePendingCount >= RENDER_QUEUE_MAX_PENDING) {
    throw new Error(`Render queue is full (${queuePendingCount} pending)`);
  }

  const inFlightSize = renderCacheEntryBytes({ value: cached?.value || null, sizeBytes: cached?.sizeBytes });
  const hasKey = renderCache.has(key);
  const oldSize = renderCacheEntryBytes(cached);
  if (!hasKey) {
    while (
      (renderCache.size >= RENDER_CACHE_MAX_ENTRIES ||
        renderCacheTotalBytes() + inFlightSize > RENDER_CACHE_MAX_BYTES) &&
      evictOldestRenderCacheEntry(renderCache, now) !== null
    ) {}
  } else {
    while (
      renderCacheTotalBytes() - oldSize + inFlightSize > RENDER_CACHE_MAX_BYTES &&
      evictOldestRenderCacheEntry(renderCache, now) !== null
    ) {}
  }
  const canInsertInFlight =
    hasKey
      ? renderCacheTotalBytes() - oldSize + inFlightSize <= RENDER_CACHE_MAX_BYTES
      : renderCache.size < RENDER_CACHE_MAX_ENTRIES &&
        renderCacheTotalBytes() + inFlightSize <= RENDER_CACHE_MAX_BYTES;

  const previousQueue = queue;
  let releaseQueue;
  queue = new Promise(resolve => { releaseQueue = resolve; });
  queuePendingCount += 1;
  let pendingReleased = false;
  const releasePending = () => {
    if (pendingReleased) return;
    pendingReleased = true;
    queuePendingCount = Math.max(0, queuePendingCount - 1);
  };

const work = previousQueue.then(() => {
    releasePending();
    return renderImplementation(url, options);
  });
  work.then(() => releaseQueue(), () => releaseQueue());

  const inFlight = work.then(value => {
    // Jangan menimpa entri yang sudah di-eviksi atau diganti oleh render lain.
    const current = renderCache.get(key);
    if (current?.inFlight === inFlight) {
      const sizeBytes = Buffer.byteLength(String(value?.html || ''), 'utf8');
      const currentSize = renderCacheEntryBytes(current);
      if (sizeBytes <= RENDER_CACHE_MAX_BYTES) {
        while (
          renderCacheTotalBytes() - currentSize + sizeBytes > RENDER_CACHE_MAX_BYTES &&
          evictOldestRenderCacheEntry(renderCache, Date.now()) !== null
        ) {}
        const latest = renderCache.get(key);
        if (
          latest?.inFlight === inFlight &&
          renderCacheTotalBytes() - currentSize + sizeBytes <= RENDER_CACHE_MAX_BYTES
        ) {
          renderCache.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
            inFlight: null,
            sizeBytes
          });
        } else if (latest?.inFlight === inFlight) {
          renderCache.delete(key);
        }
      } else {
        const latest = renderCache.get(key);
        if (latest?.inFlight === inFlight) renderCache.delete(key);
      }
    }
    return { ...value, cacheHit: false };
  }).catch(error => {
    const current = renderCache.get(key);
    if (current?.inFlight === inFlight) renderCache.delete(key);
    throw error;
  });

  if (canInsertInFlight) {
    renderCache.set(key, {
      value: cached?.value || null,
      expiresAt: cached?.expiresAt || 0,
      inFlight,
      sizeBytes: inFlightSize
    });
  }
  return inFlight;
}

export const __browserRenderer = {
  renderCache,
  sweepExpiredRenderCache,
  RENDER_CACHE_SWEEP_THRESHOLD,
  RENDER_CACHE_SWEEP_GRACE_MS,
  RENDER_CACHE_MAX_ENTRIES,
  RENDER_CACHE_MAX_BYTES,
  RENDER_QUEUE_MAX_PENDING,
  evictOldestRenderCacheEntry,
  get renderCacheTotalBytes() { return renderCacheTotalBytes(); },
  get queuePendingCount() { return queuePendingCount; },
  get renderImplementation() { return renderImplementation; },
  set renderImplementation(value) { renderImplementation = value; },
  get renderOnceWithRetry() { return renderImplementation; },
  set renderOnceWithRetry(value) { renderImplementation = value; }
};

export function browserRendererStatus() {
  return {
    cachedPages: [...renderCache.values()].filter(item => item?.value).length,
    inFlightPages: [...renderCache.values()].filter(item => item?.inFlight).length
  };
}
