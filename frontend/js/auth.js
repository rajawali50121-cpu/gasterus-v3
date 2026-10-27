/**
 * Gasterus v3 — Auth & Session Management
 */

import api from './api.js';
import { showToast } from './utils.js';

export const auth = {
  getUser() {
    try {
      const data = localStorage.getItem('gasterus_user');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  setUser(user) {
    if (user) {
      localStorage.setItem('gasterus_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('gasterus_user');
    }
  },

  isLoggedIn() {
    return Boolean(localStorage.getItem('gasterus_token'));
  },

  async login(username, password) {
    try {
      const res = await api.post('/member/login', { username, password });
      const payload = res.data || res;
      api.setSession(payload.token || payload.sessionToken, payload.csrfToken);
      this.setUser(payload.user);
      return payload.user;
    } catch (err) {
      showToast(err.message || 'Gagal login. Periksa username dan password.', 'danger');
      throw err;
    }
  },

  async register(registrationData) {
    try {
      const res = await api.post('/member/register', registrationData);
      const payload = res.data || res;
      api.setSession(payload.token || payload.sessionToken, payload.csrfToken);
      this.setUser(payload.user);
      return payload.user;
    } catch (err) {
      showToast(err.message || 'Pendaftaran gagal.', 'danger');
      throw err;
    }
  },

  async fetchMe() {
    try {
      const res = await api.get('/member/me');
      const payload = res.data || res;
      if (payload.user) {
        this.setUser(payload.user);
        if (payload.csrfToken) api.setSession(null, payload.csrfToken);
        return payload.user;
      }
    } catch (err) {
      // Hanya logout jika server benar-benar menolak sesi (401 Unauthorized).
      // Error lain (network down, timeout, 5xx) TIDAK boleh menghapus token —
      // itu yang menyebabkan user mental/kick balik ke halaman login.
      if (err.status === 401) {
        this.logout(false);
      }
    }
    return null;
  },

  async logout(callApi = true) {
    if (callApi && this.isLoggedIn()) {
      try {
        await api.post('/member/logout');
      } catch (e) {
        console.warn('Logout API error:', e);
      }
    }
    api.clearSession();
    this.setUser(null);
    window.location.href = '/index.html';
  },

  updateHeaderAuthUI() {
    const user = this.getUser();
    const guestArea = document.getElementById('header-guest-actions');
    const memberArea = document.getElementById('header-member-actions');
    const usernameEl = document.getElementById('header-username');
    const balanceEl = document.getElementById('header-balance');

    if (user && this.isLoggedIn()) {
      if (guestArea) guestArea.style.display = 'none';
      if (memberArea) memberArea.style.display = 'flex';
      if (usernameEl) usernameEl.textContent = user.username;
      if (balanceEl) {
        const bal = Number(user.balance || user.wallet?.balance || 0);
        balanceEl.textContent = new Intl.NumberFormat('id-ID').format(bal);
      }
    } else {
      if (guestArea) guestArea.style.display = 'flex';
      if (memberArea) memberArea.style.display = 'none';
    }
  }
};

export default auth;
