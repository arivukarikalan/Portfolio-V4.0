import { renderShell, bindShell } from '../ui/shell';
import { lucideIcon } from '../ui/icons';
import { setBusy, showAlert } from '../ui/feedback';
import { addTransaction, deleteTransaction, listTransactions, updateTransaction } from '../storage/transactions';
import { addGoal, deleteGoal, listGoals, updateGoal } from '../storage/goals';
import { initCloudSync, queueSnapshot, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import type { GoalPlan, RecurrenceFrequency, TransactionRecord, TransactionType } from '../core/types';
import { formatDate, formatMoney } from '../utils/format';
import Chart from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { toErrorMessage } from '../utils/errors';

type TransactionFormState = {
  type: TransactionType;
  amount: number;
  category: string;
  date: string;
  notes: string;
  personName: string;
  dueDate: string;
  paidAmount: number;
};

type RecurringFormState = {
  type: TransactionType;
  amount: number;
  category: string;
  startDate: string;
  endDate: string;
  notes: string;
  personName: string;
  frequency: RecurrenceFrequency;
  intervalDays: number;
};

const transactionTypes: Array<{ id: TransactionType; label: string }> = [
  { id: 'INCOME', label: 'Income' },
  { id: 'EXPENSE', label: 'Expense' },
  { id: 'BORROWED', label: 'Borrowed (Debt In)' },
  { id: 'LENT', label: 'Lent (Debt Out)' },
  { id: 'DEBT_REPAY', label: 'Repayment (Debt In)' },
  { id: 'DEBT_RECEIVE', label: 'Received (Debt Out)' },
  { id: 'INVESTMENT', label: 'Investment Contribution' },
  { id: 'LIQUID_ASSET', label: 'Liquid Asset' },
  { id: 'OTHER_ASSET', label: 'Other Asset' }
];

const recurringTypeOptions = transactionTypes.filter(
  (type) => type.id !== 'DEBT_REPAY' && type.id !== 'DEBT_RECEIVE'
);

const categoriesByType: Record<TransactionType, string[]> = {
  INCOME: ['Salary', 'Business', 'Interest', 'Bonus', 'Other'],
  EXPENSE: ['Food', 'Rent', 'Travel', 'Shopping', 'Bills', 'Health', 'Education', 'Other'],
  BORROWED: ['Personal Loan', 'Credit', 'Mortgage', 'Family', 'Friends', 'Other'],
  LENT: ['Personal Loan', 'Credit', 'Mortgage', 'Family', 'Friends', 'Other'],
  DEBT_REPAY: ['Debt Repayment'],
  DEBT_RECEIVE: ['Debt Receive'],
  INVESTMENT: ['Equity', 'Mutual Fund', 'Gold', 'Crypto', 'Other'],
  LIQUID_ASSET: ['Cash', 'Bank', 'FD', 'Other'],
  OTHER_ASSET: ['Property', 'Vehicle', 'Business Asset', 'Other']
};

const recurrenceOptions: Array<{ id: RecurrenceFrequency; label: string; intervalDays: number }> = [
  { id: 'DAILY', label: 'Daily', intervalDays: 1 },
  { id: 'WEEKLY', label: 'Weekly', intervalDays: 7 },
  { id: 'MONTHLY', label: 'Monthly', intervalDays: 30 },
  { id: 'CUSTOM', label: 'Custom (N days)', intervalDays: 10 }
];

const isDebtType = (type: TransactionType) =>
  type === 'BORROWED' || type === 'LENT' || type === 'DEBT_REPAY' || type === 'DEBT_RECEIVE';
const isDebtPaymentType = (type: TransactionType) => type === 'DEBT_REPAY' || type === 'DEBT_RECEIVE';

const defaultFormState = (): TransactionFormState => ({
  type: 'EXPENSE',
  amount: 0,
  category: '',
  date: new Date().toISOString().slice(0, 10),
  notes: '',
  personName: '',
  dueDate: '',
  paidAmount: 0
});

const defaultRecurringState = (): RecurringFormState => ({
  type: 'EXPENSE',
  amount: 0,
  category: '',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  notes: '',
  personName: '',
  frequency: 'MONTHLY',
  intervalDays: 30
});

const defaultGoalState = (): GoalPlan => ({
  id: '',
  userId: '',
  name: '',
  targetAmount: 0,
  targetYear: new Date().getFullYear(),
  status: 'ACTIVE',
  targetDate: null,
  notes: '',
  createdAt: '',
  updatedAt: ''
});

const computeNextRun = (date: string, frequency: RecurrenceFrequency, intervalDays: number): string => {
  const base = new Date(date);
  if (Number.isNaN(base.getTime())) return date;
  if (frequency === 'MONTHLY') {
    base.setMonth(base.getMonth() + 1);
  } else {
    const addDays = frequency === 'CUSTOM' ? Math.max(1, intervalDays) : intervalDays;
    base.setDate(base.getDate() + addDays);
  }
  return base.toISOString().slice(0, 10);
};

const parseDateValue = (value: string): number | null => {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct.getTime();
  }
  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map((part) => Number(part));
  if (!day || !month || !year) return null;
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

export function renderTransactionsView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading transactions...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    const quickNavActive =
      window.location.hash === '#recurring'
        ? 'txn-recurring'
        : window.location.hash === '#goals'
          ? 'txn-goals'
          : 'txn-history';
    root.innerHTML = renderShell({
      session,
      active: 'transactions',
      title: 'Transactions',
      subtitle: 'Track expenses, debts, assets, and recurring entries.',
      quickNavActive,
      quickNav: [
        { id: 'txn-history', label: 'History', href: 'transactions.html', icon: 'list' },
        { id: 'txn-recurring', label: 'Recurring', href: 'transactions.html#recurring', icon: 'repeat' },
        { id: 'txn-goals', label: 'Goals & Plans', href: 'transactions.html#goals', icon: 'flag' }
      ],
      content: `
        <div class="transactions-page">
        <div id="transactions-feedback" class="alert d-none" role="alert"></div>

        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <div>
            <h2 class="h5 mb-1 section-title">
              <span class="section-icon">${lucideIcon('arrow-right-left')}</span>
              Transactions
            </h2>
            <div class="text-muted small">Capture cash flow, debts, and assets with recurring rules.</div>
          </div>
          <button class="btn btn-outline-secondary btn-sm" id="transactions-sync">
            ${lucideIcon('refresh-ccw')} Sync
          </button>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('repeat')}</span>
                  Recurring In
                </div>
                <div class="h6 mb-0" id="txn-kpi-rec-in">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('repeat-1')}</span>
                  Recurring Out
                </div>
                <div class="h6 mb-0" id="txn-kpi-rec-out">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('hand-coins')}</span>
                  Total Debt
                </div>
                <div class="h6 mb-0" id="txn-kpi-debt">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('wallet')}</span>
                  Liquid Assets
                </div>
                <div class="h6 mb-0" id="txn-kpi-liquid">--</div>
              </div>
            </div>
          </div>
        </div>

        <div id="txn-section-history">
            <div class="row g-3">
              <div class="col-lg-4">
                <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h3 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('file-plus')}</span>
                  Add Transaction
                </h3>
                <form id="transaction-form" class="d-grid gap-3">
                  <div>
                    <label class="form-label">Type</label>
                    <select class="form-select" id="txn-type"></select>
                  </div>
                  <div>
                    <label class="form-label">Amount</label>
                    <input class="form-control" type="number" step="0.01" id="txn-amount" />
                  </div>
                  <div>
                    <label class="form-label">Category</label>
                    <select class="form-select" id="txn-category"></select>
                  </div>
                  <div>
                    <label class="form-label">Date</label>
                    <input class="form-control" type="date" id="txn-date" />
                  </div>
                  <div id="txn-debt-fields" class="d-none">
                    <label class="form-label">Person Name</label>
                    <input class="form-control mb-2" id="txn-person" />
                    <div>
                      <label class="form-label">Due Date</label>
                      <input class="form-control" type="date" id="txn-due-date" />
                    </div>
                    <div class="mt-2">
                      <label class="form-label" id="txn-paid-label">Paid Amount</label>
                      <input class="form-control" type="number" step="0.01" id="txn-paid" />
                    </div>
                  </div>
                  <div>
                    <label class="form-label">Notes</label>
                    <textarea class="form-control" rows="2" id="txn-notes"></textarea>
                  </div>
                  <div class="d-flex gap-2">
                    <button class="btn btn-primary flex-fill" type="submit" id="txn-save">
                      ${lucideIcon('save')} Save
                    </button>
                    <button class="btn btn-outline-secondary" type="button" id="txn-reset">Reset</button>
                  </div>
                </form>
              </div>
            </div>
          </div>

              <div class="col-lg-8">
                <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 txn-filter-bar">
                  <div>
                    <h3 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('list')}</span>
                      Transaction History
                    </h3>
                    <div class="text-muted small" id="txn-count">--</div>
                  </div>
                  <div class="d-flex flex-column gap-2 flex-wrap w-100 w-md-auto">
                    <div class="btn-group txn-range" role="group" aria-label="Transaction range">
                      <button class="btn btn-sm btn-outline-secondary" type="button" data-range="30">Last 30 Days</button>
                      <button class="btn btn-sm btn-outline-secondary" type="button" data-range="90">3M</button>
                      <button class="btn btn-sm btn-outline-secondary" type="button" data-range="180">6M</button>
                      <button class="btn btn-sm btn-outline-secondary" type="button" data-range="365">1Y</button>
                      <button class="btn btn-sm btn-outline-secondary" type="button" data-range="all">All</button>
                    </div>
                    <div class="d-flex gap-2 flex-wrap">
                      <input class="form-control form-control-sm" id="txn-search" placeholder="Search name, notes, category" />
                      <select class="form-select form-select-sm" id="txn-filter-type">
                        <option value="">All Types</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div class="table-responsive">
                  <table class="table table-sm align-middle mobile-stack mobile-toggle-details txn-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Category</th>
                        <th class="text-end">Amount</th>
                        <th>Person</th>
                        <th>Status</th>
                        <th class="text-end">Action</th>
                      </tr>
                    </thead>
                    <tbody id="txn-table"></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>

        <div id="txn-section-recurring" class="d-none">
          <div class="row g-3">
            <div class="col-lg-4">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <h3 class="h6 mb-3 section-title">
                    <span class="section-icon">${lucideIcon('repeat')}</span>
                    Recurring Setup
                  </h3>
                  <form id="recurring-form" class="d-grid gap-3">
                    <div>
                      <label class="form-label">Type</label>
                      <select class="form-select" id="rec-type"></select>
                    </div>
                    <div>
                      <label class="form-label">Amount</label>
                      <input class="form-control" type="number" step="0.01" id="rec-amount" />
                    </div>
                    <div>
                      <label class="form-label">Category</label>
                      <select class="form-select" id="rec-category"></select>
                    </div>
                    <div>
                      <label class="form-label">Start Date</label>
                      <input class="form-control" type="date" id="rec-start" />
                    </div>
                    <div>
                      <label class="form-label">End Date (optional)</label>
                      <input class="form-control" type="date" id="rec-end" />
                    </div>
                    <div id="rec-person-wrap" class="d-none">
                      <label class="form-label">Person Name</label>
                      <input class="form-control" id="rec-person" />
                    </div>
                    <div>
                      <label class="form-label">Notes</label>
                      <textarea class="form-control" rows="2" id="rec-notes"></textarea>
                    </div>
                    <div class="border rounded-3 p-2">
                      <label class="form-label">Frequency</label>
                      <select class="form-select mb-2" id="rec-frequency"></select>
                      <div id="rec-custom-days" class="d-none">
                        <label class="form-label">Every N days</label>
                        <input class="form-control" type="number" min="1" id="rec-interval" />
                      </div>
                      <div class="text-muted small" id="rec-next-run">Next run: --</div>
                    </div>
                    <div class="d-flex gap-2">
                      <button class="btn btn-primary flex-fill" type="submit" id="rec-save">
                        ${lucideIcon('save')} Save
                      </button>
                      <button class="btn btn-outline-secondary" type="button" id="rec-reset">Reset</button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
            <div class="col-lg-8">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                    <div>
                      <h3 class="h6 mb-1 section-title">
                        <span class="section-icon">${lucideIcon('calendar-clock')}</span>
                        Recurring List
                      </h3>
                      <div class="text-muted small" id="rec-count">--</div>
                    </div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle rec-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th class="text-end">Amount</th>
                          <th>Frequency</th>
                          <th>Schedule</th>
                          <th>Status</th>
                          <th class="text-end">Action</th>
                        </tr>
                      </thead>
                      <tbody id="rec-table"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="txn-section-goals" class="d-none">
          <div class="row g-3">
            <div class="col-lg-4">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <h3 class="h6 mb-3 section-title">
                    <span class="section-icon">${lucideIcon('flag')}</span>
                    Goal Builder
                  </h3>
                  <form id="goal-form" class="d-grid gap-3">
                    <div>
                      <label class="form-label">Goal Name</label>
                      <input class="form-control" id="goal-name" placeholder="e.g. Net Worth 25L" />
                    </div>
                    <div>
                      <label class="form-label">Target Amount</label>
                      <input class="form-control" type="number" step="0.01" id="goal-target" />
                    </div>
                    <div>
                      <label class="form-label">Target Year</label>
                      <input class="form-control" type="number" min="2000" max="2100" id="goal-year" />
                    </div>
                    <div>
                      <label class="form-label">Status</label>
                      <select class="form-select" id="goal-status">
                        <option value="ACTIVE">Active</option>
                        <option value="COMPLETED">Completed</option>
                      </select>
                    </div>
                    <div>
                      <label class="form-label">Notes</label>
                      <textarea class="form-control" rows="2" id="goal-notes"></textarea>
                    </div>
                    <div class="d-flex gap-2">
                      <button class="btn btn-primary flex-fill" type="submit" id="goal-save">
                        ${lucideIcon('save')} Save
                      </button>
                      <button class="btn btn-outline-secondary" type="button" id="goal-reset">Reset</button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
            <div class="col-lg-8">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                    <div>
                      <h3 class="h6 mb-1 section-title">
                        <span class="section-icon">${lucideIcon('clipboard-list')}</span>
                        Goals & Plans
                      </h3>
                      <div class="text-muted small" id="goal-count">--</div>
                    </div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle goal-table">
                      <thead>
                        <tr>
                          <th>Goal</th>
                          <th class="text-end">Target</th>
                          <th>Target Year</th>
                          <th>Status</th>
                          <th>Notes</th>
                          <th class="text-end">Action</th>
                        </tr>
                      </thead>
                      <tbody id="goal-table"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="row g-3 mt-1">
            <div class="col-lg-4">
              <div class="card shadow-sm border-0 goal-summary h-100">
                <div class="card-body">
                  <h3 class="h6 mb-3 section-title">
                    <span class="section-icon">${lucideIcon('sparkles')}</span>
                    Goal Summary
                  </h3>
                  <div class="goal-summary-item">
                    <div class="text-muted small">Total Target (Active)</div>
                    <div class="h5 mb-0" id="goal-total-target">--</div>
                  </div>
                  <div class="goal-summary-item">
                    <div class="text-muted small">Nearest Goal</div>
                    <div class="fw-semibold" id="goal-nearest-name">--</div>
                    <div class="text-muted small" id="goal-nearest-year">--</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-lg-8">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="row g-3">
                    <div class="col-lg-7">
                      <h3 class="h6 mb-2 section-title">
                        <span class="section-icon">${lucideIcon('bar-chart-3')}</span>
                        Goals by Year
                      </h3>
                      <div class="chart-wrap">
                        <canvas id="goal-year-chart"></canvas>
                      </div>
                    </div>
                    <div class="col-lg-5">
                      <h3 class="h6 mb-2 section-title">
                        <span class="section-icon">${lucideIcon('pie-chart')}</span>
                        Goal Status Mix
                      </h3>
                      <div class="chart-wrap">
                        <canvas id="goal-status-chart"></canvas>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="app-modal" id="txn-delete-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="modal"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('trash-2')}</span>
                    <span id="txn-delete-title">Delete Transaction</span>
                  </h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" data-close="modal">Close</button>
                </div>
                <div class="text-muted mb-3" id="txn-delete-body">Are you sure you want to delete this transaction?</div>
                <div class="d-flex justify-content-end gap-2">
                  <button class="btn btn-outline-secondary" type="button" data-close="modal">Cancel</button>
                  <button class="btn btn-danger" type="button" id="txn-confirm-delete">Delete</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="app-modal" id="txn-payment-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="payment"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('hand-coins')}</span>
                    <span id="txn-payment-title">Record Payment</span>
                  </h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" data-close="payment">Close</button>
                </div>
                <div class="text-muted small mb-2" id="txn-payment-subtitle">--</div>
                <div class="row g-2">
                  <div class="col-6">
                    <label class="form-label">Amount</label>
                    <input class="form-control" type="number" step="0.01" id="txn-payment-amount" />
                  </div>
                  <div class="col-6">
                    <label class="form-label">Date</label>
                    <input class="form-control" type="date" id="txn-payment-date" />
                  </div>
                  <div class="col-12">
                    <label class="form-label">Notes</label>
                    <input class="form-control" id="txn-payment-notes" />
                  </div>
                </div>
                <div class="d-flex flex-wrap justify-content-end gap-2 mt-3">
                  <button class="btn btn-outline-primary" type="button" id="txn-payment-full">Pay Full</button>
                  <button class="btn btn-outline-secondary" type="button" data-close="payment">Cancel</button>
                  <button class="btn btn-primary" type="button" id="txn-payment-save">Save Payment</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      `
    });

    bindShell(root);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#transactions-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#transactions-sync');
    const form = root.querySelector<HTMLFormElement>('#transaction-form');
    const typeSelect = root.querySelector<HTMLSelectElement>('#txn-type');
    const amountInput = root.querySelector<HTMLInputElement>('#txn-amount');
    const categorySelect = root.querySelector<HTMLSelectElement>('#txn-category');
    const dateInput = root.querySelector<HTMLInputElement>('#txn-date');
    const notesInput = root.querySelector<HTMLTextAreaElement>('#txn-notes');
    const debtFields = root.querySelector<HTMLDivElement>('#txn-debt-fields');
    const personInput = root.querySelector<HTMLInputElement>('#txn-person');
    const dueDateInput = root.querySelector<HTMLInputElement>('#txn-due-date');
    const paidInput = root.querySelector<HTMLInputElement>('#txn-paid');
    const paidLabel = root.querySelector<HTMLLabelElement>('#txn-paid-label');
    const resetButton = root.querySelector<HTMLButtonElement>('#txn-reset');
    const tableBody = root.querySelector<HTMLTableSectionElement>('#txn-table');
    const countLabel = root.querySelector<HTMLDivElement>('#txn-count');
    const kpiRecIn = root.querySelector<HTMLDivElement>('#txn-kpi-rec-in');
    const kpiRecOut = root.querySelector<HTMLDivElement>('#txn-kpi-rec-out');
    const kpiDebt = root.querySelector<HTMLDivElement>('#txn-kpi-debt');
    const kpiLiquid = root.querySelector<HTMLDivElement>('#txn-kpi-liquid');
    const searchInput = root.querySelector<HTMLInputElement>('#txn-search');
    const filterType = root.querySelector<HTMLSelectElement>('#txn-filter-type');
    const rangeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-range]'));
    const deleteModal = root.querySelector<HTMLDivElement>('#txn-delete-modal');
    const deleteConfirm = root.querySelector<HTMLButtonElement>('#txn-confirm-delete');
    const deleteTitle = root.querySelector<HTMLSpanElement>('#txn-delete-title');
    const deleteBody = root.querySelector<HTMLDivElement>('#txn-delete-body');
    const paymentModal = root.querySelector<HTMLDivElement>('#txn-payment-modal');
    const paymentTitle = root.querySelector<HTMLSpanElement>('#txn-payment-title');
    const paymentSubtitle = root.querySelector<HTMLDivElement>('#txn-payment-subtitle');
    const paymentAmount = root.querySelector<HTMLInputElement>('#txn-payment-amount');
    const paymentDate = root.querySelector<HTMLInputElement>('#txn-payment-date');
    const paymentNotes = root.querySelector<HTMLInputElement>('#txn-payment-notes');
    const paymentSave = root.querySelector<HTMLButtonElement>('#txn-payment-save');
    const paymentFull = root.querySelector<HTMLButtonElement>('#txn-payment-full');

    const sectionHistory = root.querySelector<HTMLDivElement>('#txn-section-history');
    const sectionRecurring = root.querySelector<HTMLDivElement>('#txn-section-recurring');
    const recForm = root.querySelector<HTMLFormElement>('#recurring-form');
    const recTypeSelect = root.querySelector<HTMLSelectElement>('#rec-type');
    const recAmountInput = root.querySelector<HTMLInputElement>('#rec-amount');
    const recCategorySelect = root.querySelector<HTMLSelectElement>('#rec-category');
    const recStartInput = root.querySelector<HTMLInputElement>('#rec-start');
    const recEndInput = root.querySelector<HTMLInputElement>('#rec-end');
    const recPersonWrap = root.querySelector<HTMLDivElement>('#rec-person-wrap');
    const recPersonInput = root.querySelector<HTMLInputElement>('#rec-person');
    const recNotesInput = root.querySelector<HTMLTextAreaElement>('#rec-notes');
    const recFrequencySelect = root.querySelector<HTMLSelectElement>('#rec-frequency');
    const recCustomDaysWrap = root.querySelector<HTMLDivElement>('#rec-custom-days');
    const recIntervalInput = root.querySelector<HTMLInputElement>('#rec-interval');
    const recNextRunLabel = root.querySelector<HTMLDivElement>('#rec-next-run');
    const recResetButton = root.querySelector<HTMLButtonElement>('#rec-reset');
    const recTableBody = root.querySelector<HTMLTableSectionElement>('#rec-table');
    const recCount = root.querySelector<HTMLDivElement>('#rec-count');
    const sectionGoals = root.querySelector<HTMLDivElement>('#txn-section-goals');
    const goalForm = root.querySelector<HTMLFormElement>('#goal-form');
    const goalNameInput = root.querySelector<HTMLInputElement>('#goal-name');
    const goalTargetInput = root.querySelector<HTMLInputElement>('#goal-target');
    const goalYearInput = root.querySelector<HTMLInputElement>('#goal-year');
    const goalStatusSelect = root.querySelector<HTMLSelectElement>('#goal-status');
    const goalNotesInput = root.querySelector<HTMLTextAreaElement>('#goal-notes');
    const goalResetButton = root.querySelector<HTMLButtonElement>('#goal-reset');
    const goalTableBody = root.querySelector<HTMLTableSectionElement>('#goal-table');
    const goalCount = root.querySelector<HTMLDivElement>('#goal-count');
    const goalTotalTarget = root.querySelector<HTMLDivElement>('#goal-total-target');
    const goalNearestName = root.querySelector<HTMLDivElement>('#goal-nearest-name');
    const goalNearestYear = root.querySelector<HTMLDivElement>('#goal-nearest-year');
    const goalYearChart = root.querySelector<HTMLCanvasElement>('#goal-year-chart');
    const goalStatusChart = root.querySelector<HTMLCanvasElement>('#goal-status-chart');

    if (
      !feedback ||
      !syncButton ||
      !form ||
      !typeSelect ||
      !amountInput ||
      !categorySelect ||
      !dateInput ||
      !notesInput ||
      !debtFields ||
      !personInput ||
      !dueDateInput ||
      !paidInput ||
      !paidLabel ||
      !resetButton ||
      !tableBody ||
      !countLabel ||
      !kpiRecIn ||
      !kpiRecOut ||
      !kpiDebt ||
      !kpiLiquid ||
      !searchInput ||
      !filterType ||
      !rangeButtons.length ||
      !deleteModal ||
      !deleteConfirm ||
      !deleteTitle ||
      !deleteBody ||
      !paymentModal ||
      !paymentTitle ||
      !paymentSubtitle ||
      !paymentAmount ||
      !paymentDate ||
      !paymentNotes ||
      !paymentSave ||
      !paymentFull ||
      !sectionHistory ||
      !sectionRecurring ||
      !sectionGoals ||
      !goalForm ||
      !goalNameInput ||
      !goalTargetInput ||
      !goalYearInput ||
      !goalStatusSelect ||
      !goalNotesInput ||
      !goalResetButton ||
      !goalTableBody ||
      !goalCount ||
      !goalTotalTarget ||
      !goalNearestName ||
      !goalNearestYear ||
      !goalYearChart ||
      !goalStatusChart ||
      !recForm ||
      !recTypeSelect ||
      !recAmountInput ||
      !recCategorySelect ||
      !recStartInput ||
      !recEndInput ||
      !recPersonWrap ||
      !recPersonInput ||
      !recNotesInput ||
      !recFrequencySelect ||
      !recCustomDaysWrap ||
      !recIntervalInput ||
      !recNextRunLabel ||
      !recResetButton ||
      !recTableBody ||
      !recCount
    ) {
      throw new Error('Transactions view failed to initialize');
    }

    let transactions: TransactionRecord[] = [];
    let editingId: string | null = null;
    let editingRecurringId: string | null = null;
    let goals: GoalPlan[] = [];
    let editingGoalId: string | null = null;
    let deletingId: string | null = null;
    let deletingType: 'transaction' | 'goal' = 'transaction';
    let goalYearChartInstance: Chart | null = null;
    let goalStatusChartInstance: Chart | null = null;
    let paymentTarget: TransactionRecord | null = null;
    let paymentRemaining: number = 0;
    let rangeSelection: string = '30';

    const queueAndSync = async () => {
      await queueSnapshot(session.userId);
      if (navigator.onLine) {
        await syncNow(session);
      }
    };

    const fillTypeOptions = () => {
      typeSelect.innerHTML = transactionTypes
        .map((type) => `<option value="${type.id}">${type.label}</option>`)
        .join('');
      filterType.innerHTML = `
        <option value="">All Types</option>
        ${transactionTypes.map((type) => `<option value="${type.id}">${type.label}</option>`).join('')}
      `;
      recTypeSelect.innerHTML = recurringTypeOptions
        .map((type) => `<option value="${type.id}">${type.label}</option>`)
        .join('');
    };

    const fillFrequencyOptions = () => {
      recFrequencySelect.innerHTML = recurrenceOptions
        .map((option) => `<option value="${option.id}">${option.label}</option>`)
        .join('');
    };

    const setFormState = (state: TransactionFormState) => {
      typeSelect.value = state.type;
      amountInput.value = state.amount ? String(state.amount) : '';
      categorySelect.innerHTML = categoriesByType[state.type]
        .map((cat) => `<option value="${cat}">${cat}</option>`)
        .join('');
      categorySelect.value = state.category || categoriesByType[state.type][0];
      dateInput.value = state.date;
      notesInput.value = state.notes;
      personInput.value = state.personName;
      dueDateInput.value = state.dueDate;
      paidInput.value = state.paidAmount ? String(state.paidAmount) : '';
      debtFields.classList.toggle('d-none', !isDebtType(state.type));
      paidLabel.textContent = state.type === 'BORROWED' ? 'Repaid Amount' : state.type === 'LENT' ? 'Paid Back Amount' : 'Paid Amount';
    };

    const setRecurringFormState = (state: RecurringFormState) => {
      recTypeSelect.value = state.type;
      recAmountInput.value = state.amount ? String(state.amount) : '';
      recCategorySelect.innerHTML = categoriesByType[state.type]
        .map((cat) => `<option value="${cat}">${cat}</option>`)
        .join('');
      recCategorySelect.value = state.category || categoriesByType[state.type][0];
      recStartInput.value = state.startDate;
      recEndInput.value = state.endDate;
      recNotesInput.value = state.notes;
      recPersonInput.value = state.personName;
      recPersonWrap.classList.toggle('d-none', !isDebtType(state.type));
      recFrequencySelect.value = state.frequency;
      recIntervalInput.value = String(state.intervalDays);
      recCustomDaysWrap.classList.toggle('d-none', state.frequency !== 'CUSTOM');
      recNextRunLabel.textContent = `Next run: ${computeNextRun(state.startDate, state.frequency, state.intervalDays)}`;
    };

    const setGoalFormState = (state: GoalPlan) => {
      goalNameInput.value = state.name;
      goalTargetInput.value = state.targetAmount ? String(state.targetAmount) : '';
      goalYearInput.value = state.targetYear ? String(state.targetYear) : '';
      goalStatusSelect.value = state.status || 'ACTIVE';
      goalNotesInput.value = state.notes || '';
    };

    const readFormState = (): TransactionFormState => ({
      type: typeSelect.value as TransactionType,
      amount: Number(amountInput.value),
      category: categorySelect.value,
      date: dateInput.value,
      notes: notesInput.value.trim(),
      personName: personInput.value.trim(),
      dueDate: dueDateInput.value,
      paidAmount: Number(paidInput.value),
    });

    const readRecurringFormState = (): RecurringFormState => ({
      type: recTypeSelect.value as TransactionType,
      amount: Number(recAmountInput.value),
      category: recCategorySelect.value,
      startDate: recStartInput.value,
      endDate: recEndInput.value,
      notes: recNotesInput.value.trim(),
      personName: recPersonInput.value.trim(),
      frequency: recFrequencySelect.value as RecurrenceFrequency,
      intervalDays: Number(recIntervalInput.value)
    });

    const readGoalFormState = () => ({
      name: goalNameInput.value.trim(),
      targetAmount: Number(goalTargetInput.value),
      targetYear: Number(goalYearInput.value),
      status: goalStatusSelect.value as GoalPlan['status'],
      notes: goalNotesInput.value.trim()
    });

    const resetForm = () => {
      editingId = null;
      setFormState(defaultFormState());
      form.reset();
      setFormState(defaultFormState());
    };

    const resetRecurringForm = () => {
      editingRecurringId = null;
      setRecurringFormState(defaultRecurringState());
      recForm.reset();
      setRecurringFormState(defaultRecurringState());
    };

    const resetGoalForm = () => {
      editingGoalId = null;
      const state = defaultGoalState();
      setGoalFormState(state);
      goalForm.reset();
      setGoalFormState(state);
    };

    const updateQuickNavActive = (activeId: string) => {
      const quickLinks = Array.from(root.querySelectorAll<HTMLElement>('[data-quick-id]'));
      quickLinks.forEach((link) => {
        link.classList.toggle('active', link.dataset.quickId === activeId);
      });
    };

    const setActiveSection = (section: 'history' | 'recurring' | 'goals') => {
      sectionHistory.classList.toggle('d-none', section !== 'history');
      sectionRecurring.classList.toggle('d-none', section !== 'recurring');
      sectionGoals.classList.toggle('d-none', section !== 'goals');
      updateQuickNavActive(section === 'recurring' ? 'txn-recurring' : section === 'goals' ? 'txn-goals' : 'txn-history');
    };


    const openModal = () => {
      if (deletingType === 'goal') {
        deleteTitle.textContent = 'Delete Goal';
        deleteBody.textContent = 'Are you sure you want to delete this goal?';
      } else {
        deleteTitle.textContent = 'Delete Transaction';
        deleteBody.textContent = 'Are you sure you want to delete this transaction?';
      }
      deleteModal.classList.add('show');
      deleteModal.setAttribute('aria-hidden', 'false');
    };
    const closeModal = () => {
      deleteModal.classList.remove('show');
      deleteModal.setAttribute('aria-hidden', 'true');
    };

    const openPaymentModal = (target: TransactionRecord) => {
      paymentTarget = target;
      const remaining = Math.max(0, target.amount - (target.paidAmount || 0));
      paymentRemaining = remaining;
      paymentTitle.textContent = target.type === 'BORROWED' ? 'Record Repayment' : 'Record Received Payment';
      paymentSubtitle.textContent = `${target.personName || 'Person'} - Remaining ${formatMoney(remaining)}`;
      paymentAmount.value = '';
      paymentAmount.placeholder = remaining ? String(remaining) : '';
      paymentAmount.max = remaining ? String(remaining) : '';
      paymentAmount.min = '0';
      paymentDate.value = new Date().toISOString().slice(0, 10);
      paymentNotes.value = '';
      paymentModal.classList.add('show');
      paymentModal.setAttribute('aria-hidden', 'false');
    };

    const closePaymentModal = () => {
      paymentModal.classList.remove('show');
      paymentModal.setAttribute('aria-hidden', 'true');
    };

    const applyRecurringTemplates = async () => {
      const today = new Date().toISOString().slice(0, 10);
      const templates = transactions.filter((row) => row.isRecurring && row.isTemplate);
      let changed = false;
      for (const template of templates) {
        if (!template.nextRun) continue;
        if (template.recurrenceEnd && template.nextRun > template.recurrenceEnd) {
          await updateTransaction(template.id, template.userId, { nextRun: null });
          changed = true;
          continue;
        }
        let nextRun: string | null = template.nextRun;
        let guard = 0;
        while (nextRun <= today && guard < 24) {
          if (template.recurrenceEnd && nextRun > template.recurrenceEnd) {
            break;
          }
          await addTransaction({
            userId: template.userId,
            type: template.type,
            amount: template.amount,
            category: template.category,
            date: nextRun,
            notes: template.notes,
            personName: template.personName ?? undefined,
            dueDate: template.dueDate ?? undefined,
            status: template.status,
            paidAmount: template.paidAmount ?? undefined,
            isRecurring: false,
            recurrence: null,
            nextRun: null,
            recurrenceEnd: null,
            isTemplate: false
          });
          changed = true;
          const recurrence = template.recurrence;
          if (!recurrence) break;
          nextRun = computeNextRun(nextRun, recurrence.frequency, recurrence.intervalDays || 1);
          guard += 1;
        }
        if (template.recurrenceEnd && nextRun > template.recurrenceEnd) {
          nextRun = null;
        }
        if (nextRun !== template.nextRun) {
          await updateTransaction(template.id, template.userId, { nextRun });
          changed = true;
        }
      }
      if (changed) {
        await queueAndSync();
      }
    };

    const renderTable = () => {
      const paymentLatestByDebtId = new Map<string, string>();
      transactions.forEach((row) => {
        if (!row.linkedId) return;
        const existing = paymentLatestByDebtId.get(row.linkedId);
        if (!existing || row.date > existing) {
          paymentLatestByDebtId.set(row.linkedId, row.date);
        }
      });

      const query = searchInput.value.trim().toLowerCase();
      const typeFilter = filterType.value;
      const fromDate = rangeSelection === 'all' ? '' : getRangeStartDate();
      const toDate = rangeSelection === 'all' ? '' : new Date().toISOString().slice(0, 10);
      const fromTime = fromDate ? parseDateValue(fromDate) : null;
      const toTime = toDate ? parseDateValue(toDate) : null;
      const rows = transactions.filter((row) => {
        if (row.isTemplate) return false;
        const effectiveDate =
          (row.type === 'BORROWED' || row.type === 'LENT') && paymentLatestByDebtId.has(row.id)
            ? paymentLatestByDebtId.get(row.id)!
            : row.date;
        const rowTime = parseDateValue(effectiveDate);
        if (typeFilter && row.type !== typeFilter) return false;
        if (fromTime !== null && rowTime !== null && rowTime < fromTime) return false;
        if (toTime !== null && rowTime !== null && rowTime > toTime) return false;
        if (!query) return true;
        return (
          row.category.toLowerCase().includes(query) ||
          row.notes?.toLowerCase().includes(query) ||
          row.personName?.toLowerCase().includes(query) ||
          row.type.toLowerCase().includes(query)
        );
      });
      rows.sort((a, b) => {
        const aDate =
          (a.type === 'BORROWED' || a.type === 'LENT') && paymentLatestByDebtId.has(a.id)
            ? paymentLatestByDebtId.get(a.id)!
            : a.date;
        const bDate =
          (b.type === 'BORROWED' || b.type === 'LENT') && paymentLatestByDebtId.has(b.id)
            ? paymentLatestByDebtId.get(b.id)!
            : b.date;
        const aTime = parseDateValue(aDate) ?? 0;
        const bTime = parseDateValue(bDate) ?? 0;
        return bTime - aTime;
      });
      countLabel.textContent = `${rows.length} transactions`;
      if (!rows.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="text-muted text-center py-3">No transactions found.</td></tr>';
        return;
      }
      tableBody.innerHTML = rows
        .map((row) => {
          const typeLabel = transactionTypes.find((type) => type.id === row.type)?.label || row.type;
          const typeTone =
            row.type === 'INCOME' || row.type === 'DEBT_RECEIVE'
              ? 'txn-type-positive'
              : row.type === 'EXPENSE' || row.type === 'DEBT_REPAY'
                ? 'txn-type-negative'
                : row.type === 'BORROWED'
                  ? 'txn-type-debt'
                  : row.type === 'LENT'
                    ? 'txn-type-lent'
                    : row.type === 'INVESTMENT'
                      ? 'txn-type-invest'
                      : row.type === 'LIQUID_ASSET'
                        ? 'txn-type-liquid'
                        : 'txn-type-neutral';
          const amountTone =
            row.type === 'INCOME' || row.type === 'DEBT_RECEIVE'
              ? 'txn-amount-positive'
              : row.type === 'EXPENSE' || row.type === 'DEBT_REPAY'
                ? 'txn-amount-negative'
                : 'txn-amount-neutral';
          const computedStatus =
            row.type === 'BORROWED' || row.type === 'LENT'
              ? (row.paidAmount || 0) >= row.amount
                ? 'CLOSED'
                : 'OPEN'
              : row.status || '--';
          const statusBadge = isDebtPaymentType(row.type)
            ? '<span class="badge text-bg-info">Payment</span>'
            : computedStatus === 'OPEN'
              ? '<span class="badge text-bg-warning">Open</span>'
              : computedStatus === 'CLOSED'
                ? '<span class="badge text-bg-success">Closed</span>'
                : '--';
          const showPaymentAction = row.type === 'BORROWED' || row.type === 'LENT';
          const remaining = Math.max(0, row.amount - (row.paidAmount || 0));
          const showPaymentsToggle = row.type === 'BORROWED' || row.type === 'LENT';
          const effectiveDate =
            (row.type === 'BORROWED' || row.type === 'LENT') && paymentLatestByDebtId.has(row.id)
              ? paymentLatestByDebtId.get(row.id)!
              : row.date;
          const showOriginalDate = effectiveDate !== row.date;
          const dateLabel = formatDate(effectiveDate);
          const originalDate = showOriginalDate ? formatDate(row.date) : '';
          const remainingBadge =
            row.type === 'BORROWED' || row.type === 'LENT'
              ? `<span class="badge text-bg-light txn-remaining-badge">Remaining ${formatMoney(remaining)}</span>`
              : '';
          const offsetBadge = row.notes?.includes('Auto offset')
            ? '<span class="badge text-bg-info txn-offset-badge">Auto-Offset</span>'
            : '';
          const showPayAction = showPaymentAction && remaining > 0;
          return `
            <tr>
              <td data-label="Date" data-role="summary" data-summary="ticker">
                ${dateLabel}
                ${showOriginalDate ? `<div class="text-muted small txn-date-sub">Orig ${originalDate}</div>` : ''}
              </td>
              <td data-label="Type" data-role="summary" data-summary="status">
                <span class="txn-type-pill ${typeTone}">${typeLabel}</span>
              </td>
              <td data-label="Category" data-role="detail">${row.category}</td>
              <td class="text-end" data-label="Amount" data-role="summary" data-summary="ltp">
                <span class="txn-amount ${amountTone}">${formatMoney(row.amount)}</span>
              </td>
              <td data-label="Person" data-role="detail">${row.personName || '--'}</td>
              <td data-label="Status" data-role="summary" data-summary="chg">
                <div class="d-flex flex-wrap gap-1 justify-content-end">
                  ${statusBadge}
                  ${remainingBadge}
                  ${offsetBadge}
                </div>
              </td>
              <td class="text-end" data-label="Action" data-role="action">
                <div class="txn-actions">
                  ${showPayAction ? `<button class="btn btn-sm btn-outline-success txn-pay-btn" data-action="pay" data-id="${row.id}">${row.type === 'BORROWED' ? 'Repay' : 'Receive'}</button>` : ''}
                  <div class="btn-group btn-group-sm txn-action-group" role="group" aria-label="Transaction actions">
                    <button class="btn btn-outline-secondary" data-action="edit" data-id="${row.id}">Edit</button>
                    <button class="btn btn-outline-danger" data-action="delete" data-id="${row.id}">Delete</button>
                  </div>
                  ${showPaymentsToggle ? `<button class="btn btn-sm btn-outline-primary txn-payments-toggle" data-action="toggle-payments" data-id="${row.id}">Payments</button>` : ''}
                  <button class="btn btn-link p-0 text-decoration-none mobile-details-toggle d-md-none" data-action="toggle-details" type="button">
                    Details
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const renderRecurringList = () => {
      const templates = transactions.filter((row) => row.isTemplate);
      recCount.textContent = `${templates.length} templates`;
      if (!templates.length) {
        recTableBody.innerHTML =
          '<tr><td colspan="6" class="text-muted text-center py-3">No recurring templates found.</td></tr>';
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      recTableBody.innerHTML = templates
        .sort((a, b) => (b.nextRun || '').localeCompare(a.nextRun || ''))
        .map((row) => {
          const typeLabel = transactionTypes.find((type) => type.id === row.type)?.label || row.type;
          const recurrence = row.recurrence;
          const frequencyLabel = recurrence
            ? recurrence.frequency === 'CUSTOM'
              ? `Every ${recurrence.intervalDays || 1} days`
              : recurrence.frequency
            : '--';
          const ended = row.recurrenceEnd ? row.recurrenceEnd < today : false;
          const statusBadge = ended
            ? '<span class="rec-status-pill ended">Ended</span>'
            : '<span class="rec-status-pill active">Active</span>';
          const typePill = `<span class="rec-type-pill">${typeLabel}</span>`;
          const freqPill = `<span class="rec-frequency-pill">${frequencyLabel}</span>`;
          const nextRun = row.nextRun ? formatDate(row.nextRun) : '--';
          const endLabel = row.recurrenceEnd ? formatDate(row.recurrenceEnd) : 'No end';
          return `
            <tr class="rec-row">
              <td>
                ${typePill}
                <div class="text-muted small">${row.category}</div>
              </td>
              <td class="text-end">
                <div class="rec-amount">${formatMoney(row.amount)}</div>
                <div class="text-muted small">${row.personName || '--'}</div>
              </td>
              <td>${freqPill}</td>
              <td>
                <div class="fw-semibold">${nextRun}</div>
                <div class="text-muted small">Ends: ${endLabel}</div>
              </td>
              <td>${statusBadge}</td>
              <td class="text-end">
                <div class="btn-group btn-group-sm" role="group">
                  <button class="btn btn-outline-secondary" data-action="rec-edit" data-id="${row.id}">Edit</button>
                  <button class="btn btn-outline-danger" data-action="rec-delete" data-id="${row.id}">Delete</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const renderGoalsList = () => {
      goalCount.textContent = `${goals.length} goals`;
      if (!goals.length) {
        goalTableBody.innerHTML =
          '<tr><td colspan="6" class="text-muted text-center py-3">No goals added yet.</td></tr>';
        return;
      }
      goalTableBody.innerHTML = goals
        .map((goal) => {
          const yearLabel = goal.targetYear || '--';
          const statusBadge =
            goal.status === 'COMPLETED'
              ? '<span class="goal-status-pill completed">Completed</span>'
              : '<span class="goal-status-pill active">Active</span>';
          return `
            <tr>
              <td>
                <div class="fw-semibold">${goal.name || 'Untitled Goal'}</div>
              </td>
              <td class="text-end">${formatMoney(goal.targetAmount)}</td>
              <td>${yearLabel}</td>
              <td>${statusBadge}</td>
              <td class="text-muted small">${goal.notes || '--'}</td>
              <td class="text-end">
                <div class="btn-group btn-group-sm" role="group">
                  <button class="btn btn-outline-secondary" data-action="goal-edit" data-id="${goal.id}">Edit</button>
                  <button class="btn btn-outline-danger" data-action="goal-delete" data-id="${goal.id}">Delete</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const renderGoalCharts = () => {
      const activeGoals = goals.filter((goal) => goal.status === 'ACTIVE');
      const totalTarget = activeGoals.reduce((sum, goal) => sum + goal.targetAmount, 0);
      goalTotalTarget.textContent = formatMoney(totalTarget);

      const nearest = activeGoals
        .slice()
        .sort((a, b) => a.targetYear - b.targetYear)[0];
      if (nearest) {
        goalNearestName.textContent = nearest.name || 'Untitled Goal';
        goalNearestYear.textContent = `${nearest.targetYear} • ${Math.max(0, nearest.targetYear - new Date().getFullYear())} yrs left`;
      } else {
        goalNearestName.textContent = '--';
        goalNearestYear.textContent = '--';
      }

      const yearTotals = new Map<number, number>();
      goals.forEach((goal) => {
        const year = goal.targetYear || new Date().getFullYear();
        yearTotals.set(year, (yearTotals.get(year) || 0) + goal.targetAmount);
      });
      const yearLabels = Array.from(yearTotals.keys()).sort((a, b) => a - b);
      const yearValues = yearLabels.map((year) => yearTotals.get(year) || 0);

      const statusCounts = {
        ACTIVE: goals.filter((goal) => goal.status === 'ACTIVE').length,
        COMPLETED: goals.filter((goal) => goal.status === 'COMPLETED').length
      };

      if (goalYearChartInstance) {
        goalYearChartInstance.destroy();
      }
      const yearConfig: ChartConfiguration<'bar', number[], string> = {
        type: 'bar',
        data: {
          labels: yearLabels.map(String),
          datasets: [
            {
              label: 'Target Amount',
              data: yearValues,
              backgroundColor: '#fb923c',
              borderRadius: 8
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: { grid: { display: false } },
            y: {
              ticks: {
                callback: (value) => `₹${Number(value) / 100000}L`
              }
            }
          }
        }
      };
      goalYearChartInstance = new Chart(goalYearChart, yearConfig);

      if (goalStatusChartInstance) {
        goalStatusChartInstance.destroy();
      }
      const statusConfig: ChartConfiguration<'doughnut', number[], string> = {
        type: 'doughnut',
        data: {
          labels: ['Active', 'Completed'],
          datasets: [
            {
              data: [statusCounts.ACTIVE, statusCounts.COMPLETED],
              backgroundColor: ['#22c55e', '#60a5fa']
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } },
          cutout: '65%'
        }
      };
      goalStatusChartInstance = new Chart(goalStatusChart, statusConfig);
    };

    const renderKpis = () => {
      const recurringTemplates = transactions.filter((row) => row.isTemplate);
      const recurringIn = recurringTemplates
        .filter((row) => row.type === 'INCOME')
        .reduce((sum, row) => sum + row.amount, 0);
      const recurringOut = recurringTemplates
        .filter((row) => row.type === 'EXPENSE')
        .reduce((sum, row) => sum + row.amount, 0);
      const debtTotal = transactions
        .filter((row) => row.type === 'BORROWED' && (row.paidAmount || 0) < row.amount)
        .reduce((sum, row) => sum + Math.max(0, row.amount - (row.paidAmount || 0)), 0);
      const liquidTotal = transactions
        .filter((row) => row.type === 'LIQUID_ASSET')
        .reduce((sum, row) => sum + row.amount, 0);
      kpiRecIn.textContent = formatMoney(recurringIn);
      kpiRecOut.textContent = formatMoney(recurringOut);
      kpiDebt.textContent = formatMoney(debtTotal);
      kpiLiquid.textContent = formatMoney(liquidTotal);
    };

    const getRangeStartDate = () => {
      if (rangeSelection === 'all') return '';
      const days = Number(rangeSelection);
      const today = new Date();
      const from = new Date();
      from.setDate(today.getDate() - days);
      return from.toISOString().slice(0, 10);
    };

    const setRange = (range: string) => {
      rangeSelection = range;
      rangeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.range === rangeSelection);
      });
      renderTable();
    };

    const refresh = async () => {
      transactions = await listTransactions(session.userId);
      await applyRecurringTemplates();
      transactions = await listTransactions(session.userId);
      goals = await listGoals(session.userId);
      renderKpis();
      renderTable();
      renderRecurringList();
      renderGoalsList();
      renderGoalCharts();
    };

    fillTypeOptions();
    fillFrequencyOptions();
    resetForm();
    resetRecurringForm();
    resetGoalForm();

    const applySectionFromHash = () => {
      if (window.location.hash === '#recurring') {
        setActiveSection('recurring');
      } else if (window.location.hash === '#goals') {
        setActiveSection('goals');
      } else {
        setActiveSection('history');
      }
    };
    applySectionFromHash();
    window.addEventListener('hashchange', applySectionFromHash);

    const quickNavLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>('[data-quick-id^="txn-"]'));
    quickNavLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        const id = link.dataset.quickId;
        if (!id) return;
        if (id === 'txn-history') {
          event.preventDefault();
          window.history.replaceState({}, '', 'transactions.html');
          setActiveSection('history');
          return;
        }
        if (id === 'txn-recurring') {
          event.preventDefault();
          window.location.hash = 'recurring';
          setActiveSection('recurring');
          return;
        }
        if (id === 'txn-goals') {
          event.preventDefault();
          window.location.hash = 'goals';
          setActiveSection('goals');
        }
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = readFormState();
      if (!state.date || !state.category || !state.type) {
        showAlert(feedback, 'danger', 'Please fill required fields.');
        return;
      }
      if (!Number.isFinite(state.amount) || state.amount <= 0) {
        showAlert(feedback, 'danger', 'Amount should be greater than 0.');
        return;
      }
      if (isDebtType(state.type) && !state.personName) {
        showAlert(feedback, 'danger', 'Person name is required for debts.');
        return;
      }
      if ((state.type === 'BORROWED' || state.type === 'LENT') && state.paidAmount > state.amount) {
        showAlert(feedback, 'danger', 'Paid amount cannot exceed total debt amount.');
        return;
      }
      let adjustedAmount = state.amount;
      if (!editingId && (state.type === 'BORROWED' || state.type === 'LENT')) {
        const personKey = state.personName.trim().toLowerCase();
        const oppositeType = state.type === 'BORROWED' ? 'LENT' : 'BORROWED';
        const offsetRows = transactions
          .filter(
            (row) =>
              row.type === oppositeType &&
              (row.personName || '').trim().toLowerCase() === personKey &&
              (row.paidAmount || 0) < row.amount
          )
          .sort((a, b) => a.date.localeCompare(b.date));
        for (const row of offsetRows) {
          if (adjustedAmount <= 0) break;
          const remaining = Math.max(0, row.amount - (row.paidAmount || 0));
          if (remaining <= 0) continue;
          const offset = Math.min(adjustedAmount, remaining);
          const paymentType: TransactionType = row.type === 'LENT' ? 'DEBT_RECEIVE' : 'DEBT_REPAY';
          await addTransaction({
            userId: session.userId,
            type: paymentType,
            amount: offset,
            category: categoriesByType[paymentType][0],
            date: state.date,
            notes: `Auto offset from ${state.type === 'BORROWED' ? 'borrow' : 'lend'} entry`,
            personName: row.personName || undefined,
            dueDate: row.dueDate || undefined,
            status: undefined,
            paidAmount: undefined,
            isRecurring: false,
            recurrence: null,
            nextRun: null,
            isTemplate: false,
            linkedId: row.id
          });
          const newPaid = (row.paidAmount || 0) + offset;
          const newStatus = newPaid >= row.amount ? 'CLOSED' : 'OPEN';
          await updateTransaction(row.id, session.userId, { paidAmount: newPaid, status: newStatus });
          adjustedAmount -= offset;
        }
        if (adjustedAmount <= 0) {
          showAlert(feedback, 'success', 'Debt offset by existing balance. No new debt recorded.');
          await queueAndSync();
          resetForm();
          await refresh();
          return;
        }
      }

      const paidAmount = isDebtType(state.type) ? state.paidAmount : undefined;
      const computedStatus =
        state.type === 'BORROWED' || state.type === 'LENT'
          ? (paidAmount || 0) >= adjustedAmount
            ? 'CLOSED'
            : 'OPEN'
          : undefined;
      const payload: Omit<TransactionRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: session.userId,
        type: state.type,
        amount: adjustedAmount,
        category: state.category,
        date: state.date,
        notes: state.notes || undefined,
        personName: state.personName || undefined,
        dueDate: state.dueDate || undefined,
        status: computedStatus,
        paidAmount,
        isRecurring: false,
        recurrence: null,
        nextRun: null,
        recurrenceEnd: null,
        isTemplate: false,
        linkedId: undefined
      };

      try {
        if (editingId) {
          await updateTransaction(editingId, session.userId, payload);
          showAlert(feedback, 'success', 'Transaction updated.');
        } else {
          await addTransaction(payload);
          showAlert(feedback, 'success', 'Transaction saved.');
        }
        await queueAndSync();
        resetForm();
        await refresh();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    resetButton.addEventListener('click', () => resetForm());
    recResetButton.addEventListener('click', () => resetRecurringForm());

    recForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = readRecurringFormState();
      if (!state.startDate || !state.category || !state.type) {
        showAlert(feedback, 'danger', 'Please fill required fields.');
        return;
      }
      if (!Number.isFinite(state.amount) || state.amount <= 0) {
        showAlert(feedback, 'danger', 'Amount should be greater than 0.');
        return;
      }
      if (isDebtType(state.type) && !state.personName) {
        showAlert(feedback, 'danger', 'Person name is required for debts.');
        return;
      }
      if (state.frequency === 'CUSTOM' && (!state.intervalDays || state.intervalDays < 1)) {
        showAlert(feedback, 'danger', 'Custom interval should be at least 1 day.');
        return;
      }
      if (state.endDate && state.endDate < state.startDate) {
        showAlert(feedback, 'danger', 'End date should be after start date.');
        return;
      }

      const payload: Omit<TransactionRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: session.userId,
        type: state.type,
        amount: state.amount,
        category: state.category,
        date: state.startDate,
        notes: state.notes || undefined,
        personName: state.personName || undefined,
        dueDate: undefined,
        status: isDebtType(state.type) ? 'OPEN' : undefined,
        paidAmount: isDebtType(state.type) ? 0 : undefined,
        isRecurring: true,
        recurrence: {
          frequency: state.frequency,
          intervalDays: state.frequency === 'CUSTOM' ? state.intervalDays : undefined
        },
        nextRun: computeNextRun(state.startDate, state.frequency, state.intervalDays),
        recurrenceEnd: state.endDate || null,
        isTemplate: true,
        linkedId: undefined
      };

      try {
        if (editingRecurringId) {
          await updateTransaction(editingRecurringId, session.userId, payload);
          showAlert(feedback, 'success', 'Recurring template updated.');
        } else {
          await addTransaction(payload);
          showAlert(feedback, 'success', 'Recurring template created.');
        }
        await queueAndSync();
        resetRecurringForm();
        await refresh();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    goalForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = readGoalFormState();
      if (!state.name || !state.targetAmount || !state.targetYear) {
        showAlert(feedback, 'danger', 'Please fill goal name, target amount, and target year.');
        return;
      }
      if (!Number.isFinite(state.targetAmount) || state.targetAmount <= 0) {
        showAlert(feedback, 'danger', 'Target amount should be greater than 0.');
        return;
      }
      if (!Number.isFinite(state.targetYear) || state.targetYear < 2000 || state.targetYear > 2100) {
        showAlert(feedback, 'danger', 'Target year should be a valid year.');
        return;
      }
      const payload: Omit<GoalPlan, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: session.userId,
        name: state.name,
        targetAmount: state.targetAmount,
        targetYear: state.targetYear,
        status: state.status || 'ACTIVE',
        notes: state.notes || undefined
      };
      try {
        if (editingGoalId) {
          await updateGoal(editingGoalId, session.userId, payload);
          showAlert(feedback, 'success', 'Goal updated.');
        } else {
          await addGoal(payload);
          showAlert(feedback, 'success', 'Goal created.');
        }
        await queueAndSync();
        resetGoalForm();
        await refresh();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    goalResetButton.addEventListener('click', () => resetGoalForm());

    typeSelect.addEventListener('change', () => {
      const state = readFormState();
      setFormState({ ...state, category: categoriesByType[state.type][0] });
    });

    recTypeSelect.addEventListener('change', () => {
      const state = readRecurringFormState();
      setRecurringFormState({ ...state, category: categoriesByType[state.type][0] });
    });

    recFrequencySelect.addEventListener('change', () => {
      const state = readRecurringFormState();
      const interval = recurrenceOptions.find((option) => option.id === state.frequency)?.intervalDays || 1;
      setRecurringFormState({ ...state, intervalDays: interval });
    });

    recIntervalInput.addEventListener('input', () => {
      const state = readRecurringFormState();
      recNextRunLabel.textContent = `Next run: ${computeNextRun(state.startDate, state.frequency, state.intervalDays)}`;
    });

    recStartInput.addEventListener('change', () => {
      const state = readRecurringFormState();
      recNextRunLabel.textContent = `Next run: ${computeNextRun(state.startDate, state.frequency, state.intervalDays)}`;
    });


    dateInput.addEventListener('change', () => {
      const state = readFormState();
      setFormState(state);
    });

    searchInput.addEventListener('input', renderTable);
    filterType.addEventListener('change', renderTable);
    rangeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const range = btn.dataset.range || '30';
        setRange(range);
      });
    });

    tableBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const toggle = target.closest<HTMLButtonElement>('[data-action="toggle-details"]');
      if (toggle) {
        const row = toggle.closest<HTMLTableRowElement>('tr');
        if (row) {
          row.classList.toggle('show-details');
          toggle.textContent = row.classList.contains('show-details') ? 'Hide' : 'Details';
        }
        return;
      }
      const paymentsToggle = target.closest<HTMLButtonElement>('[data-action="toggle-payments"]');
      if (paymentsToggle) {
        const row = paymentsToggle.closest<HTMLTableRowElement>('tr');
        if (!row) return;
        const id = paymentsToggle.dataset.id;
        if (!id) return;
        const existing = row.nextElementSibling as HTMLTableRowElement | null;
        if (existing?.classList.contains('txn-payments-row')) {
          existing.remove();
          return;
        }
        const related = transactions
          .filter((txn) => txn.linkedId === id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const detailsRow = document.createElement('tr');
        detailsRow.className = 'txn-payments-row';
        const detailCell = document.createElement('td');
        detailCell.colSpan = 7;
        if (!related.length) {
          detailCell.innerHTML = '<div class="text-muted small">No payments recorded yet.</div>';
        } else {
          detailCell.innerHTML = `
            <div class="txn-payments-list">
              ${related
                .map(
                  (payment) => `
                <div class="txn-payment-item">
                  <div class="fw-semibold">${payment.type === 'DEBT_REPAY' ? 'Repay' : 'Receive'}</div>
                  <div class="text-muted small">${formatDate(payment.date)} • ${formatMoney(payment.amount)}</div>
                </div>
              `
                )
                .join('')}
            </div>
          `;
        }
        detailsRow.appendChild(detailCell);
        row.insertAdjacentElement('afterend', detailsRow);
        return;
      }
      const payButton = target.closest<HTMLButtonElement>('[data-action="pay"]');
      if (payButton) {
        const id = payButton.dataset.id;
        const row = transactions.find((txn) => txn.id === id);
        if (!row) return;
        openPaymentModal(row);
        return;
      }
      const editButton = target.closest<HTMLButtonElement>('[data-action="edit"]');
      if (editButton) {
        const id = editButton.dataset.id;
        const row = transactions.find((txn) => txn.id === id);
        if (!row) return;
        editingId = row.id;
        setFormState({
          type: row.type,
          amount: row.amount,
          category: row.category,
          date: row.date,
          notes: row.notes || '',
          personName: row.personName || '',
          dueDate: row.dueDate || '',
          paidAmount: row.paidAmount || 0,
        });
        return;
      }
      const deleteButton = target.closest<HTMLButtonElement>('[data-action="delete"]');
      if (deleteButton) {
        deletingId = deleteButton.dataset.id || null;
        deletingType = 'transaction';
        openModal();
      }
    });

    recTableBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const editButton = target.closest<HTMLButtonElement>('[data-action="rec-edit"]');
      if (editButton) {
        const id = editButton.dataset.id;
        const row = transactions.find((txn) => txn.id === id);
        if (!row) return;
        editingRecurringId = row.id;
        setRecurringFormState({
          type: row.type,
          amount: row.amount,
          category: row.category,
          startDate: row.date,
          endDate: row.recurrenceEnd || '',
          notes: row.notes || '',
          personName: row.personName || '',
          frequency: row.recurrence?.frequency || 'MONTHLY',
          intervalDays: row.recurrence?.intervalDays || 30
        });
        setActiveSection('recurring');
        return;
      }
      const deleteButton = target.closest<HTMLButtonElement>('[data-action="rec-delete"]');
      if (deleteButton) {
        deletingId = deleteButton.dataset.id || null;
        deletingType = 'transaction';
        openModal();
      }
    });

    goalTableBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const editButton = target.closest<HTMLButtonElement>('[data-action="goal-edit"]');
      if (editButton) {
        const id = editButton.dataset.id;
        const goal = goals.find((item) => item.id === id);
        if (!goal) return;
        editingGoalId = goal.id;
        const fallbackYear =
          goal.targetYear || (goal.targetDate ? new Date(goal.targetDate).getFullYear() : new Date().getFullYear());
        setGoalFormState({ ...goal, targetYear: fallbackYear });
        setActiveSection('goals');
        return;
      }
      const deleteButton = target.closest<HTMLButtonElement>('[data-action="goal-delete"]');
      if (deleteButton) {
        deletingId = deleteButton.dataset.id || null;
        deletingType = 'goal';
        openModal();
      }
    });

    deleteModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'modal') {
        closeModal();
      }
    });

    paymentModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'payment') {
        closePaymentModal();
      }
    });

    paymentSave.addEventListener('click', async () => {
      if (!paymentTarget) return;
      const amount = Number.isFinite(paymentAmount.valueAsNumber)
        ? paymentAmount.valueAsNumber
        : Number(paymentAmount.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        showAlert(feedback, 'danger', 'Payment amount should be greater than 0.');
        return;
      }
      const remaining = Math.max(0, paymentTarget.amount - (paymentTarget.paidAmount || 0));
      if (amount > remaining) {
        showAlert(feedback, 'danger', 'Payment exceeds remaining balance.');
        return;
      }
      const paymentType: TransactionType = paymentTarget.type === 'BORROWED' ? 'DEBT_REPAY' : 'DEBT_RECEIVE';
      try {
        await addTransaction({
          userId: paymentTarget.userId,
          type: paymentType,
          amount,
          category: categoriesByType[paymentType][0],
          date: paymentDate.value || new Date().toISOString().slice(0, 10),
          notes: paymentNotes.value.trim(),
          personName: paymentTarget.personName || undefined,
          dueDate: paymentTarget.dueDate || undefined,
          status: undefined,
          paidAmount: undefined,
          isRecurring: false,
          recurrence: null,
          nextRun: null,
          isTemplate: false,
          linkedId: paymentTarget.id
        });
        const newPaid = (paymentTarget.paidAmount || 0) + amount;
        const newStatus = newPaid >= paymentTarget.amount ? 'CLOSED' : 'OPEN';
        await updateTransaction(paymentTarget.id, paymentTarget.userId, {
          paidAmount: newPaid,
          status: newStatus
        });
        showAlert(feedback, 'success', 'Payment recorded.');
        closePaymentModal();
        await queueAndSync();
        await refresh();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    paymentFull.addEventListener('click', () => {
      if (!paymentRemaining) return;
      paymentAmount.value = String(paymentRemaining);
    });

    deleteConfirm.addEventListener('click', async () => {
      if (!deletingId) return;
      try {
        if (deletingType === 'goal') {
          await deleteGoal(deletingId, session.userId);
          showAlert(feedback, 'success', 'Goal deleted.');
        } else {
          await deleteTransaction(deletingId, session.userId);
          showAlert(feedback, 'success', 'Transaction deleted.');
        }
        await queueAndSync();
        deletingId = null;
        closeModal();
        await refresh();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refresh();
        showAlert(feedback, 'success', 'Transactions synced.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    await refresh();
    setRange('30');
  })();
}
