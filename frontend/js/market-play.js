/**
 * Gasterus v3 — Market Betting / TOTO Logic
 */

import api from './api.js';
import auth from './auth.js';
import { formatNumber, formatRupiah, getTimeRemaining, showToast, escapeHtml } from './utils.js';

// Generate idempotency key yang konsisten dan unik per kiriman
function generateIdempotencyKey() {
  return `mp_${Date.now()}_${Math.random().toString(36).substring(2, 12)}_${Math.random().toString(36).substring(2, 8)}`;
}

let currentMarket = null;
let currentMarketConfig = null;
let betRows = [];
let rowIdCounter = 1;

// Pasar hanya boleh dianggap bisa dipertaruhkan bila backend memang mengirim
// bettingStatus OPEN, periode terisi, dan waktu tutup masih di masa depan.
// Tanpa ketiga syarat itu, pasar ditampilkan tertutup. Tidak ada nilai
// periode maupun waktu tutup yang dibuat di sisi klien.
function isMarketBettable(market, now = Date.now()) {
  if (!market || typeof market !== 'object') return false;
  if (market.available === false) return false;
  if (String(market.bettingStatus || '').toUpperCase() !== 'OPEN') return false;
  if (!String(market.period || '').trim()) return false;
  const closeMs = Date.parse(String(market.closeAt || ''));
  return Number.isFinite(closeMs) && closeMs > now;
}

function isMarketClosed(market) {
  const status = String(market?.bettingStatus || '').toUpperCase();
  return status === 'CLOSED' || status === 'SUSPENDED';
}

// Notice di bawah header bet slip. Tampil hanya ketika belum ada pasaran yang
// dipilih (halaman dibuka tanpa ?code=) supaya member tahu harus lewat tombol
// "BET DISINI" dulu, dan bukan mengira daftar game-nya kosong.
function setNoMarketNotice(show) {
  const el = document.getElementById('bet-no-market-notice');
  if (el) el.hidden = !show;
}

