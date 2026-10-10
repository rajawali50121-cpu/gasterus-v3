/**
 * GASTERUS Sportsbook — WAM-inspired UI, wired to the Gasterus API only.
 *
 * DATA SOURCES (all Gasterus, realtime, never mocked):
 *   - GET  /api/member/sportsbook/stream      (SSE — full snapshot + realtime revisions)
 *   - GET  /api/member/sportsbook/events/{id} (full market detail)
 *   - POST /api/member/sportsbook/quotes      (server quote / odds lock + revalidation)
 *   - POST /api/member/sportsbook/bets        (place bet with quoteToken + idempotency)
 *
 * The member API has NO /feed REST endpoint; the SSE stream IS the member feed.
 * No games.json, no Math.random(), no setTimeout bet simulation.
 */
import api from './api.js';
import auth from './auth.js';
import { formatRupiah, showToast, escapeHtml } from './utils.js';
import { primaryMarketColumns } from './sportsbook-markets.js';
import { chooseCombinations, systemBetMetrics } from './sportsbook-slip-calculation.js';

const STREAM_URL = '/api/member/sportsbook/stream';
const SNAPSHOT_URL = '/api/member/sportsbook/events';
const FEED_DETAIL_URL = (id) => `/api/member/sportsbook/events/${encodeURIComponent(id)}`;
const EVENTS_PAGE_SIZE = 30;
const BETSLIP_MOBILE_BREAKPOINT = 860;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let feed = { events: [], stale: false, degraded: false, source: {} };
let selected = new Map(); // selectionKey -> leg payload (betslip)
const eventDetails = new Map();
const eventDetailRequests = new Map();
const pendingEventDetails = new Set();
const expandedEventMarkets = new Set();
const selectedEventPeriods = new Map();
let currentSport = 'all';
let currentLeague = 'all';
let currentFilter = 'all'; // all | live | today | early | fav
let searchQuery = '';
let visibleEventLimit = EVENTS_PAGE_SIZE;
const FAV_KEY = 'gasterus_sb_fav_leagues';
let favLeagues = new Set();
try { favLeagues = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { favLeagues = new Set(); }
let lastRenderRevision = '';
let lastStructureRevision = '';
let bettingConfig = { minStake: 1000, maxStake: 50000000, maxLegs: 12, maxSystemCombinations: 120, quoteRequired: true, types: ['SINGLE', 'PARLAY', 'SYSTEM'] };
let streamClosed = false;
let quote = null; // last successful server quote
let quoteGeneration = 0;
let placing = false;
let lastStake = 0; // fallback stake saat input tidak ada di DOM (mobile sheet tertutup)

const el = (id) => document.getElementById(id);
const selKey = (ev, mk, sk) => `${ev}|${mk}|${sk}`;

// Visual Odds Movement Tracking
const previousOddsMap = new Map(); // selKey -> number (decimal odds)
const oddsMovementMap = new Map(); // selKey -> { direction: 'up' | 'down', timestamp: number }
const oddsCleanupTimers = new Map(); // selKey -> timeoutId
let isInitialSnapshot = true;

function updateOddsInDOM(key, direction, curOdds, sk) {
  const elements = document.querySelectorAll(`[data-sel="${key}"]`);
  if (!elements.length) return;
  const oddsText = formatDecimalOdds(curOdds);
  const arrowHtml = direction === 'up'
    ? '<span class="sb-odd-movement-arrow up" aria-label="Odds naik">↑</span>'
    : '<span class="sb-odd-movement-arrow down" aria-label="Odds turun">↓</span>';
  const moveClass = direction === 'up' ? 'sb-odd-movement-up' : 'sb-odd-movement-down';

  elements.forEach(btn => {
    btn.setAttribute('data-odds', curOdds);
    if (sk?.priceVersion) btn.setAttribute('data-pv', sk.priceVersion);

    const oddsSpan = btn.querySelector('.sb-cell-odds');
    if (oddsSpan) {
      oddsSpan.className = 'sb-cell-odds pos';
      oddsSpan.innerHTML = `${escapeHtml(oddsText)}${arrowHtml}`;
    } else {
      const quickText = btn.querySelector('div[style*="font-size:11px"]');
      if (quickText) {
        quickText.style.cssText = 'font-size:11px; font-weight:800; color:#111827;';
        quickText.innerHTML = `${escapeHtml(oddsText)}${arrowHtml}`;
      }
    }

    btn.classList.remove('sb-odd-movement-up', 'sb-odd-movement-down');
    void btn.offsetWidth; // Force reflow to restart CSS animation
    btn.classList.add(moveClass);
  });
}

function trackOddsMovement(events) {
  if (!Array.isArray(events)) return false;
  const now = Date.now();
  let anyMoved = false;

  for (const ev of events) {
    if (!ev || !Array.isArray(ev.markets)) continue;
    for (const mk of ev.markets) {
      if (!mk || !Array.isArray(mk.selections)) continue;
      for (const sk of mk.selections) {
        if (!sk || sk.suspended) continue;
        const key = selKey(ev.id, mk.id, sk.key);
        const curOdds = Number(sk.odds);
        if (!Number.isFinite(curOdds) || curOdds <= 1) continue;

        if (isInitialSnapshot) {
          // Rule 5: Initial load does not trigger flash or arrows
          previousOddsMap.set(key, curOdds);
        } else {
          if (previousOddsMap.has(key)) {
            const prevOdds = previousOddsMap.get(key);
            // Rule 14: Only trigger if odds actually changed
            if (Math.abs(curOdds - prevOdds) >= 0.001) {
              const direction = curOdds > prevOdds ? 'up' : 'down';
              oddsMovementMap.set(key, { direction, timestamp: now });
              previousOddsMap.set(key, curOdds);
              anyMoved = true;
              updateOddsInDOM(key, direction, curOdds, sk);
              scheduleOddsMovementCleanup(key, 1800);
            }
          } else {
            // New selection appearing after first load
            previousOddsMap.set(key, curOdds);
          }
        }
      }
    }
  }

  if (isInitialSnapshot && events.length > 0) {
    isInitialSnapshot = false;
  }
  return anyMoved;
}

function scheduleOddsMovementCleanup(key, delayMs = 1000) {
  if (oddsCleanupTimers.has(key)) {
    clearTimeout(oddsCleanupTimers.get(key));
  }
  const timer = setTimeout(() => {
    oddsCleanupTimers.delete(key);
    oddsMovementMap.delete(key);
    const elements = document.querySelectorAll(`[data-sel="${key}"]`);
    elements.forEach(btn => {
      btn.classList.remove('sb-odd-movement-up', 'sb-odd-movement-down');
      const arrows = btn.querySelectorAll('.sb-odd-movement-arrow');
      arrows.forEach(a => a.remove());
    });
  }, delayMs);
  oddsCleanupTimers.set(key, timer);
}
const fmt = (n) => (Number.isFinite(Number(n)) ? new Intl.NumberFormat('id-ID').format(Number(n)) : '0');
const isLiveEvent = (e) => Boolean(e?.live) || String(e?.status || '').toUpperCase() === 'LIVE';
const isFinishedEvent = (e) => String(e?.status || '').toUpperCase() === 'FINISHED';

// Realtime Live Match Clock Tracking
const liveClockState = new Map(); // eventId -> { isPaused, prefix, isInjury, baseMin, plusMin, totalSec, display, snapshotTime }
let liveClockTimer = null;

function parseLiveClock(clockStr) {
  const str = String(clockStr || "1H 0'").trim();
  const upper = str.toUpperCase();
  if (/^(HT|FT|HALF\s*TIME|HALFTIME|FULL\s*TIME|FINISHED|AET|BREAK|PEN|PENALTIES)\b/i.test(upper)) {
    return { isPaused: true, display: str };
  }
  const colonMatch = str.match(/^(?:(1H|2H|ET)\s+)?(\d+):(\d+)$/i);
  if (colonMatch) {
    const prefix = colonMatch[1] ? colonMatch[1].toUpperCase() + ' ' : '';
    const m = parseInt(colonMatch[2], 10);
    const s = parseInt(colonMatch[3], 10);
    return { isPaused: false, prefix, isInjury: false, totalSec: m * 60 + s, display: str };
  }
  const injuryMatch = str.match(/^(?:(1H|2H|ET)\s+)?(\d+)\+(\d+)(?:'|’)?$/i);
  if (injuryMatch) {
    const prefix = injuryMatch[1] ? injuryMatch[1].toUpperCase() + ' ' : '';
    const baseMin = parseInt(injuryMatch[2], 10);
    const plusMin = parseInt(injuryMatch[3], 10);
    return { isPaused: false, prefix, isInjury: true, baseMin, plusMin, totalSec: (baseMin + plusMin) * 60, display: str };
  }
  const regMatch = str.match(/^(?:(1H|2H|ET)\s+)?(\d+)(?:'|’)?$/i);
  if (regMatch) {
    const prefix = regMatch[1] ? regMatch[1].toUpperCase() + ' ' : '';
    const minutes = parseInt(regMatch[2], 10);
    return { isPaused: false, prefix, isInjury: false, totalSec: minutes * 60, display: str };
  }
  return { isPaused: true, display: str };
}

function formatLiveClockDisplay(item, elapsedSec = 0) {
  if (!item || item.isPaused) return item?.display || "1H 0'";
  const currentTotalSec = item.totalSec + elapsedSec;
  const m = Math.floor(currentTotalSec / 60);
  const s = currentTotalSec % 60;
  const sStr = String(s).padStart(2, '0');
  if (item.isInjury) {
    return `${item.prefix}${item.baseMin}+${item.plusMin}' ${sStr}"`;
  }
  return `${item.prefix}${m}:${sStr}`;
}

function getLiveClockDisplay(e) {
  const evId = String(e?.id || '');
  const state = liveClockState.get(evId);
  if (!state) {
    const parsed = parseLiveClock(e?.clock);
    return formatLiveClockDisplay(parsed, 0);
  }
  if (state.isPaused) return state.display;
  const elapsedSec = Math.floor((Date.now() - state.snapshotTime) / 1000);
  return formatLiveClockDisplay(state, elapsedSec);
}

function syncLiveClocks(events) {
  if (!Array.isArray(events)) return;
  const now = Date.now();
  const liveIds = new Set();

  for (const ev of events) {
    if (!ev || !isLiveEvent(ev)) continue;
    const evId = String(ev.id);
    liveIds.add(evId);
    const parsed = parseLiveClock(ev.clock);
    liveClockState.set(evId, {
      ...parsed,
      snapshotTime: now
    });
  }

  for (const id of liveClockState.keys()) {
    if (!liveIds.has(id)) {
      liveClockState.delete(id);
    }
  }

  if (liveClockState.size > 0) {
    startLiveClockTimer();
  } else {
    stopLiveClockTimer();
  }
}

function startLiveClockTimer() {
  if (!liveClockTimer) {
    liveClockTimer = setInterval(tickLiveClocks, 1000);
  }
}

function stopLiveClockTimer() {
  if (liveClockTimer) {
    clearInterval(liveClockTimer);
    liveClockTimer = null;
  }
}

function tickLiveClocks() {
  if (!liveClockState.size) {
    stopLiveClockTimer();
    return;
  }
  const now = Date.now();
  const elements = document.querySelectorAll('.sb-live-clock-sm[data-live-clock-id], .sb-match-live-clock[data-live-clock-id]');
  elements.forEach((node) => {
    const id = node.getAttribute('data-live-clock-id');
    const state = liveClockState.get(id);
    if (!state || state.isPaused) return;
    const elapsedSec = Math.floor((now - state.snapshotTime) / 1000);
    const text = formatLiveClockDisplay(state, elapsedSec);
    if (node.textContent !== text) {
      node.textContent = text;
    }
  });
}
function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favLeagues])); } catch { /* ignore */ } }
function toggleFavLeague(league) {
  const l = String(league || '');
  if (!l) return;
  if (favLeagues.has(l)) favLeagues.delete(l); else favLeagues.add(l);
  saveFavs();
}
async function refreshBalance() { try { await auth.fetchMe(); auth.updateHeaderAuthUI(); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export async function initSportsbook() {
  buildSkeleton();
  auth.updateHeaderAuthUI();
  if (auth.isLoggedIn()) {
    try { await auth.fetchMe(); } catch { /* session already expired */ }
    auth.updateHeaderAuthUI();
  }
  setupFilterTabs();
  setupSearch();
  setupSlipSheet();
  bindEventHandlers();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth.isLoggedIn()) refreshBalance(); });

  if (auth.isLoggedIn()) {
    startStream();
    refreshTicketNote();
  } else {
    // Public preview: unauthenticated visitors can view all matches and live odds
    setStatus('online');
    loadRestSnapshot(); // 1x saja — SSE member yang mengambil alih realtime setelah login
  }
}

