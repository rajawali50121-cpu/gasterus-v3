import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@example.com/db';
process.env.REDIS_URL = 'redis://example.com:6379';
process.env.MEMBER_PROXY_SECRET = 'm'.repeat(48);
process.env.ADMIN_PROXY_SECRET = 'a'.repeat(48);
process.env.OPS_INTERNAL_SECRET = 'o'.repeat(48);
process.env.SESSION_HMAC_KEY = 's'.repeat(48);
process.env.API_KEY_PEPPER = 'p'.repeat(48);

const { __totoDrawScheduler } = await import('../src/toto-draw-scheduler.js');
const { syncJobs, dueJobs, markPolled, applyPollResult, pollerSnapshot, __totoDrawPoller } = await import('../src/toto-draw-poller.js');

// 15:55 WIB = T-5 untuk pool yang result-nya 16:00.
const T_MINUS_5 = new Date('2026-09-27T08:55:00Z');
const plus = (base, minutes) => new Date(base.getTime() + minutes * 60 * 1000);

function reset() {
  __totoDrawPoller.jobs.clear();
  __totoDrawScheduler.state.clear();
}

test('tidak ada job polling sebelum T-5', () => {
  reset();
  syncJobs(new Date('2026-09-27T08:54:00Z'));
  // Pool lain boleh saja polling pada menit ini, tapi pool 16:00 belum boleh.
  const t54 = dueJobs(new Date('2026-09-27T08:54:00Z')).map(item => item.job.slug);
  assert.equal(t54.includes('toto-macau-sore'), false, 'T-6 tidak boleh punya job untuk pool 16:00');
  reset();
  syncJobs(T_MINUS_5);
  const due = dueJobs(T_MINUS_5);
  assert.ok(due.some(item => item.job.slug === 'toto-macau-sore'), 'pool 16:00 harus dapat job di T-5');
});

test('poll berikutnya tepat 3 menit setelah poll sebelumnya', () => {
  reset();
  syncJobs(T_MINUS_5);
  const first = dueJobs(T_MINUS_5);
  const key = first.find(item => item.job.slug === 'toto-macau-sore').key;
  markPolled(key, T_MINUS_5);
  // 2 menit kemudian belum due untuk pool itu.
  assert.equal(dueJobs(plus(T_MINUS_5, 2)).some(item => item.key === key), false);
  // 3 menit kemudian due lagi.
  const second = dueJobs(plus(T_MINUS_5, 3));
  assert.ok(second.some(item => item.key === key), 'poll kedua harus jatuh di menit ke-3');
});

test('polling berhenti begitu result baru valid untuk pool itu', () => {
  reset();
  __totoDrawScheduler.state.clear();
  const t0 = new Date('2026-09-27T08:55:00Z');
  markDrawObservationsSafe('toto-macau-sore', '2026-09-26');
  syncJobs(t0);
  const due = dueJobs(t0);
  const key = due.find(item => item.job.slug === 'toto-macau-sore').key;
  markPolled(key, t0);
  // Sumber masih mengembalikan tanggal lama: pool harus tetap polling.
  const belumBaru = applyPollResult([{ slug: 'toto-macau-sore', drawDate: '2026-09-26', status: 'VERIFIED' }], { now: plus(t0, 3), polled: [key] });
  assert.deepEqual(belumBaru.advanced, []);
  assert.ok(__totoDrawPoller.jobs.has(key), 'result lama tidak boleh menghentikan polling');

  // Tanggal draw maju: polling pool itu berhenti.
  const baru = applyPollResult([{ slug: 'toto-macau-sore', drawDate: '2026-09-27', status: 'VERIFIED' }], { now: plus(t0, 6), polled: [key] });
  assert.deepEqual(baru.advanced, ['toto-macau-sore']);
  assert.equal(__totoDrawPoller.jobs.has(key), false, 'pool dengan result baru tidak boleh dipoll lagi');
});

test('result yang sama tidak memicu settlement kedua', () => {
  reset();
  __totoDrawScheduler.state.clear();
  const t0 = new Date('2026-09-27T08:55:00Z');
  markDrawObservationsSafe('toto-macau-sore', '2026-09-26');
  syncJobs(t0);
  const key = dueJobs(t0).find(item => item.job.slug === 'toto-macau-sore').key;
  markPolled(key, t0);
  applyPollResult([{ slug: 'toto-macau-sore', drawDate: '2026-09-27', status: 'VERIFIED' }], { now: plus(t0, 3), polled: [key] });
  // Tanggal yang sama lagi pada poll berikutnya tidak dihitung sebagai advance.
  const ulang = applyPollResult([{ slug: 'toto-macau-sore', drawDate: '2026-09-27', status: 'VERIFIED' }], { now: plus(t0, 6), polled: [] });
  assert.deepEqual(ulang.advanced, []);
});

