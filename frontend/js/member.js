/**
 * Gasterus v3 — Member Area Dashboard Logic
 */

import api from './api.js';
import auth from './auth.js';
import { formatNumber, formatRupiah, getTimeRemaining, showToast, escapeHtml } from './utils.js';

let timerInterval = null;
let autoRefreshInterval = null;

export async function initMember() {
  if (!auth.isLoggedIn()) {
    window.location.href = '/index.html';
    return;
  }

  setupLogout();
  await loadUserProfile();
  await loadMarkets();
  startTimers();
}

async function loadUserProfile() {
  // Tampilkan data lokal dulu agar UI tidak kosong saat API loading
  const localUser = auth.getUser();
  if (localUser) updateProfileUI(localUser);

  try {
    const user = await auth.fetchMe();
    if (user) {
      // Update UI dengan data fresh dari server
      updateProfileUI(user);
    }
    // Jika fetchMe() return null (misal non-401 error), biarkan data lokal tetap tampil
  } catch (err) {
    console.error('Failed to load user profile', err);
    // Fallback sudah ditampilkan di atas, tidak perlu redirect
  }
}

function updateProfileUI(user) {
  const usernameEls = document.querySelectorAll('.user-display-name');
  const balanceEls = document.querySelectorAll('.user-display-balance');
  const avatarEl = document.getElementById('user-avatar-initial');

  usernameEls.forEach(el => el.textContent = user.username);
  balanceEls.forEach(el => el.textContent = formatNumber(user.balance || 0));

  if (avatarEl && user.username) {
    avatarEl.textContent = user.username.charAt(0).toUpperCase();
  }
}

async function loadMarkets() {
  const container = document.getElementById('member-markets-container');
  if (!container) return;

  try {
    const res = await api.get('/public/markets').catch(() => api.get('/member-api/markets'));
    const markets = Array.isArray(res) ? res : (res?.items ?? res?.data ?? []);
    if (!Array.isArray(markets) || !markets.length) {
      renderMarketsUnavailable();
      return;
    }
    renderMarkets(markets);
  } catch (err) {
    // Fail-closed: jangan pernah menampilkan angka pasar palsu. Member harus melihat
    // kondisi nyata, yaitu pasar tidak tersedia, bukan data dummy.
    console.warn('Data pasar tidak dapat dimuat; menampilkan status tidak tersedia.', err);
    renderMarketsUnavailable();
  }
}

function renderMarketsUnavailable() {
  const container = document.getElementById('member-markets-container');
  if (!container) return;
  container.innerHTML = '<div class="alert alert-warning" role="status">Pasaran sedang tidak tersedia. Silakan coba beberapa saat lagi.</div>';
}

function renderMarkets(markets) {
  const container = document.getElementById('member-markets-container');
  if (!container) return;

  container.innerHTML = markets.map(m => {
    const isClosed = m.bettingStatus === 'CLOSED' || m.bettingStatus === 'SUSPENDED';
    const statusBadge = isClosed
      ? `<span class="badge badge-danger">TUTUP</span>`
      : `<span class="badge badge-success">BUKA</span>`;

    const resultDigits = typeof m.result === 'string' && /^\d{3,6}$/.test(m.result) ? String(m.result).slice(0, 4) : '';
    const digits = resultDigits ? resultDigits.split('') : [];
    const balls = digits.map(d => `<span class="ball-num" style="width:30px;height:30px;font-size:0.95rem;">${escapeHtml(d)}</span>`).join('');
    const marketCode = String(m.slug || m.code || '');
    const marketHref = `/market-play.html?code=${encodeURIComponent(marketCode)}`;
    const marketAction = marketCode
      ? `<a href="${escapeHtml(marketHref)}" class="btn btn-primary btn-sm btn-block btn-play">▶ BET DISINI</a>`
      : `<button type="button" class="btn btn-secondary btn-sm btn-block btn-play" disabled>Pasaran tidak tersedia</button>`;

    return `
      <div class="member-market-card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h4 style="font-size:1rem;">${escapeHtml(m.name || '-')}</h4>
          ${statusBadge}
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">
          Periode: #${escapeHtml(m.period || '-')}
        </div>
        <div style="display:flex; gap:4px; justify-content:center; padding: 4px 0;">
          ${balls}
        </div>
        <div style="display:flex; justify-content:space-between; font-size: 0.8rem; color: var(--text-secondary); border-top: 1px solid var(--border-subtle); padding-top: 8px;">
          <span>Sisa Waktu:</span>
          <span class="countdown-timer" data-close="${escapeHtml(m.closeAt || '')}">${isClosed ? 'Tutup' : '...'}</span>
        </div>
        ${isClosed
          ? `<button type="button" class="btn btn-secondary btn-sm btn-block btn-play" disabled>Pasaran Tutup</button>`
          : marketAction}
      </div>
    `;
  }).join('');
}

