export const SPORTRADAR_CHANGE_LOG_WINDOW_MS = 5 * 60 * 1000;

export function shouldReconcileChangeLog(lastSuccessfulPollAt, now = Date.now()) {
  const last = Number(lastSuccessfulPollAt);
  return !Number.isFinite(last) || last <= 0 || now - last > SPORTRADAR_CHANGE_LOG_WINDOW_MS;
}

export function getChangedSportEventIds(payload, trackedEventIds) {
  const tracked = trackedEventIds instanceof Set ? trackedEventIds : new Set(trackedEventIds || []);
  // Official endpoint reference documents status.change[], while the
  // integration guide's response example uses top-level changes[]. Accept
  // either documented envelope; never advance the cursor for unknown shapes.
  const changes = Array.isArray(payload?.changes)
    ? payload.changes
    : Array.isArray(payload?.status?.change)
      ? payload.status.change
      : null;
  if (!changes) throw new Error("SPORTRADAR_CHANGELOG_SHAPE_INVALID");
  return [...new Set(changes.flatMap(change => {
    if (change?.type && change.type !== "sport_event") return [];
    const id = change?.id;
    return typeof id === "string" && id.startsWith("sr:sport_event:") && tracked.has(id) ? [id] : [];
  }))];
}

// Initialize only once: discovery must never advance a missed Change Log window.
export async function initializeChangeLogBaseline(redis, key, timestamp = Date.now()) {
  const result = await redis.set(key, String(timestamp), { NX: true, EX: 30 * 24 * 60 * 60 });
  return result === "OK";
}