export async function initMarketPlay() {
  if (!auth.isLoggedIn()) {
    window.location.href = '/index.html';
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const marketCode = urlParams.get('code') || urlParams.get('market');
  if (!marketCode) {
    currentMarketConfig = null;
    currentMarket = {
      name: 'Pasaran tidak dipilih',
      available: false,
      bettingStatus: 'UNAVAILABLE',
      period: null,
      closeAt: null
    };
    updateMarketHeaderUI(currentMarket);
    setNoMarketNotice(true);
    setBettingControlsDisabled(true);
    startCountdown();
    return;
  }

  const loaded = await loadMarketInfo(marketCode);
  if (loaded && !isMarketBettable(currentMarket)) {
    // Config-nya terbaca tapi pasar memang belum bisa dipertaruhkan. Member
    // deserves alasan yang jelas, bukan "tidak tersedia" yang ambigu.
    const labels = {
      BETTING_NOT_OPEN: 'Pasaran ini sedang tutup. Silakan pilih pasaran lain.',
      RESULT_AUTHORITY_NOT_READY: 'Hasil pasar belum terverifikasi, betting belum dibuka.',
      BETTING_PERIOD_MISSING: 'Periode betting belum ditentukan, betting belum dibuka.',
      BETTING_CLOSED: 'Waktu betting pasar ini sudah lewat.',
      MARKET_SUSPENDED: 'Pasaran ini sedang ditahan operator.'
    };
    const reason = String(currentMarketConfig?.readinessReason || '');
    setMarketNotice(labels[reason] || 'Pasaran ini belum menerima betting. Silakan pilih pasaran lain.');
  }
  initBetRows();
  setupEventListeners();
  setBettingControlsDisabled(!isMarketBettable(currentMarket));
  startCountdown();
}

// Fail-closed: bila API tidak dapat diakses, pasar ditampilkan sebagai tidak
// tersedia. Angka periode, waktu tutup, dan aturan pembayaran tidak pernah
// dibuat di klien karena semuanya akan disalahartikan member sebagai data
// betting yang sah.
//
// 401 bukan "pasaran tutup": itu sesi member tidak sah, biasanya token lama masih
// tersimpan di browser. Dulu error ini ikut ditelan dan member melihat "pasaran
// tidak tersedia" untuk SEMUA pasar padahal masalahnya login. Sekarang token basi
// dibersihkan dan member dikembalikan ke halaman masuk.
async function loadMarketInfo(code) {
  try {
    const res = await api.get(`/member/betting-markets/${encodeURIComponent(code)}`);
    if (!res || typeof res !== 'object' || Array.isArray(res)) {
      throw new Error('Konfigurasi pasar tidak dapat dibaca');
    }
    // Backend membungkus jawaban sukses dalam { data: ... }. Membaca respons
    // mentah membuat period, bettingStatus, dan closeAt selalu undefined, sehingga
    // "Periode Aktif" kosong dan pasar tampil tutup padahal backend melaporkan OPEN.
    const config = res?.data && typeof res.data === 'object' ? res.data : res;
    currentMarketConfig = config;
    currentMarket = config;
    updateMarketHeaderUI(config);
    setNoMarketNotice(false);
    return true;
  } catch (err) {
    const status = Number(err?.status || 0);
    const message = String(err?.message || '');
    const authFailed = status === 401 || /AUTH_REQUIRED|Sesi tidak tersedia/i.test(message);
    console.warn(authFailed
      ? 'Sesi member tidak valid; pasaaran tidak dimuat dan token basi dibersihkan.'
      : 'Data pasar tidak dapat dimuat; pasar ditampilkan tertutup.', err);
    currentMarketConfig = null;
    currentMarket = {
      name: authFailed ? 'Sesi berakhir — silakan masuk kembali' : 'Pasaran sedang tidak tersedia',
      code: String(code || '').toUpperCase(),
      available: false,
      bettingStatus: 'UNAVAILABLE',
      period: null,
      closeAt: null
    };
    updateMarketHeaderUI(currentMarket);
    setNoMarketNotice(true);
    if (authFailed) {
      setBettingControlsDisabled(true);
      setMarketNotice(authFailed
        ? 'Sesi Anda sudah berakhir. Silakan masuk kembali untuk memasang betting pada pasaran ini.'
        : 'Pasaran ini sedang tidak menerima betting. Silakan pilih pasaran lain.');
      auth.logout(false); // bersihkan token basi lalu kembali ke beranda
    }
    return false;
  }
}

function setMarketNotice(message) {
  const el = document.getElementById('bet-no-market-notice');
  if (!el) return;
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.hidden = false;
}

function setBettingControlsDisabled(disabled) {
  // Slip controls di luar #bet-rows-container (tambah baris, generator quick bet,
  // tombol submit) juga harus ikut mati saat pasaran tertutup.
  document.querySelectorAll('#bet-rows-container input, #bet-rows-container select, #bet-rows-container button, #btn-add-row, #quick-bet-mode, #btn-quick-bet, #btn-submit-bet, #btn-apply-bbfs, #bbfs-digits, #bbfs-panel input, #btn-apply-all-stake, #pay4d-quick-stake, #btn-add-1-row, #btn-add-5-rows, #btn-add-10-rows, #btn-clear-all-rows, #btn-add-5-rows-bottom, #btn-clear-rows-bottom').forEach(control => {
    control.disabled = disabled;
  });
  const addRowBtn = document.getElementById('btn-add-row');
  if (addRowBtn) addRowBtn.disabled = disabled;
  const submitBtn = document.getElementById('btn-submit-bet');
  if (submitBtn) {
    submitBtn.disabled = disabled;
    submitBtn.textContent = disabled ? 'Pasaran tidak tersedia' : 'Konfirmasi & Pasang';
  }
}

function updateMarketHeaderUI(m) {
  const titleEl = document.getElementById('market-title');
  const periodEl = document.getElementById('market-period');
  const statusEl = document.getElementById('market-status');
  const timerEl = document.getElementById('market-countdown');
  const unavailable = m?.available === false || String(m?.bettingStatus || '').toUpperCase() === 'UNAVAILABLE';
  const open = isMarketBettable(m);

  if (titleEl) titleEl.textContent = unavailable ? 'Pasaran sedang tidak tersedia' : (m?.name || '-');
  if (periodEl) periodEl.textContent = m?.period ? `#${m.period}` : '-';
  if (statusEl) {
    statusEl.textContent = unavailable ? 'TIDAK TERSEDIA' : (open ? 'BUKA' : (isMarketClosed(m) ? 'TUTUP' : 'TIDAK TERSEDIA'));
    statusEl.className = open ? 'badge badge-success' : 'badge badge-danger';
  }
  if (timerEl && (unavailable || !m?.closeAt)) timerEl.textContent = 'TIDAK TERSEDIA';
}

function startCountdown() {
  setInterval(() => {
    const timerEl = document.getElementById('market-countdown');
    if (!timerEl) return;
    if (!isMarketBettable(currentMarket)) {
      timerEl.textContent = 'TIDAK TERSEDIA';
      return;
    }
    const t = getTimeRemaining(currentMarket.closeAt);
    if (t.expired) {
      timerEl.textContent = '00:00:00 (Tutup)';
      // Saat waktu tutup terlampaui, form wager langsung dimatikan agar member
      // tidak bisa mengirim tiket pada pasar yang sudah tertutup.
      setBettingControlsDisabled(true);
      if (currentMarket) currentMarket.bettingStatus = 'CLOSED';
      updateMarketHeaderUI(currentMarket);
    } else {
      const hh = String(t.hours).padStart(2, '0');
      const mm = String(t.minutes).padStart(2, '0');
      const ss = String(t.seconds).padStart(2, '0');
      timerEl.textContent = `${hh}:${mm}:${ss}`;
    }
  }, 1000);
}

// Katalog game diambil dari config pasar yang dikirim backend, bukan dari daftar
// hardcode di klien. Backend hanya mengirim game yang enabled + engineReady, jadi
// operator cukup membuka/tutup game lewat lottery-control tanpa menyentuh frontend.
const AUTO_DIGIT_GAMES = [['STRAIGHT_4D', 4], ['STRAIGHT_3D', 3], ['STRAIGHT_2D', 2]];

function enabledGames() {
  const games = Array.isArray(currentMarketConfig?.games) ? currentMarketConfig.games : [];
  return games.filter(g => g && g.enabled && g.engineReady && g.uiMode && g.uiMode !== 'unsupported');
}

function gameByCode(code) {
  return enabledGames().find(g => g.code === code) || null;
}

function minStake() {
  const n = Number(currentMarketConfig?.minStake);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function autoGameCode(digits) {
  const hit = AUTO_DIGIT_GAMES.find(([, length]) => length === digits);
  return hit ? hit[0] : '';
}

// Game bolak-balik (urut bebas) menyimpan digit terurut supaya "21" dan "12"
// dianggap satu pilihan sama, persis seperti normalizeLotterySelection di backend.
function normalizeForGame(game, value) {
  const raw = String(value ?? '').trim();
  if (!game) return raw;
  if (game.uiMode === 'jitu') {
    const [position, digit] = raw.split(':');
    return position && digit ? `${position}:${digit}` : '';
  }
  if (game.uiMode === 'digits' || game.uiMode === 'shio') {
    const digits = raw.replace(/\D/g, '');
    return game.unordered ? digits.split('').sort().join('') : digits;
  }
  return raw.toUpperCase();
}

function isSelectionComplete(game, value) {
  const selection = String(value || '');
  if (!selection) return false;
  if (!game) return /^\d{2,4}$/.test(selection);
  if (game.uiMode === 'digits') return new RegExp(`^\\d{${game.inputDigits}}$`).test(selection);
  if (game.uiMode === 'shio') return /^(?:[1-9]|1[0-2])$/.test(selection);
  if (game.uiMode === 'jitu') return /^[^:]+:[0-9]$/.test(selection);
  if (game.uiMode === 'choice') return (game.choices || []).includes(selection);
  if (game.uiMode === 'positionChoice') {
    const [position, choice] = selection.split(':');
    return (game.positions || []).includes(position) && (game.choices || []).includes(choice);
  }
  if (game.uiMode === 'combination') {
    const [position, size, parity] = selection.split(':');
    return (game.positions || []).includes(position) && (game.sizes || []).includes(size) && (game.parities || []).includes(parity);
  }
  return false;
}

// Baris dengan gameCode AUTO memakai game yang ditebak dari jumlah digit, sama
// seperti yang dikirim ke backend.
function resolveRowGame(r) {
  if (r.gameCode && r.gameCode !== 'AUTO') return gameByCode(r.gameCode);
  return gameByCode(autoGameCode(String(r.selection || '').length));
}

// Kode game yang benar-benar dikirim ke backend. Selalu konkret: kalau config pasar
// belum memuat katalog game (mis. backend versi lama), baris tetap memakai game
// straight berdasarkan jumlah digit daripada mengirim literal "AUTO" yang pasti ditolak.
function rowGameCode(r) {
  return resolveRowGame(r)?.code || autoGameCode(String(r.selection || '').length) || 'STRAIGHT_4D';
}

// Generator quick bet. Semua angka dibuat di MEMBER satu generator, bukan di server,
// sehingga tidak pernah mengarang pilihan yang tidak dipinta member.
const QUICK_BET_SETS = Object.freeze({
  COLOK_2D_ALL: {
    gameCode: 'COLOK_2D', label: 'Colok 2D',
    values: () => { const out = []; for (let a = 0; a <= 9; a += 1) for (let b = a + 1; b <= 9; b += 1) out.push(`${a}${b}`); return out; }
  },
  COLOK_BEBAS_ALL: { gameCode: 'COLOK_BEBAS', label: 'Colok Bebas', values: () => Array.from({ length: 10 }, (_, i) => String(i)) },
  '4D_KEMBAR': { gameCode: 'STRAIGHT_4D', label: '4D Kembar', values: () => Array.from({ length: 10 }, (_, i) => String(i).repeat(4)) },
  '3D_KEMBAR': { gameCode: 'STRAIGHT_3D', label: '3D Kembar', values: () => Array.from({ length: 10 }, (_, i) => String(i).repeat(3)) },
  '2D_00_49': { gameCode: 'STRAIGHT_2D', label: '2D 00-49', values: () => Array.from({ length: 50 }, (_, i) => String(i).padStart(2, '0')) },
  '2D_50_99': { gameCode: 'STRAIGHT_2D', label: '2D 50-99', values: () => Array.from({ length: 50 }, (_, i) => String(i + 50).padStart(2, '0')) }
});

function applyQuickBet() {
  const mode = document.getElementById('quick-bet-mode')?.value;
  const set = QUICK_BET_SETS[mode];
  if (!set) return;
  const game = gameByCode(set.gameCode);
  if (!game) {
    showToast(`${set.label} belum dibuka untuk pasaran ini.`, 'danger');
    return;
  }
  const limit = Math.max(1, Math.min(Number(currentMarketConfig?.maxRows) || 50, 100));
  const stake = minStake();
  const values = set.values().slice(0, limit).map(v => normalizeForGame(game, v));
  betRows = values.map(selection => ({ id: rowIdCounter++, selection, stake, gameCode: set.gameCode }));
  renderRows();
  showToast(`${betRows.length} baris ${set.label} terisi. Periksa nominal lalu konfirmasi.`, 'success');
}

function syncMinStakeLabel() {
  const el = document.getElementById('bet-min-stake');
  if (el) el.textContent = `Min. bet Rp ${formatNumber(minStake())} / baris`;
}

function initBetRows() {
  betRows = [];
  for (let i = 0; i < 5; i++) {
    addRow();
  }
}

function addRow() {
  const rowId = rowIdCounter++;
  betRows.push({
    id: rowId,
    selection: '',
    stake: minStake() * 10,
    gameCode: 'AUTO'
  });
  renderRows();
}

function removeRow(id) {
  if (betRows.length <= 1) return;
  betRows = betRows.filter(r => r.id !== id);
  renderRows();
}

function gameOptionList(selected) {
  const options = [`<option value="AUTO"${selected === 'AUTO' ? ' selected' : ''}>Auto Detect</option>`];
  for (const g of enabledGames()) {
    const disc = Number(g.discountPercent || 0);
    const mult = Number(g.payoutMultiplier || 0);
    const suffix = `${disc ? `Disc ${disc}%` : ''}${mult ? `x${mult}` : ''}`.trim();
    options.push(`<option value="${escapeHtml(g.code)}"${g.code === selected ? ' selected' : ''}>${escapeHtml(g.label)}${suffix ? ` (${suffix})` : ''}</option>`);
  }
  return options.join('');
}

function rowField(r) {
  const isDigitGame = !r.gameCode || r.gameCode === 'AUTO' || ['STRAIGHT_4D', 'STRAIGHT_3D', 'STRAIGHT_2D'].includes(r.gameCode);
  const game = gameByCode(r.gameCode);
  if (isDigitGame || !game || game.uiMode === 'digits') {
    return `<input type="text" class="form-control bet-selection pay4d-number-input" placeholder="4D / 3D / 2D" maxlength="4" inputmode="numeric" autocomplete="off" spellcheck="false" value="${escapeHtml(r.selection || '')}">`;
  }
  if (game.uiMode === 'shio') {
    return `<input type="text" class="form-control bet-selection pay4d-number-input" placeholder="Shio 1-12" maxlength="2" inputmode="numeric" value="${escapeHtml(r.selection || '')}" style="text-align:center; font-weight:700; letter-spacing:2px;">`;
  }
  const parts = String(r.selection || '').split(':');
  const chip = (key, values, current) => `<select class="form-control bet-opt" data-key="${key}" style="max-width:104px;">${(values || []).map(v => `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`;
  let inner = '';
  if (Array.isArray(game.positions) && game.uiMode !== 'choice') inner += chip(0, game.positions, parts[0] || game.positions[0]);
  if (game.uiMode === 'choice') inner += chip(0, game.choices, parts[0] || (game.choices || [])[0]);
  if (game.uiMode === 'positionChoice') inner += chip(1, game.choices, parts[1] || (game.choices || [])[0]);
  if (game.uiMode === 'combination') {
    inner += chip(1, game.sizes, parts[1] || (game.sizes || [])[0]);
    inner += chip(2, game.parities, parts[2] || (game.parities || [])[0]);
  }
  if (game.uiMode === 'jitu') inner += `<input type="text" class="form-control bet-opt-digit pay4d-number-input" data-key="1" maxlength="1" inputmode="numeric" placeholder="digit" value="${escapeHtml(parts[1] || '')}" style="max-width:68px; text-align:center;">`;
  return `<span class="bet-extras" style="display:flex; gap:6px; align-items:center; flex:1; min-width:0;">${inner}</span>`;
}

function renderRows() {
  const container = document.getElementById('bet-rows-container');
  if (!container) return;
  const stakeMin = minStake();

  container.innerHTML = betRows.map((r, idx) => {
    const game = resolveRowGame(r);
    const disc = Number(game?.discountPercent || 0);
    const isComplete = isSelectionComplete(game, r.selection);
    const netStake = isComplete && r.stake >= stakeMin ? Math.round(r.stake * (1 - disc / 100)) : 0;
    const netHtml = isComplete && r.stake >= stakeMin
      ? `<span class="net-amount">Rp ${formatNumber(netStake)}</span>${disc > 0 ? ` <span class="net-disc-tag">-${disc}%</span>` : ''}`
      : `<span class="net-placeholder">-</span>`;

    return `
      <div class="bet-row pay4d-bet-row" data-id="${Number(r.id)}">
        <div class="cell-no">
          <span class="row-no-badge">#${idx + 1}</span>
        </div>
        <div class="cell-selection">
          <span class="cell-mobile-title">Nomor</span>
          ${rowField(r)}
        </div>
        <div class="cell-game">
          <span class="cell-mobile-title">Permainan</span>
          <select class="form-control bet-game">${gameOptionList(r.gameCode)}</select>
        </div>
        <div class="cell-stake">
          <span class="cell-mobile-title">Taruhan (Rp)</span>
          <input type="number" class="form-control bet-stake" placeholder="Nominal" step="100" min="${stakeMin}" value="${r.stake}">
        </div>
        <div class="cell-net">
          <span class="cell-mobile-title">Bayar Net</span>
          <div class="row-net-badge ${isComplete && r.stake >= stakeMin ? 'active' : ''}">${netHtml}</div>
        </div>
        <div class="cell-remove">
          <button type="button" class="btn-remove-row" onclick="window.removeBetRow(${r.id})" title="Hapus baris">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  bindRowInputs();
  syncMinStakeLabel();
  syncGameHint();
  calculateTotals();
}

function updateRowNetBadge(rowEl, item) {
  const badgeEl = rowEl.querySelector('.row-net-badge');
  if (!badgeEl) return;
  const game = resolveRowGame(item);
  const stakeMin = minStake();
  const isComplete = isSelectionComplete(game, item.selection);
  if (isComplete && item.stake >= stakeMin) {
    const disc = Number(game?.discountPercent || 0);
    const netStake = Math.round(item.stake * (1 - disc / 100));
    badgeEl.innerHTML = `<span class="net-amount">Rp ${formatNumber(netStake)}</span>${disc > 0 ? ` <span class="net-disc-tag">-${disc}%</span>` : ''}`;
    badgeEl.classList.add('active');
  } else {
    badgeEl.innerHTML = `<span class="net-placeholder">-</span>`;
    badgeEl.classList.remove('active');
  }
}

function bindRowInputs() {
  document.querySelectorAll('.bet-row.pay4d-bet-row').forEach(rowEl => {
    const id = Number(rowEl.getAttribute('data-id'));
    const item = betRows.find(r => r.id === id);
    if (!item) return;

    const selectionInput = rowEl.querySelector('.bet-selection');
    const gameSelect = rowEl.querySelector('.bet-game');
    const stakeInput = rowEl.querySelector('.bet-stake');

    const readExtras = () => {
      const parts = [];
      rowEl.querySelectorAll('.bet-opt').forEach(sel => {
        parts[Number(sel.getAttribute('data-key'))] = sel.value;
      });
      const digit = rowEl.querySelector('.bet-opt-digit');
      if (digit) parts[Number(digit.getAttribute('data-key'))] = digit.value.replace(/\D/g, '');
      const game = gameByCode(item.gameCode);
      item.selection = game ? normalizeForGame(game, parts.filter(v => v !== undefined && v !== '').join(':')) : '';
      calculateTotals();
      updateRowNetBadge(rowEl, item);
    };

    if (selectionInput) {
      selectionInput.addEventListener('input', (e) => {
        const cleanVal = e.target.value.replace(/\D/g, '').slice(0, 4);
        item.selection = cleanVal;
        e.target.value = cleanVal;

        const isDigitGame = !item.isManualGame || ['AUTO', 'STRAIGHT_4D', 'STRAIGHT_3D', 'STRAIGHT_2D'].includes(item.gameCode);

        if (isDigitGame) {
          if (cleanVal.length === 4) {
            item.gameCode = 'STRAIGHT_4D';
          } else if (cleanVal.length === 3) {
            item.gameCode = 'STRAIGHT_3D';
          } else if (cleanVal.length === 2) {
            item.gameCode = 'STRAIGHT_2D';
          } else {
            item.gameCode = 'AUTO';
          }
          gameSelect.value = item.gameCode;
          item.isManualGame = false;
        } else {
          const game = gameByCode(item.gameCode);
          item.selection = normalizeForGame(game, cleanVal);
          e.target.value = item.selection;
        }

        calculateTotals();
        updateRowNetBadge(rowEl, item);
        syncGameHint();
      });
    }

    rowEl.querySelectorAll('.bet-opt').forEach(sel => sel.addEventListener('change', readExtras));
    const extraDigit = rowEl.querySelector('.bet-opt-digit');
    if (extraDigit) {
      extraDigit.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '');
        readExtras();
      });
    }
    if (!selectionInput) readExtras();

    gameSelect.addEventListener('change', (e) => {
      item.gameCode = e.target.value;
      if (['AUTO', 'STRAIGHT_4D', 'STRAIGHT_3D', 'STRAIGHT_2D'].includes(item.gameCode)) {
        item.isManualGame = false;
        if (item.gameCode === 'AUTO' && item.selection) {
          if (item.selection.length === 4) item.gameCode = 'STRAIGHT_4D';
          else if (item.selection.length === 3) item.gameCode = 'STRAIGHT_3D';
          else if (item.selection.length === 2) item.gameCode = 'STRAIGHT_2D';
          gameSelect.value = item.gameCode;
        }
      } else {
        item.isManualGame = true;
      }
      renderRows();
    });

    if (stakeInput) {
      stakeInput.addEventListener('input', (e) => {
        item.stake = Math.max(0, parseInt(e.target.value, 10) || 0);
        calculateTotals();
        updateRowNetBadge(rowEl, item);
      });
    }
  });
}