test('restart tidak membuat job ganda', () => {
  reset();
  __totoDrawPoller.jobs.clear();
  syncJobs(T_MINUS_5);
  const firstCount = pollerSnapshot(T_MINUS_5).activeJobs;
  // Simulasi restart: state memori hilang, sinkron ulang pada waktu yang sama.
  __totoDrawPoller.jobs.clear();
  syncJobs(T_MINUS_5);
  const secondCount = pollerSnapshot(T_MINUS_5).activeJobs;
  assert.equal(firstCount, secondCount);
  assert.equal(dueJobs(T_MINUS_5).filter(item => item.job.slug === 'toto-macau-sore').length, 1, 'satu pool tidak boleh punya dua job');
});

test('hari libur tidak pernah membuat polling job', () => {
  reset();
  // 2026-09-29 = Selasa. Singapore libur Selasa dan Jumat.
  const selasa = new Date('2026-09-29T15:55:00Z');
  syncJobs(selasa);
  const due = dueJobs(selasa).map(item => item.job.slug);
  assert.equal(due.includes('singapore-pool'), false);
});

test('pool yang tidak men-answer dihentikan sebagai RESULT_DELAYED, bukan polling tanpa akhir', () => {
  reset();
  __totoDrawScheduler.state.clear();
  const t0 = new Date('2026-09-27T08:55:00Z');
  markDrawObservationsSafe('toto-macau-sore', '2026-09-26');
  syncJobs(t0);
  const key = dueJobs(t0).find(item => item.job.slug === 'toto-macau-sore').key;
  // Lewat batas kesabaran tanpa result baru.
  const jauh = plus(t0, 240);
  applyPollResult([], { now: jauh, polled: [key] });
  const setelah = dueJobs(jauh);
  assert.equal(setelah.some(item => item.key === key), false, 'job harus dihentikan, bukan dilanjutkan');
});

test('setiap pool punya state sendiri', () => {
  reset();
  const t0 = new Date('2026-09-27T08:55:00Z');
  syncJobs(t0);
  const snap = pollerSnapshot(t0);
  const poolNames = snap.jobs.map(item => item.pool);
  assert.equal(new Set(poolNames).size, poolNames.length, 'tidak boleh ada pool dobel');
  for (const job of snap.jobs) {
    assert.equal(job.attempts, 0);
    assert.equal(job.status, 'WAITING');
  }
});

// Bantuan: catat tanggal draw awal tanpa memicu log siklus penuh.
async function markDrawObservationsSafe(slug, drawDate) {
  const { markDrawObservations } = await import('../src/toto-draw-scheduler.js');
  markDrawObservations([{ slug, drawDate, status: 'VERIFIED' }], { now: new Date('2026-09-26T10:00:00Z') });
}

test('lifecycle tetap satu-satunya pembuka: butuh result VERIFIED dan periode baru', async () => {
  const { buildCashWindowPlan } = await import('../src/toto-cash-window.js');
  const history = [{ period: '2026-09-24' }, { period: '2026-09-25' }];
  const schedule = { resultTime: '16:00', closeTime: '15:40', status: 'OBSERVED' };
  const nowMs = Date.parse('2026-09-26T00:00:00Z');

  // Tanpa decision sama sekali: tidak ada rencana buka.
  assert.equal(buildCashWindowPlan({ history, decision: null, resultPeriod: '2026-09-25', nowMs }), null);
  // Decision belum VERIFIED: tidak ada rencana buka.
  assert.equal(buildCashWindowPlan({ history, decision: { status: 'PROVISIONAL', drawDate: '2026-09-25', schedule }, resultPeriod: '2026-09-25', nowMs }), null);
  // VERIFIED tapi periode hasil sudah sama dengan periode yang Akan dibuka.
  const sudahLewat = buildCashWindowPlan({ history, decision: { status: 'VERIFIED', drawDate: '2026-09-26', schedule }, resultPeriod: '2026-09-26', nowMs });
  assert.equal(sudahLewat, null, 'periode yang sudah punya hasil tidak boleh dibuka lagi');
  // VERIFIED dan periode baru: lifecycle yang membuka.
  const sah = buildCashWindowPlan({ history, decision: { status: 'VERIFIED', drawDate: '2026-09-25', schedule }, resultPeriod: '2026-09-25', nowMs });
  assert.ok(sah && sah.period === '2026-09-26', 'periode berikutnya harus bisa dibuka lifecycle');
});

test('fallback markets.js tidak menulis pasar milik lifecycle', () => {
  const markets = readFileSync(new URL('../src/markets.js', import.meta.url), 'utf8');
  const openCheck = markets.slice(markets.indexOf('export async function runMarketOpenCheck'), markets.indexOf('export function startMarketOpenScheduler'));
  assert.match(openCheck, /COALESCE\(c\.auto_cash_window, FALSE\) = FALSE/);
  assert.match(openCheck, /COALESCE\(c\.auto_reopen_blocked, FALSE\) = FALSE/);
});

test('feed worker memakai poller, bukan loop scrape global', () => {
  const worker = readFileSync(new URL('../src/feed-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /from '\.\/toto-draw-poller\.js'/);
  assert.match(worker, /syncJobs\(now\)/);
  assert.match(worker, /dueJobs\(now\)/);
  assert.match(worker, /applyPollResult\(/);
  assert.doesNotMatch(worker, /anyDrawWindowActive/);
  assert.doesNotMatch(worker, /collectorIntervalMs/);
});
