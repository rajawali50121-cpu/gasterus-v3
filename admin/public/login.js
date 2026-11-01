'use strict';

const form = document.getElementById('loginForm');
const username = document.getElementById('username');
const password = document.getElementById('password');
const button = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const response = await fetch('/admin-api/owner/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || 'Login gagal. Periksa akses dan coba kembali.');
    if (payload?.data?.user?.username !== 'gasterus' || !(payload?.data?.user?.roles || []).includes('OWNER')) {
      throw new Error('Akun ini tidak memiliki akses OWNER.');
    }
    password.value = '';
    location.href = 'console.html#/dashboard';
  } catch (error) {
    message.textContent = error.message || 'Layanan login tidak tersedia.';
  } finally {
    button.disabled = false;
    button.innerHTML = 'Continue <span aria-hidden="true">→</span>';
  }
});

fetch('/admin-api/owner/me', { credentials: 'same-origin' })
  .then(response => {
    if (response.ok) location.replace('console.html#/dashboard');
    else if (response.status !== 401) message.textContent = 'Sesi belum dapat diverifikasi. Anda tetap dapat mencoba login.';
  })
  .catch(() => {
    message.textContent = 'Layanan verifikasi sesi tidak tersedia. Anda tetap dapat mencoba login.';
  });