function applyMassStake() {
  const input = document.getElementById('pay4d-quick-stake');
  const stakeMin = minStake();
  const val = Math.max(stakeMin, parseInt(input?.value, 10) || stakeMin);
  betRows.forEach(r => { r.stake = val; });
  renderRows();
  showToast(`Nominal Rp ${formatNumber(val)} diterapkan ke semua baris.`, 'success');
}

function addMultipleRows(count) {
  const limit = Math.max(1, Math.min(Number(currentMarketConfig?.maxRows) || 100, 100));
  if (betRows.length >= limit) {
    showToast(`Maksimal ${limit} baris taruhan.`, 'danger');
    return;
  }
  const toAdd = Math.min(count, limit - betRows.length);
  const stake = parseInt(document.getElementById('pay4d-quick-stake')?.value, 10) || (minStake() * 10);
  for (let i = 0; i < toAdd; i++) {
    betRows.push({
      id: rowIdCounter++,
      selection: '',
      stake,
      gameCode: 'AUTO'
    });
  }
  renderRows();
  showToast(`+${toAdd} baris ditambahkan.`, 'success');
}

function clearBetRows() {
  const stake = parseInt(document.getElementById('pay4d-quick-stake')?.value, 10) || (minStake() * 10);
  betRows = [];
  for (let i = 0; i < 5; i++) {
    betRows.push({
      id: rowIdCounter++,
      selection: '',
      stake,
      gameCode: 'AUTO'
    });
  }
  renderRows();
  showToast('Formulir taruhan dibersihkan.', 'success');
}

