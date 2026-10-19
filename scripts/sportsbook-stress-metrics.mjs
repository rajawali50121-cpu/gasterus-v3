import { appendFileSync } from 'node:fs';
import { writeHeapSnapshot } from 'node:v8';

const intervalMs = Number(process.env.STRESS_METRIC_INTERVAL_MS || 30_000);
const label = process.env.STRESS_METRIC_LABEL || process.title || 'node';
const metricLog = process.env.STRESS_METRIC_LOG;
const snapshotDir = process.env.STRESS_SNAPSHOT_DIR;

function sample() {
  const memory = process.memoryUsage();
  const timers = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
  const record = {
    at: new Date().toISOString(),
    label,
    pid: process.pid,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    timers
  };
  const line = `STRESS_METRIC ${JSON.stringify(record)}`;
  console.log(line);
  if (metricLog) appendFileSync(metricLog, `${JSON.stringify(record)}\n`);
}

setInterval(sample, intervalMs).unref();

function scheduleSnapshot(name, delayMs) {
  if (!snapshotDir || !Number.isFinite(delayMs) || delayMs <= 0) return;
  const timer = setTimeout(() => {
    const path = `${snapshotDir}/${label}-${name}.heapsnapshot`;
    const startedAt = Date.now();
    const writtenPath = writeHeapSnapshot(path);
    const record = { at: new Date().toISOString(), label, snapshot: name, path: writtenPath, durationMs: Date.now() - startedAt };
    console.log(`STRESS_SNAPSHOT ${JSON.stringify(record)}`);
    if (metricLog) appendFileSync(metricLog, `${JSON.stringify(record)}\n`);
  }, delayMs);
  timer.unref();
}

scheduleSnapshot('warmup', Number(process.env.STRESS_SNAPSHOT_WARMUP_MS || 120_000));
scheduleSnapshot('final', Number(process.env.STRESS_SNAPSHOT_FINAL_MS || 1_800_000));