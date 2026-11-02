import { config } from './config.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { sportsbookSnapshot } from './sportsbook-feed.js';

const clients = new Set();
let pollTimer = null;
let heartbeatTimer = null;
let inFlight = null;
let lastFeedRevision = '';
const metrics = {
  totalConnections: 0,
  broadcasts: 0,
  broadcastBytes: 0,
  refreshErrors: 0,
  lastBroadcastAt: null,
  lastRefreshAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  slowClientsDropped: 0
};

function sendEvent(response, event, data, id = '') {
  if (response.destroyed || response.writableEnded) return 0;
  if (Number(response.writableLength || 0) > 1024 * 1024) {
    metrics.slowClientsDropped += 1;
    response.destroy();
    return 0;
  }
  const payload = `${id ? `id: ${String(id).replace(/[\r\n]/g, '')}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  response.write(payload);
  return Buffer.byteLength(payload);
}
function removeClient(client) {
  clients.delete(client);
  if (!clients.size) stopTimers();
}
function stateToken(snapshot) {
  const source = snapshot?.source || {};
  const page = snapshot?.pagination || {};
  return [source.feedRevision || '', source.status || '', source.mode || '', snapshot?.stale ? 'stale' : 'fresh', page.offset || 0, page.limit || 0, page.total || 0, Number(source.pricedMarkets || 0), Number(source.bettableMarkets || 0)].join('|');
}
function broadcastSnapshot(client, snapshot) {
  const token = stateToken(snapshot);
  if (!token || token === client.lastStateToken) return;
  client.lastStateToken = token;
  lastFeedRevision = snapshot?.source?.feedRevision || lastFeedRevision;
  const id = snapshot?.source?.feedRevision || String(Date.now());
  const bytes = sendEvent(client.response, 'snapshot', snapshot, id);
  metrics.broadcasts += 1;
  metrics.broadcastBytes += bytes;
  metrics.lastBroadcastAt = new Date().toISOString();
}
async function refreshOnce() {
  if (inFlight || !clients.size) return inFlight;
  inFlight = (async () => {
    try {
      metrics.lastRefreshAt = new Date().toISOString();
      const snapshots = new Map();
      await Promise.all([...clients].map(async client => {
        try {
          const key = JSON.stringify(client.filters);
          let pending = snapshots.get(key);
          if (!pending) {
            pending = sportsbookSnapshot(client.filters);
            snapshots.set(key, pending);
          }
          broadcastSnapshot(client, await pending);
        } catch (error) {
          metrics.refreshErrors += 1;
          metrics.lastErrorAt = new Date().toISOString();
          metrics.lastErrorCode = error?.code || 'SPORTSBOOK_REALTIME_REFRESH_ERROR';
          logger.warn('Sportsbook realtime view unavailable', { code: error?.code, error: error?.message });
          sendEvent(client.response, 'degraded', { code: error?.code || 'SPORTSBOOK_REALTIME_REFRESH_ERROR', at: metrics.lastErrorAt });
        }
      }));
      return true;
    } catch (error) {
      metrics.refreshErrors += 1;
      metrics.lastErrorAt = new Date().toISOString();
      metrics.lastErrorCode = error?.code || 'SPORTSBOOK_REALTIME_REFRESH_ERROR';
      logger.warn('Sportsbook realtime refresh unavailable', { code: error?.code, error: error?.message });
      for (const client of [...clients]) {
        try { sendEvent(client.response, 'degraded', { code: error?.code || 'SPORTSBOOK_REALTIME_REFRESH_ERROR', at: metrics.lastErrorAt }); }
        catch { removeClient(client); }
      }
      return null;
    } finally { inFlight = null; }
  })();
  return inFlight;
}
function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  pollTimer = null;
  heartbeatTimer = null;
}
function ensureTimers() {
  if (!config.sportsbookRealtimeEnabled) return;
  if (!pollTimer) pollTimer = setInterval(() => { refreshOnce().catch(() => {}); }, config.sportsbookRealtimePollMs).unref();
  if (!heartbeatTimer) heartbeatTimer = setInterval(() => {
    const now = new Date().toISOString();
    for (const client of [...clients]) {
      try {
        if (!client.response.destroyed && !client.response.writableEnded) client.response.write(`: heartbeat ${now}\n\n`);
        else removeClient(client);
      } catch { removeClient(client); }
    }
  }, config.sportsbookRealtimeHeartbeatSeconds * 1000).unref();
}

export function openSportsbookRealtimeStream(request, response, filters = {}) {
  if (!config.sportsbookRealtimeEnabled) throw new AppError(503, 'Realtime Sportsbook sedang dinonaktifkan.', 'SPORTSBOOK_REALTIME_DISABLED');
  if (clients.size >= config.sportsbookRealtimeMaxClients) throw new AppError(503, 'Kapasitas koneksi realtime sedang penuh.', 'SPORTSBOOK_REALTIME_CAPACITY');
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.flushHeaders?.();
  response.write('retry: 3000\n\n');
  const client = {
    response,
    connectedAt: Date.now(),
    lastStateToken: '',
    filters: {
      sport: filters.sport || '',
      live: filters.live || '',
      q: filters.q || '',
      tab: filters.tab || 'all',
      league: filters.league || '',
      leagues: filters.leagues ?? null,
      country: filters.country || '',
      offset: filters.offset || 0,
      limit: filters.limit || 30,
      revision: filters.revision || ''
    }
  };
  clients.add(client);
  metrics.totalConnections += 1;
  sendEvent(response, 'ready', { connected: true, heartbeatSeconds: config.sportsbookRealtimeHeartbeatSeconds, pollMs: config.sportsbookRealtimePollMs, at: new Date().toISOString() });
  ensureTimers();
  refreshOnce().catch(() => {});
  const close = () => removeClient(client);
  request.once('close', close);
  response.once('close', close);
  response.once('error', close);
}

export function sportsbookRealtimeStatus() {
  return {
    enabled: Boolean(config.sportsbookRealtimeEnabled),
    connectedClients: clients.size,
    maxClients: config.sportsbookRealtimeMaxClients,
    pollMs: config.sportsbookRealtimePollMs,
    heartbeatSeconds: config.sportsbookRealtimeHeartbeatSeconds,
    lastFeedRevision: lastFeedRevision || null,
    ...metrics
  };
}

export const __sportsbookRealtime = { stateToken };
