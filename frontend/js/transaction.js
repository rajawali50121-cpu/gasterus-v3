/**
 * Gasterus v3 — Transaction (Deposit & Withdrawal) Logic
 */

import api from './api.js';
import auth from './auth.js';
import { formatRupiah, formatDateTime, showToast, escapeHtml } from './utils.js';

function generateIdempotencyKey() {
  return `tx_${Date.now()}_${Math.random().toString(36).substring(2, 12)}_${Math.random().toString(36).substring(2, 8)}`;
}

export async function initDeposit() {
  if (!auth.isLoggedIn()) {
    window.location.href = '/index.html';
    return;
  }
  // Fetch fresh user data from server, then update UI
  try { await auth.fetchMe(); } catch (e) { /* use cached */ }
  auth.updateHeaderAuthUI();
  updateDepositUserBar();
  setupNominalPresets('deposit-amount-input');
  setupNominalPresets('qris-amount-input');
  await loadPaymentMethods();
  setupDepositForm();
  setupQrisDepositForm();
  await loadTransactionHistory('DEPOSIT');
}

function updateDepositUserBar() {
  const user = auth.getUser();
  if (!user) return;
  const nameEl = document.querySelector('.user-display-name');
  const balanceEl = document.querySelector('.user-display-balance');
  if (nameEl) nameEl.textContent = user.username || 'Member';
  if (balanceEl) {
    const bal = Number(user.balance || user.wallet?.balance || 0);
    balanceEl.textContent = new Intl.NumberFormat('id-ID').format(bal);
  }
}

export async function initWithdraw() {
  if (!auth.isLoggedIn()) {
    window.location.href = '/index.html';
    return;
  }
  // Fetch fresh user data from server, then update UI
  try { await auth.fetchMe(); } catch (e) { /* use cached */ }
  auth.updateHeaderAuthUI();
  updateDepositUserBar();
  setupNominalPresets('withdraw-amount-input');
  setupWithdrawForm();
  await loadTransactionHistory('WITHDRAW');
}

function setupNominalPresets(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  // Scope preset buttons to the same form/container as the target input
  const container = input.closest('form') || input.closest('.deposit-form-container');
  if (!container) return;

  container.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-value');
      if (val) {
        input.value = val;
        // Visual feedback - only within the same container
        container.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });
}

let _currentBankMethods = [];
let _selectedMethodId = null;

async function loadPaymentMethods() {
  const grid = document.getElementById('payment-methods-grid');
  if (!grid) return;

  let methods = [];
  try {
    const res = await api.get('/member/payment-methods');
    methods = (res && Array.isArray(res.data)) ? res.data : (Array.isArray(res) ? res : []);
  } catch (err) {
    console.warn('Gagal memuat metode pembayaran dari server:', err);
  }

  // Filter only active methods
  const activeMethods = methods.filter(m => m.isActive === true);
  _currentBankMethods = activeMethods.filter(m => m.methodType === 'BANK' || m.methodType === 'EWALLET');
  const qrisMethod = activeMethods.find(m => m.methodType === 'QRIS');

  const noBankAlert = document.getElementById('no-bank-alert');
  const bankInfoCard = document.getElementById('bank-info-card');
  const depositForm = document.getElementById('deposit-form');

  if (!_currentBankMethods.length && !qrisMethod) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 18px; color: #94a3b8; font-size: 11px;">Belum ada metode pembayaran yang tersedia.</div>';
    if (noBankAlert) {
      noBankAlert.textContent = 'Metode deposit bank sedang tidak tersedia.';
      noBankAlert.style.display = '';
    }
    if (bankInfoCard) bankInfoCard.style.display = 'none';
    if (depositForm) depositForm.style.display = 'none';
    return;
  }

  // Render method buttons
  let html = '';
  _currentBankMethods.forEach((m, idx) => {
    const slug = (m.code || m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    html += `
      <button type="button" class="payment-method${idx === 0 ? ' active' : ''}" data-id="${escapeHtml(String(m.id))}" data-type="BANK">
        <span class="method-icon-wrap">
          <img src="assets/mobile-bank-logos/${slug}.svg" alt="${escapeHtml(m.name)}" class="method-icon" width="36" height="36" loading="lazy" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-block';">
          <span class="method-icon-fallback" style="display:none; font-size:10px; font-weight:800; color:#0f172a;">${escapeHtml(m.name.slice(0, 4))}</span>
        </span>
        <span class="method-name">${escapeHtml(m.name)}</span>
      </button>
    `;
  });

  if (qrisMethod) {
    html += `
      <button type="button" class="payment-method${_currentBankMethods.length === 0 ? ' active' : ''}" data-id="${escapeHtml(String(qrisMethod.id))}" data-type="QRIS">
        <span class="method-icon-wrap method-icon-qris">
          <img src="assets/mobile-bank-logos/qris.svg" alt="QRIS" class="method-icon" width="36" height="36" loading="lazy">
        </span>
        <span class="method-name">QRIS</span>
      </button>
    `;
  }

  grid.innerHTML = html;

  // Add click listeners to payment-method buttons
  grid.querySelectorAll('.payment-method').forEach(btn => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.payment-method').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const type = btn.getAttribute('data-type');
      const id = btn.getAttribute('data-id');

      const bankForm = document.getElementById('bank-form');
      const qrisForm = document.getElementById('qris-form');

      if (type === 'QRIS') {
        if (bankForm) bankForm.style.display = 'none';
        if (qrisForm) qrisForm.style.display = '';
      } else {
        if (bankForm) bankForm.style.display = '';
        if (qrisForm) qrisForm.style.display = 'none';
        selectBankMethod(id);
      }
    });
  });

  if (_currentBankMethods.length > 0) {
    selectBankMethod(_currentBankMethods[0].id);
  } else if (qrisMethod) {
    const bankForm = document.getElementById('bank-form');
    const qrisForm = document.getElementById('qris-form');
    if (bankForm) bankForm.style.display = 'none';
    if (qrisForm) qrisForm.style.display = '';
  }
}

