const managedCaches = new Set();

export function pruneExpiredCacheEntries(cache, now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry?.inFlight) continue;
    const expiresAt = Number(entry?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) cache.delete(key);
  }
}

export function ensureBoundedCacheCapacity(cache, key, maxEntries) {
  while (!cache.has(key) && cache.size >= maxEntries) {
    let oldestKey = null;
    let oldestFetchedAt = Number.POSITIVE_INFINITY;
    for (const [entryKey, entry] of cache) {
      if (entry?.inFlight || entry?.value === undefined) continue;
      const fetchedAt = Number(entry.fetchedAt) || 0;
      if (fetchedAt < oldestFetchedAt) {
        oldestKey = entryKey;
        oldestFetchedAt = fetchedAt;
      }
    }
    if (oldestKey === null) {
      throw new Error(`Provider cache reached its ${maxEntries}-entry limit`);
    }
    cache.delete(oldestKey);
  }
}

export function setBoundedCacheEntry(cache, key, value, {
  fetchedAt = Date.now(),
  expiresAt = null,
  maxEntryBytes,
  maxTotalBytes,
  maxEntries = Number.POSITIVE_INFINITY
} = {}) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cache value is not JSON-serializable');
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  if (sizeBytes > maxEntryBytes) {
    throw new Error(`Provider response exceeds cache entry limit (${sizeBytes} > ${maxEntryBytes} bytes)`);
  }
  if (sizeBytes > maxTotalBytes) {
    throw new Error(`Provider response exceeds total cache limit (${sizeBytes} > ${maxTotalBytes} bytes)`);
  }

  let totalBytes = 0;
  const oldestFirst = [];
  const now = Date.now();
  for (const managedCache of managedCaches) pruneExpiredCacheEntries(managedCache, now);
  managedCaches.add(cache);
  pruneExpiredCacheEntries(cache, now);
  ensureBoundedCacheCapacity(cache, key, maxEntries);
  for (const managedCache of managedCaches) {
    for (const [entryKey, entry] of managedCache) {
      if (managedCache === cache && entryKey === key) continue;
      const entrySize = Number(entry?.sizeBytes) || 0;
      totalBytes += entrySize;
      if (!entry?.inFlight && entry?.value !== undefined) {
        oldestFirst.push([managedCache, entryKey, Number(entry?.fetchedAt) || 0, entrySize]);
      }
    }
  }
  oldestFirst.sort((a, b) => a[2] - b[2]);

  while (totalBytes + sizeBytes > maxTotalBytes && oldestFirst.length) {
    const [oldestCache, oldestKey, , entrySize] = oldestFirst.shift();
    oldestCache.delete(oldestKey);
    totalBytes -= entrySize;
  }
  if (totalBytes + sizeBytes > maxTotalBytes) {
    throw new Error('Provider response cannot fit within total cache limit');
  }

  const entry = { value, fetchedAt, sizeBytes };
  if (Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0) entry.expiresAt = Number(expiresAt);
  cache.set(key, entry);
  return entry;
}
