import { APPS_SCRIPT_URL } from '../core/constants';
import { addActivityLog, clearActivityLogs, listActivityLogs, type ActivityLogEntry } from '../storage/activity';
import {
  getAdminConfig,
  listAdminUsers,
  listNseMaster,
  listPendingRequests,
  listTickerRequestsAdmin,
  replaceNseMaster,
  reviewPendingRequest,
  resolveTickerRequestAdmin,
  setAdminConfig,
  trimSnapshots,
  updateAdminUser,
  type AdminUserRow,
  type PendingRequest,
  type TickerAdminRequest
} from '../services/admin';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
import { renderShell, bindShell } from '../ui/shell';
import { lucideIcon } from '../ui/icons';
import { parseCsvText } from '../utils/csv';
import { toErrorMessage } from '../utils/errors';
import type { UserRole, UserSession } from '../core/types';
import { initCloudSync } from '../services/cloudSync';
import { requireSession } from './guards';

type NseRow = { symbol: string; name: string; isin: string };
type NseAnalysis = {
  total: number;
  validRows: NseRow[];
  invalidRows: Array<{ symbol: string; reason: string }>;
};

function normalizeHeader(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function headerIndex(headers: string[], options: string[]): number {
  const normalized = headers.map(normalizeHeader);
  const wanted = options.map(normalizeHeader);
  return normalized.findIndex((header) => wanted.includes(header));
}

function parseNseRows(text: string): { rows: NseRow[]; total: number } {
  const parsed = parseCsvText(text);
  if (!parsed.headers.length) return { rows: [], total: 0 };
  const symbolIdx = headerIndex(parsed.headers, ['symbol', 'ticker']);
  const nameIdx = headerIndex(parsed.headers, ['name', 'company', 'name_of_company', 'company_name']);
  const isinIdx = headerIndex(parsed.headers, ['isin', 'isin_code', 'isin_number']);
  if (symbolIdx < 0 || nameIdx < 0) {
    throw new Error('CSV must include headers for symbol/ticker and name/company.');
  }

  const rows: NseRow[] = [];
  parsed.body.forEach((row) => {
    const symbol = String(row[symbolIdx] || '').trim().toUpperCase();
    const name = String(row[nameIdx] || '').trim();
    const isin = isinIdx >= 0 ? String(row[isinIdx] || '').trim() : '';
    if (!symbol && !name && !isin) return;
    rows.push({ symbol, name, isin });
  });
  return { rows, total: rows.length };
}

function analyzeNseRows(rows: NseRow[]): NseAnalysis {
  const seen = new Set<string>();
  const validRows: NseRow[] = [];
  const invalidRows: Array<{ symbol: string; reason: string }> = [];

  rows.forEach((row) => {
    const symbol = row.symbol.trim().toUpperCase();
    const name = row.name.trim();
    if (!symbol || !name) {
      invalidRows.push({ symbol: symbol || '(missing)', reason: 'Missing symbol or name' });
      return;
    }
    if (seen.has(symbol)) {
      invalidRows.push({ symbol, reason: 'Duplicate symbol' });
      return;
    }
    seen.add(symbol);
    validRows.push({ ...row, symbol, name });
  });

  return {
    total: rows.length,
    validRows,
    invalidRows
  };
}

function renderPendingRows(rows: PendingRequest[]): string {
  if (!rows.length) {
    return '<tr><td colspan="4" class="text-muted text-center py-3">No pending requests.</td></tr>';
  }
  return rows
    .map(
      (row) => `
      <tr data-request-id="${row.requestId}">
        <td>${row.name}</td>
        <td>${row.loginId}</td>
        <td>${row.requestedAt}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-success me-2" data-action="approve">Approve</button>
          <button class="btn btn-sm btn-outline-danger" data-action="reject">Reject</button>
        </td>
      </tr>
    `
    )
    .join('');
}

function renderUserRows(rows: AdminUserRow[], currentUserId: string): string {
  if (!rows.length) {
    return '<tr><td colspan="5" class="text-muted text-center py-3">No users found.</td></tr>';
  }
  return rows
    .map((row) => {
      const roleLabel = row.role === 'ADMIN' ? 'ADMIN' : 'USER';
      const statusLabel = row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
      const isSelf = row.userId === currentUserId;
      return `
        <tr data-user-id="${row.userId}">
          <td>${row.name}</td>
          <td>${row.loginId}</td>
          <td><span class="badge ${roleLabel === 'ADMIN' ? 'text-bg-dark' : 'text-bg-secondary'}">${roleLabel}</span></td>
          <td><span class="badge ${statusLabel === 'ACTIVE' ? 'text-bg-success' : 'text-bg-danger'}">${statusLabel}</span></td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-primary me-2" data-action="toggle-role">Make ${roleLabel === 'ADMIN' ? 'User' : 'Admin'}</button>
            <button class="btn btn-sm btn-outline-secondary" data-action="toggle-status" ${isSelf ? 'disabled' : ''}>
              ${statusLabel === 'ACTIVE' ? 'Disable' : 'Activate'}
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderTickerRequestRows(rows: TickerAdminRequest[]): string {
  if (!rows.length) {
    return '<tr><td colspan="7" class="text-muted text-center py-3">No ticker requests.</td></tr>';
  }
  return rows
    .map((row) => {
      const status = String(row.status || '').toUpperCase();
      const badge =
        status === 'APPROVED' ? 'text-bg-success' : status === 'REJECTED' ? 'text-bg-danger' : 'text-bg-warning';
      const resolvedTicker = row.resolvedTicker || row.rawSymbol || '';
      return `
        <tr data-ticker-request-id="${row.requestId}">
          <td class="fw-semibold">${row.userName}</td>
          <td>${row.rawSymbol}</td>
          <td><span class="badge ${badge}">${status || 'PENDING'}</span></td>
          <td>${row.requestedAt || '--'}</td>
          <td>
            <input class="form-control form-control-sm" data-field="resolvedTicker" value="${resolvedTicker}" />
          </td>
          <td>
            <input class="form-control form-control-sm" data-field="resolvedName" placeholder="Company name" />
          </td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-success me-2" data-action="approve">Approve</button>
            <button class="btn btn-sm btn-outline-danger" data-action="reject">Reject</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderLogRows(entries: ActivityLogEntry[], filterType: string, query: string): string {
  const filtered = entries.filter((row) => {
    const matchesType = filterType === 'all' || row.type === filterType;
    const matchesQuery = !query || row.detail.toLowerCase().includes(query);
    return matchesType && matchesQuery;
  });

  if (!filtered.length) {
    return '<li class="list-group-item text-muted">No activity yet.</li>';
  }

  return filtered
    .map(
      (row) => `
      <li class="list-group-item d-flex justify-content-between align-items-start">
        <div>
          <div class="fw-semibold text-capitalize">${row.type}</div>
          <div class="small text-muted">${row.detail}</div>
        </div>
        <span class="text-muted small">${new Date(row.ts).toLocaleString()}</span>
      </li>
    `
    )
    .join('');
}

export function renderAdminView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading admin panel...</div>';

  void (async () => {
    const session = await requireSession('ADMIN');
    if (!session) return;

    const initialTab = window.location.hash.replace('#', '') || 'users';
    const adminQuickNav = [
      { id: 'users', label: 'Users', href: 'admin.html#users', adminTab: 'users', icon: 'users' },
      { id: 'system', label: 'Settings', href: 'admin.html#system', adminTab: 'system', icon: 'settings' },
      { id: 'tickers', label: 'NSE Master', href: 'admin.html#tickers', adminTab: 'tickers', icon: 'database' },
      { id: 'logs', label: 'Log Summary', href: 'admin.html#logs', adminTab: 'logs', icon: 'activity' }
    ];

    root.innerHTML = renderShell({
      session,
      active: 'admin',
      title: 'Admin Control',
      subtitle: 'Approve users, tune sync settings, and manage NSE master data.',
      quickNav: adminQuickNav,
      quickNavActive: initialTab,
      content: `
        <div id="admin-feedback" class="alert d-none" role="alert"></div>

        <div class="row g-3 mb-3">
          <div class="col-sm-6 col-xl-3">
            <div class="card shadow-sm border-0">
              <div class="card-body d-flex align-items-center justify-content-between">
                <div>
                  <div class="text-muted small">Pending Requests</div>
                  <div class="h5 mb-0" id="kpi-pending">--</div>
                </div>
                <span class="text-primary">${lucideIcon('user-check')}</span>
              </div>
            </div>
          </div>
          <div class="col-sm-6 col-xl-3">
            <div class="card shadow-sm border-0">
              <div class="card-body d-flex align-items-center justify-content-between">
                <div>
                  <div class="text-muted small">Active Users</div>
                  <div class="h5 mb-0" id="kpi-active">--</div>
                </div>
                <span class="text-success">${lucideIcon('users')}</span>
              </div>
            </div>
          </div>
          <div class="col-sm-6 col-xl-3">
            <div class="card shadow-sm border-0">
              <div class="card-body d-flex align-items-center justify-content-between">
                <div>
                  <div class="text-muted small">NSE Master</div>
                  <div class="h5 mb-0" id="kpi-nse">--</div>
                </div>
                <span class="text-info">${lucideIcon('database')}</span>
              </div>
            </div>
          </div>
          <div class="col-sm-6 col-xl-3">
            <div class="card shadow-sm border-0">
              <div class="card-body d-flex align-items-center justify-content-between">
                <div>
                  <div class="text-muted small">Snapshot Limit</div>
                  <div class="h5 mb-0" id="kpi-snapshots">--</div>
                </div>
                <span class="text-warning">${lucideIcon('archive')}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="tab-content">
          <section class="tab-pane show active" id="admin-tab-users" data-admin-panel="users">
            <div class="row g-3">
              <div class="col-12 col-xl-5">
                <div class="card shadow-sm border-0 h-100">
                  <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                      <div>
                        <h2 class="h6 mb-0 section-title">
                          <span class="section-icon">${lucideIcon('user-plus')}</span>
                          Pending Requests
                        </h2>
                        <div class="text-muted small" id="pending-count">Loading...</div>
                      </div>
                      <button class="btn btn-sm btn-outline-primary" id="pending-refresh">Refresh</button>
                    </div>
                    <div class="table-responsive">
                      <table class="table table-sm align-middle mb-0">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Login</th>
                            <th>Requested</th>
                            <th class="text-end">Action</th>
                          </tr>
                        </thead>
                        <tbody id="pending-body"></tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-12 col-xl-7">
                <div class="card shadow-sm border-0 h-100">
                  <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                      <div>
                        <h2 class="h6 mb-0 section-title">
                          <span class="section-icon">${lucideIcon('user-check')}</span>
                          Approved Users
                        </h2>
                        <div class="text-muted small" id="users-count">Loading...</div>
                      </div>
                      <button class="btn btn-sm btn-outline-primary" id="users-refresh">Refresh</button>
                    </div>
                    <div class="table-responsive">
                      <table class="table table-sm align-middle mb-0">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Login</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th class="text-end">Action</th>
                          </tr>
                        </thead>
                        <tbody id="users-body"></tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="tab-pane" id="admin-tab-system" data-admin-panel="system">
            <div class="row g-3">
              <div class="col-xl-6">
                <div class="card shadow-sm border-0">
                  <div class="card-body">
                    <h2 class="h6 mb-3 section-title">
                      <span class="section-icon">${lucideIcon('sliders')}</span>
                      Sync &amp; Limits
                    </h2>
                    <div class="row g-3">
                      <div class="col-md-6">
                        <label class="form-label">Live price interval (sec)</label>
                        <input class="form-control" type="number" min="10" id="config-live-price" />
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Cloud sync interval (min)</label>
                        <input class="form-control" type="number" min="1" id="config-cloud-sync" />
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Snapshot limit</label>
                        <input class="form-control" type="number" min="1" id="config-snapshots" />
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Daily retention (days)</label>
                        <input class="form-control" type="number" min="1" id="config-snapshot-days" />
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Monthly retention (months)</label>
                        <input class="form-control" type="number" min="1" id="config-snapshot-months" />
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Toast auto-close (sec)</label>
                        <input class="form-control" type="number" min="1" id="config-toast-close" />
                      </div>
                    </div>
                    <div class="d-flex flex-wrap gap-2 mt-3">
                      <button class="btn btn-primary" id="config-save">Save Settings</button>
                      <button class="btn btn-outline-secondary" id="config-trim">Trim Snapshots</button>
                    </div>
                    <div class="text-muted small mt-2">Intervals apply per user session and auto-sync jobs.</div>
                  </div>
                </div>
              </div>
              <div class="col-xl-6">
                <div class="card shadow-sm border-0 h-100">
                  <div class="card-body">
                    <h2 class="h6 mb-3 section-title">
                      <span class="section-icon">${lucideIcon('activity')}</span>
                      System Summary
                    </h2>
                    <div class="d-flex flex-column gap-2">
                      <div class="d-flex align-items-center justify-content-between">
                        <span class="text-muted">Active Users</span>
                        <strong id="system-active-users">--</strong>
                      </div>
                      <div class="d-flex align-items-center justify-content-between">
                        <span class="text-muted">Pending Requests</span>
                        <strong id="system-pending-users">--</strong>
                      </div>
                      <div class="d-flex align-items-center justify-content-between">
                        <span class="text-muted">NSE Master Rows</span>
                        <strong id="system-nse-total">--</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="tab-pane" id="admin-tab-tickers" data-admin-panel="tickers">
            <div class="row g-3">
              <div class="col-xl-5">
                <div class="card shadow-sm border-0 h-100">
                  <div class="card-body">
                    <h2 class="h6 mb-3 section-title">
                      <span class="section-icon">${lucideIcon('database')}</span>
                      NSE Master Summary
                    </h2>
                    <div class="d-flex align-items-center justify-content-between mb-2">
                      <span class="text-muted">Total tickers</span>
                      <strong id="nse-total">--</strong>
                    </div>
                    <div class="d-flex align-items-center justify-content-between mb-2">
                      <span class="text-muted">Valid tickers</span>
                      <strong id="nse-valid">--</strong>
                    </div>
                    <div class="d-flex align-items-center justify-content-between">
                      <span class="text-muted">Invalid tickers</span>
                      <strong id="nse-invalid">--</strong>
                    </div>
                    <div class="mt-3">
                      <h3 class="h6 mb-2">Invalid Summary</h3>
                      <ul class="small text-muted mb-0" id="nse-invalid-list"></ul>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-xl-7">
                <div class="card shadow-sm border-0 h-100">
                  <div class="card-body">
                    <h2 class="h6 mb-3 section-title">
                      <span class="section-icon">${lucideIcon('upload')}</span>
                      Upload NSE Master
                    </h2>
                    <div class="d-flex flex-column gap-2">
                      <input class="form-control" type="file" accept=".csv" id="nse-file" />
                      <div class="text-muted small" id="nse-file-status">
                        CSV headers required: symbol/ticker, name/company, optional isin.
                      </div>
                    </div>
                    <div class="d-flex flex-wrap gap-2 mt-3">
                      <button class="btn btn-primary" id="nse-upload" disabled>Replace NSE Master</button>
                      <button class="btn btn-outline-secondary" id="nse-refresh">Refresh</button>
                    </div>
                    <div class="mt-3 small text-muted" id="nse-preview"></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="row g-3 mt-1">
              <div class="col-12">
                <div class="card shadow-sm border-0">
                  <div class="card-body">
                    <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                      <div>
                        <h2 class="h6 mb-0 section-title">
                          <span class="section-icon">${lucideIcon('send')}</span>
                          Ticker Requests
                        </h2>
                        <div class="text-muted small" id="ticker-req-count">Loading...</div>
                      </div>
                      <button class="btn btn-sm btn-outline-primary" id="ticker-req-refresh">Refresh</button>
                    </div>
                    <div class="table-responsive">
                      <table class="table table-sm align-middle mb-0">
                        <thead>
                          <tr>
                            <th>User</th>
                            <th>Requested</th>
                            <th>Status</th>
                            <th>Requested At</th>
                            <th>Resolved Ticker</th>
                            <th>Resolved Name</th>
                            <th class="text-end">Action</th>
                          </tr>
                        </thead>
                        <tbody id="ticker-req-body"></tbody>
                      </table>
                    </div>
                    <div class="text-muted small mt-2">Approving will add the ticker to NSE Master.</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="tab-pane" id="admin-tab-logs" data-admin-panel="logs">
            <div class="card shadow-sm border-0">
              <div class="card-body">
                <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center mb-3">
                  <div>
                    <h2 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('list')}</span>
                      Activity Log
                    </h2>
                    <div class="text-muted small">Recent admin actions stored locally.</div>
                  </div>
                  <button class="btn btn-outline-danger btn-sm" id="logs-clear">Clear Logs</button>
                </div>
                <div class="d-flex flex-wrap gap-2 mb-3">
                  <select class="form-select form-select-sm w-auto" id="logs-filter">
                    <option value="all">All</option>
                    <option value="auth">Auth</option>
                    <option value="config">Config</option>
                    <option value="ticker">Ticker</option>
                  </select>
                  <input class="form-control form-control-sm" type="text" placeholder="Search logs" id="logs-search" />
                </div>
                <ul class="list-group" id="logs-list"></ul>
              </div>
            </div>
          </section>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#admin-feedback');
    const tabButtons = root.querySelectorAll<HTMLElement>('[data-admin-tab]');
    const tabPanels = root.querySelectorAll<HTMLElement>('[data-admin-panel]');
    const pendingBody = root.querySelector<HTMLTableSectionElement>('#pending-body');
    const usersBody = root.querySelector<HTMLTableSectionElement>('#users-body');
    const pendingCount = root.querySelector<HTMLDivElement>('#pending-count');
    const usersCount = root.querySelector<HTMLDivElement>('#users-count');
    const kpiPending = root.querySelector<HTMLElement>('#kpi-pending');
    const kpiActive = root.querySelector<HTMLElement>('#kpi-active');
    const kpiNse = root.querySelector<HTMLElement>('#kpi-nse');
    const kpiSnapshots = root.querySelector<HTMLElement>('#kpi-snapshots');
    const pendingRefresh = root.querySelector<HTMLButtonElement>('#pending-refresh');
    const usersRefresh = root.querySelector<HTMLButtonElement>('#users-refresh');
    const configLive = root.querySelector<HTMLInputElement>('#config-live-price');
    const configCloud = root.querySelector<HTMLInputElement>('#config-cloud-sync');
    const configSnapshots = root.querySelector<HTMLInputElement>('#config-snapshots');
    const configSnapshotDays = root.querySelector<HTMLInputElement>('#config-snapshot-days');
    const configSnapshotMonths = root.querySelector<HTMLInputElement>('#config-snapshot-months');
    const configToastClose = root.querySelector<HTMLInputElement>('#config-toast-close');
    const configSave = root.querySelector<HTMLButtonElement>('#config-save');
    const configTrim = root.querySelector<HTMLButtonElement>('#config-trim');
    const systemActiveUsers = root.querySelector<HTMLElement>('#system-active-users');
    const systemPendingUsers = root.querySelector<HTMLElement>('#system-pending-users');
    const systemNseTotal = root.querySelector<HTMLElement>('#system-nse-total');
    const nseTotal = root.querySelector<HTMLElement>('#nse-total');
    const nseValid = root.querySelector<HTMLElement>('#nse-valid');
    const nseInvalid = root.querySelector<HTMLElement>('#nse-invalid');
    const nseInvalidList = root.querySelector<HTMLUListElement>('#nse-invalid-list');
    const nseFile = root.querySelector<HTMLInputElement>('#nse-file');
    const nseFileStatus = root.querySelector<HTMLDivElement>('#nse-file-status');
    const nseUpload = root.querySelector<HTMLButtonElement>('#nse-upload');
    const nseRefresh = root.querySelector<HTMLButtonElement>('#nse-refresh');
    const nsePreview = root.querySelector<HTMLDivElement>('#nse-preview');
    const tickerReqBody = root.querySelector<HTMLTableSectionElement>('#ticker-req-body');
    const tickerReqCount = root.querySelector<HTMLElement>('#ticker-req-count');
    const tickerReqRefresh = root.querySelector<HTMLButtonElement>('#ticker-req-refresh');
    const logsList = root.querySelector<HTMLUListElement>('#logs-list');
    const logsFilter = root.querySelector<HTMLSelectElement>('#logs-filter');
    const logsSearch = root.querySelector<HTMLInputElement>('#logs-search');
    const logsClear = root.querySelector<HTMLButtonElement>('#logs-clear');

    if (
      !feedback ||
      !pendingBody ||
      !usersBody ||
      !pendingCount ||
      !usersCount ||
      !kpiPending ||
      !kpiActive ||
      !kpiNse ||
      !kpiSnapshots ||
      !pendingRefresh ||
      !usersRefresh ||
      !configLive ||
      !configCloud ||
      !configSnapshots ||
      !configSnapshotDays ||
      !configSnapshotMonths ||
      !configToastClose ||
      !configSave ||
      !configTrim ||
      !systemActiveUsers ||
      !systemPendingUsers ||
      !systemNseTotal ||
      !nseTotal ||
      !nseValid ||
      !nseInvalid ||
      !nseInvalidList ||
      !nseFile ||
      !nseFileStatus ||
      !nseUpload ||
      !nseRefresh ||
      !nsePreview ||
      !tickerReqBody ||
      !tickerReqCount ||
      !tickerReqRefresh ||
      !logsList ||
      !logsFilter ||
      !logsSearch ||
      !logsClear
    ) {
      throw new Error('Admin view failed to initialize');
    }

    let currentSession: UserSession | null = session;
    let pendingRows: PendingRequest[] = [];
    let usersRows: AdminUserRow[] = [];
    let nseRows: NseRow[] = [];
    let nseAnalysis: NseAnalysis | null = null;
    let tickerRequestRows: TickerAdminRequest[] = [];
    let autoTrimTimer: number | null = null;

    const scheduleAutoTrim = (intervalMin: number) => {
      if (autoTrimTimer) {
        window.clearInterval(autoTrimTimer);
      }
      if (!currentSession?.adminSessionToken) return;
      const intervalMs = Math.max(1, Math.floor(intervalMin)) * 60 * 1000;
      autoTrimTimer = window.setInterval(async () => {
        if (!currentSession?.adminSessionToken) return;
        try {
          await trimSnapshots({
            adminUserId: currentSession.userId,
            adminToken: currentSession.adminSessionToken
          });
        } catch {
          // Auto-trim should be quiet on failure.
        }
      }, intervalMs);
    };

    const setTab = (name: string) => {
      tabButtons.forEach((btn) => {
        const isActive = btn.dataset.adminTab === name;
        btn.classList.toggle('active', isActive);
      });
      tabPanels.forEach((panel) => {
        panel.classList.toggle('show', panel.dataset.adminPanel === name);
        panel.classList.toggle('active', panel.dataset.adminPanel === name);
      });
      if (name) {
        window.location.hash = name;
      }
    };

    tabButtons.forEach((btn) =>
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        setTab(btn.dataset.adminTab || 'users');
      })
    );

    window.addEventListener('hashchange', () => {
      const nextTab = window.location.hash.replace('#', '') || 'users';
      setTab(nextTab);
    });

    const refreshLogs = async () => {
      const entries = await listActivityLogs(200);
      const filter = logsFilter.value;
      const query = logsSearch.value.trim().toLowerCase();
      logsList.innerHTML = renderLogRows(entries, filter, query);
    };

    const refreshNseSummary = (rows: NseRow[]) => {
      const analysis = analyzeNseRows(rows);
      nseTotal.textContent = String(analysis.total);
      nseValid.textContent = String(analysis.validRows.length);
      nseInvalid.textContent = String(analysis.invalidRows.length);
      systemNseTotal.textContent = String(analysis.total);
      kpiNse.textContent = String(analysis.total);
      nseInvalidList.innerHTML = analysis.invalidRows.length
        ? analysis.invalidRows.slice(0, 6).map((row) => `<li>${row.symbol}: ${row.reason}</li>`).join('')
        : '<li class="text-muted">No invalid tickers found.</li>';
    };

    const refreshAdminData = async () => {
      if (!currentSession?.adminSessionToken) {
        showAlert(feedback, 'warning', 'Admin session expired. Please login again.');
        window.location.href = 'index.html';
        return;
      }
      if (!APPS_SCRIPT_URL) {
        showAlert(feedback, 'warning', 'Apps Script URL is missing. Configure VITE_APPS_SCRIPT_URL.');
        return;
      }

      clearAlert(feedback);
      const adminToken = currentSession.adminSessionToken;
      try {
        const [pending, users, config, master, tickerRequests] = await Promise.all([
          listPendingRequests(currentSession.userId, adminToken),
          listAdminUsers(currentSession.userId, adminToken),
          getAdminConfig(currentSession.userId, adminToken),
          listNseMaster(currentSession.userId, adminToken),
          listTickerRequestsAdmin(currentSession.userId, adminToken)
        ]);

        pendingRows = pending.filter((row) => String(row.status || '').toUpperCase() === 'PENDING');
        usersRows = users;
        nseRows = master.map((row) => ({
          symbol: row.symbol || '',
          name: row.name || '',
          isin: row.isin || ''
        }));
        tickerRequestRows = tickerRequests.filter(
          (row) => String(row.status || '').toUpperCase() === 'PENDING'
        );

        pendingBody.innerHTML = renderPendingRows(pendingRows);
        usersBody.innerHTML = renderUserRows(usersRows, currentSession.userId);
        pendingCount.textContent = `${pendingRows.length} pending`;
        usersCount.textContent = `${usersRows.length} users`;
        kpiPending.textContent = String(pendingRows.length);
        kpiActive.textContent = String(usersRows.filter((row) => row.status === 'ACTIVE').length);

        configLive.value = String(config.livePriceRefreshSec || 60);
        configCloud.value = String(config.cloudSyncIntervalMin || 10);
        configSnapshots.value = String(config.maxSnapshots || 10);
        configSnapshotDays.value = String(config.snapshotDailyDays || 30);
        configSnapshotMonths.value = String(config.snapshotMonthlyMonths || 12);
        configToastClose.value = String(config.toastAutoCloseSec || 7);
        kpiSnapshots.textContent = String(config.maxSnapshots || 10);
        scheduleAutoTrim(config.cloudSyncIntervalMin || 10);

        systemActiveUsers.textContent = String(usersRows.filter((row) => row.status === 'ACTIVE').length);
        systemPendingUsers.textContent = String(pendingRows.length);
        refreshNseSummary(nseRows);
        tickerReqBody.innerHTML = renderTickerRequestRows(tickerRequestRows);
        tickerReqCount.textContent = `${tickerRequestRows.length} pending`;
        await refreshLogs();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    };

    pendingRefresh.addEventListener('click', refreshAdminData);
    usersRefresh.addEventListener('click', refreshAdminData);
    nseRefresh.addEventListener('click', refreshAdminData);
    tickerReqRefresh.addEventListener('click', refreshAdminData);

    pendingBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLButtonElement | null;
      if (!target || !currentSession?.adminSessionToken) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-request-id]');
      if (!row) return;
      const requestId = row.dataset.requestId || '';
      if (!requestId) return;
      const action = target.dataset.action;
      if (action !== 'approve' && action !== 'reject') return;

      const label = target.textContent || 'Approve';
      setBusy(target, true, label);
      try {
        await reviewPendingRequest({
          adminUserId: currentSession.userId,
          adminToken: currentSession.adminSessionToken,
          requestId,
          decision: action === 'approve' ? 'approve' : 'reject'
        });
        await addActivityLog('auth', `${action === 'approve' ? 'Approved' : 'Rejected'} request ${requestId}`);
        await refreshAdminData();
        showAlert(feedback, 'success', `Request ${action}d successfully.`);
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(target, false, label);
      }
    });

    usersBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLButtonElement | null;
      if (!target || !currentSession?.adminSessionToken) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-user-id]');
      if (!row) return;
      const userId = row.dataset.userId || '';
      if (!userId) return;
      const action = target.dataset.action;
      if (action !== 'toggle-role' && action !== 'toggle-status') return;

      const roleCell = row.children[2]?.textContent || '';
      const statusCell = row.children[3]?.textContent || '';
      const nextRole: UserRole = roleCell.includes('ADMIN') ? 'USER' : 'ADMIN';
      const nextStatus = statusCell.includes('DISABLED') ? 'ACTIVE' : 'DISABLED';

      const label = target.textContent || 'Update';
      setBusy(target, true, label);
      try {
        await updateAdminUser({
          adminUserId: currentSession.userId,
          adminToken: currentSession.adminSessionToken,
          userId,
          role: action === 'toggle-role' ? nextRole : undefined,
          status: action === 'toggle-status' ? (nextStatus as 'ACTIVE' | 'DISABLED') : undefined
        });
        await addActivityLog(
          'auth',
          `${action === 'toggle-role' ? 'Role' : 'Status'} updated for user ${userId}`
        );
        await refreshAdminData();
        showAlert(feedback, 'success', 'User updated.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(target, false, label);
      }
    });

    configSave.addEventListener('click', async () => {
      if (!currentSession?.adminSessionToken) return;
      clearAlert(feedback);
      const label = configSave.textContent || 'Save Settings';
      setBusy(configSave, true, label);
      try {
        await setAdminConfig({
          adminUserId: currentSession.userId,
          adminToken: currentSession.adminSessionToken,
          maxSnapshots: Number(configSnapshots.value || 10),
          livePriceRefreshSec: Number(configLive.value || 60),
          cloudSyncIntervalMin: Number(configCloud.value || 10),
          toastAutoCloseSec: Number(configToastClose.value || 7),
          snapshotDailyDays: Number(configSnapshotDays.value || 30),
          snapshotMonthlyMonths: Number(configSnapshotMonths.value || 12)
        });
        document.documentElement.dataset.toastAutoCloseSec = String(Number(configToastClose.value || 7));
        scheduleAutoTrim(Number(configCloud.value || 10));
        await addActivityLog('config', 'System settings updated');
        showAlert(feedback, 'success', 'Settings saved.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(configSave, false, label);
      }
    });

    configTrim.addEventListener('click', async () => {
      if (!currentSession?.adminSessionToken) return;
      const label = configTrim.textContent || 'Trim Snapshots';
      setBusy(configTrim, true, label);
      try {
        await trimSnapshots({
          adminUserId: currentSession.userId,
          adminToken: currentSession.adminSessionToken
        });
        await addActivityLog('config', 'Snapshots trimmed');
        showAlert(feedback, 'success', 'Snapshots trimmed.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(configTrim, false, label);
      }
    });

    nseFile.addEventListener('change', async () => {
      nseUpload.disabled = true;
      nsePreview.textContent = '';
      nseFileStatus.textContent = 'Reading file...';
      nseAnalysis = null;
      const file = nseFile.files?.[0];
      if (!file) {
        nseFileStatus.textContent = 'CSV headers required: symbol/ticker, name/company, optional isin.';
        return;
      }

      try {
        const text = await file.text();
        const parsed = parseNseRows(text);
        nseAnalysis = analyzeNseRows(parsed.rows);
        nseFileStatus.textContent = `Loaded ${nseAnalysis.total} rows. ${nseAnalysis.validRows.length} valid.`;
        nsePreview.innerHTML = `
          <div class="text-muted small">
            ${nseAnalysis.invalidRows.length} invalid rows will be skipped. Upload will replace the existing NSE master.
          </div>
        `;
        nseUpload.disabled = nseAnalysis.validRows.length === 0;
      } catch (error) {
        nseFileStatus.textContent = toErrorMessage(error);
      }
    });

    nseUpload.addEventListener('click', async () => {
      if (!currentSession?.adminSessionToken || !nseAnalysis) return;
      const label = nseUpload.textContent || 'Replace NSE Master';
      setBusy(nseUpload, true, label);
      try {
        await replaceNseMaster(
          currentSession.userId,
          currentSession.adminSessionToken,
          nseAnalysis.validRows
        );
        await addActivityLog('ticker', `NSE master replaced (${nseAnalysis.validRows.length} rows)`);
        showAlert(feedback, 'success', 'NSE master updated.');
        await refreshAdminData();
        nseUpload.disabled = true;
        nseFile.value = '';
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(nseUpload, false, label);
      }
    });

    tickerReqBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLButtonElement | null;
      if (!target || !currentSession?.adminSessionToken) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-ticker-request-id]');
      if (!row) return;
      const requestId = row.dataset.tickerRequestId || '';
      if (!requestId) return;
      const action = target.dataset.action;
      if (action !== 'approve' && action !== 'reject') return;

      const resolvedTickerInput = row.querySelector<HTMLInputElement>('[data-field="resolvedTicker"]');
      const resolvedNameInput = row.querySelector<HTMLInputElement>('[data-field="resolvedName"]');
      const resolvedTicker = resolvedTickerInput?.value.trim() || '';
      const resolvedName = resolvedNameInput?.value.trim() || resolvedTicker;

      const label = target.textContent || 'Approve';
      setBusy(target, true, label);
      try {
        await resolveTickerRequestAdmin({
          adminUserId: currentSession.userId,
          adminToken: currentSession.adminSessionToken,
          requestId,
          status: action === 'approve' ? 'APPROVED' : 'REJECTED',
          resolvedTicker: action === 'approve' ? resolvedTicker : '',
          resolvedName: action === 'approve' ? resolvedName : '',
          note: ''
        });
        await addActivityLog(
          'ticker',
          `${action === 'approve' ? 'Approved' : 'Rejected'} ticker request ${requestId}`
        );
        await refreshAdminData();
        showAlert(feedback, 'success', `Ticker request ${action}d.`);
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(target, false, label);
      }
    });

    logsFilter.addEventListener('change', refreshLogs);
    logsSearch.addEventListener('input', refreshLogs);
    logsClear.addEventListener('click', async () => {
      await clearActivityLogs();
      await refreshLogs();
    });

    setTab(initialTab);
    await refreshAdminData();
  })();
}