function selectBankMethod(methodId) {
  const method = _currentBankMethods.find(m => m.id === methodId) || _currentBankMethods[0];
  const noBankAlert = document.getElementById('no-bank-alert');
  const bankInfoCard = document.getElementById('bank-info-card');
  const form = document.getElementById('deposit-form');

  if (!method) {
    if (noBankAlert) {
      noBankAlert.textContent = 'Metode deposit bank sedang tidak tersedia.';
      noBankAlert.style.display = '';
    }
    if (bankInfoCard) bankInfoCard.style.display = 'none';
    if (form) form.style.display = 'none';
    return;
  }

  _selectedMethodId = method.id;
  if (noBankAlert) noBankAlert.style.display = 'none';
  if (bankInfoCard) bankInfoCard.style.display = '';
  if (form) form.style.display = '';

  const destName = document.getElementById('dest-bank-name');
  const destAcc = document.getElementById('dest-bank-account');
  const destHolder = document.getElementById('dest-account-holder');
  const minMaxRow = document.getElementById('dest-min-max-row');
  const minMaxVal = document.getElementById('dest-min-max');
  const hiddenMethodId = document.getElementById('deposit-payment-method-id');
  const amountInput = document.getElementById('deposit-amount-input');
  const limitHint = document.getElementById('deposit-limit-hint');

  if (destName) destName.textContent = method.name;
  if (destAcc) destAcc.textContent = method.accountNumber || '-';
  if (destHolder) destHolder.textContent = method.accountName || '-';
  if (hiddenMethodId) hiddenMethodId.value = method.id;

  const minAmt = Number(method.minAmount || 10000);
  const maxAmt = Number(method.maxAmount || 200000000);

  if (amountInput) {
    amountInput.min = minAmt;
    amountInput.max = maxAmt;
  }
  if (limitHint) {
    limitHint.textContent = `Minimal deposit Rp ${minAmt.toLocaleString('id-ID')} (Maks: Rp ${maxAmt.toLocaleString('id-ID')})`;
  }
  if (minMaxRow && minMaxVal) {
    minMaxVal.textContent = `Rp ${minAmt.toLocaleString('id-ID')} – Rp ${maxAmt.toLocaleString('id-ID')}`;
    minMaxRow.style.display = '';
  }
}

