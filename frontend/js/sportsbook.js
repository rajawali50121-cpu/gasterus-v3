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

const STREAM_URL = '/api/member/sportsbook/stream';
const SNAPSHOT_URL = '/api/member/sportsbook/events';
const FEED_DETAIL_URL = (id) => `/api/member/sportsbook/events/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let feed = { events: [], stale: false, degraded: false, source: {} };
let pagination = { hasMore: false, nextCursor: null };
let loadingMoreEvents = false;
let selected = new Map(); // selectionKey -> leg payload (betslip)
let currentSport = 'all';
let currentLeague = 'all';
let currentFilter = 'all'; // all | live | upcoming | fav
let searchQuery = '';
const FAV_KEY = 'gasterus_sb_fav_leagues';
let favLeagues = new Set();
try { favLeagues = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { favLeagues = new Set(); }
let lastRenderRevision = '';
let lastStructureRevision = '';
let bettingConfig = { minStake: 1000, maxStake: 50000000, maxLegs: 12, quoteRequired: true };
let streamClosed = false;
let quote = null; // last successful server quote
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
              scheduleOddsMovementCleanup(key, 1000);
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
const SB_BUILD = 'sb7';
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
    if (payload && Array.isArray(payload.events)) {
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
  const revision = snapshot.source?.feedRevision || '';
  const previousRevision = feed.source?.feedRevision || '';
  const revisionChanged = Boolean(previousRevision && revision && previousRevision !== revision);
  const incomingIds = new Set(snapshot.events.map(event => event.id));
  const retainedEvents = revisionChanged ? [] : feed.events.filter(event => !incomingIds.has(event.id));
  feed = {
    events: [...snapshot.events, ...retainedEvents],
    stale: Boolean(snapshot.stale),
    degraded: Boolean(snapshot.degraded),
    source: snapshot.source || {}
  };
  pagination = snapshot.pagination || { hasMore: false, nextCursor: null };
  if (snapshot.betting) bettingConfig = { ...bettingConfig, ...snapshot.betting };
  syncLiveClocks(feed.events);
  const oddsMovedInFeed = trackOddsMovement(feed.events);
  const oddsMoved = syncSelectedOdds(feed.events);
  pruneSelections(feed.events);
  if (oddsMoved) {
    quote = null; // harga berubah → quote lama tidak valid, minta ulang
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
  renderLoadMore();
}

function pruneSelections(events) {
  if (!selected.size) return;
  const eventIds = new Set(events.map(event => String(event.id)));
  const liveKeys = new Set();
  for (const ev of events) {
    for (const mk of ev.markets || []) {
      for (const sk of mk.selections || []) liveKeys.add(selKey(ev.id, mk.id, sk.key));
    }
  }
  let changed = false;
  for (const key of [...selected.keys()]) {
    const eventId = key.slice(0, key.indexOf('|'));
    if (eventIds.has(eventId) && !liveKeys.has(key)) { selected.delete(key); changed = true; }
  }
  if (changed) { quote = null; renderBetslip(); }
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
    if (!sel || sel.suspended) continue; // penghapusan ditangani pruneSelections
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
  if (banner) {
    const src = feed.source || {};
    const mode = String(src.mode || '');
    const isCached = /CACHED|SNAPSHOT|STALE/i.test(mode) || Boolean(src.cachedFallback);
    // P1: tampilkan umur feed + tanggal update agar jadwal cached tidak dikira acak.
    const stamp = src.fetchedAt || src.capturedAt || null;
    let stampText = '';
    if (stamp) {
      const d = new Date(stamp);
      if (!Number.isNaN(d.getTime())) {
        stampText = ` • update ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
    }
    if (feed.stale || isCached) {
      banner.hidden = false;
      banner.textContent = `Jadwal sementara (data cached${stampText}) — odds dapat berubah saat feed pulih. Feed akan memperbarui otomatis.`;
    } else if (feed.degraded) {
      banner.hidden = false;
      banner.textContent = `Feed terhubung tetapi belum bisa terima taruhan${stampText}. Menunggu otoritas settlement.`;
    } else banner.hidden = true;
  }
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
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter') || 'today';
      renderAll();
    });
  });

  // Action bar buttons
  const btnLeague = el('btn-show-leagues');
  if (btnLeague) btnLeague.addEventListener('click', openLeagueModal);

  const btnFilter = el('btn-filter-toggle');
  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      currentFilter = currentFilter === 'fav' ? 'today' : 'fav';
      showToast(currentFilter === 'fav' ? 'Menampilkan liga favorit' : 'Menampilkan semua liga', 'info');
      renderAll();
    });
  }

  setupMixParlay();
  setupSportDropdown();
  setupLeagueModal();
  setupBalanceToggle();
  setupBottomNav();
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
    btn.classList.toggle('active');
    const isParlay = btn.classList.contains('active');
    showToast(isParlay ? 'Mode Mix Parlay Aktif' : 'Mode Normal Aktif', 'info');
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

  menu.querySelectorAll('.sb-sport-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      menu.querySelectorAll('.sb-sport-opt').forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      currentSport = opt.getAttribute('data-sport') || 'all';
      if (label) label.textContent = opt.textContent.replace(/^[^\w]+/, '').trim();
      menu.hidden = true;
      renderAll();
    });
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
let activeSlipTab = 'single'; // 'single' | 'parlay'