function calculateTotals() {
  let totalGross = 0;
  let totalDiscount = 0;
  let validItemsCount = 0;
  const stakeMin = minStake();

  betRows.forEach(r => {
    const game = resolveRowGame(r);
    if (!isSelectionComplete(game, r.selection)) return;
    if (!(r.stake >= stakeMin)) return;
    validItemsCount++;
    totalGross += r.stake;
    // Diskon ikut game yang benar-benar dipilih, bukan lagi ditebak dari jumlah
    // digit — supaya total di layar sama dengan yang dihitung backend.
    const disc = Number(game?.discountPercent || 0) / 100;
    totalDiscount += Math.round(r.stake * disc);
  });

  const totalNet = totalGross - totalDiscount;

  const countEl = document.getElementById('betslip-count');
  const grossEl = document.getElementById('betslip-gross');
  const discEl = document.getElementById('betslip-discount');
  const totalEl = document.getElementById('betslip-total');

  if (countEl) countEl.textContent = `${validItemsCount} Baris`;
  if (grossEl) grossEl.textContent = formatRupiah(totalGross);
  if (discEl) discEl.textContent = formatRupiah(totalDiscount);
  if (totalEl) totalEl.textContent = formatRupiah(totalNet);

  return { totalGross, totalDiscount, totalNet, validItemsCount };
}