function setupDepositForm() {
  const form = document.getElementById('deposit-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(form.amount.value);
    const methodId = form.paymentMethodId?.value || _selectedMethodId;
    const refNumber = form.referenceNumber?.value?.trim() || '';
    const note = form.note?.value?.trim() || '';

    const successBanner = document.getElementById('deposit-success-banner');
    if (successBanner) successBanner.style.display = 'none';

    if (!methodId) {
      showToast('Pilih metode pembayaran deposit.', 'warning');
      return;
    }

    const currentMethod = _currentBankMethods.find(m => m.id === methodId);
    const minAmt = currentMethod ? Number(currentMethod.minAmount || 10000) : 10000;
    const maxAmt = currentMethod ? Number(currentMethod.maxAmount || 200000000) : 200000000;

    if (!amount || amount < minAmt) {
      showToast(`Jumlah minimal deposit adalah Rp ${minAmt.toLocaleString('id-ID')}.`, 'warning');
      return;
    }
    if (amount > maxAmt) {
      showToast(`Jumlah maksimal deposit adalah Rp ${maxAmt.toLocaleString('id-ID')}.`, 'warning');
      return;
    }
    if (!refNumber || refNumber.length < 2) {
      showToast('Isi nomor / nama rekening pengirim untuk konfirmasi transfer.', 'warning');
      return;
    }

    const payload = {
      requestType: 'DEPOSIT',
      amount,
      paymentMethodId: methodId,
      referenceNumber: refNumber,
      note: note || undefined,
      idempotencyKey: generateIdempotencyKey()
    };

    const submitBtn = document.getElementById('btn-submit-deposit') || form.querySelector('button[type="submit"]');
    const submitText = document.getElementById('btn-submit-text');
    const origText = submitText ? submitText.textContent : (submitBtn ? submitBtn.textContent : 'Kirim Pengajuan Deposit');

    try {
      if (submitBtn) submitBtn.disabled = true;
      if (submitText) submitText.textContent = 'Mengirim Pengajuan...';
      else if (submitBtn) submitBtn.textContent = 'Mengirim Pengajuan...';

      await api.post('/member/wallet-requests', payload);

      if (successBanner) {
        successBanner.textContent = 'Pengajuan deposit berhasil dikirim dan sedang menunggu konfirmasi admin.';
        successBanner.style.display = '';
      }
      showToast('Pengajuan deposit berhasil dikirim dan sedang menunggu konfirmasi admin.', 'success');

      form.reset();
      const hiddenMethodId = document.getElementById('deposit-payment-method-id');
      if (hiddenMethodId && _selectedMethodId) hiddenMethodId.value = _selectedMethodId;
      await loadTransactionHistory('DEPOSIT');
    } catch (err) {
      showToast(err.message || 'Gagal mengirim pengajuan deposit.', 'danger');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (submitText) submitText.textContent = origText;
      else if (submitBtn) submitBtn.textContent = origText;
    }
  });
}

function setupQrisDepositForm() {
  const form = document.getElementById('qris-deposit-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(form.amount.value);

    if (!amount || amount < 10000) {
      showToast('Jumlah minimal deposit QRIS adalah Rp 10.000.', 'warning');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Membuat QRIS...';

      const idempotencyKey = generateIdempotencyKey();
      const res = await api.post('/member/qris/create-order', { amount, idempotencyKey });
      const order = (res && res.data) ? res.data : res;
      if (order && order.orderId) {
        openQrisModal(order, form);
      } else {
        throw new Error('Gagal membuat order QRIS.');
      }
    } catch (qrisErr) {
      console.warn('QRIS auto deposit unavailable', qrisErr);
      // Fallback: submit as manual deposit request
      try {
        const payload = {
          requestType: 'DEPOSIT',
          amount,
          paymentMethodId: null,
          idempotencyKey: generateIdempotencyKey(),
          note: 'QRIS (manual)'
        };
        await api.post('/member/wallet-requests', payload);
        showToast('Mode QRIS otomatis tidak tersedia, permintaan dikirim manual. Admin akan memproses segera.', 'warning');
        form.reset();
        await loadTransactionHistory('DEPOSIT');
      } catch (err) {
        showToast(qrisErr.message || err.message || 'Gagal membuat deposit QRIS.', 'danger');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Bayar dengan QRIS';
    }
  });
}

function setupWithdrawForm() {
  const form = document.getElementById('withdraw-form');
  if (!form) return;

  const user = auth.getUser();
  const bankInfoEl = document.getElementById('member-bank-info');
  if (bankInfoEl) {
    if (user && user.bankName && user.accountNumber) {
      bankInfoEl.textContent = `${user.bankName} - ${user.accountNumber} (a/n ${user.accountName || user.username})`;
      bankInfoEl.style.color = '';
    } else {
      bankInfoEl.textContent = 'Rekening belum dilengkapi — lengkapi di Profil sebelum withdraw.';
      bankInfoEl.style.color = '#f87171';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(form.amount.value);
    const password = form.password.value;

    if (!amount || amount < 50000) {
      showToast('Minimal penarikan dana adalah Rp 50.000.', 'warning');
      return;
    }

    if (!password) {
      showToast('Masukkan kata sandi akun untuk verifikasi keamanan.', 'warning');
      return;
    }

    const payload = {
      requestType: 'WITHDRAW',
      amount,
      authorizationPassword: password,
      idempotencyKey: generateIdempotencyKey()
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Memproses Penarikan...';

      await api.post('/member/wallet-requests', payload);
      showToast('Permintaan penarikan dana berhasil diajukan. Status: PENDING.', 'success');
      form.reset();
      await auth.fetchMe();
      auth.updateHeaderAuthUI();
      updateDepositUserBar();
      await loadTransactionHistory('WITHDRAW');
    } catch (err) {
      showToast(err.message || 'Gagal mengajukan penarikan dana.', 'danger');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Tarik Dana Sekarang';
    }
  });
}

