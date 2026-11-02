export const SPORTSBOOK_FEED_REVISIONS_KEY = 'sportsbook:aggregated-feed-revisions:v1';
const MAX_REVISIONS = 2;

function parseSnapshots(raw, { now, maxAgeMs }) {
  let snapshots;
  try {
    snapshots = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter(snapshot => {
    const fetchedAt = Number(snapshot?.fetchedAt);
    const ageMs = now - fetchedAt;
    return /^[a-f0-9]{32}$/i.test(String(snapshot?.revision || ''))
      && Array.isArray(snapshot.events)
      && Number.isFinite(fetchedAt)
      && ageMs >= 0
      && ageMs <= maxAgeMs;
  });
}

export function appendFeedRevision(raw, feed, { now = Date.now(), maxAgeMs } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1) throw new Error('A positive revision cache lifetime is required.');
  if (!/^[a-f0-9]{32}$/i.test(String(feed?.revision || ''))) throw new Error('A valid feed revision is required.');
  const previous = parseSnapshots(raw, { now, maxAgeMs })
    .filter(snapshot => snapshot.revision !== feed.revision);
  return JSON.stringify([feed, ...previous].slice(0, MAX_REVISIONS));
}

export function readFeedRevision(raw, revision, { now = Date.now(), maxAgeMs } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(String(revision || '')) || !Number.isFinite(maxAgeMs) || maxAgeMs < 1) return null;
  return parseSnapshots(raw, { now, maxAgeMs })
    .find(snapshot => snapshot.revision === revision) || null;
}

export function paginateEvents(events = [], { offset, limit } = {}) {
  const pageSize = Math.min(500, Math.max(1, Number(limit) || 500));
  const start = Math.max(0, Math.min(events.length, Math.floor(Number(offset) || 0)));
  const page = events.slice(start, start + pageSize);
  return {
    events: page,
    pagination: {
      offset: start,
      limit: pageSize,
      total: events.length,
      hasMore: start + page.length < events.length
    }
  };
}