function openSlipSheet() {
  // Don't open mobile sheet on desktop - betslip is already visible in sidebar
  if (window.innerWidth > 1024) return;
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
  activeSlipTab = tab;
  // Single mode hanya mendukung 1 selection — batasi dengan aman + pesan jelas.
  if (tab === 'single' && selected.size > 1) {
    const [firstKey, firstLeg] = [...selected.entries()][0];
    selected.clear();
    selected.set(firstKey, firstLeg);
    quote = null;
    showToast('Mode Single hanya mendukung 1 pilihan. Pilihan lain dihapus — gunakan tab Parlay untuk mix parlay.', 'warning');
  }
  // Update mobile sheet tabs
  document.querySelectorAll('.sb-slip-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-slip-tab') === tab);
  });
  // Update desktop betslip tabs
  document.querySelectorAll('.sb-bs-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-bstab') === tab);
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
      currentFilter = currentFilter === 'fav' ? 'today' : 'fav';
      renderAll();
      showToast(currentFilter === 'fav' ? 'Menampilkan Pertandingan Saya' : 'Menampilkan Semua', 'info');
    });
  }
  if (myBetsBtn) {
    myBetsBtn.addEventListener('click', () => { closeSlipSheet(); openUserBetsModal('Taruhan Saya'); });
  }
  if (cashoutBtn) {
    cashoutBtn.addEventListener('click', () => { closeSlipSheet(); openUserBetsModal('Fitur Bayar Sekarang (Cashout)'); });
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
    t = setTimeout(() => { searchQuery = input.value.trim().toLowerCase(); renderAll(); }, 200);
  });
}

function bindEventHandlers() {
  const ev = el('sb-events');
  if (!ev) return;
  ev.addEventListener('click', (e) => {
    const odd = e.target.closest('.sb-odd-cell');
    if (odd && !odd.classList.contains('disabled') && !odd.classList.contains('locked')) {
      handleOddClick(odd);
      return;
    }
    const accBtn = e.target.closest('[data-toggle-accordion]');
    if (accBtn) {
      const eventId = accBtn.getAttribute('data-toggle-accordion');
      toggleAccordion(eventId);
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
      leagueHead.classList.toggle('collapsed');
      const list = leagueHead.nextElementSibling;
      if (list) list.hidden = leagueHead.classList.contains('collapsed');
      return;
    }
  });
  el('sb-load-more')?.addEventListener('click', loadMoreEvents);
}

function renderLoadMore() {
  const button = el('sb-load-more');
  if (!button) return;
  button.hidden = !pagination.hasMore;
  button.disabled = loadingMoreEvents;
  button.textContent = loadingMoreEvents ? 'Memuat pertandingan…' : 'Muat lebih';
}