async function loadTransactionHistory(type) {
  const tbody = document.getElementById('tx-history-tbody');
  if (!tbody) return;

  const isDeposit = type === 'DEPOSIT';
  const colSpan = isDeposit ? 5 : 5;

  try {
    const res = await api.get('/member/wallet-requests');
    const list = (res && Array.isArray(res.data)) ? res.data : (Array.isArray(res) ? res : []);
    const filtered = list.filter(item => item.requestType === type);

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; padding:24px; color:#94a3b8; font-size:12px;">Belum ada riwayat pengajuan ${type.toLowerCase()}.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      // Status badge — untuk WITHDRAW: APPROVED = EXECUTED (dana sudah cair)
      let badge;
      if (item.status === 'PENDING') {
        badge = '<span style="background:rgba(234,179,8,0.18); color:#facc15; border:1px solid rgba(234,179,8,0.4); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">PENDING</span>';
      } else if (item.status === 'PROCESSING') {
        badge = '<span style="background:rgba(59,130,246,0.18); color:#60a5fa; border:1px solid rgba(59,130,246,0.4); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">DIPROSES</span>';
      } else if (item.status === 'APPROVED' || item.status === 'SETTLED') {
        const label = (!isDeposit && item.status === 'APPROVED') ? 'EXECUTED' : 'APPROVED';
        badge = `<span style="background:rgba(34,197,94,0.18); color:#4ade80; border:1px solid rgba(34,197,94,0.4); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">${label}</span>`;
      } else if (item.status === 'REJECTED' || item.status === 'FAILED') {
        badge = '<span style="background:rgba(239,68,68,0.18); color:#f87171; border:1px solid rgba(239,68,68,0.4); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">DITOLAK</span>';
      } else if (item.status === 'AWAITING_SECOND_APPROVAL') {
        badge = '<span style="background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.4); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">REVIEW</span>';
      } else {
        badge = `<span style="background:rgba(148,163,184,0.12); color:#94a3b8; border:1px solid rgba(148,163,184,0.3); padding:3px 8px; border-radius:6px; font-size:10.5px; font-weight:800; white-space:nowrap;">${escapeHtml(item.status)}</span>`;
      }

      // Method / destination label
      const methodLabel = isDeposit
        ? (item.paymentMethod?.name || '-')
        : (() => {
            const ps = item.payoutSnapshot;
            if (ps && ps.bankName) {
              return `${ps.bankName} ${ps.accountNumber ? '• ' + ps.accountNumber : ''}`;
            }
            return '-';
          })();

      const keterangan = [
        item.referenceNumber ? `Ref: ${item.referenceNumber}` : '',
        item.note || '',
        item.rejectionReason ? `Alasan: ${item.rejectionReason}` : ''
      ].filter(Boolean).join(' • ') || '-';

      if (isDeposit) {
        return `
          <tr>
            <td style="font-size:11px; color:#94a3b8; white-space:nowrap;">${formatDateTime(item.createdAt)}</td>
            <td style="font-size:11.5px; font-weight:700; color:#e2e8f0;">${escapeHtml(methodLabel)}</td>
            <td style="font-size:12px; font-weight:800; color:#38bdf8;">${formatRupiah(item.amount)}</td>
            <td>${badge}</td>
            <td style="font-size:11px; color:#94a3b8; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(keterangan)}">${escapeHtml(keterangan)}</td>
          </tr>
        `;
      } else {
        return `
          <tr>
            <td style="font-size:11px; color:#94a3b8; white-space:nowrap;">${formatDateTime(item.createdAt)}</td>
            <td style="font-weight:700; color:var(--text-gold,#e2b84f);">${formatRupiah(item.amount)}</td>
            <td style="font-size:11px; color:#cbd5e1;">${escapeHtml(methodLabel)}</td>
            <td>${badge}</td>
            <td style="font-size:11px; color:var(--text-secondary,#94a3b8); max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(keterangan)}">${escapeHtml(keterangan)}</td>
          </tr>
        `;
      }
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; padding:20px; color:#94a3b8; font-size:12px;">Belum ada data riwayat transaksi.</td></tr>`;
  }
}

/* ============================================================
   QRIS Auto Deposit Modal — dynamic QR + polling until payment
   is confirmed by the provider webhook (balance auto credited).
   ============================================================ */
