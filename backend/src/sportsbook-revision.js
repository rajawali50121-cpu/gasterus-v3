import { redis } from './redis.js';
import { config } from './config.js';
import { SPORTSBOOK_INGEST_REDIS_KEY } from './sportsbook-ingestion.js';
import { allocateRevision as storeAllocateRevision } from './sportsbook-ingest-revision-store.js';

export async function allocateRevision() {
  if (!redis.isOpen) {
    throw new Error('Redis unavailable; cannot allocate sportsbook ingestion revision.');
  }
  return storeAllocateRevision(redis, config.sportsbookIngestRevisionKey, SPORTSBOOK_INGEST_REDIS_KEY);
}

export async function initializeRevisionCounter() {
  return allocateRevision();
}

export function isRevisionCounterInitialized() {
  return true;
}

export function resetRevisionCounterForTest() {
  // No-op: counter is managed atomically by Redis Lua; no JS-side state to reset.
}