// Tempel banyak angka sekaligus. Angka dipisah spasi, koma, garis, atau enter,
// lalu tiap angka dipasang ke game sesuai panjang digitnya — sama persis dengan
// aturan auto-detect supaya member tidak perlu memilih game satu per satu.
const PASTE_GAME_BY_DIGITS = [
  { digits: 4, gameCode: 'STRAIGHT_4D' },
  { digits: 3, gameCode: 'STRAIGHT_3D' },
  { digits: 2, gameCode: 'STRAIGHT_2D' },
  { digits: 1, gameCode: 'COLOK_BEBAS' }
];

function applyPastedBets() {
  const box = document.getElementById('quick-bet-paste');
  if (!box) return;
  const tokens = String(box.value || '')
    .split(/[\s,/|;]+/)
    .map(token => token.replace(/\D/g, ''))
    .filter(Boolean);
  if (!tokens.length) {
    showToast('Tidak ada angka yang terbaca dari tempelan.', 'danger');
    return;
  }
  const stake = minStake();
  const rows = [];
  let skipped = 0;
  for (const token of tokens) {
    const digits = token.slice(0, 4);
    const rule = PASTE_GAME_BY_DIGITS.find(item => item.digits === digits.length);
    const game = rule ? gameByCode(rule.gameCode) : null;
    if (!game) { skipped += 1; continue; }
    rows.push({ id: rowIdCounter++, selection: normalizeForGame(game, digits), stake, gameCode: game.code });
  }
  if (!rows.length) {
    showToast('Tidak ada angka yang cocok dengan game yang terbuka di pasaran ini.', 'danger');
    return;
  }
  const limit = Math.max(1, Math.min(Number(currentMarketConfig?.maxRows) || 50, 100));
  betRows = rows.slice(0, limit);
  renderRows();
  showToast(`${betRows.length} baris dari tempelan${skipped ? `, ${skipped} angka dilewati` : ''}. Periksa nominal lalu konfirmasi.`, 'success');
}

