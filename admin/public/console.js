'use strict';

(() => {
  const content = document.getElementById('content');
  const title = document.getElementById('pageTitle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('menuOverlay');
  const modal = document.getElementById('modal');
  const toast = document.getElementById('toast');
  const PAGE_SIZE = 25;
  const state = { me: null, view: 'dashboard', page: 1, betType: 'market', betRows: [], filters: {}, toastTimer: 0 };

  const titles = {
    dashboard: 'Dashboard', deposits: 'Deposit management', withdrawals: 'Withdrawal management',
    members: 'Member management', bets: 'Bet history', activity: 'Activity log', account: 'Owner account'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const money = value => `IDR ${Number(value || 0).toLocaleString('id-ID')}`;
  const date = value => {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('id-ID');
  };
  const day = value => {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  };
  const status = value => `<span class="status ${esc(String(value || 'unknown').toLowerCase())}">${esc(value || 'UNKNOWN')}</span>`;
  const view = documentValue => document.getElementById(documentValue);

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  async function request(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
      headers['x-csrf-token'] = state.me?.csrfToken || '';
    }
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.href = 'index.html';
      throw new Error('Sesi OWNER sudah berakhir. Silakan login kembali.');
    }
    if (!response.ok) throw new Error(payload?.error?.message || 'Permintaan gagal. Silakan coba kembali.');
    return payload.data;
  }

  function shell(contentHtml, heading, subtitle) {
    title.textContent = heading || titles[state.view];
    content.innerHTML = `${subtitle ? `<div class="page-heading"><div><h2>${esc(heading || titles[state.view])}</h2><p>${esc(subtitle)}</p></div></div>` : ''}${contentHtml}`;
    document.querySelectorAll('[data-view]').forEach(link => {
      if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function errorPage(error, retry) {
    content.innerHTML = `<div class="panel"><div class="error-state">${esc(error.message || 'Data tidak dapat dimuat.')}</div><div class="toolbar" style="justify-content:center"><button class="button" type="button" id="retry">Coba lagi</button></div></div>`;
    view('retry').addEventListener('click', retry, { once: true });
  }

  function showModal(heading, subtitle, html, actions = []) {
    view('modalTitle').textContent = heading;
    view('modalSubtitle').textContent = subtitle || '';
    view('modalContent').innerHTML = html;
    const actionHost = view('modalActions');
    actionHost.replaceChildren();
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = `button ${action.className || ''}`;
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        if (action.run) await action.run(button);
      });
      actionHost.append(button);
    }
    modal.hidden = false;
    view('modalClose').focus();
  }

  function closeModal() {
    modal.hidden = true;
    view('modalContent').replaceChildren();
    view('modalActions').replaceChildren();
  }

  function detailItems(items) {
    return `<div class="detail-grid">${items.map(([label, value]) => `<div class="detail-item"><small>${esc(label)}</small><strong>${esc(value || '—')}</strong></div>`).join('')}</div>`;
  }

  function remoteFooter(hasNext, shown) {
    const first = shown ? (state.page - 1) * PAGE_SIZE + 1 : 0;
    const last = shown ? first + shown - 1 : 0;
    return `<div class="table-footer"><span>${first ? `${first}–${last} ditampilkan · halaman ${state.page}` : '0 data pada halaman ini'}</span><div class="pagination"><button class="button" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>Sebelumnya</button><button class="button" data-page="${state.page + 1}" ${!hasNext ? 'disabled' : ''}>Berikutnya</button></div></div>`;
  }

  function bindRemoteFilters(ids, update) {
    for (const id of ids) {
      const element = view(id);
      element.addEventListener(id === 'searchFilter' ? 'input' : 'change', () => {
        state.filters[state.view] = {
          search: view('searchFilter')?.value || '',
          status: view('statusFilter')?.value || '',
          from: view('fromFilter')?.value || '',
          to: view('toFilter')?.value || ''
        };
        state.page = 1;
        if (id === 'searchFilter') {
          clearTimeout(state.filterTimer);
          state.filterTimer = setTimeout(update, 250);
        } else void update();
      });
    }
  }

  function renderChart(series) {
    if (!Array.isArray(series) || series.length === 0) return '<div class="empty-state">Belum ada data transaksi untuk grafik.</div>';
    const max = Math.max(1, ...series.flatMap(row => [Number(row.deposits || 0), Number(row.withdrawals || 0)]));
    return `<div class="bar-chart">${series.map(row => {
      const depositHeight = Math.max(2, Number(row.deposits || 0) / max * 138);
      const withdrawalHeight = Math.max(2, Number(row.withdrawals || 0) / max * 138);
      const label = row.day || row.date;
      return `<div class="chart-day" title="${esc(label)} · Deposit ${esc(money(row.deposits))} · Withdrawal ${esc(money(row.withdrawals))}"><span class="chart-bar" style="height:${depositHeight.toFixed(1)}px"></span><span class="chart-bar withdraw" style="height:${withdrawalHeight.toFixed(1)}px"></span><time>${esc(String(label || '').slice(5))}</time></div>`;
    }).join('')}</div><div class="chart-legend"><span><i class="legend-dot"></i>Deposit berhasil</span><span><i class="legend-dot withdraw"></i>Withdrawal berhasil</span></div>`;
  }

  async function loadDashboard() {
    const [summary, dashboard, audits] = await Promise.all([
      request('/admin-api/owner/backoffice-summary'),
      request('/admin-api/owner/dashboard'),
      request('/admin-api/owner/audit?limit=8')
    ]);
    const html = `<div class="metric-grid grid">
      <article class="metric-card"><div class="metric-label">TOTAL MEMBER</div><strong class="metric-value">${esc(summary.members ?? dashboard.members ?? 0)}</strong><div class="metric-note">Akun non-pengelola terdaftar</div></article>
      <article class="metric-card"><div class="metric-label">DEPOSIT HARI INI</div><strong class="metric-value">${esc(money(summary.depositsToday))}</strong><div class="metric-note">Transaksi APPROVED hari ini</div></article>
      <article class="metric-card"><div class="metric-label">WITHDRAWAL HARI INI</div><strong class="metric-value">${esc(money(summary.withdrawsToday))}</strong><div class="metric-note">Transaksi APPROVED hari ini</div></article>
      <article class="metric-card"><div class="metric-label">TRANSAKSI PENDING</div><strong class="metric-value">${esc(summary.pendingWallet ?? dashboard.pending ?? 0)}</strong><div class="metric-note">PENDING, second approval, atau payout</div></article>
      <article class="metric-card"><div class="metric-label">TRANSAKSI BERHASIL</div><strong class="metric-value">${esc(summary.transactionsSuccessful ?? 0)}</strong><div class="metric-note">Status APPROVED sepanjang waktu</div></article>
      <article class="metric-card"><div class="metric-label">TRANSAKSI GAGAL</div><strong class="metric-value">${esc(summary.transactionsFailed ?? 0)}</strong><div class="metric-note">Status FAILED atau REJECTED</div></article>
      <article class="metric-card"><div class="metric-label">LEDGER</div><strong class="metric-value">${dashboard.ledgerBalanced ? 'BALANCED' : 'CHECK'}</strong><div class="metric-note">Verifikasi ledger resmi website</div></article>
      <article class="metric-card"><div class="metric-label">METODE PEMBAYARAN</div><strong class="metric-value">${esc(summary.paymentMethods ?? 0)}</strong><div class="metric-note">Metode aktif di layanan website</div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-header"><div><h3>Transaksi berhasil · 14 hari</h3><p>Jumlah nominal per hari, berdasarkan waktu pembuatan pengajuan yang berstatus APPROVED.</p></div></div>${renderChart(summary.transactionSeries)}</section>
      <section class="panel"><div class="panel-header"><div><h3>Operasional</h3><p>Snapshot layanan back-office</p></div></div><div class="operational-list">
        <div class="operational-row"><span>Member suspended</span><strong>${esc(summary.suspended ?? 0)}</strong></div>
        <div class="operational-row"><span>Deposit & withdrawal pending</span><strong>${esc(summary.pendingWallet ?? 0)}</strong></div>
        <div class="operational-row"><span>Banner aktif</span><strong>${esc(summary.liveBanners ?? 0)}</strong></div>
        <div class="operational-row"><span>Promosi aktif</span><strong>${esc(summary.livePromotions ?? 0)}</strong></div>
        <div class="operational-row"><span>Approval tertunda</span><strong>${esc(dashboard.pendingApprovals ?? 0)}</strong></div>
      </div></section>
    </div>
    <section class="panel"><div class="panel-header"><div><h3>Aktivitas OWNER terbaru</h3><p>Audit trail operasional dari database website.</p></div><a class="button" href="#/activity">Lihat semua</a></div>
      <div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Tindakan</th><th>Referensi</th><th>Pelaku</th></tr></thead><tbody>${audits.map(row => `<tr><td>${esc(date(row.created_at))}</td><td>${esc(row.action)}</td><td class="cell-sub">${esc(row.target_id || '—')}</td><td>${esc(row.actor_role || 'OWNER')}</td></tr>`).join('') || '<tr><td class="empty-state" colspan="4">Belum ada aktivitas.</td></tr>'}</tbody></table></div>
    </section>
    <p class="metric-note">Data berasal dari API PostgreSQL website. Deposit/withdrawal hari ini dihitung dari transaksi APPROVED sejak awal hari waktu database; grafik memakai tanggal pembuatan pengajuan.</p>`;
    shell(html, 'Dashboard', 'Ringkasan aktual aktivitas, transaksi, dan status operasional website.');
  }

  function walletDetail(row) {
    const requestType = String(row.requestType || '').toUpperCase();
    const snapshot = row.payoutSnapshot || {};
    const payment = row.paymentMethod || {};
    const items = [
      ['ID transaksi', row.id], ['Username', row.username], ['Jenis', requestType], ['Nominal', money(row.amount)],
      ['Status', row.status], ['Status dana', row.fundsState], ['Dibuat', date(row.createdAt || row.created_at)],
      ['Diproses', date(row.reviewedAt || row.payoutProcessedAt)], ['Metode deposit', payment.name || payment.methodType],
      ['Referensi deposit', row.referenceNumber], ['Status provider', row.providerStatus], ['Catatan', row.note],
      ['Rekening tujuan', [snapshot.bankName, snapshot.accountName, snapshot.accountNumber].filter(Boolean).join(' · ')],
      ['Alasan penolakan', row.rejectionReason], ['Referensi payout', row.payoutReference || row.providerReference]
    ];
    showModal(`${requestType} · ${money(row.amount)}`, `Transaksi ${row.id}`, detailItems(items));
  }

  async function processWallet(id, action) {
    const row = state.walletRows.find(item => item.id === id);
    if (!row) throw new Error('Data transaksi tidak tersedia. Muat ulang daftar sebelum memproses.');
    if (action === 'REJECTED') {
      const reason = window.prompt('Alasan penolakan (wajib):');
      if (!reason || reason.trim().length < 3) return;
      if (!window.confirm(`Tolak pengajuan ${row.requestType} ${money(row.amount)} milik ${row.username}?`)) return;
      await request(`/admin-api/owner/wallet-requests/${encodeURIComponent(id)}/review`, {
        method: 'POST', body: JSON.stringify({ decision: 'REJECTED', reason: reason.trim() })
      });
    } else if (action === 'APPROVED') {
      if (!window.confirm(`Setujui pengajuan ${row.requestType} ${money(row.amount)} milik ${row.username}?`)) return;
      await request(`/admin-api/owner/wallet-requests/${encodeURIComponent(id)}/review`, {
        method: 'POST', body: JSON.stringify({ decision: 'APPROVED' })
      });
    } else {
      const body = {};
      if (action === 'PAID') {
        body.reference = window.prompt('Masukkan referensi transfer payout yang berhasil:')?.trim() || '';
        if (body.reference.length < 4) return;
        if (!window.confirm('Konfirmasi bahwa dana withdrawal sudah benar-benar ditransfer?')) return;
      } else {
        body.reason = window.prompt('Alasan payout gagal (wajib):')?.trim() || '';
        if (body.reason.length < 4) return;
        if (!window.confirm('Tandai payout gagal? Dana yang ditahan akan diproses sesuai layanan wallet website.')) return;
      }
      body.decision = action;
      await request(`/admin-api/owner/wallet-requests/${encodeURIComponent(id)}/payout`, {
        method: 'POST', body: JSON.stringify(body)
      });
    }
    showToast('Tindakan berhasil diproses oleh layanan transaksi website.');
    closeModal();
    await loadWallets();
  }

  async function loadWallets() {
    const type = state.view === 'deposits' ? 'DEPOSIT' : 'WITHDRAW';
    const filters = state.filters[state.view] || (state.filters[state.view] = { search: '', status: '', from: '', to: '' });
    const params = new URLSearchParams({ type, limit: String(PAGE_SIZE + 1), offset: String((state.page - 1) * PAGE_SIZE) });
    if (filters.search) params.set('q', filters.search);
    if (filters.status) params.set('status', filters.status);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const result = await request(`/admin-api/owner/wallet-requests?${params}`);
    const hasNext = result.length > PAGE_SIZE;
    const rows = result.slice(0, PAGE_SIZE);
    state.walletRows = rows;
    const html = `<div class="page-heading"><div><h2>${type === 'DEPOSIT' ? 'Deposit requests' : 'Withdrawal requests'}</h2><p>Daftar transaksi wallet resmi dengan filter server-side dan pagination.</p></div><button class="button" id="refreshTable">Refresh</button></div>
      <section class="panel"><div class="toolbar" style="margin-bottom:13px">
        <input class="filter-input search" id="searchFilter" value="${esc(filters.search)}" placeholder="Cari username, ID transaksi, nominal" aria-label="Cari transaksi">
        <select class="filter-select" id="statusFilter" aria-label="Filter status"><option value="">Semua status</option>${['PENDING','AWAITING_SECOND_APPROVAL','PROCESSING','APPROVED','REJECTED','FAILED','REVERSED'].map(value => `<option ${filters.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
        <input class="filter-input" type="date" id="fromFilter" value="${esc(filters.from)}" aria-label="Tanggal mulai">
        <input class="filter-input" type="date" id="toFilter" value="${esc(filters.to)}" aria-label="Tanggal akhir">
      </div><div class="table-wrap"><table><thead><tr><th>Transaksi</th><th>Member</th><th>Nominal</th><th>Metode / tujuan</th><th>Status</th><th>Status dana</th><th>Aksi</th></tr></thead><tbody id="walletTable"></tbody></table></div><div id="pagination"></div></section>`;
    shell(html, titles[state.view], `Pemeriksaan dan pemrosesan ${type === 'DEPOSIT' ? 'deposit' : 'withdrawal'} melalui service wallet resmi.`);
    view('walletTable').innerHTML = rows.map(row => {
      const destination = type === 'WITHDRAW'
        ? [row.payoutSnapshot?.bankName, row.payoutSnapshot?.accountName, row.payoutSnapshot?.accountNumber].filter(Boolean).join(' · ')
        : row.paymentMethod?.name || row.paymentMethod?.methodType || '—';
      let actions = `<button class="button" data-detail="${esc(row.id)}">Detail</button>`;
      if (row.status === 'PENDING') {
        actions += ` <button class="button button-success" data-wallet="${esc(row.id)}" data-action="APPROVED">${type === 'WITHDRAW' ? 'Otorisasi' : 'Setujui'}</button> <button class="button button-danger" data-wallet="${esc(row.id)}" data-action="REJECTED">Tolak</button>`;
      } else if (type === 'WITHDRAW' && row.status === 'PROCESSING') {
        actions += ` <button class="button button-success" data-wallet="${esc(row.id)}" data-action="PAID">Payout selesai</button> <button class="button button-danger" data-wallet="${esc(row.id)}" data-action="FAILED">Payout gagal</button>`;
      }
      return `<tr><td><span class="cell-primary">${esc(row.requestType)}</span><div class="cell-sub">${esc(row.id)}</div></td><td>${esc(row.username)}</td><td>${esc(money(row.amount))}</td><td>${esc(destination || '—')}</td><td>${status(row.status)}</td><td>${status(row.fundsState || 'NONE')}</td><td><div class="toolbar">${actions}</div></td></tr>`;
    }).join('') || '<tr><td class="empty-state" colspan="7">Tidak ada transaksi yang sesuai.</td></tr>';
    view('pagination').innerHTML = remoteFooter(hasNext, rows.length);
    bindRemoteFilters(['searchFilter','statusFilter','fromFilter','toFilter'], () => {
      state.filters[state.view] = {
        search: view('searchFilter').value.trim(), status: view('statusFilter').value,
        from: view('fromFilter').value, to: view('toFilter').value
      };
      return loadWallets();
    });
    view('refreshTable').addEventListener('click', () => void loadCurrent().catch(showPageError));
  }

  async function loadMembers() {
    const filters = state.filters.members || (state.filters.members = { search: '', status: '' });
    const params = new URLSearchParams({ membersOnly: '1', limit: String(PAGE_SIZE + 1), offset: String((state.page - 1) * PAGE_SIZE) });
    if (filters.search) params.set('q', filters.search);
    if (filters.status) params.set('status', filters.status);
    const result = await request(`/admin-api/owner/members?${params}`);
    const hasNext = result.length > PAGE_SIZE;
    const members = result.slice(0, PAGE_SIZE);
    const html = `<div class="page-heading"><div><h2>Member directory</h2><p>Profil dan saldo hanya-baca · Riwayat ditampilkan dari service akun dan taruhan website.</p></div><button class="button" id="refreshTable">Refresh</button></div>
      <section class="panel"><div class="toolbar" style="margin-bottom:13px">
        <input class="filter-input search" id="searchFilter" value="${esc(filters.search)}" placeholder="Cari username, ID, email, atau nomor telepon" aria-label="Cari member">
        <select class="filter-select" id="statusFilter" aria-label="Filter status"><option value="">Semua status</option><option ${filters.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${filters.status === 'SUSPENDED' ? 'selected' : ''}>SUSPENDED</option></select>
      </div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Email / telepon</th><th>Saldo</th><th>Status</th><th>Terdaftar</th><th>Detail</th></tr></thead><tbody id="memberTable"></tbody></table></div><div id="pagination"></div></section>`;
    shell(html, titles.members, 'Pencarian akun member dan pemeriksaan transaksi tanpa mengubah saldo.');
    view('memberTable').innerHTML = members.map(member => `<tr>
      <td><span class="cell-primary">${esc(member.username)}</span><div class="cell-sub">${esc(member.id)}</div></td>
      <td>${esc(member.email || '—')}<div class="cell-sub">${esc(member.phone || '—')}</div></td>
      <td>${esc(money(member.balance))}</td><td>${status(member.status)}</td>
      <td>${esc(date(member.createdAt))}</td><td><button class="button" data-member="${esc(member.id)}">Lihat detail</button></td></tr>`).join('') || '<tr><td class="empty-state" colspan="6">Member tidak ditemukan.</td></tr>';
    view('pagination').innerHTML = remoteFooter(hasNext, members.length);
    bindRemoteFilters(['searchFilter','statusFilter'], () => {
      state.filters.members = { search: view('searchFilter').value.trim(), status: view('statusFilter').value };
      return loadMembers();
    });
    view('refreshTable').addEventListener('click', () => void loadCurrent().catch(showPageError));
  }

  async function showMember(id) {
    const member = await request(`/admin-api/owner/members/${encodeURIComponent(id)}`);
    const [marketBets, sportsBets] = await Promise.all([
      request(`/admin-api/owner/bets?username=${encodeURIComponent(member.username)}&limit=10`),
      request(`/admin-api/owner/sportsbook/bets?username=${encodeURIComponent(member.username)}&limit=10`)
    ]);
    const ledger = member.ledger || [];
    const walletSummary = member.walletSummary || [];
    const marketRows = marketBets.map(row => `<tr><td>${esc(row.invoice || row.id)}</td><td>${esc(row.marketName || row.marketSlug || '—')}</td><td>${esc(row.status)}</td><td>${esc(money(row.totalStake ?? row.stake ?? row.total_amount))}</td><td>${esc(date(row.createdAt || row.created_at))}</td></tr>`).join('');
    const sportsRows = sportsBets.map(row => `<tr><td>${esc(row.invoice || row.id)}</td><td>${esc(row.status)}</td><td>${esc(money(row.totalStake ?? row.stake))}</td><td>${esc(date(row.createdAt || row.created_at || row.acceptedAt))}</td></tr>`).join('');
    showModal(`Member · ${member.username}`, `ID ${member.id}`, `
      ${detailItems([['Status', member.status], ['Saldo', money(member.balance)], ['Email', member.email], ['Telepon', member.phone], ['Bank', member.bankName], ['Nama rekening', member.accountName], ['Nomor rekening', member.accountNumber], ['Terdaftar', date(member.createdAt)]])}
      <div class="panel-header" style="margin-top:20px"><div><h3>Ringkasan wallet</h3></div></div>
      <div class="table-wrap"><table><thead><tr><th>Jenis</th><th>Status</th><th>Jumlah</th><th>Nominal</th></tr></thead><tbody>${walletSummary.map(row => `<tr><td>${esc(row.requestType)}</td><td>${esc(row.status)}</td><td>${esc(row.count)}</td><td>${esc(money(row.amount))}</td></tr>`).join('') || '<tr><td class="empty-state" colspan="4">Tidak ada transaksi wallet.</td></tr>'}</tbody></table></div>
      <div class="panel-header" style="margin-top:20px"><div><h3>Ledger terbaru</h3></div></div>
      <div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Tipe</th><th>Nominal</th><th>Saldo setelah</th></tr></thead><tbody>${ledger.map(row => `<tr><td>${esc(date(row.createdAt || row.created_at))}</td><td>${esc(row.transactionType || row.transaction_type)}</td><td>${esc(money(row.amount ?? row.amountSigned))}</td><td>${esc(money(row.balanceAfter))}</td></tr>`).join('') || '<tr><td class="empty-state" colspan="4">Ledger kosong.</td></tr>'}</tbody></table></div>
      <div class="panel-header" style="margin-top:20px"><div><h3>Riwayat Market Play</h3></div></div>
      <div class="table-wrap"><table><thead><tr><th>ID / Tiket</th><th>Pasaran</th><th>Status</th><th>Nominal</th><th>Waktu</th></tr></thead><tbody>${marketRows || '<tr><td class="empty-state" colspan="5">Tidak ada riwayat pada 10 data terbaru.</td></tr>'}</tbody></table></div>
      <div class="panel-header" style="margin-top:20px"><div><h3>Riwayat Sportsbook</h3></div></div>
      <div class="table-wrap"><table><thead><tr><th>ID / Tiket</th><th>Status</th><th>Nominal</th><th>Waktu</th></tr></thead><tbody>${sportsRows || '<tr><td class="empty-state" colspan="4">Tidak ada riwayat pada 10 data terbaru.</td></tr>'}</tbody></table></div>`);
  }

  async function loadBets() {
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    const initialType = query.get('type') === 'sportsbook' ? 'sportsbook' : state.betType;
    state.betType = initialType;
    const filterKey = `bets-${state.betType}`;
    const filters = state.filters[filterKey] || (state.filters[filterKey] = { search: '', status: '', from: '', to: '' });
    const statusOptions = state.betType === 'market'
      ? ['', 'DRAFT', 'ACCEPTED', 'SETTLED_WON', 'SETTLED_LOST', 'CANCELLED', 'VOID']
      : ['', 'OPEN', 'WON', 'LOST', 'VOID', 'CASHED_OUT'];
    const html = `<div class="page-heading"><div><h2>Bet history</h2><p>Read-only monitoring of existing Market Play and Sportsbook betting lifecycles.</p></div>
      <div class="segmented" role="group" aria-label="Jenis taruhan"><button type="button" data-bet-type="market" aria-pressed="${initialType === 'market'}">Market Play</button><button type="button" data-bet-type="sportsbook" aria-pressed="${initialType === 'sportsbook'}">Sportsbook</button></div></div>
      <div class="notice">Filter dan pagination dijalankan oleh query baca backend. Halaman ini tidak mengubah tiket, settlement, atau payout.</div>
      <section class="panel"><div class="toolbar" style="margin-bottom:13px">
        <input class="filter-input search" id="searchFilter" value="${esc(filters.search)}" placeholder="Cari username, ID tiket, atau invoice" aria-label="Cari tiket">
        <select class="filter-select" id="statusFilter" aria-label="Filter status">${statusOptions.map(value => `<option value="${esc(value)}" ${filters.status === value ? 'selected' : ''}>${value ? esc(value) : 'Semua status'}</option>`).join('')}</select>
        <input class="filter-input" type="date" id="fromFilter" value="${esc(filters.from)}" aria-label="Tanggal mulai"><input class="filter-input" type="date" id="toFilter" value="${esc(filters.to)}" aria-label="Tanggal akhir">
        <button class="button" id="refreshTable">Refresh</button>
      </div><div class="table-wrap"><table><thead id="betHead"></thead><tbody id="betTable"></tbody></table></div><div id="pagination"></div></section>`;
    shell(html, titles.bets, 'Riwayat taruhan aktual · pemeriksaan saja.');
    const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1), offset: String((state.page - 1) * PAGE_SIZE) });
    if (filters.search) params.set('q', filters.search);
    if (filters.status) params.set('status', filters.status);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const endpoint = state.betType === 'market' ? '/admin-api/owner/bets' : '/admin-api/owner/sportsbook/bets';
    const result = await request(`${endpoint}?${params}`);
    const hasNext = result.length > PAGE_SIZE;
    state.betRows = result.slice(0, PAGE_SIZE);
    view('betHead').innerHTML = state.betType === 'market'
      ? '<tr><th>ID / Invoice</th><th>Member</th><th>Pasaran / periode</th><th>Nominal</th><th>Status</th><th>Waktu</th><th>Detail</th></tr>'
      : '<tr><th>ID / Invoice</th><th>Member</th><th>Pilihan</th><th>Nominal</th><th>Odds</th><th>Status settlement</th><th>Waktu</th><th>Detail</th></tr>';
    view('betTable').innerHTML = state.betRows.map(row => {
      const id = row.id;
      if (state.betType === 'market') {
        return `<tr><td><span class="cell-primary">${esc(row.invoice || id)}</span><div class="cell-sub">${esc(id)}</div></td><td>${esc(row.username)}</td><td>${esc(row.marketName || row.marketSlug || row.market || row.slug || '—')}<div class="cell-sub">${esc(row.period || '—')}</div></td><td>${esc(money(row.totalStake ?? row.stake ?? row.total_amount))}</td><td>${status(row.status)}</td><td>${esc(date(row.createdAt || row.created_at))}</td><td><button class="button" data-bet-detail="${esc(id)}">Detail</button></td></tr>`;
      }
      const legs = row.legs || [];
      const selections = legs.map(leg => [leg.home && leg.away ? `${leg.home} vs ${leg.away}` : '', leg.marketLabel || leg.marketType || '', leg.selectionLabel || leg.selection || leg.selectionName || leg.marketName || leg.market || ''].filter(Boolean).join(' · ') || '—').join(' · ');
      const odds = legs.map(leg => leg.acceptedOdds ?? leg.odds ?? leg.price ?? '—').join(' · ');
      return `<tr><td><span class="cell-primary">${esc(row.invoice || id)}</span><div class="cell-sub">${esc(id)}</div></td><td>${esc(row.username)}</td><td>${esc(selections || `${legs.length} leg`)}</td><td>${esc(money(row.totalStake ?? row.stake))}</td><td>${esc(odds || row.totalOdds || '—')}</td><td>${status(row.status)}</td><td>${esc(date(row.createdAt || row.created_at || row.acceptedAt))}</td><td><button class="button" data-bet-detail="${esc(id)}">Detail</button></td></tr>`;
    }).join('') || `<tr><td class="empty-state" colspan="${state.betType === 'market' ? '7' : '8'}">Tidak ada tiket yang sesuai.</td></tr>`;
    view('pagination').innerHTML = remoteFooter(hasNext, state.betRows.length);
    bindRemoteFilters(['searchFilter','statusFilter','fromFilter','toFilter'], () => {
      state.filters[filterKey] = {
        search: view('searchFilter').value.trim(), status: view('statusFilter').value,
        from: view('fromFilter').value, to: view('toFilter').value
      };
      return loadBets();
    });
    view('refreshTable').addEventListener('click', () => void loadCurrent().catch(showPageError));
  }

  async function showBet(id) {
    let row = state.betRows.find(item => item.id === id);
    if (!row) throw new Error('Tiket tidak tersedia di data yang dimuat.');
    if (state.betType === 'market') row = await request(`/admin-api/owner/bets/${encodeURIComponent(id)}`);
    const legs = row.items || row.legs || [];
    const legRows = legs.map((leg, index) => {
      const selection = [leg.home && leg.away ? `${leg.home} vs ${leg.away}` : '', leg.marketLabel || leg.marketType || '', leg.selectionLabel || leg.selection || leg.selection_value || leg.selectionName || leg.marketName || leg.market || ''].filter(Boolean).join(' · ') || '—';
      const result = leg.resultValue || leg.result_value || (leg.won === true ? 'WON' : leg.won === false ? 'LOST' : leg.resultStatus || leg.result_status || leg.status) || '—';
      return `<tr><td>${esc(leg.legNo ?? leg.leg_no ?? leg.lineNo ?? index + 1)}</td><td>${esc(selection)}</td><td>${esc(leg.acceptedOdds ?? leg.odds ?? leg.price ?? leg.payoutMultiplier ?? leg.payout_multiplier ?? '—')}</td><td>${esc(result)}</td><td>${esc(leg.payout ?? leg.payout_amount ?? '—')}</td></tr>`;
    }).join('');
    const fields = [
      ['Tiket', row.invoice || row.id], ['Member', row.username], ['Status', row.status],
      ['Settlement', row.settlementStatus || row.settlement_status || row.status], ['Nominal', money(row.totalStake ?? row.stake ?? row.total_amount)],
      ['Potensi payout', money(row.potentialPayout ?? row.potential_payout)], ['Payout', money(row.payout)],
      ['Odds / multiplier gabungan', row.totalOdds ?? row.combinedOdds ?? row.combined_odds], ['Dibuat / diterima', date(row.createdAt || row.created_at || row.acceptedAt)],
      ['Diselesaikan', date(row.settledAt || row.settled_at)], ['Hasil', row.result || row.resultValue || row.lastSettlementAction],
      ['Alasan', row.reason || row.failureReason || row.cancelReason]
    ];
    const legHeading = state.betType === 'market' ? 'Pilihan Market Play' : 'Pilihan Sportsbook';
    const multiplierLabel = state.betType === 'market' ? 'Multiplier' : 'Odds diterima';
    const resultLabel = state.betType === 'market' ? 'Menang / hasil' : 'Hasil settlement';
    showModal(`Bet · ${row.invoice || row.id}`, `${state.betType === 'market' ? 'Market Play' : 'Sportsbook'} · detail read-only`,
      `${detailItems(fields)}<div class="panel-header" style="margin-top:20px"><div><h3>${legHeading}</h3></div></div><div class="table-wrap"><table><thead><tr><th>No.</th><th>Pilihan</th><th>${multiplierLabel}</th><th>${resultLabel}</th><th>Nominal hasil</th></tr></thead><tbody>${legRows || '<tr><td colspan="5" class="empty-state">Detail pilihan tidak tersedia.</td></tr>'}</tbody></table></div>`);
  }

  async function loadActivity() {
    const filters = state.filters.activity || (state.filters.activity = { search: '', from: '', to: '' });
    const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1), offset: String((state.page - 1) * PAGE_SIZE) });
    if (filters.search) params.set('q', filters.search);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const result = await request(`/admin-api/owner/audit?${params}`);
    const hasNext = result.length > PAGE_SIZE;
    const rows = result.slice(0, PAGE_SIZE);
    const html = `<div class="page-heading"><div><h2>Activity log</h2><p>Audit penting OWNER dari database website · pagination server-side.</p></div><button class="button" id="refreshTable">Refresh</button></div>
      <section class="panel"><div class="toolbar" style="margin-bottom:13px">
        <input class="filter-input search" id="searchFilter" value="${esc(filters.search)}" placeholder="Cari tindakan atau referensi" aria-label="Cari aktivitas">
        <input class="filter-input" type="date" id="fromFilter" value="${esc(filters.from)}" aria-label="Tanggal mulai"><input class="filter-input" type="date" id="toFilter" value="${esc(filters.to)}" aria-label="Tanggal akhir">
      </div><div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Pelaku</th><th>Tindakan</th><th>Jenis target</th><th>Referensi</th><th>Detail aman</th></tr></thead><tbody id="activityTable"></tbody></table></div><div id="pagination"></div></section>`;
    shell(html, titles.activity, 'Catatan login, logout, perubahan kredensial, dan keputusan operasional.');
    view('activityTable').innerHTML = rows.map(row => {
      const safeDetails = row.details && typeof row.details === 'object'
        ? Object.entries(row.details).filter(([key]) => !/password|token|secret|credential/i.test(key)).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ')
        : '';
      return `<tr><td>${esc(date(row.created_at))}</td><td>${esc(row.actor_role || 'OWNER')}<div class="cell-sub">${esc(row.actor_id || '')}</div></td><td class="cell-primary">${esc(row.action)}</td><td>${esc(row.target_type || '—')}</td><td class="cell-sub">${esc(row.target_id || '—')}</td><td>${esc(safeDetails || '—')}</td></tr>`;
    }).join('') || '<tr><td class="empty-state" colspan="6">Tidak ada aktivitas pada filter ini.</td></tr>';
    view('pagination').innerHTML = remoteFooter(hasNext, rows.length);
    bindRemoteFilters(['searchFilter','fromFilter','toFilter'], () => {
      state.filters.activity = {
        search: view('searchFilter').value.trim(), from: view('fromFilter').value, to: view('toFilter').value
      };
      return loadActivity();
    });
    view('refreshTable').addEventListener('click', () => void loadCurrent().catch(showPageError));
  }

  function loadAccount() {
    const user = state.me.user;
    const html = `<div class="page-heading"><div><h2>Owner account</h2><p>Credential changes are verified and recorded without logging secret values.</p></div></div>
      <div class="account-grid">
        <section class="panel"><div class="panel-header"><div><h3>Identitas akun</h3><p>OWNER tunggal untuk back-office</p></div>${status(user.status)}</div>
          ${detailItems([['Username', user.username], ['Role', 'OWNER'], ['Email', user.email], ['Phone', user.phone], ['Sesi', 'HttpOnly cookie · CSRF protected'], ['Masa sesi', 'Idle timeout sesuai konfigurasi server']])}
          <div class="notice warning" style="margin-top:14px">Tidak ada menu perubahan saldo member. Pengelolaan transaksi tetap melalui alur wallet resmi.</div>
        </section>
        <section class="panel"><div class="panel-header"><div><h3>Ubah password</h3><p>Password lama wajib diverifikasi sebelum perubahan.</p></div></div>
          <form class="settings-form" id="passwordForm">
            <label class="field"><span>Password saat ini</span><input id="currentPassword" type="password" autocomplete="current-password" required></label>
            <label class="field"><span>Password baru</span><input id="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required><small class="metric-note">10–128 karakter.</small></label>
            <label class="field"><span>Ulangi password baru</span><input id="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
            <button class="button button-primary" id="changePassword" type="submit">Simpan password baru</button>
          </form>
        </section>
      </div>`;
    shell(html, titles.account, 'Profil dan keamanan sesi OWNER.');
    view('passwordForm').addEventListener('submit', async event => {
      event.preventDefault();
      const current = view('currentPassword').value;
      const next = view('newPassword').value;
      const confirmation = view('confirmPassword').value;
      if (next !== confirmation) { showToast('Konfirmasi password baru tidak cocok.', true); return; }
      const button = view('changePassword');
      button.disabled = true;
      try {
        const result = await request('/admin-api/owner/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: current, newPassword: next })
        });
        view('passwordForm').reset();
        showToast(`Password diperbarui. ${result.revokedSessions} sesi OWNER lain telah dicabut.`);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function loadCurrent() {
    const loaders = {
      dashboard: loadDashboard, deposits: loadWallets, withdrawals: loadWallets,
      members: loadMembers, bets: loadBets, activity: loadActivity, account: loadAccount
    };
    try { await loaders[state.view](); }
    catch (error) { showPageError(error); }
  }

  function showPageError(error) {
    if (error?.message) errorPage(error, loadCurrent);
    else showToast('Tindakan tidak dapat diselesaikan.', true);
  }

  async function logout() {
    try {
      await request('/admin-api/owner/logout', { method: 'POST', body: '{}' });
      location.replace('index.html');
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function closeMenu() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  }

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const page = target.closest('[data-page]');
    if (page && !page.hasAttribute('disabled')) {
      state.page = Number(page.dataset.page);
      void loadCurrent();
      return;
    }
    const detail = target.closest('[data-detail]');
    if (detail) {
      const row = state.walletRows.find(item => item.id === detail.dataset.detail);
      if (row) walletDetail(row);
      return;
    }
    const walletAction = target.closest('[data-wallet]');
    if (walletAction) {
      processWallet(walletAction.dataset.wallet, walletAction.dataset.action).catch(showPageError);
      return;
    }
    const member = target.closest('[data-member]');
    if (member) { showMember(member.dataset.member).catch(showPageError); return; }
    const betDetail = target.closest('[data-bet-detail]');
    if (betDetail) { showBet(betDetail.dataset.betDetail).catch(showPageError); return; }
    const betType = target.closest('[data-bet-type]');
    if (betType) {
      state.betType = betType.dataset.betType;
      state.page = 1;
      void loadCurrent();
      return;
    }
    if (target.closest('#sidebarLogout')) { void logout(); return; }
    if (target.closest('#modalClose') || target === modal) closeModal();
    if (target === overlay) closeMenu();
    if (target.closest('[data-view]')) closeMenu();
  });

  window.addEventListener('hashchange', () => {
    const selected = location.hash.replace(/^#\/?/, '').split('?')[0];
    state.view = Object.hasOwn(titles, selected) ? selected : 'dashboard';
    state.page = 1;
    void loadCurrent();
  });

  view('modalClose').addEventListener('click', closeModal);
  view('mobileMenu').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  });
  view('clock').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  setInterval(() => {
    view('clock').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  }, 60000);

  request('/admin-api/owner/me')
    .then(me => {
      if (me.user?.username !== 'gasterus' || !(me.roles || []).includes('OWNER')) {
        throw new Error('Sesi ini tidak memiliki akses OWNER.');
      }
      state.me = { ...me, csrfToken: me.csrfToken };
      view('sidebarOwner').textContent = me.user.username;
      const selected = location.hash.replace(/^#\/?/, '').split('?')[0];
      state.view = Object.hasOwn(titles, selected) ? selected : 'dashboard';
      if (!location.hash) history.replaceState(null, '', '#/dashboard');
      void loadCurrent();
    })
    .catch(error => {
      if (error.message.includes('Sesi OWNER') || error.message.includes('tidak memiliki akses')) {
        location.replace('index.html');
        return;
      }
      errorPage(error, () => location.reload());
    });
})();
