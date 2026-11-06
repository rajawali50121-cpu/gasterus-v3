const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const seen = new Set();
  const normalized = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    const id = String(event.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const markets = Array.isArray(event.markets)
      ? event.markets.filter(isRecord).map(market => ({
        ...market,
        selections: Array.isArray(market.selections) ? market.selections.filter(isRecord) : []
      }))
      : [];
    normalized.push({
      ...event,
      id,
      home: isRecord(event.home) ? event.home : {},
      away: isRecord(event.away) ? event.away : {},
      markets
    });
  }

  return normalized;
}

export function normalizeSnapshot(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.events)) return null;
  const events = normalizeEvents(snapshot.events);
  if (snapshot.events.length && !events.length) return null;

  return {
    ...snapshot,
    events,
    source: isRecord(snapshot.source) ? snapshot.source : {},
    counts: isRecord(snapshot.counts) ? snapshot.counts : {},
    leagues: Array.isArray(snapshot.leagues) ? snapshot.leagues.filter(isRecord) : [],
    pagination: isRecord(snapshot.pagination)
      ? snapshot.pagination
      : { offset: 0, limit: events.length, total: events.length, hasMore: false }
  };
}

export function shouldApplySnapshot(current, incoming) {
  if (!incoming || !Array.isArray(incoming.events)) return false;
  const currentRevision = current?.source?.feedRevision;
  const incomingRevision = incoming?.source?.feedRevision;
  if (!currentRevision && !current?.source?.fetchedAt) return true;
  if (currentRevision && currentRevision === incomingRevision) return true;

  const currentAt = Date.parse(current?.source?.fetchedAt || current?.source?.capturedAt || '');
  const incomingAt = Date.parse(incoming?.source?.fetchedAt || incoming?.source?.capturedAt || '');
  if (Number.isFinite(currentAt) && Number.isFinite(incomingAt)) {
    if (incomingAt !== currentAt) return incomingAt > currentAt;
    return currentRevision === incomingRevision;
  }
  if (currentRevision && incomingRevision && currentRevision !== incomingRevision) return false;
  return true;
}

export function mergeEventsAtOffset(currentEvents, incomingEvents, offset = 0, { preserveTail = false } = {}) {
  const current = normalizeEvents(currentEvents);
  const incoming = normalizeEvents(incomingEvents);
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  if (!pageOffset) return preserveTail
    ? normalizeEvents([...incoming, ...current.slice(incoming.length)])
    : incoming;
  if (pageOffset > current.length) return null;

  return normalizeEvents([
    ...current.slice(0, pageOffset),
    ...incoming,
    ...current.slice(pageOffset + incoming.length)
  ]);
}

export function nextPageOffset(currentOffset, pageSize) {
  const offset = Math.max(0, Math.floor(Number(currentOffset) || 0));
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  return offset + size;
}

export function connectionState(hasSnapshot, streamConnected, feedStatus = '') {
  if (String(feedStatus).toUpperCase() === 'OFFLINE') return 'offline';
  if (streamConnected) return hasSnapshot ? 'online' : 'connecting';
  return hasSnapshot ? 'snapshot' : 'connecting';
}

export function filterVisibleEvents(events, {
  sport = 'all',
  league = 'all',
  country = 'all',
  filter = 'all',
  searchQuery = '',
  favLeagues = new Set(),
  favMatches = new Set(),
  isLive = event => Boolean(event?.live) || String(event?.status || '').toUpperCase() === 'LIVE',
  isToday = () => false,
  isFuture = () => false
} = {}) {
  let list = Array.isArray(events) ? events.filter(isRecord) : [];
  if (sport !== 'all') list = list.filter(event => String(event.sport || '').toLowerCase() === String(sport).toLowerCase());
  if (league !== 'all') list = list.filter(event => String(event.league || '') === league);
  if (country !== 'all') list = list.filter(event => String(event.country || '') === country);

  if (filter === 'live') list = list.filter(isLive);
  else if (filter === 'today') list = list.filter(event => isToday(event) || isLive(event));
  else if (filter === 'early') list = list.filter(isFuture);
  else if (filter === 'fav') list = list.filter(event => favLeagues.has(String(event.league || 'Liga Internasional')) || favMatches.has(String(event.id)));

  const query = String(searchQuery || '').trim().toLowerCase();
  if (query) {
    list = list.filter(event =>
      String(event.league || '').toLowerCase().includes(query) ||
      String(event.home?.name || '').toLowerCase().includes(query) ||
      String(event.away?.name || '').toLowerCase().includes(query));
  }
  return list;
}

export function renderItemsSafely(items, renderItem, renderFallback, onError = () => {}) {
  return items.map((item, index) => {
    try {
      return renderItem(item, index);
    } catch (error) {
      onError(error, item, index);
      try {
        return renderFallback(item, error, index);
      } catch {
        return '';
      }
    }
  }).join('');
}