function syncGameHint() {
  const el = document.getElementById('game-hint');
  if (!el) return;
  const game = resolveRowGame(betRows[0] || { gameCode: 'AUTO', selection: '' });
  const text = game?.description || 'Pilih tipe game, lalu isi angka sesuai aturan game tersebut.';
  el.textContent = `${game ? `${game.label}: ` : ''}${text}`;
}


// ============================================================================
// BBFS (Bolak Balik Full Set) Generator Logic
// ============================================================================
function getPermutations(arr, length) {
  const result = new Set();
  function permute(current, remaining) {
    if (current.length === length) {
      result.add(current.join(''));
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      permute([...current, remaining[i]], remaining.filter((_, idx) => idx !== i));
    }
  }
  permute([], arr);
  return Array.from(result);
}

function updateBBFSPreview() {
  const digitsRaw = document.getElementById('bbfs-digits')?.value || '';
  const digits = digitsRaw.replace(/\D/g, '').split('');
  const infoEl = document.getElementById('bbfs-digit-info');
  if (infoEl) {
    infoEl.textContent = `${digits.length} / 7 digit dimasukkan (${digits.join(', ') || '-'})`;
  }

  const check4d = document.getElementById('bbfs-check-4d')?.checked;
  const check3d = document.getElementById('bbfs-check-3d')?.checked;
  const check2d = document.getElementById('bbfs-check-2d')?.checked;
  const check2dFront = document.getElementById('bbfs-check-2d-front')?.checked;
  const check2dMid = document.getElementById('bbfs-check-2d-mid')?.checked;

  const stake4d = Math.max(0, Number(document.getElementById('bbfs-stake-4d')?.value) || 0);
  const stake3d = Math.max(0, Number(document.getElementById('bbfs-stake-3d')?.value) || 0);
  const stake2d = Math.max(0, Number(document.getElementById('bbfs-stake-2d')?.value) || 0);
  const stake2dFront = Math.max(0, Number(document.getElementById('bbfs-stake-2d-front')?.value) || 0);
  const stake2dMid = Math.max(0, Number(document.getElementById('bbfs-stake-2d-mid')?.value) || 0);

  const p4 = (check4d && digits.length >= 4) ? getPermutations(digits, 4).length : 0;
  const p3 = (check3d && digits.length >= 3) ? getPermutations(digits, 3).length : 0;
  const p2 = (check2d && digits.length >= 2) ? getPermutations(digits, 2).length : 0;
  const p2f = (check2dFront && digits.length >= 2) ? getPermutations(digits, 2).length : 0;
  const p2m = (check2dMid && digits.length >= 2) ? getPermutations(digits, 2).length : 0;

  const el4d = document.getElementById('bbfs-count-4d');
  const el3d = document.getElementById('bbfs-count-3d');
  const el2d = document.getElementById('bbfs-count-2d');
  const el2df = document.getElementById('bbfs-count-2d-front');
  const el2dm = document.getElementById('bbfs-count-2d-mid');

  if (el4d) el4d.textContent = `(${p4} ln)`;
  if (el3d) el3d.textContent = `(${p3} ln)`;
  if (el2d) el2d.textContent = `(${p2} ln)`;
  if (el2df) el2df.textContent = `(${p2f} ln)`;
  if (el2dm) el2dm.textContent = `(${p2m} ln)`;

  const totalLines = p4 + p3 + p2 + p2f + p2m;
  const totalCombEl = document.getElementById('bbfs-total-combinations');
  if (totalCombEl) totalCombEl.textContent = `${totalLines} Line`;

  // Estimasi bayar setelah diskon
  const disc4 = Number(gameByCode('STRAIGHT_4D')?.discountPercent || 66) / 100;
  const disc3 = Number(gameByCode('STRAIGHT_3D')?.discountPercent || 59) / 100;
  const disc2 = Number(gameByCode('STRAIGHT_2D')?.discountPercent || 29) / 100;
  const disc2f = Number(gameByCode('POSITION_2D_FRONT')?.discountPercent || 28) / 100;
  const disc2m = Number(gameByCode('POSITION_2D_MIDDLE')?.discountPercent || 28) / 100;

  const cost4 = p4 * stake4d * (1 - disc4);
  const cost3 = p3 * stake3d * (1 - disc3);
  const cost2 = p2 * stake2d * (1 - disc2);
  const cost2f = p2f * stake2dFront * (1 - disc2f);
  const cost2m = p2m * stake2dMid * (1 - disc2m);
  const estNet = Math.round(cost4 + cost3 + cost2 + cost2f + cost2m);

  const estNetEl = document.getElementById('bbfs-estimated-net');
  if (estNetEl) estNetEl.textContent = formatRupiah(estNet);
}