async function loadMoreEvents() {
  if (loadingMoreEvents || !pagination.nextCursor) return;
  loadingMoreEvents = true;
  renderLoadMore();
  try {
    const headers = { Accept: 'application/json' };
    if (api.token) { headers.Authorization = `Bearer ${api.token}`; headers['x-session-token'] = api.token; }
    const url = `${SNAPSHOT_URL}?cursor=${encodeURIComponent(pagination.nextCursor)}`;
    const response = await fetch(url, { method: 'GET', credentials: 'include', headers });
    if (response.status === 409) {
      pagination = { hasMore: false, nextCursor: null };
      showToast('Daftar pertandingan diperbarui. Memuat ulang halaman pertama.', 'warning');
      await loadRestSnapshot();
      return;
    }
    if (!response.ok) throw new Error(`snapshot http ${response.status}`);
    const json = await response.json();
    const payload = json?.data || json;
    if (!Array.isArray(payload?.events)) throw new Error('snapshot tidak valid');
    if (feed.source?.feedRevision && payload.source?.feedRevision !== feed.source.feedRevision) {
      pagination = { hasMore: false, nextCursor: null };
      await loadRestSnapshot();
      return;
    }
    const existingIds = new Set(feed.events.map(event => event.id));
    const appended = payload.events.filter(event => !existingIds.has(event.id));
    feed.events = [...feed.events, ...appended];
    pagination = payload.pagination || { hasMore: false, nextCursor: null };
    syncLiveClocks(appended);
    trackOddsMovement(appended);
    syncSelectedOdds(appended);
    pruneSelections(feed.events);
    renderAll();
  } catch (error) {
    showToast(error?.message || 'Gagal memuat pertandingan berikutnya.', 'danger');
  } finally {
    loadingMoreEvents = false;
    renderLoadMore();
  }
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
  ev.innerHTML = renderLeagueGroups(list);
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
    const hdp = findMarket(e, 'HANDICAP', 'FT');
    const hSel = hdp?.selections?.find((s) => /^(home|1)$/i.test(s.key || s.label)) || hdp?.selections?.[0];
    const aSel = hdp?.selections?.find((s) => /^(away|2)$/i.test(s.key || s.label)) || hdp?.selections?.[1];
    
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
              <span>${escapeHtml(e.home?.name || 'Home')}</span>
              <b>${escapeHtml(String(e.home?.score ?? 0))}</b>
            </div>
            <div class="sb-live-team-row">
              <span>${escapeHtml(e.away?.name || 'Away')}</span>
              <b>${escapeHtml(String(e.away?.score ?? 0))}</b>
            </div>
          </div>
          <div class="sb-live-quick-odds">
            <div style="font-size:10px; font-weight:700; color:#475569; text-align:center;">BP Handicap</div>
            ${renderQuickOddBtn(e, hdp, hSel, 'H')}
            ${renderQuickOddBtn(e, hdp, aSel, 'A')}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuickOddBtn(e, m, s, label) {
  if (!m || !s) return `<div class="sb-quick-odd-btn disabled"><span>${label}</span><span>—</span></div>`;
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
  for (const [league, events] of sorted) {
    html += `<div class="sb-league-group">`;
    html += `
      <div class="sb-league-head">
        <span class="sb-league-title">${escapeHtml(league)}</span>
        <div class="sb-league-right">
          <span class="sb-league-pill">${events.length}</span>
          <span class="sb-league-toggle">▲</span>
        </div>
      </div>
    `;
    html += `<div class="sb-match-list">`;
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

function renderOddCell(e, m, s, lineOverride) {
  if (!m || m.suspended || !s || s.suspended) {
    return `<div class="sb-odd-cell disabled"><span class="sb-cell-odds">—</span></div>`;
  }
  const decOdds = Number(s.odds);
  if (!Number.isFinite(decOdds) || decOdds <= 1) {
    return `<div class="sb-odd-cell disabled"><span class="sb-cell-odds">—</span></div>`;
  }
  const key = selKey(e.id, m.id, s.key);
  const isChosen = selected.has(key);
  
  const lineVal = lineOverride != null ? lineOverride : (s.line ?? m.line);
  const lineFormatted = lineVal != null
    ? (Number(lineVal) > 0 ? `+${Number(lineVal).toFixed(2)}` : Number(lineVal).toFixed(2)) 
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

function renderMatch(e) {
  const isLive = Boolean(e.live) || String(e.status || '').toUpperCase() === 'LIVE';
  const home = e.home || {}, away = e.away || {};

  // Markets for Asian 3-Column Table
  const bpHdp = findMarket(e, 'HANDICAP', 'FT');
  const bpOu  = findMarket(e, 'TOTALS', 'FT');
  const bp1x2 = findMarket(e, '1X2', 'FT');

  const b1Hdp = findMarket(e, 'HANDICAP', '1H');
  const b1Ou  = findMarket(e, 'TOTALS', '1H');
  const b11x2 = findMarket(e, '1X2', '1H');

  // Determine Favorite team (Red color): line < 0
  const hdpLine = Number(bpHdp?.line ?? 0);
  const isHomeFav = hdpLine < 0;
  const isAwayFav = hdpLine > 0;

  // HDP Selections
  const hHdp = bpHdp?.selections?.find((s) => /^(home|1)$/i.test(s.key || s.label)) || bpHdp?.selections?.[0];
  const aHdp = bpHdp?.selections?.find((s) => /^(away|2)$/i.test(s.key || s.label)) || bpHdp?.selections?.[1];

  // OU Selections
  const oOu = bpOu?.selections?.find((s) => /^over\b/i.test(s.key || s.label)) || bpOu?.selections?.[0];
  const uOu = bpOu?.selections?.find((s) => /^under\b/i.test(s.key || s.label)) || bpOu?.selections?.[1];

  // 1X2 Selections
  const h1x2 = bp1x2?.selections?.find((s) => /^(home|1)$/i.test(s.key || s.label)) || bp1x2?.selections?.[0];
  const a1x2 = bp1x2?.selections?.find((s) => /^(away|2)$/i.test(s.key || s.label)) || bp1x2?.selections?.[1];
  const d1x2 = bp1x2?.selections?.find((s) => /^(draw|x)$/i.test(s.key || s.label)) || bp1x2?.selections?.[2];

  // 1H HDP Selections
  const hHdp1 = b1Hdp?.selections?.find((s) => /^(home|1)$/i.test(s.key || s.label)) || b1Hdp?.selections?.[0];
  const aHdp1 = b1Hdp?.selections?.find((s) => /^(away|2)$/i.test(s.key || s.label)) || b1Hdp?.selections?.[1];

  // 1H OU Selections
  const oOu1 = b1Ou?.selections?.find((s) => /^over\b/i.test(s.key || s.label)) || b1Ou?.selections?.[0];
  const uOu1 = b1Ou?.selections?.find((s) => /^under\b/i.test(s.key || s.label)) || b1Ou?.selections?.[1];

  // 1H 1X2 Selections
  const h1x2_1 = b11x2?.selections?.find((s) => /^(home|1)$/i.test(s.key || s.label)) || b11x2?.selections?.[0];
  const a1x2_1 = b11x2?.selections?.find((s) => /^(away|2)$/i.test(s.key || s.label)) || b11x2?.selections?.[1];
  const d1x2_1 = b11x2?.selections?.find((s) => /^(draw|x)$/i.test(s.key || s.label)) || b11x2?.selections?.[2];

  const extraCount = Math.max((e.markets || []).length - 6, 0);

  return `
    <article class="sb-match-card" data-evid="${escapeHtml(e.id)}">
      
      <!-- Slanted Banner -->
      <div class="sb-card-banner">
        <div class="sb-banner-left">
          ${isLive 
            ? `<div class="sb-badge-slanted-live"><span>LANGSUNG</span></div>` 
            : `<div class="sb-badge-slanted-live" style="background:#2563eb;"><span>${formatShortDate(e.startTime)}</span></div>`}
          <div class="sb-badge-slanted-league"><span>${escapeHtml(e.league || 'SPORTSBOOK')}</span></div>
        </div>
        <button type="button" class="sb-banner-refresh" onclick="window.location.reload()" title="Muat ulang odds">↻</button>
      </div>

      <!-- Teams Row -->
      <div class="sb-teams-row">
        <div class="sb-team-col ${isHomeFav ? 'is-fav' : ''}">
          ${home.logo ? `<img class="sb-team-logo" src="${escapeHtml(home.logo)}" alt="" width="20" height="20" loading="lazy" decoding="async" onerror="this.remove()">` : ''}<span class="sb-team-name">${escapeHtml(home.name || 'Home')}</span>
        </div>
        <div class="sb-score-col">
          ${isLive 
            ? `<span class="sb-match-live-score">${escapeHtml(String(home.score ?? 0))} - ${escapeHtml(String(away.score ?? 0))}</span>
               <span class="sb-match-live-clock" data-live-clock-id="${escapeHtml(e.id)}">${escapeHtml(getLiveClockDisplay(e))}</span>`
            : `<span class="sb-match-date">${formatKickoffDate(e.startTime)}</span>
               <span class="sb-match-kickoff">${timeLabel(e.startTime)}</span>`}
        </div>
        <div class="sb-team-col away ${isAwayFav ? 'is-fav' : ''}">
          <span class="sb-team-name">${escapeHtml(away.name || 'Away')}</span>${away.logo ? `<img class="sb-team-logo" src="${escapeHtml(away.logo)}" alt="" width="20" height="20" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        </div>
      </div>

      <!-- Pasaran / Bet Builder Tabs -->
      <div class="sb-match-tabs">
        <button type="button" class="sb-mtab active">Pasaran</button>
        <button type="button" class="sb-mtab">Bet Builder</button>
      </div>

      <!-- The 3-Column Odds Matrix Grid -->
      <div class="sb-matrix-table">
        <!-- Headers -->
        <div class="sb-mth-row" style="display:grid; grid-template-columns: 1fr 1fr 1fr;">
          <div class="sb-mth">BP Handicap</div>
          <div class="sb-mth">BP Atas/Bawah</div>
          <div class="sb-mth">BP 1X2</div>
        </div>

        <!-- Babak Penuh (FT) Rows -->
        <div class="sb-matrix-row">
          <!-- Col 1: BP Handicap -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">H</span>
              ${renderOddCell(e, bpHdp, hHdp)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">A</span>
              ${renderOddCell(e, bpHdp, aHdp)}
            </div>
          </div>

          <!-- Col 2: BP Atas/Bawah -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">O</span>
              ${renderOddCell(e, bpOu, oOu)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">U</span>
              ${renderOddCell(e, bpOu, uOu)}
            </div>
          </div>

          <!-- Col 3: BP 1X2 -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">H</span>
              ${renderOddCell(e, bp1x2, h1x2)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">A</span>
              ${renderOddCell(e, bp1x2, a1x2)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">D</span>
              ${renderOddCell(e, bp1x2, d1x2)}
            </div>
          </div>
        </div>

        <!-- Babak 1 (1H) Subheader -->
        <div class="sb-mth-row sb-mth-sub" style="display:grid; grid-template-columns: 1fr 1fr 1fr;">
          <div>B1 Handicap</div>
          <div>B1 Atas/Bawah</div>
          <div>B1 1X2</div>
        </div>

        <!-- Babak 1 (1H) Rows -->
        <div class="sb-matrix-row">
          <!-- Col 1: B1 Handicap -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">H</span>
              ${renderOddCell(e, b1Hdp, hHdp1)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">A</span>
              ${renderOddCell(e, b1Hdp, aHdp1)}
            </div>
          </div>

          <!-- Col 2: B1 Atas/Bawah -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">O</span>
              ${renderOddCell(e, b1Ou, oOu1)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">U</span>
              ${renderOddCell(e, b1Ou, uOu1)}
            </div>
          </div>

          <!-- Col 3: B1 1X2 -->
          <div class="sb-mcol">
            <div class="sb-mrow-item">
              <span class="sb-mletter">H</span>
              ${renderOddCell(e, b11x2, h1x2_1)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">A</span>
              ${renderOddCell(e, b11x2, a1x2_1)}
            </div>
            <div class="sb-mrow-item">
              <span class="sb-mletter">D</span>
              ${renderOddCell(e, b11x2, d1x2_1)}
            </div>
          </div>
        </div>
      </div>

      <!-- Extra Markets Accordion -->
      <div class="sb-accordion-wrapper" id="acc-wrap-${escapeHtml(e.id)}" hidden>
        <div class="sb-accordion-top-tab" data-toggle-accordion="${escapeHtml(e.id)}">
          <span>Tampilkan Odds</span>
          <span>▲</span>
        </div>
        <div class="sb-accordion-list">
          ${renderAccordionMarketRows(e)}
        </div>
      </div>

      <!-- Card Footer -->
      <div class="sb-card-footer">
        <span class="sb-pitch-icon">⚽ 🏟️</span>
        <button type="button" class="sb-more-pill" data-toggle-accordion="${escapeHtml(e.id)}">
          <span>${extraCount}</span> ●
        </button>
      </div>

    </article>
  `;
}

function renderAccordionMarketRows(e) {
  return (e.markets || [])
    .filter(market => Array.isArray(market.selections) && market.selections.length > 0)
    .map(market => {
      const period = String(market.period || 'FT').toUpperCase();
      const line = market.line === null || market.line === undefined ? '' : ` · ${escapeHtml(String(market.line))}`;
      const suspended = market.suspended ? ' · Ditangguhkan' : '';

      return `
      <div class="sb-accordion-row">
        <div class="sb-accordion-header">
          <span>${escapeHtml(market.label || market.type || 'Market')} · ${escapeHtml(period)}${line}${suspended}</span>
          <span class="sb-accordion-arrow">▼</span>
        </div>
        <div class="sb-accordion-body" hidden>
          <div class="sb-accordion-grid">
            ${market.selections.map(selection => `
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:10px; color:#64748b; text-align:center;">${escapeHtml(selection.label || selection.key)}</span>
                ${renderOddCell(e, market, selection)}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    }).join('');
}

function toggleAccordion(eventId) {
  const wrap = el(`acc-wrap-${eventId}`);
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
}

function formatShortDate(iso) {
  if (!iso) return 'JADWAL';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'JADWAL';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatKickoffDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function timeLabel(start) {
  if (!start) return 'TBA';
  const d = new Date(start);
  if (isNaN(d.getTime())) return 'TBA';
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// Sidebar Desktop
function renderSidebar(list) {
  const sportHost = el('sport-nav');
  const leagueHost = el('league-nav');
  const sports = [...new Set(list.map((e) => e.sport || 'Football'))];
  const leagues = [...new Set(list.map((e) => e.league || 'Liga Internasional'))].sort((a, b) => a.localeCompare(b));
  
  if (sportHost) {
    let h = `<button type="button" class="sb-nav-item${currentSport === 'all' ? ' active' : ''}" data-sport="all">Semua</button>`;
    h += sports.map((s) => `<button type="button" class="sb-nav-item${currentSport === s ? ' active' : ''}" data-sport="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
    sportHost.innerHTML = h;
    sportHost.querySelectorAll('.sb-nav-item').forEach((b) => b.addEventListener('click', () => { currentSport = b.getAttribute('data-sport'); renderAll(); }));
  }
  if (leagueHost) {
    let h = `<button type="button" class="sb-nav-item${currentLeague === 'all' ? ' active' : ''}" data-league="all">Semua Liga</button>`;
    h += leagues.slice(0, 12).map((l) => `<button type="button" class="sb-nav-item${currentLeague === l ? ' active' : ''}" data-league="${escapeHtml(l)}">${favLeagues.has(l) ? '★ ' : ''}${escapeHtml(l)}</button>`).join('');
    leagueHost.innerHTML = h;
    leagueHost.querySelectorAll('[data-league]').forEach((b) => b.addEventListener('click', () => { currentLeague = b.getAttribute('data-league'); renderAll(); }));
  }
  const st = el('sidebar-status');
  if (st) st.innerHTML = feed.source?.pricedMarkets ? `${fmt(feed.source.pricedMarkets)} markets` : '—';
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
  const event = feed.events.find((e) => e.id === btn.getAttribute('data-evid'));
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
    marketLine: market.line || null,
    eventName: `${event.home?.name || ''} vs ${event.away?.name || ''}`,
    odds,
    priceVersion
  });
  quote = null;
  renderBetslip();
  renderAll();
  showToast(`${selection.label} @ ${odds.toFixed(2)} ditambahkan`, 'success');
  // Auto-open betslip sheet on mobile when first selection is made
  if (window.innerWidth <= 1024 && !slipSheetOpen) {
    setTimeout(() => openSlipSheet(), 250);
  }
}
// ---------------------------------------------------------------------------
// Betslip — WAM-style accumulator, backed by Gasterus server quotes
// ---------------------------------------------------------------------------
function betType() {
  // Tab Single = selalu SINGLE bet (tidak pernah otomatis jadi Mix Parlay).
  if (activeSlipTab === 'single') return 'SINGLE';
  return selected.size > 1 ? 'PARLAY' : 'SINGLE';
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
  const isDesktop = window.innerWidth > 1024;
  
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
  if (mode) mode.textContent = selected.size > 0 ? (betType() === 'SINGLE' ? 'Single' : `Parlay · ${selected.size} leg`) : '';

  const legs = [...selected.values()];

  if (!selected.size) {
    const emptyHtml = '<div class="sb-slip-empty">Pilih odds pada pertandingan untuk memasang taruhan.</div>';
    // Only render to the active target
    if (isDesktop && desktop) desktop.innerHTML = emptyHtml;
    else if (!isDesktop && mobileBody) mobileBody.innerHTML = emptyHtml;
    return;
  }

  let stake = betslipStake();
  if (!stake) stake = bettingConfig.minStake;
  const odds = totalOdds();
  const est = Math.floor(stake * odds);
  const balance = betslipBalance();
  const overBalance = stake > balance;
  const isParlay = activeSlipTab === 'parlay' || legs.length > 1;

  const parlayInfo = isParlay && legs.length > 1 ? `<div class="sb-parlay-info">Mix Parlay ${legs.length} pilihan &mdash; Total odds: <b>${odds.toFixed(2)}</b></div>` : '';
  const singleInfo = !isParlay ? '<div class="sb-single-mode-label">Mode Single &mdash; Stake berlaku per pilihan</div>' : '';

  const html = `
    ${isParlay ? parlayInfo : singleInfo}
    <div class="sb-slip-legs">${legs.map(slipLegHtml).join('')}</div>
    <div class="sb-slip-summary">
      <div class="sb-slip-row"><span>Jumlah pilihan</span><b>${legs.length}</b></div>
      <div class="sb-slip-row"><span>Total odds</span><b>${odds.toFixed(2)}</b></div>
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
      <div class="sb-slip-row" style="margin-top:6px"><span>Stake</span><b>${formatRupiah(stake)}</b></div>
      <div class="sb-slip-row"><span>Estimasi menang</span><b class="sb-win" id="slip-est">${formatRupiah(est)}</b></div>
      <div class="sb-slip-hint">Min ${formatRupiah(bettingConfig.minStake)} · Maks ${formatRupiah(bettingConfig.maxStake)}</div>
      ${overBalance ? `<div class="sb-slip-hint" style="color:#ef4444">Stake melebihi saldo. <a href="/deposit.html" style="color:#ef4444"><u>Deposit</u></a></div>` : ''}
    </div>
    <button type="button" id="btn-place-bet" class="sb-btn sb-btn-place sb-btn-block"${(placing || overBalance) ? ' disabled' : ''}>${placing ? '⏳ Memproses…' : '⚽ Pasang Taruhan'}</button>
    <button type="button" id="btn-clear-slip" class="sb-btn sb-btn-ghost sb-btn-block sb-btn-sm">Kosongkan betslip</button>`;

  // Render ONLY to the active target based on screen size to prevent double views
  if (isDesktop && desktop) { 
    desktop.innerHTML = html; 
    bindBetslipEvents(desktop); 
  } else if (!isDesktop && mobileBody) { 
    mobileBody.innerHTML = html; 
    bindBetslipEvents(mobileBody); 
  }

  if (stake >= bettingConfig.minStake) requestQuote();
}

function slipLegHtml(s) {
  const key = selKey(s.eventId, s.marketId, s.selectionId);
  return `<div class="sb-slip-leg" data-key="${escapeHtml(key)}">
    <div class="sb-slip-leg-main">
      <span class="sb-slip-event">${escapeHtml(s.eventName)}</span>
      <span class="sb-slip-pick">${escapeHtml(s.selectionLabel)} <b>@ ${Number(s.odds).toFixed(2)}</b></span>
      <span class="sb-slip-market">${escapeHtml(s.marketLabel)}${s.marketPeriod === '1H' ? ' · HT' : ''}${s.marketLine ? ` (${escapeHtml(String(s.marketLine))})` : ''}</span>
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
  if (quoteInFlight || !selected.size) return;
  const stake = betslipStake();
  if (stake < bettingConfig.minStake || stake > bettingConfig.maxStake) return;
  quoteInFlight = true;
  try {
    const payload = {
      betType: betType(),
      stake,
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
    quote = q;
    renderQuote(q);
  } catch (err) {
    quote = null;
    showQuoteError(err?.message || 'Gagal membuat quote.');
  } finally {
    quoteInFlight = false;
  }
}

function renderQuote(q) {
  const host = el('slip-quote');
  if (!host) return;
  if (!q) { host.innerHTML = ''; return; }
  const expires = q.expiresAt ? new Date(q.expiresAt) : null;
  host.innerHTML = `<div class="sb-slip-row sb-quote-ok"><span>Quote server terkunci</span><b>${Number(q.totalOdds).toFixed(2)}</b></div>
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
    renderBetslip();
    renderAll();
  }));
  root.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const input = el('sb-stake');
    if (input) { input.value = b.getAttribute('data-quick'); onStakeChange(); }
  }));
  const stakeInput = el('sb-stake');
  if (stakeInput) stakeInput.addEventListener('input', onStakeChange);
  const place = el('btn-place-bet');
  if (place) place.addEventListener('click', placeBet);
  const clear = el('btn-clear-slip');
  if (clear) clear.addEventListener('click', () => { selected.clear(); quote = null; renderBetslip(); renderAll(); });
}

function onStakeChange() {
  const stake = betslipStake(); // juga menyimpan ke lastStake
  const est = el('slip-est');
  if (est) est.textContent = formatRupiah(Math.floor(stake * totalOdds()));
  const pot = el('slip-potential');
  if (pot) pot.textContent = formatRupiah(Math.floor(stake * totalOdds()));
  const place = el('btn-place-bet');
  const over = stake > betslipBalance();
  if (place && !placing) place.disabled = over;
  quote = null;
  const host = el('slip-quote');
  if (host) host.innerHTML = '';
  clearTimeout(stakeTimer);
  stakeTimer = setTimeout(() => { if (selected.size && stake >= bettingConfig.minStake) requestQuote(); }, 500);
}

async function placeBet() {
  if (!auth.isLoggedIn()) {
    showToast('Silakan login terlebih dahulu untuk memasang taruhan.', 'warning');
    setTimeout(() => { window.location.href = '/index.html?msg=login_required'; }, 1200);
    return;
  }
  if (placing || !selected.size) return;
  const stake = betslipStake() || lastStake || bettingConfig.minStake;
  if (stake < bettingConfig.minStake) { showToast(`Minimal taruhan ${formatRupiah(bettingConfig.minStake)}.`, 'warning'); return; }
  if (stake > bettingConfig.maxStake) { showToast(`Maksimal taruhan ${formatRupiah(bettingConfig.maxStake)}.`, 'warning'); return; }
  if (stake > betslipBalance()) { showToast('Stake melebihi saldo. Silakan deposit dulu.', 'warning'); return; }
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
      syncSelectedOdds(feed.events);
      renderBetslip();
      renderAll();
    } else if (code === 'SPORTSBOOK_QUOTE_EXPIRED' || code === 'SPORTSBOOK_QUOTE_INVALID') {
      showToast('Quote kedaluwarsa. Meminta harga terbaru…', 'warning');
      quote = null;
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
    if (window.innerWidth > 1024 && slipSheetOpen) {
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
