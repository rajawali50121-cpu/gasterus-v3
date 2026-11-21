/**
 * Gasterus v3 — Casino Lobby (via backend proxy, tanpa RapidAPI key di frontend).
 * Backend: GET /api/member/casino/providers, /api/member/casino/games?provider=PGSOFT, /api/member/casino/status
 */
import { api } from './api.js';

const state = { providers: [], categories: [], filter: 'ALL', q: '', games: [], gamesProvider: '', launchMode: 'DEMO' };
const slotsView = new URLSearchParams(window.location.search).get('view') === 'slots';

function el(id) { return document.getElementById(id); }

function categoryLabel(c) {
  return { ALL: 'Semua', SLOTS: 'Slots', LIVE_CASINO: 'Live Casino', SPORTSBOOK: 'Sportsbook', CRASH_ARCADE: 'Crash/Arcade', OTHER: 'Lainnya' }[c] || c;
}

function renderFilters(categories) {
  const wrap = el('casino-filters');
  if (!wrap) return;
  const cats = ['ALL', ...categories];
  wrap.innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'casino-chip' + (state.filter === c ? ' active' : '');
    b.textContent = categoryLabel(c);
    b.onclick = () => { state.filter = c; renderFilters(state.categories); renderProviders(); };
    wrap.appendChild(b);
  }
}

function showProviderList() {
  const url = new URL(window.location.href);
  url.searchParams.delete('provider');
  window.location.assign(url.href);
}

function restoreProviderListView() {
  for (const id of ['casino-toolbar', 'casino-filters', 'casino-grid']) {
    const node = el(id);
    if (node) node.hidden = false;
  }
  const games = el('casino-games');
  if (games) games.hidden = true;
}

function showProviderGames() {
  for (const id of ['casino-toolbar', 'casino-filters', 'casino-grid']) {
    const node = el(id);
    if (node) node.hidden = true;
  }
  const games = el('casino-games');
  if (games) games.hidden = false;
}

function renderProviders() {
  const grid = el('casino-grid');
  const count = el('casino-count');
  if (!grid) return;
  const q = state.q.trim().toLowerCase();
  const list = state.providers.filter((p) =>
    (state.filter === 'ALL' || p.category === state.filter) &&
    (!q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)));
  if (count) count.textContent = list.length + ' provider';
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<div class="casino-empty">Tidak ada provider yang cocok.</div>';
    return;
  }
  for (const p of list.slice(0, 300)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'casino-card';
    card.innerHTML = '<span class="casino-code"></span><span class="casino-cat"></span>';
    card.querySelector('.casino-code').textContent = p.code;
    card.querySelector('.casino-cat').textContent = categoryLabel(p.category);
    card.title = p.name;
    card.onclick = () => {
      const url = new URL(window.location.href);
      url.searchParams.set('provider', p.code);
      window.location.assign(url.href);
    };
    grid.appendChild(card);
  }
}

async function loadGames(provider) {
  state.gamesProvider = provider;
  showProviderGames();
  const box = el('casino-games');
  if (box) {
    box.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'casino-empty';
    loading.textContent = 'Memuat game ' + provider + '...';
    box.appendChild(loading);
  }
  try {
    const res = await api.get('/api/member/casino/games?provider=' + encodeURIComponent(provider));
    const payload = res?.data ?? res;
    const games = Array.isArray(payload?.games) ? payload.games
      : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload) ? payload : [];
    state.games = games;
    renderGames();
  } catch (e) {
    if (box) {
      box.innerHTML = '';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'casino-chip';
      back.textContent = '← Kembali ke Provider';
      back.addEventListener('click', showProviderList);
      box.appendChild(back);
      const empty = document.createElement('div');
      empty.className = 'casino-empty';
      const detail = e?.data?.error?.message || e?.message || 'error';
      const code = e?.data?.error?.code || e?.code || '';
      empty.textContent = 'Gagal memuat game ' + provider + ': ' + detail + (code ? ' [' + code + ']' : '');
      box.appendChild(empty);
    }
  }
}

async function launchGame(game, card) {
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    const box = el('casino-games');
    if (box) {
      const notice = document.createElement('div');
      notice.className = 'casino-empty';
      notice.textContent = 'Izinkan popup untuk membuka game.';
      box.prepend(notice);
    }
    return;
  }
  popup.opener = null;
  card.disabled = true;
  try {
    const res = await api.post('/api/member/casino/launch', {
      gameId: game.id,
      platform: window.matchMedia('(pointer: coarse)').matches ? 2 : 1
    });
    const payload = res?.data ?? res;
    const launchUrl = new URL(String(payload?.gameUrl || ''));
    if (launchUrl.protocol !== 'https:') throw new Error('URL game tidak aman.');
    popup.location.replace(launchUrl.href);
  } catch (error) {
    popup.close();
    const box = el('casino-games');
    if (box) {
      const notice = document.createElement('div');
      notice.className = 'casino-empty';
      notice.textContent = 'Gagal membuka game: ' + (error?.data?.error?.message || error?.message || 'error');
      box.prepend(notice);
    }
  } finally {
    card.disabled = false;
  }
}