function applyBBFS() {
  const digitsRaw = document.getElementById('bbfs-digits')?.value || '';
  const digits = digitsRaw.replace(/\D/g, '').split('');
  if (digits.length < 2) {
    showToast('Masukkan minimal 2 sampai 7 digit untuk BBFS.', 'danger');
    return;
  }

  const check4d = document.getElementById('bbfs-check-4d')?.checked;
  const check3d = document.getElementById('bbfs-check-3d')?.checked;
  const check2d = document.getElementById('bbfs-check-2d')?.checked;
  const check2dFront = document.getElementById('bbfs-check-2d-front')?.checked;
  const check2dMid = document.getElementById('bbfs-check-2d-mid')?.checked;

  const stake4d = Math.max(0, Number(document.getElementById('bbfs-stake-4d')?.value) || 0);
  const stake3d = Math.max(0, Number(document.getElementById('bbfs-stake-3d')?.value) || 0);
  const stake2d = Math.max(0, Number(document.getElementById('bbfs-stake-2d')?.value) || 0);
  const stake2dFront = Math.max(0, Number(document.getElementById('bbfs-stake-2d-front')?.value) || 0);
  const stake2dMid = Math.max(0, Number(document.getElementById('bbfs-stake-2d-mid')?.value) || 0);

  const rows = [];
  const min = minStake();

  if (check4d && digits.length >= 4 && stake4d >= min && gameByCode('STRAIGHT_4D')) {
    getPermutations(digits, 4).forEach(num => {
      rows.push({ id: rowIdCounter++, selection: num, stake: stake4d, gameCode: 'STRAIGHT_4D' });
    });
  }
  if (check3d && digits.length >= 3 && stake3d >= min && gameByCode('STRAIGHT_3D')) {
    getPermutations(digits, 3).forEach(num => {
      rows.push({ id: rowIdCounter++, selection: num, stake: stake3d, gameCode: 'STRAIGHT_3D' });
    });
  }
  if (check2d && digits.length >= 2 && stake2d >= min && gameByCode('STRAIGHT_2D')) {
    getPermutations(digits, 2).forEach(num => {
      rows.push({ id: rowIdCounter++, selection: num, stake: stake2d, gameCode: 'STRAIGHT_2D' });
    });
  }
  if (check2dFront && digits.length >= 2 && stake2dFront >= min && gameByCode('POSITION_2D_FRONT')) {
    getPermutations(digits, 2).forEach(num => {
      rows.push({ id: rowIdCounter++, selection: num, stake: stake2dFront, gameCode: 'POSITION_2D_FRONT' });
    });
  }
  if (check2dMid && digits.length >= 2 && stake2dMid >= min && gameByCode('POSITION_2D_MIDDLE')) {
    getPermutations(digits, 2).forEach(num => {
      rows.push({ id: rowIdCounter++, selection: num, stake: stake2dMid, gameCode: 'POSITION_2D_MIDDLE' });
    });
  }

  if (!rows.length) {
    showToast('Pilih setidaknya 1 tipe game dan pastikan nominal bet memenuhi minimal stake (' + formatRupiah(min) + ').', 'danger');
    return;
  }

  const limit = Math.max(1, Math.min(Number(currentMarketConfig?.maxRows) || 100, 100));
  const isTruncated = rows.length > limit;
  betRows = rows.slice(0, limit);
  renderRows();
  
  // Kembalikan view ke tabel standar agar pemain dapat memeriksa baris taruhan
  setGameModeTab('standard');

  showToast(`Berhasil generate ${betRows.length} baris BBFS ke slip taruhan!${isTruncated ? ` (dibatasi ${limit} baris)` : ''}`, 'success');
}