function startTimers() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    document.querySelectorAll('.countdown-timer[data-close]').forEach(el => {
      const closeAt = el.getAttribute('data-close');
      if (!closeAt) return;
      const t = getTimeRemaining(closeAt);
      if (t.expired) {
        el.textContent = 'Ditutup';
      } else {
        const hh = String(t.hours).padStart(2, '0');
        const mm = String(t.minutes).padStart(2, '0');
        const ss = String(t.seconds).padStart(2, '0');
        el.textContent = `${hh}:${mm}:${ss}`;
      }
    });
  }, 1000);
}

function setupLogout() {
  document.querySelectorAll('.btn-action-logout').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (confirm('Apakah Anda yakin ingin keluar?')) {
        await auth.logout();
      }
    });
  });
}

// Event-driven: update numbers exactly when each market's close time arrives
const scheduledUpdates = new Map();

function startMarketAutoUpdate() {
  const scheduleUpdate = (closeAt, marketIndex) => {
    if (!closeAt) return;
    const delay = new Date(closeAt).getTime() - Date.now() + 3000; // 3s after close
    if (delay <= 0) return;

    // Clear existing timeout for this market
    if (scheduledUpdates.has(marketIndex)) {
      clearTimeout(scheduledUpdates.get(marketIndex));
    }

    const timeoutId = setTimeout(async () => {
      // Fetch latest data at this market's close time
      try {
        const res = await api.get('/public/markets').catch(() => api.get('/member-api/markets'));
        const markets = res.items || res.data || res || [];
        if (!Array.isArray(markets) || !markets.length) return;

        const container = document.getElementById('member-markets-container');
        if (!container) return;
        const cards = container.querySelectorAll('.member-market-card');
        if (!cards.length) return;

        // Find the market by code/slug and update only that one
        markets.forEach((m) => {
          const cardIdx = Array.from(cards).findIndex(c => {
            const nameEl = c.querySelector('h4');
            return nameEl && nameEl.textContent.trim().toUpperCase() === (m.name || '').toUpperCase();
          });
          if (cardIdx < 0) return;
          const card = cards[cardIdx];

          // Update result balls
          const ballsContainer = card.querySelector('div[style*="display:flex; gap:4px"]');
          if (ballsContainer && m.result) {
            const newDigits = String(m.result).split('');
            const currentBalls = ballsContainer.querySelectorAll('.ball-num');
            if (currentBalls.length === newDigits.length) {
              newDigits.forEach((digit, i) => {
                if (currentBalls[i] && currentBalls[i].textContent !== digit) {
                  currentBalls[i].textContent = digit;
                  currentBalls[i].style.transition = 'background 0.3s';
                  currentBalls[i].style.background = '#fef08a';
                  setTimeout(() => { if (currentBalls[i]) currentBalls[i].style.background = ''; }, 600);
                }
              });
            }
          }

          // Update period
          const periodEl = card.querySelector('div[style*="Periode:"]');
          if (periodEl && m.period) {
            periodEl.textContent = 'Periode: #' + m.period;
          }

          // Update status
          const statusBadge = card.querySelector('.badge');
          if (statusBadge) {
            const isClosed = m.bettingStatus === 'CLOSED' || m.bettingStatus === 'SUSPENDED';
            statusBadge.textContent = isClosed ? 'TUTUP' : 'BUKA';
            statusBadge.className = isClosed ? 'badge badge-danger' : 'badge badge-success';
          }

          // Schedule next update for this market using its new closeAt
          if (m.closeAt) {
            scheduleUpdate(m.closeAt, cardIdx);
          }
        });
      } catch (e) {
        // Silent fail
      }
    }, delay);

    scheduledUpdates.set(marketIndex, timeoutId);
  };

  // Initial schedule after markets load
  setTimeout(async () => {
    try {
      const res = await api.get('/public/markets').catch(() => api.get('/member-api/markets'));
      const markets = res.items || res.data || res || [];
      markets.forEach((m, idx) => {
        if (m.closeAt) scheduleUpdate(m.closeAt, idx);
      });
    } catch (e) { /* silent */ }
  }, 1000);
}