function buildSkeleton() {
  const s = el('sb-skeleton');
  if (!s) return;
  let h = '';
  for (let i = 0; i < 4; i += 1) {
    h += `<div class="sb-sk-card"><div class="sb-sk-line" style="width:45%"></div>` +
      `<div class="sb-sk-line" style="width:80%"></div>` +
      `<div class="sb-sk-line" style="width:30%"></div></div>`;
  }
  s.innerHTML = h;
}

function renderAuthRequired() {
  const sk = el('sb-skeleton');
  if (sk) { sk.innerHTML = ''; sk.hidden = true; }
  const dot = el('rt-dot');
  const label = el('rt-label');
  if (dot) dot.className = 'sb-rt-dot off';
  if (label) label.textContent = 'Login diperlukan';
  const ev = el('sb-events');
  if (ev) ev.innerHTML = '';
  const empty = el('sb-empty');
  if (empty) {
    empty.hidden = false;
    empty.innerHTML = 'Sportsbook khusus member. <a href="/index.html"><strong>Login di sini</strong></a> untuk melihat odds dan memasang taruhan.';
  }
  const err = el('sb-error');
  if (err) err.hidden = true;
}

function setStatus(state) {
  const dot = el('rt-dot');
  const label = el('rt-label');
  if (state === 'online') { if (dot) dot.className = 'sb-rt-dot on'; if (label) label.textContent = 'Live'; }
  else if (state === 'connecting') { if (dot) dot.className = 'sb-rt-dot'; if (label) label.textContent = 'Connecting…'; }
  else { if (dot) dot.className = 'sb-rt-dot off'; if (label) label.textContent = 'Offline'; }
}

// ---------------------------------------------------------------------------
// SSE stream — manual client so the Authorization header can be sent.
// EventSource cannot set headers, and the member session may be Bearer-based.
// ---------------------------------------------------------------------------
const SB_BUILD = 'sb8';
window.__SB_BUILD = SB_BUILD;
console.info(`[GASTERUS] sportsbook build ${SB_BUILD}`);

function startStream() {
  streamClosed = false;
  setStatus('connecting');
  loadRestSnapshot(); // REST bootstrap 1x — render papan data seketika; SSE mengambil alih realtime.
  // Timer REST 45 detik DIHAPUS: SSE broadcast tiap revisi feed, jadi polling berkala
  // hanya mengulang snapshot yang sama (beban request + render sia-sia, dan sempat jadi
  // akar pola 222↔5). Cadangan tetap ada: bootstrap 1x di atas + loadRestSnapshot()
  // di catch SSE (baris ~415) saat stream benar-benar putus.
  connectStream();
}

// REST bootstrap/fallback — papan tetap terisi walau SSE terblokir/dibuffer perantara.
async function loadRestSnapshot() {
  try {
    const headers = { Accept: 'application/json' };
    if (api.token) { headers.Authorization = `Bearer ${api.token}`; headers['x-session-token'] = api.token; }
    const res = await fetch(SNAPSHOT_URL, { method: 'GET', credentials: 'include', headers });
    if (!res.ok) { console.warn('[GASTERUS] snapshot http', res.status); return false; }
    const json = await res.json();
    const payload = json?.data || json || null;
    if (payload && Array.isArray(payload.events) && payload.events.length) {
      onSnapshot(payload);
      return true;
    }
  } catch (e) { console.warn('[GASTERUS] snapshot bootstrap gagal', e); }
  return false;
}

async function connectStream() {
  let backoff = 1500;
  while (!streamClosed) {
    try {
      const headers = { Accept: 'text/event-stream', 'x-session-token': api.token || '' };
      if (api.token) headers.Authorization = `Bearer ${api.token}`;
      const res = await fetch(STREAM_URL, { method: 'GET', credentials: 'include', headers });
      if (res.status === 401) {
        window.location.href = '/index.html?msg=session_expired';
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);
      setStatus('online');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!streamClosed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value ?? new Uint8Array(0), { stream: true });
        if (buf.length > 2 * 1024 * 1024) buf = ''; // Safety guard against runaway buffer leak
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(frame.replace(/\r\n/g, '\n'));
        }
      }
      reader.release?.();
      if (streamClosed) return;
    } catch (e) {
      // transport error — refresh data via REST fallback lalu reconnect dengan backoff
      await loadRestSnapshot();
    }
    if (streamClosed) return;
    setStatus('connecting');
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 1.6, 15000);
  }
}

function handleFrame(frame) {
  if (!frame.trim()) return;
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
  }
  if (event === 'ready') { streamActive = true; return; } // handshake only
  if (event === 'degraded') { setStatus('online'); return; }
  if (event === 'snapshot' && data) {
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    onSnapshot(payload);
  }
}

// Re-render only when the feed revision actually changes (prevents flicker).
// Satu sumber kebenaran: SSE adalah penulis utama feed. REST hanya bootstrap 1x +
// darurat saat SSE putus — tidak ada lagi dua penulis yang saling menimpa (akar pola 222↔5).
function onSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return;
  const previousFeedRevision = String(feed.source?.feedRevision || '');
  const revision = snapshot.source?.feedRevision || '';
  feed = {
    events: snapshot.events,
    stale: Boolean(snapshot.stale),
    degraded: Boolean(snapshot.degraded),
    source: snapshot.source || {}
  };
  const detailRefreshIds = new Set();
  if (revision && revision !== previousFeedRevision) {
    const currentEventIds = new Set(feed.events.map(event => event.id));
    for (const eventId of expandedEventMarkets) {
      if (currentEventIds.has(eventId)) detailRefreshIds.add(eventId);
      else {
        expandedEventMarkets.delete(eventId);
        eventDetails.delete(eventId);
        pendingEventDetails.delete(eventId);
      }
    }
    for (const selection of selected.values()) {
      const summary = feed.events.find(event => event.id === selection.eventId);
      if (summary && !summary.markets?.some(market => market.id === selection.marketId)) {
        detailRefreshIds.add(selection.eventId);
      }
    }
    for (const eventId of detailRefreshIds) {
      eventDetails.delete(eventId);
      pendingEventDetails.add(eventId);
      const panel = el(`event-markets-${eventId}`);
      if (panel && expandedEventMarkets.has(eventId)) panel.innerHTML = '<div class="sb-detail-markets-status">Memperbarui odds…</div>';
    }
    if (detailRefreshIds.size && [...selected.values()].some(selection => detailRefreshIds.has(selection.eventId))) {
      quote = null;
      quoteGeneration += 1;
    }
  }
  if (snapshot.betting) bettingConfig = { ...bettingConfig, ...snapshot.betting };
  syncLiveClocks(feed.events);
  trackOddsMovement(feed.events);
  const selectionEvents = eventsWithFreshDetails();
  const oddsMoved = syncSelectedOdds(selectionEvents);
  pruneSelections(selectionEvents);
  const selectedDetailsPending = [...selected.values()].some(selection => pendingEventDetails.has(selection.eventId));
  if (selectedDetailsPending) {
    quote = null;
    renderBetslip();
  }
  if (oddsMoved) {
    quote = null; // harga berubah → quote lama tidak valid, minta ulang
    quoteGeneration += 1;
    renderBetslip();
    if (el('sb-stake')) onStakeChange();
  }

  const eventsEl = el('sb-events');
  const needsFirstRender = !eventsEl || !eventsEl.innerHTML;
  const structRev = feed.events.map(e => `${e.id}:${e.status}:${e.live?1:0}:${e.home?.score ?? ''}-${e.away?.score ?? ''}:${(e.markets||[]).map(m=>`${m.id}:${m.suspended?1:0}`).join(',')}`).join(';');
  const structureChanged = structRev !== lastStructureRevision;
  if (structureChanged || needsFirstRender) {
    lastStructureRevision = structRev;
    lastRenderRevision = revision;
    try { renderAll(); }
    catch (e) {
      // Fail-loud: bug render harus terlihat, bukan "Connecting…" tanpa akhir.
      console.error('[GASTERUS] renderAll gagal', e);
      if (eventsEl) eventsEl.innerHTML = `<div class="sb-empty">Gagal menampilkan papan: ${escapeHtml(e?.message || String(e))} (build ${SB_BUILD})</div>`;
    }
  }
  renderStatusMeta();
  for (const eventId of detailRefreshIds) void loadEventMarkets(eventId, { notify: false });
}

function eventsWithFreshDetails(events = feed.events) {
  const revision = String(feed.source?.feedRevision || '');
  return (events || []).map(event => {
    const detail = eventDetails.get(event.id);
    return detail && detail.revision === revision
      ? { ...event, ...detail.event, markets: detail.event.markets }
      : event;
  });
}

function pruneSelections(events) {
  if (!selected.size) return;
  const liveKeys = new Set();
  for (const ev of events) {
    for (const mk of ev.markets || []) {
      if (mk.suspended) continue;
      for (const sk of mk.selections || []) {
        const odds = Number(sk.odds);
        if (!sk.suspended && Number.isFinite(odds) && odds > 1) {
          liveKeys.add(selKey(ev.id, mk.id, sk.key));
        }
      }
    }
  }
  let changed = false;
  for (const key of [...selected.keys()]) {
    const selection = selected.get(key);
    if (!liveKeys.has(key) && !pendingEventDetails.has(selection.eventId)) {
      selected.delete(key);
      changed = true;
    }
  }
  if (changed) { quote = null; quoteGeneration += 1; renderBetslip(); }
}

// Bet engine: sinkron odds betslip dengan feed terbaru.
// Kalau odds/priceVersion leg berubah di feed, perbarui simpanan agar quote
// berikutnya memakai harga segar (server tetap revalidasi saat placeBet).
function syncSelectedOdds(events) {
  if (!selected.size) return false;
  const byId = new Map((events || []).map((e) => [e?.id, e]));
  let changed = false;
  for (const s of selected.values()) {
    const mk = byId.get(s.eventId)?.markets?.find((m) => m.id === s.marketId);
    const sel = mk?.selections?.find((x) => x.key === s.selectionId);
    if (!mk || mk.suspended || !sel || sel.suspended) continue; // penghapusan ditangani pruneSelections
    const fresh = Number(sel.odds);
    if (Number.isFinite(fresh) && fresh > 1 &&
      (fresh !== Number(s.odds) || String(sel.priceVersion || '') !== String(s.priceVersion || ''))) {
      s.odds = fresh;
      s.priceVersion = sel.priceVersion || '';
      if (sel.label) s.selectionLabel = sel.label;
      changed = true;
    }
  }
  return changed;
}