function setGameModeTab(mode) {
  document.querySelectorAll('.mode-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  const bbfsPanel = document.getElementById('bbfs-panel');
  const quickPanel = document.getElementById('quick-bet-wrap');
  if (bbfsPanel) {
    bbfsPanel.style.display = mode === 'bbfs' ? 'block' : 'none';
  }
  if (quickPanel) {
    quickPanel.style.display = mode === 'quick' ? 'flex' : 'none';
  }
  if (mode === 'bbfs') {
    document.getElementById('bbfs-digits')?.focus();
    updateBBFSPreview();
  } else if (mode === 'quick') {
    document.getElementById('quick-bet-paste')?.focus();
  }
}

function setupEventListeners() {
  // Togel Game Mode Tabs
  document.querySelectorAll('.mode-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      setGameModeTab(mode);
    });
  });

  // BBFS Inputs & Calculations
  const bbfsInput = document.getElementById('bbfs-digits');
  if (bbfsInput) {
    bbfsInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
      updateBBFSPreview();
    });
  }

  const clearBbfsBtn = document.getElementById('btn-clear-bbfs');
  if (clearBbfsBtn) {
    clearBbfsBtn.addEventListener('click', () => {
      if (bbfsInput) bbfsInput.value = '';
      updateBBFSPreview();
    });
  }

  document.querySelectorAll('#bbfs-panel input[type="checkbox"], #bbfs-panel input[type="number"]').forEach(el => {
    el.addEventListener('input', updateBBFSPreview);
    el.addEventListener('change', updateBBFSPreview);
  });

  const applyBbfsBtn = document.getElementById('btn-apply-bbfs');
  if (applyBbfsBtn) {
    applyBbfsBtn.addEventListener('click', applyBBFS);
  }

  window.removeBetRow = removeRow;

  const addRowBtn = document.getElementById('btn-add-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', addRow);
  }

  const quickBetBtn = document.getElementById('btn-quick-bet');
  if (quickBetBtn) {
    quickBetBtn.addEventListener('click', applyQuickBet);
  }

  const pasteBtn = document.getElementById('btn-paste-bet');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', applyPastedBets);
  }

  // Pay4D Toolbar Actions
  const applyAllStakeBtn = document.getElementById('btn-apply-all-stake');
  if (applyAllStakeBtn) {
    applyAllStakeBtn.addEventListener('click', applyMassStake);
  }
  const add1Btn = document.getElementById('btn-add-1-row');
  if (add1Btn) add1Btn.addEventListener('click', () => addMultipleRows(1));
  const add5Btn = document.getElementById('btn-add-5-rows');
  if (add5Btn) add5Btn.addEventListener('click', () => addMultipleRows(5));
  const add10Btn = document.getElementById('btn-add-10-rows');
  if (add10Btn) add10Btn.addEventListener('click', () => addMultipleRows(10));
  const clearBtn = document.getElementById('btn-clear-all-rows');
  if (clearBtn) clearBtn.addEventListener('click', clearBetRows);

  const add5BottomBtn = document.getElementById('btn-add-5-rows-bottom');
  if (add5BottomBtn) add5BottomBtn.addEventListener('click', () => addMultipleRows(5));
  const clearBottomBtn = document.getElementById('btn-clear-rows-bottom');
  if (clearBottomBtn) clearBottomBtn.addEventListener('click', clearBetRows);

  const submitBtn = document.getElementById('btn-submit-bet');
  if (submitBtn) {
    submitBtn.addEventListener('click', handleBetSubmit);
  }
}

async function handleBetSubmit() {
  // Validasi memakai definisi game dari backend (panjang digit, mode input), bukan
  // daftar kode game yang ditulis manual di halaman ini.
  const stakeMin = minStake();
  const invalidRows = betRows
    .filter(r => r.selection && r.stake > 0)
    .filter(r => {
      const game = resolveRowGame(r);
      if (!isSelectionComplete(game, r.selection)) return true;
      if (r.stake < stakeMin) return true;
      // Cek duplikat selection per game (backend juga menolak sebagai BET_DUPLICATE_LINE).
      const sel = `${rowGameCode(r)}|${String(r.selection).toUpperCase()}`;
      return betRows.some(other =>
        other !== r &&
        other.selection &&
        `${rowGameCode(other)}|${String(other.selection).toUpperCase()}` === sel
      );
    });

  if (invalidRows.length > 0) {
    const label = r => `${r.selection} (${resolveRowGame(r)?.label || r.gameCode})`;
    const examples = invalidRows.slice(0, 3).map(label).join(', ');
    showToast(`Pilihan tidak valid, kembar, duplikat, atau di bawah min ${stakeMin}: ${examples}${invalidRows.length > 3 ? ' ...' : ''}`, 'danger');
    return;
  }

  const user = auth.getUser();
  // totalNet hanya ada sebagai return value calculateTotals() — ambil dari sana
  // (sebelumnya referensi langsung ke totalNet menyebabkan ReferenceError di
  // handleBetSubmit sehingga tombol submit TOTO tidak pernah mengirim request).
  const { totalNet } = calculateTotals();
  if (user && Number(user.balance ?? 0) < totalNet) {
    showToast('Saldo Anda tidak mencukupi untuk memasang taruhan ini.', 'danger');
    return;
  }

  const rows = betRows
    .filter(r => isSelectionComplete(resolveRowGame(r), r.selection) && r.stake >= stakeMin)
    .map(r => ({
      gameCode: rowGameCode(r),
      selection: r.selection,
      // amount = nominal bruto yang dimasukkan user.
      // Backend akan menghitung ulang stake setelah diskon via calculateLotteryPricing,
      // jadi kita tidak perlu kirim stake dari sini.
      amount: r.stake
    }));

  // Penjaga terakhir sebelum mengirim. Backend sudah menolak wager pada pasar
  // tertutup, tetapi pemeriksaan di sini mencegah request yang pasti ditolak dan
  // memastikan periode yang dikirim selalu berasal dari server.
  if (!isMarketBettable(currentMarket)) {
    showToast('Pasaran sedang tidak tersedia. Silakan coba lagi nanti.', 'danger');
    setBettingControlsDisabled(true);
    return;
  }
  if (!currentMarketConfig) {
    showToast('Data pasar belum termuat. Silakan muat ulang halaman.', 'danger');
    return;
  }

  const marketId = currentMarketConfig?.marketId
    || currentMarket?.marketId
    || currentMarket?.id
    || currentMarket?.slug;

  const payload = {
    marketId,
    period: currentMarketConfig?.period || currentMarket?.period,
    rows,
    idempotencyKey: generateIdempotencyKey()
  };

  const submitBtn = document.getElementById('btn-submit-bet');
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Memproses Taruhan...';

    await api.post('/member/bets', payload);
    showToast('Taruhan berhasil dipasang!', 'success');
    await auth.fetchMe();
    auth.updateHeaderAuthUI();

    setTimeout(() => {
      window.location.href = '/bet-history.html';
    }, 1000);
  } catch (err) {
    showToast(err.message || 'Gagal memasang taruhan.', 'danger');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Konfirmasi & Pasang Taruhan';
  }
}

// Auto init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMarketPlay);
} else {
  initMarketPlay();
}