let _qrisPollTimer = null;

function openQrisModal(order, form) {
  closeQrisModal();

  const auto = order.settleMode === 'AUTO';
  // Use static QRIS barcode image with cache-buster
  const qrSrc = '/assets/qris-barcode.png?v=20260914-qris-fixed';

  const overlay = document.createElement('div');
  overlay.id = 'qris-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(2,8,20,.82);display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:#0f1c30;border:1px solid #2c405a;border-radius:16px;max-width:360px;width:100%;padding:22px;text-align:center;color:#eef3f8;font-family:Inter,Arial,sans-serif;">
      <div style="font-weight:800;font-size:1.05rem;margin-bottom:4px;">Scan QRIS untuk Deposit</div>
      <div style="font-size:.8rem;color:#92a2b6;margin-bottom:14px;">Nominal: <strong style="color:#e2b84f;">Rp ${Number(order.amount).toLocaleString('id-ID')}</strong></div>
      <div id="qris-image-box" style="background:#fff;border-radius:12px;padding:12px;display:inline-block;min-width:260px;min-height:260px;line-height:260px;">
        ${qrSrc ? `<img src="${qrSrc}" alt="QRIS" style="width:260px;height:260px;display:inline-block;vertical-align:middle;">` : '<span style="font-size:.8rem;color:#333;">QRIS tidak tersedia</span>'}
      </div>
      <div id="qris-status" style="margin-top:14px;font-size:.85rem;color:#f5dc8a;"><svg class="ui-icon" aria-hidden="true"><use href="/assets/icons/ui-icons.svg#clock"></use></svg> Menunggu pembayaran…</div>
      <div id="qris-timer" style="margin-top:4px;font-size:.75rem;color:#92a2b6;"></div>
      <button id="qris-close-btn" type="button" style="margin-top:16px;padding:9px 22px;border-radius:8px;border:1px solid #405570;background:#12243a;color:#fff;cursor:pointer;font-weight:700;">Tutup</button>
      ${auto ? '' : '<div style="margin-top:10px;font-size:.72rem;color:#92a2b6;">Saldo akan masuk setelah admin mengonfirmasi pembayaran Anda.</div>'}
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('qris-close-btn').addEventListener('click', closeQrisModal);

  // Countdown
  const expiresAt = new Date(order.expiresAt).getTime();
  const timerEl = document.getElementById('qris-timer');
  const tick = () => {
    const left = expiresAt - Date.now();
    if (left <= 0) { if (timerEl) timerEl.textContent = 'Kedaluwarsa.'; return; }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    if (timerEl) timerEl.textContent = `Berlaku ${m}:${String(s).padStart(2, '0')} menit`;
  };
  tick();
  const countdown = setInterval(tick, 1000);
  overlay._countdown = countdown;

  // Poll status every 3s until PAID / EXPIRED / closed
  _qrisPollTimer = setInterval(async () => {
    try {
      const res = await api.get(`/member/qris/${order.orderId}/status`);
      const st = (res && res.data) ? res.data : res;
      const statusEl = document.getElementById('qris-status');
      if (!statusEl) return;
      if (st.balanceCredited || st.status === 'PAID') {
        statusEl.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="/assets/icons/ui-icons.svg#check-circle"></use></svg> Pembayaran diterima! Saldo telah masuk.';
        statusEl.style.color = '#29b56d';
        if (overlay._countdown) clearInterval(overlay._countdown);
        clearInterval(_qrisPollTimer); _qrisPollTimer = null;
        setTimeout(async () => {
          closeQrisModal();
          try { await auth.fetchMe(); auth.updateHeaderAuthUI(); } catch (e) { /* ignore */ }
          await loadTransactionHistory('DEPOSIT');
          showToast('Deposit berhasil! Saldo telah ditambahkan.', 'success');
        }, 1800);
      } else if (st.status === 'EXPIRED') {
        statusEl.textContent = '⚠️ Transaksi kedaluwarsa. Silakan buat deposit baru.';
        statusEl.style.color = '#df5a62';
        if (overlay._countdown) clearInterval(overlay._countdown);
        clearInterval(_qrisPollTimer); _qrisPollTimer = null;
      }
    } catch (e) { /* keep polling; transient network errors are ignored */ }
  }, 3000);
}

function closeQrisModal() {
  if (_qrisPollTimer) { clearInterval(_qrisPollTimer); _qrisPollTimer = null; }
  const existing = document.getElementById('qris-modal-overlay');
  if (existing && existing._countdown) clearInterval(existing._countdown);
  if (existing) existing.remove();
}