function renderStatusMeta() {
  const banner = el('sb-stale-banner');
  const feedStatus = el('sb-feed-status');
  const feedUpdated = el('sb-feed-updated');
  const eventCount = el('sb-feed-events-count');
  const marketCount = el('sb-feed-markets-count');
  const status = String(feed.source?.status || '').toUpperCase();
  if (feedStatus) {
    feedStatus.textContent = feed.stale || /STALE|OFFLINE/.test(status)
      ? 'Feed tertunda'
      : feed.degraded || status === 'DEGRADED'
        ? 'Feed terbatas'
        : feed.events.length && Number(feed.source?.bettableMarkets || feed.source?.pricedMarkets) > 0
          ? 'Feed aktif'
          : 'Menunggu odds';
  }
  if (eventCount) eventCount.textContent = fmt(feed.events.length);
  if (marketCount) marketCount.textContent = fmt(feed.source?.bettableMarkets ?? feed.source?.pricedMarkets ?? 0);
  if (feedUpdated) {
    const stamp = feed.source?.fetchedAt || feed.source?.capturedAt;
    feedUpdated.textContent = stamp ? `Update ${formatWibDateTime(stamp)} WIB` : '';
  }
  if (banner) {
    const src = feed.source || {};
    const mode = String(src.mode || '');
    const isCached = /CACHED|SNAPSHOT|STALE/i.test(mode) || Boolean(src.cachedFallback);
    // P1: tampilkan umur feed + tanggal update agar jadwal cached tidak dikira acak.
    const stamp = src.fetchedAt || src.capturedAt || null;
    const stampText = stamp ? ` • update ${formatWibDateTime(stamp)}` : '';
    if (feed.stale || isCached) {
      banner.hidden = false;
      banner.textContent = `Jadwal sementara (data cached${stampText}) — odds dapat berubah saat feed pulih. Feed akan memperbarui otomatis.`;
    } else if (feed.degraded) {
      banner.hidden = false;
      banner.textContent = `Feed terhubung tetapi belum bisa terima taruhan${stampText}. Menunggu otoritas settlement.`;
    } else banner.hidden = true;
  }
}

function formatWibDateTime(stamp) {
  const date = new Date(stamp);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
}
// ---------------------------------------------------------------------------
// Asian Handicap & Indo Odds Helpers
// ---------------------------------------------------------------------------

/**
 * Indo Odds Calculation:
 * - If Decimal Odds >= 2.00: Indo odds = +(Decimal - 1.00) (Positive, BLACK)
 * - If Decimal Odds < 2.00: Indo odds = -1.00 / (Decimal - 1.00) (Negative, RED)
 * Returns { text: string, isNeg: boolean }
 */
function formatDecimalOdds(value) {
  const odds = Number(value);
  return Number.isFinite(odds) && odds > 1 ? odds.toFixed(2) : '—';
}

// Timezone-aware "today" check (WIB = UTC+7).
// Juga memberi window +26 jam ke depan & -3 jam ke belakang agar event
// yang baru saja mulai atau berakhir tidak tiba-tiba hilang dari tab Hari Ini.
function todayDateWIB(ts) {
  // Returns 'YYYY-MM-DD' in WIB (UTC+7)
  const d = new Date((ts || Date.now()) + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function isTodayEvent(e) {
  if (!e?.startTime) return false;
  const evTs = new Date(e.startTime).getTime();
  if (!Number.isFinite(evTs)) return false;
  const nowTs = Date.now();
  const diffHours = (evTs - nowTs) / (1000 * 60 * 60);
  // Standar Sportsbook "Hari Ini": dimulai dalam matchday berjalan (-3 jam hingga +26 jam)
  if (diffHours >= -3 && diffHours <= 26) return true;
  // Fallback: tanggal kalender yang sama dalam WIB
  return todayDateWIB(evTs) === todayDateWIB(nowTs);
}

function isFutureEvent(e) {
  if (!e?.startTime) return false;
  // "Pasar Awal" (Early Market): semua pertandingan mendatang di luar jadwal Hari Ini & bukan Live
  return !isTodayEvent(e) && !isLiveEvent(e);
}

// ---------------------------------------------------------------------------
// Filters / Search / Tabs / Navigation
// ---------------------------------------------------------------------------
function setupFilterTabs() {
  const tabs = document.querySelectorAll('#sb-primary-tabs .sb-cat-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      setMatchFilter(tab.getAttribute('data-filter') || 'today');
    });
  });

  // Action bar buttons
  const btnLeague = el('btn-show-leagues');
  if (btnLeague) btnLeague.addEventListener('click', openLeagueModal);

  const btnFilter = el('btn-filter-toggle');
  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      const nextFilter = currentFilter === 'fav' ? 'all' : 'fav';
      setMatchFilter(nextFilter);
      showToast(currentFilter === 'fav' ? 'Menampilkan liga favorit' : 'Menampilkan semua liga', 'info');
    });
  }

  setupMixParlay();
  setupSportDropdown();
  setupLeagueModal();
  setupBalanceToggle();
  setupBottomNav();
}

function setMatchFilter(filter) {
  currentFilter = filter;
  visibleEventLimit = EVENTS_PAGE_SIZE;
  document.querySelectorAll('#sb-primary-tabs .sb-cat-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.getAttribute('data-filter') === filter);
  });
  const favoriteButton = el('btn-filter-toggle');
  if (favoriteButton) {
    const active = filter === 'fav';
    favoriteButton.classList.toggle('active', active);
    favoriteButton.setAttribute('aria-pressed', String(active));
  }
  renderAll();
}

function setupBalanceToggle() {
  const toggle = el('toggle-balance-vis');
  const bal = el('header-balance');
  if (!toggle || !bal) return;
  let vis = true;
  toggle.addEventListener('click', () => {
    vis = !vis;
    toggle.textContent = vis ? '👁' : '🙈';
    bal.textContent = vis ? formatRupiah(betslipBalance()).replace('Rp', '').trim() : '******';
  });
}

function setupMixParlay() {
  const btn = el('btn-toggle-parlay');
  if (!btn) return;
  btn.addEventListener('click', () => {
    setSlipTab('parlay');
    if (window.innerWidth <= BETSLIP_MOBILE_BREAKPOINT && selected.size) openSlipSheet();
    showToast('Mode Mix Parlay Aktif', 'info');
  });
}

function setupSportDropdown() {
  const trigger = el('sb-sport-dropdown-trigger');
  const menu = el('sb-sport-menu');
  const label = el('current-sport-label');
  if (!trigger || !menu) return;
  
  trigger.addEventListener('click', (e) => {
    if (e.target.closest('.sb-sport-opt')) return;
    menu.hidden = !menu.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!trigger.contains(e.target)) menu.hidden = true;
  });

  menu.addEventListener('click', (e) => {
    const option = e.target.closest('.sb-sport-opt');
    if (!option) return;
    currentSport = option.getAttribute('data-sport') || 'all';
    visibleEventLimit = EVENTS_PAGE_SIZE;
    if (label) label.textContent = option.dataset.sportLabel || option.textContent.trim();
    menu.hidden = true;
    renderAll();
  });
}

function setupLeagueModal() {
  const modal = el('league-modal-backdrop');
  const closeBtn = el('btn-close-league-modal');
  const applyBtn = el('btn-league-apply');
  const selectAll = el('btn-league-select-all');
  const searchInput = el('league-search-input');

  if (closeBtn && modal) closeBtn.addEventListener('click', () => { modal.hidden = true; });
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  if (applyBtn && modal) {
    applyBtn.addEventListener('click', () => {
      modal.hidden = true;
      renderAll();
    });
  }
  if (selectAll) {
    selectAll.addEventListener('click', () => {
      const boxes = document.querySelectorAll('#league-modal-list input[type="checkbox"]');
      boxes.forEach((b) => { b.checked = true; favLeagues.add(b.value); });
      saveFavs();
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      document.querySelectorAll('.sb-league-modal-item').forEach((item) => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });
  }
}

function openLeagueModal() {
  const modal = el('league-modal-backdrop');
  const list = el('league-modal-list');
  if (!modal || !list) return;
  const leagues = [...new Set(feed.events.map((e) => e.league || 'Liga Internasional'))].sort();
  list.innerHTML = leagues.map((l) => `
    <label class="sb-league-modal-item">
      <input type="checkbox" value="${escapeHtml(l)}" ${favLeagues.has(l) ? 'checked' : ''}>
      <span>${escapeHtml(l)}</span>
    </label>
  `).join('');
  list.querySelectorAll('input').forEach((b) => {
    b.addEventListener('change', () => {
      if (b.checked) favLeagues.add(b.value);
      else favLeagues.delete(b.value);
      saveFavs();
    });
  });
  modal.hidden = false;
}

// ---------------------------------------------------------------------------
// Slip Sheet helpers (Mobile SBOBET-style slide-up betslip)
// ---------------------------------------------------------------------------
let slipSheetOpen = false;
let activeSlipTab = 'single';
let activeSystemSize = 2;

function openSlipSheet() {
  // Don't open mobile sheet on desktop - betslip is already visible in sidebar
  if (window.innerWidth > BETSLIP_MOBILE_BREAKPOINT) return;
  const sheet = el('sb-slip-sheet');
  const overlay = el('sb-slip-overlay');
  if (!sheet) return;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  if (overlay) overlay.classList.add('active');
  slipSheetOpen = true;
  // Mark Slip Parlay button as active
  const bnavSlip = el('bnav-slip');
  if (bnavSlip) bnavSlip.classList.add('active');
  renderBetslip();
}

function closeSlipSheet() {
  const sheet = el('sb-slip-sheet');
  const overlay = el('sb-slip-overlay');
  if (!sheet) return;
  const bnavSlip = el('bnav-slip');
  if (sheet.contains(document.activeElement)) {
    if (bnavSlip && typeof bnavSlip.focus === 'function') {
      bnavSlip.focus({ preventScroll: true });
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (overlay) overlay.classList.remove('active');
  slipSheetOpen = false;
  if (bnavSlip) bnavSlip.classList.remove('active');
}

function setSlipTab(tab) {
  const nextTab = ['single', 'parlay', 'system'].includes(tab) ? tab : 'single';
  if (nextTab !== activeSlipTab) {
    activeSlipTab = nextTab;
    quote = null;
    quoteGeneration += 1;
  }
  const mixParlayButton = el('btn-toggle-parlay');
  if (mixParlayButton) mixParlayButton.classList.toggle('active', activeSlipTab === 'parlay');
  // Single mode hanya mendukung 1 selection — batasi dengan aman + pesan jelas.
  if (activeSlipTab === 'single' && selected.size > 1) {
    const [firstKey, firstLeg] = [...selected.entries()][0];
    selected.clear();
    selected.set(firstKey, firstLeg);
    showToast('Mode Single hanya mendukung 1 pilihan. Pilihan lain dihapus — gunakan tab Parlay untuk mix parlay.', 'warning');
  }
  // Update mobile sheet tabs
  document.querySelectorAll('.sb-slip-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-slip-tab') === activeSlipTab);
  });
  // Update desktop betslip tabs
  document.querySelectorAll('.sb-bs-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-bstab') === activeSlipTab);
  });
  renderBetslip();
}

function setupBottomNav() {
  const myMatchesBtn = el('bnav-my-matches');
  const myBetsBtn = el('bnav-my-bets');
  const cashoutBtn = el('bnav-cashout');
  const betsModal = el('sb-user-bets-backdrop');
  const closeBets = el('btn-close-bets-modal');

  // "Slip Parlay" button → toggle slip sheet
  const slipBtn = el('bnav-slip');
  if (slipBtn) {
    slipBtn.addEventListener('click', () => {
      if (slipSheetOpen) closeSlipSheet();
      else openSlipSheet();
    });
  }
  if (myMatchesBtn) {
    myMatchesBtn.addEventListener('click', () => {
      closeSlipSheet();
      setMatchFilter(currentFilter === 'fav' ? 'today' : 'fav');
      showToast(currentFilter === 'fav' ? 'Menampilkan Pertandingan Saya' : 'Menampilkan Semua', 'info');
    });
  }
  if (myBetsBtn) {
    myBetsBtn.addEventListener('click', () => { closeSlipSheet(); openUserBetsModal('Taruhan Saya'); });
  }
  if (cashoutBtn) {
    cashoutBtn.addEventListener('click', () => {
      closeSlipSheet();
      if (!auth.isLoggedIn()) {
        showToast('Silakan login terlebih dahulu untuk mengakses Cash Out.', 'warning');
        setTimeout(() => { window.location.href = '/index.html?msg=login_required'; }, 800);
        return;
      }
      window.location.href = '/cashout.html';
    });
  }
  if (closeBets && betsModal) {
    closeBets.addEventListener('click', () => { betsModal.hidden = true; });
  }
  if (betsModal) {
    betsModal.addEventListener('click', (e) => { if (e.target === betsModal) betsModal.hidden = true; });
  }
}

