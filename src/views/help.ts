import { renderShell, bindShell } from '../ui/shell';
import { lucideIcon } from '../ui/icons';
import { requireSession } from './guards';
import { formatDateTime } from '../utils/format';

type ImportAuditEntry = {
  id: string;
  createdAt: string;
  fileName: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  mappedCount: number;
  failedCount: number;
  lowConfidenceCount: number;
  status: 'imported' | 'failed';
  error?: string;
};

const IMPORT_AUDIT_KEY = 'trade_import_audit_v1';

function loadImportAudit(): ImportAuditEntry[] {
  try {
    const raw = localStorage.getItem(IMPORT_AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ImportAuditEntry[]) : [];
  } catch {
    return [];
  }
}

export function renderHelpView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading help...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'help',
      title: 'Help Center',
      subtitle: 'Everything you need to run your portfolio with confidence.',
      content: `
        <div class="row g-3 mb-3">
          <div class="col-lg-7">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="section-title mb-2">
                  <span class="section-icon">${lucideIcon('sparkles')}</span>
                  Quick Start
                </div>
                <div class="text-muted small mb-3">Follow this flow the first time you open the app.</div>
                <div class="help-steps">
                  <div class="help-step">
                    <div class="help-step-badge">1</div>
                    <div>
                      <div class="fw-semibold">Import or add your trades</div>
                      <div class="text-muted small">Go to Trades → Import File, or add trades manually.</div>
                    </div>
                  </div>
                  <div class="help-step">
                    <div class="help-step-badge">2</div>
                    <div>
                      <div class="fw-semibold">Set targets & fees</div>
                      <div class="text-muted small">Admin Settings → Allocation, brokerage, target %.</div>
                    </div>
                  </div>
                  <div class="help-step">
                    <div class="help-step-badge">3</div>
                    <div>
                      <div class="fw-semibold">Sync to cloud</div>
                      <div class="text-muted small">Use the bell icon → Sync Now to push changes.</div>
                    </div>
                  </div>
                  <div class="help-step">
                    <div class="help-step-badge">4</div>
                    <div>
                      <div class="fw-semibold">Review Recovery / Re-entry plans</div>
                      <div class="text-muted small">Use Recovery Plans and Intraday Analysis to track strategic moves.</div>
                    </div>
                  </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-3">
                  <a class="btn btn-sm btn-outline-primary" href="trades.html#history">${lucideIcon('repeat')} Open Trades</a>
                  <a class="btn btn-sm btn-outline-secondary" href="settings.html">${lucideIcon('settings')} Open Settings</a>
                  <a class="btn btn-sm btn-outline-secondary" href="admin.html">${lucideIcon('shield')} Admin Panel</a>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-5">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="section-title mb-2">
                  <span class="section-icon">${lucideIcon('info')}</span>
                  What You Can Do
                </div>
                <ul class="help-list">
                  <li>Track holdings, trades, P/L, and insights.</li>
                  <li>Import trades from multiple broker formats with mapping review.</li>
                  <li>Use Recovery Plans and Re-entry Analysis to compare decisions.</li>
                  <li>Work offline with auto-queue sync + snapshot retention.</li>
                  <li>Export data to Excel with one sheet per section.</li>
                  <li>Customize theme, font size, compact mode, and animations.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="section-title mb-2">
                  <span class="section-icon">${lucideIcon('life-buoy')}</span>
                  Tips & Troubleshooting
                </div>
                <ul class="help-list">
                  <li>If a ticker looks wrong, open Trades → Ticker List → Request Review.</li>
                  <li>When import mapping is low confidence, review it before confirming.</li>
                  <li>Use Sync panel to see pending changes and sync logs.</li>
                  <li>If charts look blank, refresh prices from the sync panel.</li>
                </ul>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="section-title mb-2">
                  <span class="section-icon">${lucideIcon('file-text')}</span>
                  Import Audit Log
                </div>
                <div class="text-muted small mb-2">Recent trade imports and any mapping warnings.</div>
                <div class="table-responsive">
                  <table class="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Status</th>
                        <th>Mapped</th>
                        <th>Unmapped</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody id="help-import-audit-body"></tbody>
                  </table>
                </div>
                <div class="text-muted small mt-2 d-none" id="help-import-audit-empty">No imports logged yet.</div>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);

    const auditBody = root.querySelector<HTMLTableSectionElement>('#help-import-audit-body');
    const auditEmpty = root.querySelector<HTMLDivElement>('#help-import-audit-empty');
    if (!auditBody || !auditEmpty) return;

    const logs = loadImportAudit();
    if (!logs.length) {
      auditEmpty.classList.remove('d-none');
      auditBody.innerHTML = '';
      return;
    }

    auditEmpty.classList.add('d-none');
    auditBody.innerHTML = logs
      .slice(0, 8)
      .map((entry) => {
        const statusClass = entry.status === 'failed' ? 'text-danger' : 'text-success';
        return `
          <tr>
            <td class="fw-semibold">${entry.fileName}</td>
            <td class="${statusClass} text-uppercase">${entry.status}</td>
            <td>${entry.mappedCount}</td>
            <td>${entry.failedCount}</td>
            <td>${formatDateTime(entry.createdAt)}</td>
          </tr>
        `;
      })
      .join('');
  })();
}
