import { AppError } from './errors.js';

export function compactMemberMarkets(markets = []) {
  return Array.isArray(markets) ? markets : [];
}

const MEMBER_PAGE_SIZE = 30;
const CURSOR_FILTERS = ['sport', 'live', 'q', 'league'];

function normalizedCursorFilters(filters = {}) {
  return Object.fromEntries(CURSOR_FILTERS.map(key => [key, String(filters[key] ?? '')]));
}
function eventCursorKey(event) {
  const parsed = Date.parse(event?.startTime || '');
  return { start: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER, id: String(event?.id || '') };
}
function compareCursorKeys(left, right) {
  return left.start - right.start || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function encodeMemberCursor(event, revision, filters) {
  return Buffer.from(JSON.stringify({ v: 1, revision, filters, after: eventCursorKey(event) })).toString('base64url');
}
function decodeMemberCursor(cursor, revision, filters) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (value?.v !== 1 || !value.after || !Number.isSafeInteger(value.after.start) || typeof value.after.id !== 'string') throw new Error('invalid cursor');
    if (value.revision !== revision) throw new AppError(409, 'Katalog pertandingan berubah. Muat ulang daftar sebelum melanjutkan.', 'SPORTSBOOK_CURSOR_STALE');
    if (JSON.stringify(value.filters) !== JSON.stringify(filters)) throw new Error('cursor filters changed');
    return value.after;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'Cursor katalog sportsbook tidak valid.', 'SPORTSBOOK_CURSOR_INVALID');
  }
}

export function paginateMemberEvents(events = [], { cursor = '', revision = '', filters = {} } = {}) {
  const normalizedFilters = normalizedCursorFilters(filters);
  const ordered = [...(Array.isArray(events) ? events : [])].sort((left, right) => compareCursorKeys(eventCursorKey(left), eventCursorKey(right)));
  const after = cursor ? decodeMemberCursor(cursor, revision, normalizedFilters) : null;
  const remaining = after ? ordered.filter(event => compareCursorKeys(eventCursorKey(event), after) > 0) : ordered;
  const candidates = remaining.slice(0, MEMBER_PAGE_SIZE + 1);
  const hasMore = candidates.length > MEMBER_PAGE_SIZE;
  const page = candidates.slice(0, MEMBER_PAGE_SIZE);
  return {
    events: page,
    hasMore,
    nextCursor: hasMore ? encodeMemberCursor(page[page.length - 1], revision, normalizedFilters) : null,
    pageSize: MEMBER_PAGE_SIZE
  };
}

export function projectMemberMarkets(markets = []) {
  return (markets || []).map(market => ({
    id: market.id,
    type: market.type,
    label: market.label,
    period: market.period,
    line: market.line,
    suspended: market.suspended,
    mainLine: market.mainLine ?? null,
    selections: (market.selections || []).map(selection => ({
      key: selection.key,
      label: selection.label,
      odds: selection.odds,
      line: selection.line,
      suspended: selection.suspended,
      priceVersion: selection.priceVersion
    }))
  }));
}