// Auto-refresh market data from API every 60 seconds
function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(async () => {
    try {
      const res = await api.get('/public/markets').catch(() => api.get('/member-api/markets'));
      const markets = res.items || res.data || res || [];
      if (!Array.isArray(markets) || !markets.length) return;

      const container = document.getElementById('member-markets-container');
      if (!container) return;
      const cards = container.querySelectorAll('.member-market-card');
      if (!cards.length) return;

      markets.forEach((m) => {
        // Find matching card by market name
        const cardIdx = Array.from(cards).findIndex(c => {
          const nameEl = c.querySelector('h4');
          return nameEl && nameEl.textContent.trim().toUpperCase() === (m.name || '').toUpperCase();
        });
        if (cardIdx < 0) return;
        const card = cards[cardIdx];

        // Update result balls
        const ballsContainer = card.querySelector('div[style*="display:flex; gap:4px"]');
        if (ballsContainer && m.result) {
          const newDigits = String(m.result).split('');
          const currentBalls = ballsContainer.querySelectorAll('.ball-num');
          if (currentBalls.length === newDigits.length) {
            newDigits.forEach((digit, i) => {
              if (currentBalls[i] && currentBalls[i].textContent !== digit) {
                currentBalls[i].textContent = digit;
                currentBalls[i].style.transition = 'background 0.3s';
                currentBalls[i].style.background = '#fef08a';
                setTimeout(() => { if (currentBalls[i]) currentBalls[i].style.background = ''; }, 600);
              }
            });
          }
        }

        // Update period
        const periodEl = card.querySelector('div[style*="Periode:"]');
        if (periodEl && m.period) {
          periodEl.textContent = 'Periode: #' + m.period;
        }

        // Update status badge
        const statusBadge = card.querySelector('.badge');
        if (statusBadge) {
          const isClosed = m.bettingStatus === 'CLOSED' || m.bettingStatus === 'SUSPENDED';
          statusBadge.textContent = isClosed ? 'TUTUP' : 'BUKA';
          statusBadge.className = isClosed ? 'badge badge-danger' : 'badge badge-success';
        }

        // Update close time for countdown
        const countdownEl = card.querySelector('.countdown-timer');
        if (countdownEl && m.closeAt) {
          countdownEl.setAttribute('data-close', m.closeAt);
        }

        // Update button state
        const isClosed = m.bettingStatus === 'CLOSED' || m.bettingStatus === 'SUSPENDED';
        const btnEl = card.querySelector('.btn-play');
        if (btnEl) {
          if (isClosed) {
            if (btnEl.tagName === 'A') {
              // Replace <a> with <button disabled>
              const newBtn = document.createElement('button');
              newBtn.type = 'button';
              newBtn.className = 'btn btn-secondary btn-sm btn-block btn-play';
              newBtn.disabled = true;
              newBtn.textContent = 'Pasaran Tutup';
              btnEl.replaceWith(newBtn);
            }
          } else {
            if (btnEl.tagName === 'BUTTON' && btnEl.disabled) {
              // Replace <button disabled> with <a>
              const newBtn = document.createElement('a');
              newBtn.href = '/market-play.html?code=' + encodeURIComponent(String(m.slug || m.code || ''));
              newBtn.className = 'btn btn-primary btn-sm btn-block btn-play';
              newBtn.textContent = '▶ BET DISINI';
              btnEl.replaceWith(newBtn);
            }
          }
        }
      });
    } catch (e) {
      // Silent fail — will retry in 60s
    }
  }, 60000); // 60 seconds
}

// Auto init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initMember();
    startMarketAutoUpdate();
    startAutoRefresh();
  });
} else {
  initMember();
  startMarketAutoUpdate();
  startAutoRefresh();
}