async function openUserBetsModal(title) {
  const modal = el('sb-user-bets-backdrop');
  const titleEl = el('sb-user-bets-title');
  const bodyEl = el('sb-user-bets-body');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = title;
  modal.hidden = false;
  bodyEl.innerHTML = '<div class="sb-empty">Memuat daftar tiket…</div>';

  try {
    const res = await api.get('/member/sportsbook/bets?limit=10');
    const items = res?.data?.items || res?.data || [];
    if (!Array.isArray(items) || !items.length) {
      bodyEl.innerHTML = '<div class="sb-empty">Belum ada riwayat taruhan aktif. Pasang taruhan untuk melihat tiket Anda.</div>';
      return;
    }
    bodyEl.innerHTML = items.map((b) => `
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; font-weight:700; font-size:12px;">
          <span>Invoice: ${escapeHtml(b.invoice || b.id || '—')}</span>
          <span style="color:#2563eb;">${escapeHtml(b.status || 'ACTIVE')}</span>
        </div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">
          Stake: ${formatRupiah(Number(b.totalStake ?? b.unitStake ?? 0))} · Odds: ${Number(b.totalOdds || 1).toFixed(2)} · Potensi: ${formatRupiah(b.potentialPayout || 0)}
        </div>
      </div>
    `).join('');
  } catch {
    bodyEl.innerHTML = '<div class="sb-empty">Gagal memuat riwayat tiket. Silakan login terlebih dahulu.</div>';
  }
}

function updateCategoryCounts() {
  const events = feed.events || [];
  const liveCount = events.filter(isLiveEvent).length;
  const todayCount = events.filter(isTodayEvent).length;
  const earlyCount = events.filter(isFutureEvent).length;

  const cAll = el('count-all');
  const cLive = el('count-live');
  const cToday = el('count-today');
  const cEarly = el('count-early');
  const cOutright = el('count-outright');

  if (cAll) cAll.textContent = String(events.length);
  if (cLive) cLive.textContent = String(liveCount);
  if (cToday) cToday.textContent = String(todayCount);
  if (cEarly) cEarly.textContent = String(earlyCount);
  if (cOutright) cOutright.textContent = '0';
}

function setupSearch() {
  const input = el('sb-search');
  if (!input) return;
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      searchQuery = input.value.trim().toLowerCase();
      visibleEventLimit = EVENTS_PAGE_SIZE;
      renderAll();
    }, 200);
  });
}

