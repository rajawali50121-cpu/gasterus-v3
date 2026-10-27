import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isWorkerHeartbeatFresh, workerHealthStatus } from '../src/worker-health.js';

const root = resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

test('worker heartbeat freshness is fail-closed for missing, invalid, future, and stale values', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const fresh = new Date(now - 179_000).toISOString();
  const stale = new Date(now - 180_001).toISOString();
  const future = new Date(now + 1_000).toISOString();

  assert.equal(isWorkerHeartbeatFresh(fresh, { now, staleAfterSeconds: 180 }), true);
  assert.equal(isWorkerHeartbeatFresh(new Date(now - 180_000).toISOString(), { now, staleAfterSeconds: 180 }), true);
  assert.equal(isWorkerHeartbeatFresh(stale, { now, staleAfterSeconds: 180 }), false);
  assert.equal(isWorkerHeartbeatFresh(future, { now, staleAfterSeconds: 180 }), false);
  assert.equal(isWorkerHeartbeatFresh('', { now, staleAfterSeconds: 180 }), false);
  assert.equal(isWorkerHeartbeatFresh('not-a-date', { now, staleAfterSeconds: 180 }), false);
  assert.deepEqual(workerHealthStatus(stale, { now, staleAfterSeconds: 180 }), { status: 'degraded', healthy: false });
});

test('public healthz is heartbeat-gated while the core route stays status-only', () => {
  const app = read('backend/src/app.js');
  const gateway = read('deploy/gateway.js');
  assert.match(app, /add\('GET',\/\^\\\/healthz\$\//);
  assert.match(app, /redis\.get\(config\.workerHeartbeatKey\)/);
  assert.match(app, /isWorkerHeartbeatFresh/);
  assert.match(app, /healthy\?200:503/);
  assert.doesNotMatch(app.match(/add\('GET',\/\^\\\/healthz\$\/[^;]+;/)[0], /heartbeatAt|heartbeatAgeSeconds|error/);
  assert.match(gateway, /localReady\(Number\(process\.env\.CORE_INTERNAL_PORT \|\| 8083\), '\/healthz'\)/);
  assert.match(gateway, /coreHealthy \? 200 : 503/);
  assert.doesNotMatch(gateway, /url\.pathname === '\/healthz'[\s\S]{0,180}deploymentId/);
});

test('core readiness is HTTP-unready when database or cache is unhealthy', () => {
  const app = read('backend/src/app.js');
  const readyRoute = app.match(/add\('GET',\/\^\\\/ready\$\/,[\s\S]*?\n\}\);/);

  assert.ok(readyRoute, 'core /ready route should exist');
  assert.match(readyRoute[0], /checkDatabase\(\),checkRedis\(\)/);
  assert.match(readyRoute[0], /database\.ok&&cache\.ok/);
  assert.match(readyRoute[0], /status:ready\?'ready':'degraded'/);
  assert.match(readyRoute[0], /ready\?200:503/);
  assert.match(readyRoute[0], /database,cache/);
});