function renderGames() {
  const box = el('casino-games');
  if (!box) return;
  box.innerHTML = '';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'casino-chip';
  back.textContent = '← Kembali ke Provider';
  back.addEventListener('click', showProviderList);
  box.appendChild(back);
  if (!state.games.length) {
    const empty = document.createElement('div');
    empty.className = 'casino-empty';
    empty.textContent = 'Belum ada permainan yang tersedia dari provider ' + state.gamesProvider + '.';
    box.appendChild(empty);
    return;
  }
  const title = document.createElement('h3');
  title.textContent = state.gamesProvider + ' — Pilih Permainan (' + state.games.length + ')';
  box.appendChild(title);
  if (!slotsView) {
    const modeNote = document.createElement('p');
    modeNote.className = 'casino-status';
    modeNote.textContent = state.launchMode === 'REAL'
      ? 'SALDO GASTERUS - transaksi diproses melalui callback Betnex.'
      : state.launchMode === 'REAL_NOT_CONFIGURED'
        ? 'Mode saldo Gasterus belum dikonfigurasi; game belum dapat diluncurkan.'
        : 'MODE DEMO - saldo member tidak digunakan.';
    box.appendChild(modeNote);
  }
  const grid = document.createElement('div');
  grid.className = 'casino-grid';
  for (const g of state.games.slice(0, 200)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'casino-card';
    card.disabled = !g.id || state.launchMode === 'REAL_NOT_CONFIGURED';
    card.title = slotsView ? 'Buka permainan' : (state.launchMode === 'REAL' ? 'Main dengan saldo Gasterus' : 'Main demo - saldo member tidak digunakan');
    if (g.img) {
      const img = document.createElement('img');
      img.src = g.img;
      img.alt = g.name;
      img.loading = 'lazy';
      img.className = 'casino-thumb';
      card.appendChild(img);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'casino-code';
    nameEl.textContent = String(g.name || 'Game').slice(0, 60);
    card.appendChild(nameEl);
    if (g.type) {
      const typeEl = document.createElement('span');
      typeEl.className = 'casino-cat';
      typeEl.textContent = (slotsView ? '' : (state.launchMode === 'REAL' ? 'GASTERUS - ' : 'DEMO - ')) + String(g.type).slice(0, 20);
      card.appendChild(typeEl);
    }
    if (g.id) card.addEventListener('click', () => launchGame(g, card));
    grid.appendChild(card);
  }
  box.appendChild(grid);
}

async function init() {
  const statusBox = el('casino-status');
  const title = el('casino-title');
  const description = el('casino-description');
  const filters = el('casino-filters');
  const selectedProvider = new URLSearchParams(window.location.search).get('provider');
  if (selectedProvider) {
    showProviderGames();
    if (title) title.textContent = selectedProvider;
    if (description) description.textContent = 'Memuat permainan dari provider ' + selectedProvider + '...';
    if (statusBox) statusBox.textContent = '';
  }
  if (slotsView) {
    document.title = 'Slot - GASTERUS V3';
    if (title) title.textContent = 'Lobby Slot';
    if (description) description.textContent = 'Pilih provider slot untuk melihat grid permainan slot.';
    if (filters) filters.hidden = true;
  }
  try {
    const statusResponse = await api.get('/api/member/casino/status');
    const wallet = (statusResponse?.data ?? statusResponse)?.wallet;
    if (['DEMO', 'REAL', 'REAL_NOT_CONFIGURED'].includes(wallet?.launchMode)) state.launchMode = wallet.launchMode;
  } catch {}
  try {
    const res = await api.get('/api/member/casino/providers');
    const payload = res?.data ?? res;
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    state.providers = providers.filter((provider) => slotsView
      ? provider.category === 'SLOTS'
      : provider.category !== 'SLOTS');
    state.categories = [...new Set(state.providers.map((provider) => provider.category))].sort();
    renderFilters(state.categories);
    renderProviders();
    if (selectedProvider) {
      const match = state.providers.find((provider) => provider.code.toLowerCase() === selectedProvider.toLowerCase());
      if (match) {
        if (title) title.textContent = match.name || match.code;
        if (description) description.textContent = 'Pilih permainan dari provider ' + (match.name || match.code) + '.';
        if (statusBox) statusBox.textContent = '';
        await loadGames(match.code);
      } else {
        restoreProviderListView();
      }
    }
    if (statusBox) statusBox.textContent = 'Terhubung: ' + state.providers.length + (slotsView ? ' provider Slot' : ' provider Casino') + (state.launchMode === 'REAL_NOT_CONFIGURED' ? ' · saldo game belum dikonfigurasi' : '');
  } catch (e) {
    if (statusBox) statusBox.textContent = (slotsView ? 'Slot' : 'Casino') + ' belum tersedia: ' + (e.message || 'error');
    renderProviders();
  }
  const search = el('casino-search');
  if (search) search.addEventListener('input', () => { state.q = search.value; renderProviders(); });
}

document.addEventListener('DOMContentLoaded', init);