function bindEventHandlers() {
  const ev = el('sb-events');
  if (!ev) return;
  ev.addEventListener('click', (e) => {
    const periodButton = e.target.closest('[data-match-period]');
    if (periodButton) {
      const match = periodButton.closest('.sb-match-card');
      if (match) {
        selectedEventPeriods.set(match.dataset.evid, periodButton.dataset.matchPeriod);
        renderAll();
      }
      return;
    }
    const odd = e.target.closest('.sb-odd-cell');
    if (odd && !odd.classList.contains('disabled') && !odd.classList.contains('locked')) {
      handleOddClick(odd);
      return;
    }
    const marketButton = e.target.closest('[data-toggle-event-markets]');
    if (marketButton) {
      void toggleEventMarkets(marketButton.getAttribute('data-toggle-event-markets'));
      return;
    }
    const marketFilter = e.target.closest('[data-market-browser-filter]');
    if (marketFilter) {
      const panel = marketFilter.closest('.sb-detail-markets');
      const dimension = marketFilter.dataset.marketBrowserDimension;
      panel?.querySelectorAll(`[data-market-browser-dimension="${dimension}"]`).forEach(button => {
        const active = button === marketFilter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      if (panel) applyMarketBrowserFilters(panel);
      return;
    }
    const retryMarketsButton = e.target.closest('[data-retry-event-markets]');
    if (retryMarketsButton) {
      void loadEventMarkets(retryMarketsButton.getAttribute('data-retry-event-markets'), { force: true });
      return;
    }
    if (e.target.closest('[data-load-more-events]')) {
      visibleEventLimit += EVENTS_PAGE_SIZE;
      renderAll();
      return;
    }
    const accRowHead = e.target.closest('.sb-accordion-header');
    if (accRowHead) {
      const row = accRowHead.closest('.sb-accordion-row');
      if (row) row.classList.toggle('open');
      return;
    }
    const leagueHead = e.target.closest('.sb-league-head');
    if (leagueHead) {
        const collapsed = leagueHead.classList.toggle('collapsed');
        leagueHead.setAttribute('aria-expanded', String(!collapsed));
        const list = leagueHead.nextElementSibling;
        if (list) list.hidden = collapsed;
        return;
    }
  });
  ev.addEventListener('input', (e) => {
    const search = e.target.closest('[data-market-browser-search]');
    if (search) {
      const panel = search.closest('.sb-detail-markets');
      if (panel) applyMarketBrowserFilters(panel);
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering (Asian Sportsbook 3-Column Table Grid)
// ---------------------------------------------------------------------------
function visibleEvents() {
  let list = feed.events;
  if (currentSport !== 'all') list = list.filter((e) => String(e.sport || '').toLowerCase() === String(currentSport).toLowerCase());
  if (currentLeague !== 'all') list = list.filter((e) => String(e.league || '') === currentLeague);
  
  if (currentFilter === 'live') list = list.filter((e) => isLiveEvent(e));
  else if (currentFilter === 'today') list = list.filter((e) => isTodayEvent(e) || isLiveEvent(e));
  else if (currentFilter === 'early') list = list.filter((e) => isFutureEvent(e));
  else if (currentFilter === 'fav') list = list.filter((e) => favLeagues.has(String(e.league || 'Liga Internasional')));
  
  if (searchQuery) {
    list = list.filter((e) =>
      String(e.league || '').toLowerCase().includes(searchQuery) ||
      String(e.home?.name || '').toLowerCase().includes(searchQuery) ||
      String(e.away?.name || '').toLowerCase().includes(searchQuery));
  }
  return list;
}

function renderAll() {
  hideSkeleton();
  updateCategoryCounts();
  renderLiveCarousel();

  const ev = el('sb-events');
  if (!ev) return;
  const list = visibleEvents();
  if (!list.length) {
    ev.innerHTML = '';
    setEmpty(currentFilter === 'fav' && !favLeagues.size ? 'Belum ada liga favorit. Tandai pada pilihan liga.' : 'Tidak ada pertandingan yang tersedia pada filter ini.');
    renderSidebar(feed.events);
    return;
  }
  const empty = el('sb-empty');
  if (empty) empty.hidden = true;
  const visibleList = list.slice(0, visibleEventLimit);
  ev.innerHTML = renderLeagueGroups(visibleList);
  if (list.length > visibleList.length) {
    ev.insertAdjacentHTML('beforeend', `
      <div class="sb-events-load-more">
        <p>Menampilkan ${fmt(visibleList.length)} dari ${fmt(list.length)} pertandingan</p>
        <button type="button" data-load-more-events>
          Muat ${fmt(Math.min(EVENTS_PAGE_SIZE, list.length - visibleList.length))} pertandingan lagi
        </button>
      </div>
    `);
  }
  renderSidebar(feed.events);
}

function setEmpty(msg) {
  hideSkeleton();
  const e = el('sb-empty');
  if (e) { e.hidden = false; e.textContent = msg; }
}

function hideSkeleton() { const s = el('sb-skeleton'); if (s) s.innerHTML = ''; }

// Featured Live Carousel Section
function renderLiveCarousel() {
  const section = el('sb-live-section');
  const carousel = el('sb-live-carousel');
  if (!section || !carousel) return;
  const liveList = feed.events.filter(isLiveEvent);
  if (!liveList.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  carousel.innerHTML = liveList.slice(0, 6).map((e) => {
    const primaryMarket = primaryMarketColumns(e, 'FT')[0];
    const quickSelections = (primaryMarket?.outcomes || [])
      .filter(([, selection]) => !selection.suspended && Number(selection.odds) > 1);
    
    return `
      <div class="sb-live-card">
        <div class="sb-live-card-head">
          <span>⚽ ${escapeHtml(e.league || 'Live Match')}</span>
          <span>↻</span>
        </div>
        <div class="sb-live-card-body">
          <div>
            <div>
              <span class="sb-live-badge-sm">LANGSUNG</span>
              <span class="sb-live-clock-sm" data-live-clock-id="${escapeHtml(e.id)}">${escapeHtml(getLiveClockDisplay(e))}</span>
            </div>
            <div class="sb-live-team-row">
              <span>${escapeHtml(e.home?.name || 'TBA')}</span>
              <b>${escapeHtml(scoreText(e.home?.score))}</b>
            </div>
            <div class="sb-live-team-row">
              <span>${escapeHtml(e.away?.name || 'TBA')}</span>
              <b>${escapeHtml(scoreText(e.away?.score))}</b>
            </div>
          </div>
          <div class="sb-live-quick-odds" aria-label="${escapeHtml(primaryMarket?.title || 'Odds live')}">
            ${primaryMarket && quickSelections.length
              ? `<div class="sb-live-market-label">${escapeHtml(primaryMarket.title)}</div>
                ${quickSelections.slice(0, 3).map(([label, selection]) => renderQuickOddBtn(e, primaryMarket.market, selection, label)).join('')}`
              : '<div class="sb-live-no-odds">Odds belum tersedia</div>'}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function scoreText(score) {
  return score === null || score === undefined || score === '' ? '—' : String(score);
}

function renderQuickOddBtn(e, m, s, label) {
  if (!m || !s) return '';
  const key = selKey(e.id, m.id, s.key);
  const line = s.line ?? m.line;
  const lineStr = line != null ? (Number(line) > 0 ? `+${Number(line).toFixed(2)}` : Number(line).toFixed(2)) : '';

  let movementClass = '';
  let movementArrow = '';
  const move = oddsMovementMap.get(key);
  if (move && (Date.now() - move.timestamp) < 1100) {
    if (move.direction === 'up') {
      movementClass = ' sb-odd-movement-up';
      movementArrow = '<span class="sb-odd-movement-arrow up" aria-label="Odds naik">↑</span>';
    } else if (move.direction === 'down') {
      movementClass = ' sb-odd-movement-down';
      movementArrow = '<span class="sb-odd-movement-arrow down" aria-label="Odds turun">↓</span>';
    }
  }

  return `
    <button type="button" class="sb-quick-odd-btn sb-odd-cell${movementClass}"
      data-sel="${escapeHtml(key)}" data-evid="${escapeHtml(e.id)}" data-mk="${escapeHtml(m.id)}" data-sk="${escapeHtml(s.key)}" 
      data-odds="${escapeHtml(String(s.odds))}" data-pv="${escapeHtml(s.priceVersion || '')}">
      <span>${label}</span>
      <div style="text-align:right;">
        ${lineStr ? `<div style="font-size:9px; color:#0284c7; font-weight:700;">${lineStr}</div>` : ''}
        <div style="font-size:11px; font-weight:800; color:#111827;">${formatDecimalOdds(s.odds)}${movementArrow}</div>
      </div>
    </button>
  `;
}

function renderLeagueGroups(list) {
  const groups = new Map();
  for (const e of list) {
    const lg = e.league || 'Liga Internasional';
    if (!groups.has(lg)) groups.set(lg, []);
    groups.get(lg).push(e);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let html = '';
  for (const [index, [league, events]] of sorted.entries()) {
    html += `<div class="sb-league-group">`;
    html += `
      <button type="button" class="sb-league-head" aria-expanded="true" aria-controls="sb-league-list-${index}">
        <span class="sb-league-title">${escapeHtml(league)}</span>
        <span class="sb-league-right">
          <span class="sb-league-pill">${events.length}</span>
          <span class="sb-league-toggle">▲</span>
        </span>
      </button>
    `;
    html += `<div class="sb-match-list" id="sb-league-list-${index}">`;
    for (const e of events) html += renderMatch(e);
    html += `</div></div>`;
  }
  return html;
}

function findMarket(e, type, period) {
  return (e.markets || []).find((m) =>
    !m.suspended &&
    String(m.type || '').toUpperCase() === String(type).toUpperCase() &&
    String(m.period || 'FT').toUpperCase() === String(period).toUpperCase()
  );
}

const MARKET_PERIOD_LABELS = {
  FT: 'FT · Full Time', '1H': 'HT · Babak 1', '2H': '2H · Babak 2',
  Q1: 'Kuarter 1', Q2: 'Kuarter 2', Q3: 'Kuarter 3', Q4: 'Kuarter 4'
};
const MARKET_PERIOD_ORDER = ['FT', '1H', '2H', 'Q1', 'Q2', 'Q3', 'Q4'];

function eventMarketPeriods(event) {
  const periods = new Set();
  for (const market of event?.markets || []) {
    if (market?.suspended || !Array.isArray(market?.selections)) continue;
    if (!market.selections.some(selection => !selection?.suspended && Number(selection?.odds) > 1)) continue;
    periods.add(String(market.period || 'FT').toUpperCase());
  }
  return [...periods].sort((left, right) => {
    const leftOrder = MARKET_PERIOD_ORDER.indexOf(left);
    const rightOrder = MARKET_PERIOD_ORDER.indexOf(right);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) -
      (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder) || left.localeCompare(right);
  });
}

function findMarketSelection(market, aliases, fallbackIndex, allowPrefix = false) {
  const selections = Array.isArray(market?.selections) ? market.selections : [];
  const knownAliases = ['home', '1', 'away', '2', 'draw', 'x', 'over', 'under'];
  const matches = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return aliases.some(alias => normalized === alias || (allowPrefix && normalized.startsWith(`${alias} `)));
  };
  const selection = selections.find(item => matches(item.label) || matches(item.key));
  if (selection) return selection;
  const hasKnownOutcome = selections.some(item => [item.label, item.key].some(value => {
    const normalized = String(value || '').trim().toLowerCase();
    return knownAliases.some(alias =>
      normalized === alias || (['over', 'under'].includes(alias) && normalized.startsWith(`${alias} `))
    );
  }));
  if (hasKnownOutcome) return null;
  return selections[fallbackIndex] || null;
}

function renderOddCell(e, m, s, lineOverride) {
  if (!m || !s) {
    return `<div class="sb-odd-cell disabled"><span class="sb-cell-odds">Tidak tersedia</span></div>`;
  }
  if (m.suspended || s.suspended) {
    return `<div class="sb-odd-cell disabled"><span class="sb-cell-odds">Ditangguhkan</span></div>`;
  }
  const decOdds = Number(s.odds);
  if (!Number.isFinite(decOdds) || decOdds <= 1) {
    return `<div class="sb-odd-cell disabled"><span class="sb-cell-odds">Belum tersedia</span></div>`;
  }
  const key = selKey(e.id, m.id, s.key);
  const isChosen = selected.has(key);
  
  const lineVal = lineOverride != null ? lineOverride : (s.line ?? m.line);
  const lineFormatted = lineVal != null
    ? (String(m.type || '').toUpperCase() === 'HANDICAP'
        ? (Number(lineVal) > 0 ? `+${Number(lineVal).toFixed(2)}` : Number(lineVal).toFixed(2))
        : Number(lineVal).toFixed(2))
    : '';
  const oddsText = formatDecimalOdds(decOdds);

  // Visual Odds Movement
  let movementClass = '';
  let movementArrow = '';
  const move = oddsMovementMap.get(key);
  if (move && (Date.now() - move.timestamp) < 1100) {
    if (move.direction === 'up') {
      movementClass = ' sb-odd-movement-up';
      movementArrow = '<span class="sb-odd-movement-arrow up" aria-label="Odds naik">↑</span>';
    } else if (move.direction === 'down') {
      movementClass = ' sb-odd-movement-down';
      movementArrow = '<span class="sb-odd-movement-arrow down" aria-label="Odds turun">↓</span>';
    }
  }

  return `
    <button type="button" class="sb-odd-cell${isChosen ? ' chosen' : ''}${movementClass}"
      data-sel="${escapeHtml(key)}" 
      data-evid="${escapeHtml(e.id)}" 
      data-mk="${escapeHtml(m.id)}" 
      data-sk="${escapeHtml(s.key)}" 
      data-odds="${decOdds}" 
      data-pv="${escapeHtml(s.priceVersion || '')}"
      aria-pressed="${isChosen ? 'true' : 'false'}"
      title="${escapeHtml(s.label || s.key)} @ ${decOdds.toFixed(2)}">
      ${lineFormatted ? `<span class="sb-cell-line">${escapeHtml(lineFormatted)}</span>` : ''}
      <span class="sb-cell-odds pos">${oddsText}${movementArrow}</span>
    </button>
  `;
}

function renderMarketColumns(e, markets) {
  if (!markets.length) return '';
  return `
    <div class="sb-market-grid">
      ${markets.map(item => `
        <section class="sb-market-card">
          <h3 class="sb-market-card-title">${escapeHtml(item.title)}</h3>
          <div class="sb-market-outcomes" style="--outcome-count:${Math.max(1, item.outcomes.length)}">
            ${item.outcomes.map(([label, selection]) => `
              <div class="sb-market-outcome">
                <span class="sb-market-outcome-label">${escapeHtml(label)}</span>
              ${renderOddCell(e, item.market, selection)}
              </div>
            `).join('')}
          </div>
        </section>
      `).join('')}
    </div>
  `;
}

function eventProviderBadges(e) {
  const providers = new Set();
  const markets = Array.isArray(e?.markets) ? e.markets : [];

  for (const market of markets) {
    const source = market?.bookmaker || market?.sourceLabel || market?.provider || market?.source || market?.supplier || '';
    if (source) providers.add(String(source).trim());
  }

  const list = [...providers].slice(0, 3);
  if (!list.length) {
    return '<span class="sb-provider-chip sb-provider-chip-muted">Feed</span>';
  }

  return list.map(value => `<span class="sb-provider-chip">${escapeHtml(value)}</span>`).join('');
}

function renderMatch(e) {
  const isLive = Boolean(e.live) || String(e.status || '').toUpperCase() === 'LIVE';
  const home = e.home || {}, away = e.away || {};

  const bpHdp = findMarket(e, 'HANDICAP', 'FT');
  const hdpLine = Number(bpHdp?.line ?? 0);
  const isHomeFav = hdpLine < 0;
  const isAwayFav = hdpLine > 0;
  const availablePeriods = eventMarketPeriods(e);
  const requestedPeriod = selectedEventPeriods.get(e.id);
  const activePeriod = availablePeriods.includes(requestedPeriod)
    ? requestedPeriod
    : availablePeriods.includes('FT') ? 'FT' : availablePeriods[0] || 'FT';
  const activeMarkets = primaryMarketColumns(e, activePeriod);
  const eventDetail = eventDetails.get(e.id);
  const detailIsCurrent = eventDetail?.revision === String(feed.source?.feedRevision || '');
  const marketsPanelOpen = expandedEventMarkets.has(e.id);
  const marketsCount = Math.max(Number(e.availableMarketCount || 0), e.markets?.length || 0);
  const providerSummary = eventProviderBadges(e);
  const marketSummaryText = marketsCount ? `${marketsCount} pasar aktif` : 'Pasar live';

  return `
    <article class="sb-match-card" data-evid="${escapeHtml(e.id)}">
      <div class="sb-match-info">
        <div class="sb-card-banner">
          ${isLive
            ? '<span class="sb-match-status is-live"><span></span> LANGSUNG</span>'
            : `<span class="sb-match-status">${formatKickoffDate(e.startTime)}</span>`}
        <button type="button" class="sb-banner-refresh" onclick="window.location.reload()" title="Muat ulang odds">↻</button>
        </div>
        <div class="sb-match-meta-row">
          <span class="sb-match-league">${escapeHtml(e.league || 'Match')}</span>
          <div class="sb-provider-stack">${providerSummary}</div>
        </div>
        <div class="sb-teams-row">
          <div class="sb-team-col ${isHomeFav ? 'is-fav' : ''}">
            ${home.logo ? `<img class="sb-team-logo" src="${escapeHtml(home.logo)}" alt="" width="20" height="20" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
            <span class="sb-team-name">${escapeHtml(home.name || 'TBA')}</span>
            ${isLive ? `<span class="sb-team-score">${escapeHtml(scoreText(home.score))}</span>` : ''}
          </div>
          <div class="sb-team-col away ${isAwayFav ? 'is-fav' : ''}">
            ${away.logo ? `<img class="sb-team-logo" src="${escapeHtml(away.logo)}" alt="" width="20" height="20" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
            <span class="sb-team-name">${escapeHtml(away.name || 'TBA')}</span>
            ${isLive ? `<span class="sb-team-score">${escapeHtml(scoreText(away.score))}</span>` : ''}
          </div>
        </div>
        <div class="sb-score-col">
          ${isLive
            ? `<span class="sb-match-live-clock" data-live-clock-id="${escapeHtml(e.id)}">${escapeHtml(getLiveClockDisplay(e))}</span>`
            : `<span class="sb-match-kickoff">${timeLabel(e.startTime)} WIB</span>`}
        </div>
      </div>

      <div class="sb-match-market-head">
        <span>PASAR UTAMA</span>
        <span class="sb-market-summary-text">${marketSummaryText}</span>
      </div>

      <div class="sb-market-period-tabs" role="group" aria-label="Periode odds">
        ${availablePeriods.map(period => `<button type="button" class="sb-market-period-tab${period === activePeriod ? ' active' : ''}"
          data-match-period="${escapeHtml(period)}" aria-pressed="${period === activePeriod ? 'true' : 'false'}">
          ${escapeHtml(MARKET_PERIOD_LABELS[period] || period)}
        </button>`).join('')}
      </div>

      <div class="sb-matrix-table">
        ${activeMarkets.length
          ? `<div class="sb-market-period"><span>${escapeHtml(MARKET_PERIOD_LABELS[activePeriod] || activePeriod)}</span></div>${renderMarketColumns(e, activeMarkets)}`
          : ''}
        ${!activeMarkets.length
          ? '<div class="sb-no-primary-odds">Odds utama belum tersedia dari provider untuk pertandingan ini.</div>'
          : ''}
      </div>

      ${marketsCount ? `<div class="sb-detail-markets-wrapper">
        <button type="button" class="sb-accordion-top-tab sb-detail-markets-toggle"
          data-toggle-event-markets="${escapeHtml(e.id)}" data-market-count="${marketsCount}"
          aria-expanded="${marketsPanelOpen ? 'true' : 'false'}">
          ${marketsPanelOpen ? 'Tutup semua pasar' : 'Semua pasar'} · ${fmt(marketsCount)}
        </button>
        <div class="sb-detail-markets" id="event-markets-${escapeHtml(e.id)}"${marketsPanelOpen ? '' : ' hidden'}>
          ${marketsPanelOpen
            ? detailIsCurrent
              ? renderAllEventMarkets(eventDetail.event)
              : pendingEventDetails.has(e.id)
                ? '<div class="sb-detail-markets-status">Memuat semua odds…</div>'
                : '<div class="sb-detail-markets-status">Buka untuk memuat semua odds pertandingan.</div>'
            : ''}
        </div>
      </div>` : ''}

      <div class="sb-card-footer">
        <span class="sb-market-help">${isLive ? 'Pertandingan langsung' : 'Pilih odds untuk menambahkan ke betslip'}</span>
        <span class="sb-match-quick-time">${isLive ? escapeHtml(getLiveClockDisplay(e)) : `${formatKickoffDate(e.startTime)} · ${timeLabel(e.startTime)} WIB`}</span>
      </div>

    </article>
  `;
}

function renderAllEventMarkets(event) {
  const markets = (event.markets || []).filter(market => Array.isArray(market.selections) && market.selections.length);
  if (!markets.length) return '<div class="sb-detail-markets-status">Belum ada pasar odds untuk pertandingan ini.</div>';
  const types = [...new Set(markets.map(market => String(market.type || 'OTHER').toUpperCase()))];
  const periods = [...new Set(markets.map(market => String(market.period || 'FT').toUpperCase()))];
  const typeLabels = {
    '1X2': '1X2',
    HANDICAP: 'Handicap',
    TOTALS: 'Total Gol',
    BTTS: 'Kedua Tim Cetak Gol',
    DOUBLE_CHANCE: 'Double Chance',
    DRAW_NO_BET: 'Draw No Bet',
    TEAM_TOTAL: 'Total Tim',
    ODD_EVEN: 'Ganjil / Genap',
    HT_FT: 'Half Time / Full Time',
    CORRECT_SCORE: 'Skor Tepat',
    CORNERS: 'Tendangan Sudut',
    CARDS: 'Kartu',
    PLAYER_PROP: 'Pemain',
    BET_BUILDER: 'Bet Builder',
    OTHER: 'Lainnya'
  };
  const filters = (dimension, values, labelFor) => {
    if (values.length < 2) return '';
    const countFor = value => markets.filter(market =>
      String(dimension === 'type' ? market.type || 'OTHER' : market.period || 'FT').toUpperCase() === value
    ).length;
    const title = dimension === 'type' ? 'Jenis pasar' : 'Periode';
    return `
    <div class="sb-market-browser-filter-group">
      <span class="sb-market-browser-filter-label">${title}</span>
      <div class="sb-market-browser-filters" role="group" aria-label="Filter ${title.toLowerCase()}">
        <button type="button" class="sb-market-browser-chip active"
          data-market-browser-filter="all" data-market-browser-dimension="${dimension}" aria-pressed="true">Semua <span>${markets.length}</span></button>
        ${values.map(value => `<button type="button" class="sb-market-browser-chip"
          data-market-browser-filter="${escapeHtml(value)}" data-market-browser-dimension="${dimension}" aria-pressed="false">
          ${escapeHtml(labelFor(value))} <span>${countFor(value)}</span>
        </button>`).join('')}
      </div>
    </div>`;
  };
  const periodLabel = period => MARKET_PERIOD_LABELS[period] || period;
  return `<div class="sb-market-browser">
    <div class="sb-market-browser-toolbar">
      <label class="sb-market-browser-search">
        <span>Cari pasar</span>
        <input type="search" data-market-browser-search placeholder="Contoh: Over 2.5, handicap…" autocomplete="off">
      </label>
      ${filters('type', types, type => typeLabels[type] || type.replaceAll('_', ' '))}
      ${filters('period', periods, periodLabel)}
    </div>
    <div class="sb-market-browser-summary" data-market-browser-summary>${markets.length} pasar · ${markets.reduce((total, market) => total + market.selections.length, 0)} pilihan berharga dari feed</div>
    <div class="sb-detail-market-list">${markets.map(market => `
    <section class="sb-detail-market"
      data-market-type="${escapeHtml(String(market.type || 'OTHER').toUpperCase())}"
      data-market-period="${escapeHtml(String(market.period || 'FT').toUpperCase())}"
      data-market-category="${escapeHtml(String(market.type || 'OTHER').toUpperCase())}">
      <h4 class="sb-detail-market-heading">
        <span>${escapeHtml(market.label || market.type || 'Pasar')}</span>
        <span>${escapeHtml(periodLabel(String(market.period || 'FT').toUpperCase()))}${market.line !== null && market.line !== undefined ? ` · ${escapeHtml(String(market.line))}` : ''}</span>
      </h4>
      <div class="sb-accordion-grid">
        ${market.selections.map(selection => `
          <div class="sb-detail-market-selection">
            <span>${escapeHtml(selection.label || selection.key || 'Pilihan')}</span>
            ${renderOddCell(event, market, selection)}
          </div>
        `).join('')}
      </div>
    </section>
  `).join('')}</div>
  <div class="sb-market-browser-empty" hidden>Tidak ada pasar yang cocok dengan filter.</div>
  </div>`;
}

function applyMarketBrowserFilters(panel) {
  const type = panel.querySelector('[data-market-browser-dimension="type"].active')?.dataset.marketBrowserFilter || 'all';
  const period = panel.querySelector('[data-market-browser-dimension="period"].active')?.dataset.marketBrowserFilter || 'all';
  const query = panel.querySelector('[data-market-browser-search]')?.value.trim().toLowerCase() || '';
  const total = panel.querySelectorAll('.sb-detail-market').length;
  let visible = 0;
  panel.querySelectorAll('.sb-detail-market').forEach(market => {
    const matches = (type === 'all' || market.dataset.marketType === type) &&
      (period === 'all' || market.dataset.marketPeriod === period) &&
      (!query || market.textContent.toLowerCase().includes(query));
    market.hidden = !matches;
    if (matches) visible += 1;
  });
  const summary = panel.querySelector('[data-market-browser-summary]');
  if (summary) summary.textContent = `${visible} dari ${total} pasar ditampilkan`;
  const empty = panel.querySelector('.sb-market-browser-empty');
  if (empty) empty.hidden = visible > 0;
}

async function toggleEventMarkets(eventId) {
  if (!eventId) return;
  const panel = el(`event-markets-${eventId}`);
  if (expandedEventMarkets.has(eventId)) {
    expandedEventMarkets.delete(eventId);
    if (panel) panel.hidden = true;
    const button = panel?.closest('.sb-match-card')?.querySelector('[data-toggle-event-markets]');
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      button.textContent = `Semua pasar${button.dataset.marketCount ? ` · ${fmt(button.dataset.marketCount)}` : ''}`;
    }
    return;
  }

  expandedEventMarkets.add(eventId);
  if (panel) {
    panel.hidden = false;
    const detail = eventDetails.get(eventId);
    panel.innerHTML = detail?.revision === String(feed.source?.feedRevision || '')
      ? renderAllEventMarkets(detail.event)
      : '<div class="sb-detail-markets-status">Memuat semua odds…</div>';
  }
  const button = panel?.closest('.sb-match-card')?.querySelector('[data-toggle-event-markets]');
  if (button) {
    button.setAttribute('aria-expanded', 'true');
    button.textContent = `Tutup semua pasar${button.dataset.marketCount ? ` · ${fmt(button.dataset.marketCount)}` : ''}`;
  }
  await loadEventMarkets(eventId);
}

async function loadEventMarkets(eventId, { force = false, notify = true } = {}) {
  if (!eventId) return null;
  const revision = String(feed.source?.feedRevision || '');
  const cached = eventDetails.get(eventId);
  if (!force && cached?.revision === revision) return cached.event;
  const existingRequest = eventDetailRequests.get(eventId);
  if (existingRequest) return existingRequest;

  pendingEventDetails.add(eventId);
  const panel = el(`event-markets-${eventId}`);
  if (panel && expandedEventMarkets.has(eventId)) {
    panel.hidden = false;
    panel.innerHTML = '<div class="sb-detail-markets-status">Memuat semua odds…</div>';
  }

  const request = (async () => {
    try {
      const response = await api.get(FEED_DETAIL_URL(eventId));
      const payload = response?.data || response;
      const event = payload?.event;
      if (!event || event.id !== eventId || !Array.isArray(event.markets)) {
        throw new Error('Respons detail odds pertandingan tidak lengkap.');
      }
      const responseRevision = String(payload.source?.feedRevision || '');
      if (!responseRevision || responseRevision !== String(feed.source?.feedRevision || '')) {
        throw new Error('Versi feed berubah saat memuat odds. Coba lagi.');
      }
      eventDetails.set(eventId, { event, revision: responseRevision });
      pendingEventDetails.delete(eventId);

      const allEvents = eventsWithFreshDetails();
      const oddsChanged = syncSelectedOdds(allEvents);
      pruneSelections(allEvents);
      if (oddsChanged) {
        quote = null;
        quoteGeneration += 1;
      }
      renderBetslip();
      const currentPanel = el(`event-markets-${eventId}`);
      if (currentPanel && expandedEventMarkets.has(eventId)) {
        currentPanel.innerHTML = renderAllEventMarkets(event);
      }
      return event;
    } catch (error) {
      pendingEventDetails.delete(eventId);
      eventDetails.delete(eventId);
      const summary = feed.events.find(item => item.id === eventId);
      let removed = false;
      if (summary) {
        const currentKeys = new Set(summary.markets.flatMap(market =>
          market.selections.map(selection => selKey(summary.id, market.id, selection.key))
        ));
        for (const [key, selection] of selected) {
          if (selection.eventId === eventId && !currentKeys.has(key)) {
            selected.delete(key);
            removed = true;
          }
        }
        if (removed) {
          quote = null;
          quoteGeneration += 1;
        }
      }
      renderBetslip();
      const currentPanel = el(`event-markets-${eventId}`);
      if (currentPanel && expandedEventMarkets.has(eventId)) {
        currentPanel.innerHTML = `<div class="sb-detail-markets-status">${escapeHtml(error?.message || 'Gagal memuat odds pertandingan.')} <button type="button" class="sb-detail-markets-retry" data-retry-event-markets="${escapeHtml(eventId)}">Coba lagi</button></div>`;
      }
      if (notify || removed) showToast(error?.message || 'Gagal memuat odds pertandingan.', 'danger');
      return null;
    } finally {
      eventDetailRequests.delete(eventId);
    }
  })();
  eventDetailRequests.set(eventId, request);
  return request;
}

function formatKickoffDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit' }).format(d);
}

function timeLabel(start) {
  if (!start) return 'TBA';
  const d = new Date(start);
  if (isNaN(d.getTime())) return 'TBA';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(d);
}

// Sidebar Desktop
function renderSidebar(list) {
  const sportHost = el('sport-nav');
  const leagueHost = el('league-nav');
  const sports = [...new Set(list.map((e) => e.sport || 'Football'))];
  const leagues = [...new Set(list.map((e) => e.league || 'Liga Internasional'))].sort((a, b) => a.localeCompare(b));
  const dropdown = el('sb-sport-menu');
  const sportLabel = el('current-sport-label');

  if (!sports.includes(currentSport)) currentSport = 'all';
  if (dropdown) {
    const options = [{ value: 'all', label: 'Semua Olahraga' },
      ...sports.map((sport) => ({ value: sport, label: displaySportName(sport) }))];
    dropdown.innerHTML = options.map((option) => `
      <button type="button" class="sb-sport-opt${currentSport === option.value ? ' active' : ''}"
        data-sport="${escapeHtml(option.value)}" data-sport-label="${escapeHtml(option.label)}">
        ${currentSport === option.value ? '✓ ' : ''}${escapeHtml(option.label)}
      </button>
    `).join('');
    const activeSport = options.find((option) => option.value === currentSport);
    if (sportLabel) sportLabel.textContent = activeSport?.label || 'Semua Olahraga';
  }
  
  if (sportHost) {
    let h = `<button type="button" class="sb-nav-item${currentSport === 'all' ? ' active' : ''}" data-sport="all">Semua</button>`;
    h += sports.map((s) => `<button type="button" class="sb-nav-item${currentSport === s ? ' active' : ''}" data-sport="${escapeHtml(s)}">${escapeHtml(displaySportName(s))}</button>`).join('');
    sportHost.innerHTML = h;
  sportHost.querySelectorAll('.sb-nav-item').forEach((b) => b.addEventListener('click', () => {
    currentSport = b.getAttribute('data-sport');
    visibleEventLimit = EVENTS_PAGE_SIZE;
    renderAll();
  }));
  }
  if (leagueHost) {
    let h = `<button type="button" class="sb-nav-item${currentLeague === 'all' ? ' active' : ''}" data-league="all">Semua Liga</button>`;
    h += leagues.map((l) => `<button type="button" class="sb-nav-item${currentLeague === l ? ' active' : ''}" data-league="${escapeHtml(l)}">${favLeagues.has(l) ? '★ ' : ''}${escapeHtml(l)}</button>`).join('');
    leagueHost.innerHTML = h;
    leagueHost.querySelectorAll('[data-league]').forEach((b) => b.addEventListener('click', () => {
      currentLeague = b.getAttribute('data-league');
      visibleEventLimit = EVENTS_PAGE_SIZE;
      renderAll();
    }));
  }
  const st = el('sidebar-status');
  if (st) st.innerHTML = feed.source?.pricedMarkets ? `${fmt(feed.source.pricedMarkets)} markets` : '—';
}

function displaySportName(sport) {
  const labels = { Football: 'Sepak Bola', Soccer: 'Sepak Bola', Basketball: 'Bola Basket',
    Tennis: 'Tenis', Badminton: 'Bulu Tangkis', Esports: 'E-Sports' };
  return labels[sport] || sport;
}

// ---------------------------------------------------------------------------
// Odds click -> betslip
// ---------------------------------------------------------------------------
function handleOddClick(btn) {
  const key = btn.getAttribute('data-sel');

  const odds = Number(btn.getAttribute('data-odds'));
  const priceVersion = btn.getAttribute('data-pv') || '';
  if (!key || !Number.isFinite(odds)) return;

  if (selected.has(key)) {
    selected.delete(key);
    quote = null;
    quoteGeneration += 1;
    renderBetslip();
    renderAll();
    return;
  }
  if (selected.size >= bettingConfig.maxLegs) {
    showToast(`Maksimal ${bettingConfig.maxLegs} pilihan per tiket.`, 'warning');
    return;
  }
  // Single mode: maksimal 1 selection — jangan ubah otomatis menjadi Mix Parlay.
  if (activeSlipTab === 'single' && selected.size >= 1) {
    showToast('Mode Single hanya mendukung 1 pilihan. Buka tab Parlay untuk mix parlay.', 'warning');
    return;
  }
  const event = eventsWithFreshDetails().find((e) => e.id === btn.getAttribute('data-evid'));
  const market = event?.markets?.find((m) => m.id === btn.getAttribute('data-mk'));
  const selection = market?.selections?.find((s) => s.key === btn.getAttribute('data-sk'));
  if (!event || !market || !selection || !priceVersion) {
    showToast('Data pilihan tidak lengkap. Muat ulang halaman.', 'danger');
    return;
  }
  // One selection per market per event (sportsbook rule, like WAM)
  for (const [k, v] of [...selected.entries()]) {
    if (v.eventId === event.id && v.marketId === market.id) selected.delete(k);
  }
  selected.set(key, {
    eventId: event.id,
    marketId: market.id,
    selectionId: selection.key,
    selectionLabel: selection.label,
    marketLabel: market.label || marketLabel(market.type),
    marketPeriod: market.period || 'FT',
    marketLine: market.line ?? selection.line ?? null,
    eventName: `${event.home?.name || ''} vs ${event.away?.name || ''}`,
    odds,
    priceVersion
  });
  quote = null;
  quoteGeneration += 1;
  renderBetslip();
  renderAll();
  showToast(`${selection.label} @ ${odds.toFixed(2)} ditambahkan`, 'success');
  // Auto-open betslip sheet on mobile when first selection is made
  if (window.innerWidth <= BETSLIP_MOBILE_BREAKPOINT && !slipSheetOpen) {
    setTimeout(() => openSlipSheet(), 250);
  }
}
// ---------------------------------------------------------------------------
// Betslip — WAM-style accumulator, backed by Gasterus server quotes
// ---------------------------------------------------------------------------
function betType() {
  if (activeSlipTab === 'single') return 'SINGLE';
  if (activeSlipTab === 'system') return 'SYSTEM';
  return selected.size > 1 ? 'PARLAY' : 'SINGLE';
}

function systemSizeOptions(legCount) {
  return Array.from({ length: Math.max(0, legCount - 2) }, (_, index) => index + 2)
    .filter(size => chooseCombinations(legCount, size) <= bettingConfig.maxSystemCombinations);
}

function betslipMetrics(stake, legs = [...selected.values()]) {
  const type = betType();
  const isSystem = type === 'SYSTEM';
  const sizes = isSystem ? systemSizeOptions(legs.length) : [];
  const systemSize = isSystem ? sizes.includes(activeSystemSize) ? activeSystemSize : sizes[0] ?? activeSystemSize : null;
  const systemCalculation = isSystem
    ? systemBetMetrics(stake, legs.map(leg => Number(leg.odds)), systemSize)
    : null;
  const combinationCount = isSystem ? systemCalculation.combinationCount : 1;
  const totalStake = stake * combinationCount;
  const potentialPayout = isSystem
    ? systemCalculation.potentialPayout
    : Math.floor(stake * totalOdds());
  return { type, systemSize, combinationCount, totalStake, potentialPayout };
}

function betslipReady(legs = [...selected.values()]) {
  if (activeSlipTab === 'single') return legs.length === 1;
  if (activeSlipTab === 'parlay') return legs.length >= 2;
  return systemSizeOptions(legs.length).includes(activeSystemSize);
}

function totalOdds() {
  let acc = 1;
  for (const s of selected.values()) acc *= Number(s.odds) || 1;
  return acc;
}

function betslipStake() {
  const input = el('sb-stake');
  if (input) {
    const n = Number(input.value);
    if (Number.isFinite(n) && n > 0) { lastStake = Math.floor(n); return lastStake; }
    return 0;
  }
  return Number.isFinite(lastStake) && lastStake > 0 ? Math.floor(lastStake) : 0;
}

function betslipBalance() {
  const u = auth.getUser() || {};
  return Number(u.balance ?? u.wallet?.balance ?? 0) || 0;
}

function renderBetslip() {
  const desktop = el('betslip-body');
  const mobileBody = el('sb-mobile-sheet'); // inside sb-slip-sheet-body
  const isDesktop = window.innerWidth > BETSLIP_MOBILE_BREAKPOINT;
  
  // Only render to the appropriate target based on screen size to avoid double views
  const target = isDesktop ? desktop : mobileBody;
  if (!target && !desktop && !mobileBody) return;

  // --- Update ALL badge counters ---
  const countEls = [el('bnav-slip-count'), el('sb-dock-count'), el('slip-sheet-count')];
  countEls.forEach((c) => {
    if (!c) return;
    if (selected.size > 0) { c.hidden = false; c.textContent = String(selected.size); }
    else { c.hidden = true; c.textContent = '0'; }
  });

  // Update desktop mode badge
  const mode = el('betslip-mode');
  if (mode) mode.textContent = selected.size > 0
    ? betType() === 'SINGLE' ? 'Single' : betType() === 'SYSTEM' ? `System ${activeSystemSize}/${selected.size}` : `Parlay · ${selected.size} leg`
    : '';

  const legs = [...selected.values()];
  const detailsPending = legs.some(leg => pendingEventDetails.has(leg.eventId));

  if (!selected.size) {
    const emptyHtml = '<div class="sb-slip-empty">Pilih odds pada pertandingan untuk memasang taruhan.</div>';
    // Only render to the active target
    if (isDesktop && desktop) desktop.innerHTML = emptyHtml;
    else if (!isDesktop && mobileBody) mobileBody.innerHTML = emptyHtml;
    return;
  }

  let stake = betslipStake();
  if (!stake) stake = bettingConfig.minStake;
  const isSystem = betType() === 'SYSTEM';
  const availableSystemSizes = isSystem ? systemSizeOptions(legs.length) : [];
  if (isSystem && availableSystemSizes.length && !availableSystemSizes.includes(activeSystemSize)) activeSystemSize = availableSystemSizes[0];
  const metrics = betslipMetrics(stake, legs);
  const odds = totalOdds();
  const est = metrics.potentialPayout;
  const balance = betslipBalance();
  const overBalance = metrics.totalStake > balance;
  const overMaxStake = metrics.totalStake > bettingConfig.maxStake;
  const isSystemMode = metrics.type === 'SYSTEM';
  const isParlay = metrics.type === 'PARLAY';
  const ready = betslipReady(legs);

  const parlayInfo = isParlay ? `<div class="sb-parlay-info">Mix Parlay · ${legs.length} pilihan · Odds ${odds.toFixed(2)}</div>` : '';
  const systemInfo = isSystem ? `<div class="sb-parlay-info">System ${metrics.systemSize}/${legs.length} · ${metrics.combinationCount} kombinasi</div>` : '';
  const singleInfo = metrics.type === 'SINGLE' ? '<div class="sb-single-mode-label">Single · Stake untuk satu pilihan</div>' : '';
  const systemSelector = isSystemMode && availableSystemSizes.length ? `<label class="sb-system-size">Kombinasi
      <select id="sb-system-size" aria-label="Ukuran kombinasi System">
        ${availableSystemSizes.map(size =>
          `<option value="${size}"${size === metrics.systemSize ? ' selected' : ''}>${size}/${legs.length} · ${chooseCombinations(legs.length, size)} kombinasi</option>`
        ).join('')}
      </select>
    </label>` : '';
  const betButtonLabel = placing ? 'Memproses…' : detailsPending ? 'Memperbarui odds…' : !ready ? (isSystemMode ? 'Pilih minimal 3 pertandingan' : isParlay ? 'Pilih minimal 2 pertandingan' : 'Pilih 1 pertandingan') : 'Pasang Taruhan';

  const html = `
    ${isSystemMode ? systemInfo : isParlay ? parlayInfo : singleInfo}
    <div class="sb-slip-legs">${legs.map(slipLegHtml).join('')}</div>
    ${systemSelector}
    <div class="sb-slip-summary">
      <div class="sb-slip-row"><span>Jumlah pilihan</span><b>${legs.length}</b></div>
      ${isSystemMode ? `<div class="sb-slip-row"><span>Kombinasi</span><b>${metrics.combinationCount}</b></div>` : `<div class="sb-slip-row"><span>Total odds</span><b>${odds.toFixed(2)}</b></div>`}
      <div class="sb-slip-row"><span>Saldo</span><b>${formatRupiah(balance)}</b></div>
      <div id="slip-quote" class="sb-slip-quote"></div>
      <div id="sb-quote-error" class="sb-quote-error" hidden></div>
    </div>
    <div class="sb-slip-stake">
      <label class="sb-label" for="sb-stake">Nominal taruhan (Rp)</label>
      <input type="number" id="sb-stake" inputmode="numeric" min="${bettingConfig.minStake}" max="${bettingConfig.maxStake}" step="1000" value="${stake}">
      <div class="sb-quick" role="group">
        ${[10000, 25000, 50000, 100000].map((v) => `<button type="button" class="sb-quick-btn" data-quick="${v}">${fmt(v)}</button>`).join('')}
      </div>
      <div class="sb-slip-row" style="margin-top:6px"><span>${isSystemMode ? 'Stake per kombinasi' : 'Stake'}</span><b>${formatRupiah(stake)}</b></div>
      ${isSystemMode ? `<div class="sb-slip-row"><span>Total stake</span><b id="slip-total-stake">${formatRupiah(metrics.totalStake)}</b></div>` : ''}
      <div class="sb-slip-row"><span>Estimasi menang</span><b class="sb-win" id="slip-est">${formatRupiah(est)}</b></div>
      <div class="sb-slip-hint">Min ${formatRupiah(bettingConfig.minStake)} · Maks ${formatRupiah(bettingConfig.maxStake)}</div>
      ${overBalance ? `<div class="sb-slip-hint" style="color:#b84639">Total stake melebihi saldo. <a href="/deposit.html" style="color:#b84639"><u>Deposit</u></a></div>` : ''}
      ${overMaxStake ? `<div class="sb-slip-hint" style="color:#b84639">Total stake melewati batas taruhan.</div>` : ''}
    </div>
    <button type="button" id="btn-place-bet" class="sb-btn sb-btn-place sb-btn-block"${(placing || overBalance || overMaxStake || detailsPending || !ready) ? ' disabled' : ''}>${betButtonLabel}</button>
    <button type="button" id="btn-clear-slip" class="sb-btn sb-btn-ghost sb-btn-block sb-btn-sm">Kosongkan betslip</button>`;

  // Render ONLY to the active target based on screen size to prevent double views
  if (isDesktop && desktop) { 
    desktop.innerHTML = html; 
    bindBetslipEvents(desktop); 
  } else if (!isDesktop && mobileBody) { 
    mobileBody.innerHTML = html; 
    bindBetslipEvents(mobileBody); 
  }

  if (stake >= bettingConfig.minStake && betslipReady(legs)) requestQuote();
}

function slipLegHtml(s) {
  const key = selKey(s.eventId, s.marketId, s.selectionId);
  return `<div class="sb-slip-leg" data-key="${escapeHtml(key)}">
    <div class="sb-slip-leg-main">
      <span class="sb-slip-event">${escapeHtml(s.eventName)}</span>
      <span class="sb-slip-pick">${escapeHtml(s.selectionLabel)} <b>@ ${Number(s.odds).toFixed(2)}</b></span>
      <span class="sb-slip-market">${escapeHtml(s.marketLabel)}${s.marketPeriod === '1H' ? ' · HT' : ''}${s.marketLine !== null && s.marketLine !== undefined ? ` (${escapeHtml(String(s.marketLine))})` : ''}</span>
    </div>
    <button type="button" class="sb-slip-remove" data-remove="${escapeHtml(key)}" aria-label="Hapus pilihan">×</button>
  </div>`;
}
// ---------------------------------------------------------------------------
// Server quote (odds lock) + place bet — real Gasterus endpoints only
// ---------------------------------------------------------------------------
let quoteInFlight = false;
let stakeTimer;

async function requestQuote() {
  if (quoteInFlight || !betslipReady()) return;
  if ([...selected.values()].some(selection => pendingEventDetails.has(selection.eventId))) return;
  const stake = betslipStake();
  if (stake < bettingConfig.minStake || stake > bettingConfig.maxStake) return;
  const metrics = betslipMetrics(stake);
  if (metrics.totalStake > bettingConfig.maxStake || metrics.totalStake > betslipBalance()) return;
  const requestGeneration = quoteGeneration;
  quoteInFlight = true;
  try {
    const type = betType();
    const payload = {
      betType: type,
      stake,
      ...(type === 'SYSTEM' ? { systemSize: activeSystemSize } : {}),
      oddsChangePolicy: 'REJECT',
      selections: [...selected.values()].map((s) => ({
        eventId: s.eventId,
        marketId: s.marketId,
        selectionId: s.selectionId,
        acceptedOdds: s.odds,
        acceptedPriceVersion: s.priceVersion
      }))
    };
    const res = await api.post('/member/sportsbook/quotes', payload);
    const q = res?.data || res;
    if (requestGeneration !== quoteGeneration) return;
    quote = q;
    renderQuote(q);
  } catch (err) {
    if (requestGeneration !== quoteGeneration) return;
    quote = null;
    showQuoteError(err?.message || 'Gagal membuat quote.');
  } finally {
    quoteInFlight = false;
    if (requestGeneration !== quoteGeneration && betslipReady() &&
      ![...selected.values()].some(selection => pendingEventDetails.has(selection.eventId))) {
      void requestQuote();
    }
  }
}

function renderQuote(q) {
  const host = el('slip-quote');
  if (!host) return;
  if (!q) { host.innerHTML = ''; return; }
  const expires = q.expiresAt ? new Date(q.expiresAt) : null;
  const quoteLabel = q.betType === 'SYSTEM' ? `System ${q.systemSize}/${q.selectionCount}` : 'Total odds terkunci';
  const quoteValue = q.betType === 'SYSTEM' ? `${q.combinationCount} kombinasi` : Number(q.totalOdds).toFixed(2);
  host.innerHTML = `<div class="sb-slip-row sb-quote-ok"><span>${quoteLabel}</span><b>${quoteValue}</b></div>
    <div class="sb-slip-row"><span>Potensi bayar (server)</span><b class="sb-win">${formatRupiah(Number(q.potentialPayout || 0))}</b></div>
    ${expires ? `<div class="sb-slip-hint">Berlaku sampai ${expires.toLocaleTimeString('id-ID')}</div>` : ''}`;
  const err = el('sb-quote-error');
  if (err) err.hidden = true;
}

function showQuoteError(message) {
  const err = el('sb-quote-error');
  if (err) { err.hidden = false; err.textContent = message; }
  const host = el('slip-quote');
  if (host) host.innerHTML = '';
}
function bindBetslipEvents(root) {
  root.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    selected.delete(b.getAttribute('data-remove'));
    quote = null;
    quoteGeneration += 1;
    renderBetslip();
    renderAll();
  }));
  root.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const input = el('sb-stake');
    if (input) { input.value = b.getAttribute('data-quick'); onStakeChange(); }
  }));
  const stakeInput = el('sb-stake');
  if (stakeInput) stakeInput.addEventListener('input', onStakeChange);
  const systemSize = root.querySelector('#sb-system-size');
  if (systemSize) systemSize.addEventListener('change', () => {
    activeSystemSize = Number(systemSize.value) || 2;
    quote = null;
    quoteGeneration += 1;
    renderBetslip();
  });
  const place = el('btn-place-bet');
  if (place) place.addEventListener('click', placeBet);
  const clear = el('btn-clear-slip');
  if (clear) clear.addEventListener('click', () => { selected.clear(); quote = null; quoteGeneration += 1; renderBetslip(); renderAll(); });
}

function onStakeChange() {
  const stake = betslipStake(); // juga menyimpan ke lastStake
  const metrics = betslipMetrics(stake);
  const est = el('slip-est');
  if (est) est.textContent = formatRupiah(metrics.potentialPayout);
  const totalStake = el('slip-total-stake');
  if (totalStake) totalStake.textContent = formatRupiah(metrics.totalStake);
  const pot = el('slip-potential');
  if (pot) pot.textContent = formatRupiah(metrics.potentialPayout);
  const place = el('btn-place-bet');
  const over = metrics.totalStake > betslipBalance() || metrics.totalStake > bettingConfig.maxStake;
  const detailsPending = [...selected.values()].some(selection => pendingEventDetails.has(selection.eventId));
  if (place && !placing) place.disabled = over || detailsPending || !betslipReady() ||
    stake < bettingConfig.minStake || stake > bettingConfig.maxStake;
  quote = null;
  quoteGeneration += 1;
  const host = el('slip-quote');
  if (host) host.innerHTML = '';
  clearTimeout(stakeTimer);
  stakeTimer = setTimeout(() => { if (betslipReady() && stake >= bettingConfig.minStake) requestQuote(); }, 500);
}

async function placeBet() {
  if (!auth.isLoggedIn()) {
    showToast('Silakan login terlebih dahulu untuk memasang taruhan.', 'warning');
    setTimeout(() => { window.location.href = '/index.html?msg=login_required'; }, 1200);
    return;
  }
  if (placing || !betslipReady()) {
    if (!betslipReady()) showToast(activeSlipTab === 'system' ? 'System bet membutuhkan minimal 3 pilihan.' : 'Jumlah pilihan belum sesuai dengan tipe taruhan.', 'warning');
    return;
  }
  if ([...selected.values()].some(selection => pendingEventDetails.has(selection.eventId))) {
    showToast('Odds sedang diperbarui. Tunggu sebelum memasang taruhan.', 'warning');
    return;
  }
  const stake = betslipStake() || lastStake || bettingConfig.minStake;
  const metrics = betslipMetrics(stake);
  if (stake < bettingConfig.minStake) { showToast(`Minimal taruhan ${formatRupiah(bettingConfig.minStake)}.`, 'warning'); return; }
  if (stake > bettingConfig.maxStake) { showToast(`Maksimal taruhan ${formatRupiah(bettingConfig.maxStake)}.`, 'warning'); return; }
  if (metrics.totalStake > bettingConfig.maxStake) { showToast(`Total taruhan ${formatRupiah(metrics.totalStake)} melewati batas.`, 'warning'); return; }
  if (metrics.totalStake > betslipBalance()) { showToast('Total stake melebihi saldo. Silakan deposit dulu.', 'warning'); return; }
  if (bettingConfig.quoteRequired && !quote?.quoteToken) {
    showToast('Quote server belum siap. Coba lagi sebentar.', 'warning');
    return;
  }
  const btn = el('btn-place-bet');
  placing = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
  try {
    const idempotencyKey = (crypto?.randomUUID)
      ? crypto.randomUUID()
      : `sb-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const res = await api.post('/member/sportsbook/bets', { idempotencyKey, quoteToken: quote.quoteToken });
    const ticket = res?.data || res;
    selected.clear();
    quote = null;
    quoteGeneration += 1;
    renderBetslip();
    renderAll();
    showToast(`Tiket ${ticket?.invoice || ''} berhasil dipasang!`, 'success');
    refreshTicketNote();
    refreshBalance();
  } catch (err) {
    const code = err?.data?.error?.code || '';
    if (code === 'SPORTSBOOK_ODDS_CHANGED' || code === 'SPORTSBOOK_ODDS_VERSION_CHANGED') {
      showToast('Odds telah berubah. Betslip diperbarui — tinjau kembali.', 'warning');
      quote = null;
      quoteGeneration += 1;
      syncSelectedOdds(feed.events);
      renderBetslip();
      renderAll();
    } else if (code === 'SPORTSBOOK_QUOTE_EXPIRED' || code === 'SPORTSBOOK_QUOTE_INVALID') {
      showToast('Quote kedaluwarsa. Meminta harga terbaru…', 'warning');
      quote = null;
      quoteGeneration += 1;
      renderBetslip();
      const stake = betslipStake() || lastStake || 0;
      if (selected.size && stake >= bettingConfig.minStake) requestQuote();
    } else {
      showToast(err?.message || 'Gagal memasang taruhan.', 'danger');
    }
  } finally {
    placing = false;
    const b = el('btn-place-bet');
    if (b) { b.disabled = false; b.textContent = '⚽ Pasang Taruhan'; }
  }
}

// Read-only ticket note (GET /api/member/sportsbook/bets)
async function refreshTicketNote() {
  try {
    const res = await api.get('/member/sportsbook/bets?limit=5');
    const items = res?.data?.items || res?.data || [];
    if (!Array.isArray(items) || !items.length) return;
    const st = el('sidebar-status');
    if (st) st.innerHTML = `${fmt(feed.source?.pricedMarkets || 0)} markets · ${items.length} tiket terakhir`;
  } catch { /* informational only */ }
}

// ---------------------------------------------------------------------------
// Slip Sheet Setup (Mobile slide-up betslip with tabs)
// ---------------------------------------------------------------------------
function setupSlipSheet() {
  // Close button
  const closeBtn = el('btn-close-slip-sheet');
  if (closeBtn) closeBtn.addEventListener('click', closeSlipSheet);

  // Overlay click to close
  const overlay = el('sb-slip-overlay');
  if (overlay) overlay.addEventListener('click', closeSlipSheet);

  // Tab switching (mobile)
  document.querySelectorAll('.sb-slip-tab').forEach((tab) => {
    tab.addEventListener('click', () => setSlipTab(tab.getAttribute('data-slip-tab') || 'single'));
  });

  // Tab switching (desktop)
  document.querySelectorAll('.sb-bs-tab').forEach((tab) => {
    tab.addEventListener('click', () => setSlipTab(tab.getAttribute('data-bstab') || 'single'));
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && slipSheetOpen) closeSlipSheet();
  });
}

// Handle window resize to re-render betslip in correct container
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    // Close mobile sheet if resizing to desktop
    if (window.innerWidth > BETSLIP_MOBILE_BREAKPOINT && slipSheetOpen) {
      closeSlipSheet();
    }
    // Re-render betslip in the correct container
    renderBetslip();
  }, 250);
});

// Auto init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSportsbook);
} else {
  initSportsbook();
}
