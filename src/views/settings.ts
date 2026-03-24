import * as XLSX from 'xlsx';
import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
import type {
  GoalPlan,
  RecurrenceFrequency,
  RecoveryLeg,
  RecoveryLossLeg,
  RecoveryPlan,
  TradeRecord,
  TradeSide,
  TransactionRecord,
  UserSettings
} from '../core/types';
import { listTrades, replaceTradesForUser } from '../storage/trades';
import { listTransactions, replaceTransactionsForUser } from '../storage/transactions';
import { listGoals, replaceGoalsForUser } from '../storage/goals';
import { listRecoveryPlans, replaceRecoveryPlansForUser } from '../storage/recoveryPlans';
import { deleteUserSettings, getUserSettings, saveUserSettings } from '../storage/settings';
import { queueSnapshot } from '../services/cloudSync';
import { requireSession } from './guards';
import { lucideIcon } from '../ui/icons';
import { renderConfirmModal, bindConfirmModal } from '../ui/confirm';
import { toErrorMessage } from '../utils/errors';

export function renderSettingsView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading settings...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'settings',
      title: 'Settings',
      subtitle: 'Control allocation, fees, and return expectations used across the app.',
      content: `
        <div id="settings-feedback" class="alert d-none" role="alert"></div>

        <div class="row g-3">
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('sliders')}</span>
                  Allocation
                </h2>
                <div class="mb-3">
                  <label class="form-label">Total Investment Amount (INR)</label>
                  <div class="input-group">
                    <span class="input-group-text">₹</span>
                    <input class="form-control" type="number" min="0" step="0.01" id="settings-total-investment" />
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label">Max Allocation Limit</label>
                  <div class="input-group">
                    <input class="form-control" type="number" min="0" step="0.1" id="settings-max-allocation" />
                    <span class="input-group-text">%</span>
                  </div>
                  <div class="form-text text-muted">Percentage of total investment per trade.</div>
                </div>
                <div class="row g-3">
                  <div class="col-6">
                    <label class="form-label">L1 Zone</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-l1-zone" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-6">
                    <label class="form-label">L2 Zone</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-l2-zone" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('receipt')}</span>
                  Charges
                </h2>
                <div class="row g-3">
                  <div class="col-md-6">
                    <label class="form-label">Buy Brokerage</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-buy-brokerage" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Sell Brokerage</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-sell-brokerage" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">DP Charge</label>
                    <div class="input-group">
                      <span class="input-group-text">₹</span>
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-dp-charge" />
                    </div>
                  </div>
                </div>
                <div class="text-muted small mt-2">Charges are stored for future P&L calculations.</div>
              </div>
            </div>
          </div>
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('activity')}</span>
                  Return Benchmarks (Annual %)
                </h2>
                <div class="row g-3">
                  <div class="col-md-3">
                    <label class="form-label">Expected Return</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-expected-return" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">Inflation</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-inflation" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">FD Return</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-fd-return" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">Target Exit Profit</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-target-profit" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="d-flex flex-wrap gap-2 mt-4">
          <button class="btn btn-primary" id="settings-save">Save Settings</button>
          <div class="text-muted small align-self-center" id="settings-updated">Last updated: --</div>
        </div>

        <div class="row g-3 mt-4">
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('database')}</span>
                  Data Backup
                </h2>
                <div class="text-muted small mb-3">
                  Export or import your full app data as an Excel workbook.
                </div>
                <div class="d-flex flex-wrap gap-2">
                  <button class="btn btn-outline-primary" id="settings-export">Export Excel</button>
                  <button class="btn btn-outline-secondary" id="settings-import">Import Excel</button>
                  <input class="d-none" type="file" id="settings-import-file" accept=".xlsx,.xls" />
                </div>
                <div class="text-muted small mt-2">
                  Sheets: Trades, Transactions, Recurring, Goals, RecoveryPlans, RecoveryLegs, RecoveryLossLegs, Settings
                </div>
              </div>
            </div>
          </div>
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title text-danger">
                  <span class="section-icon">${lucideIcon('trash')}</span>
                  Danger Zone
                </h2>
                <div class="text-muted small mb-3">
                  Delete a section of data for the current user only. This cannot be undone.
                </div>
                <div class="row g-2 align-items-end">
                  <div class="col-md-7">
                    <label class="form-label">Delete Section</label>
                    <select class="form-select" id="settings-delete-scope">
                      <option value="trades">Trades</option>
                      <option value="transactions">Transactions</option>
                      <option value="recurring">Recurring Templates</option>
                      <option value="goals">Goals</option>
                      <option value="settings">Settings</option>
                      <option value="all">All Data</option>
                    </select>
                  </div>
                  <div class="col-md-5 d-grid">
                    <button class="btn btn-danger" id="settings-delete-btn">Delete Data</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        ${renderConfirmModal()}

        <div class="app-modal" id="settings-import-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="modal"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <h3 class="h6 mb-0">Import Excel Data</h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="settings-import-close">Close</button>
                </div>
                <div class="text-muted small mb-3">
                  Choose how you want to apply the incoming data for this user.
                </div>
                <div class="text-muted small" id="settings-import-summary">No file loaded.</div>
                <div class="alert alert-warning small mt-3 mb-0">
                  Replace will overwrite selected sheets for this user.
                </div>
                <div class="d-flex flex-wrap gap-2 justify-content-end mt-3">
                  <button class="btn btn-outline-secondary" type="button" id="settings-import-cancel">Cancel</button>
                  <button class="btn btn-outline-primary" type="button" id="settings-import-merge">Merge</button>
                  <button class="btn btn-danger" type="button" id="settings-import-replace">Replace</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);

    const feedback = root.querySelector<HTMLDivElement>('#settings-feedback');
    const totalInvestment = root.querySelector<HTMLInputElement>('#settings-total-investment');
    const maxAllocation = root.querySelector<HTMLInputElement>('#settings-max-allocation');
    const l1Zone = root.querySelector<HTMLInputElement>('#settings-l1-zone');
    const l2Zone = root.querySelector<HTMLInputElement>('#settings-l2-zone');
    const buyBrokerage = root.querySelector<HTMLInputElement>('#settings-buy-brokerage');
    const sellBrokerage = root.querySelector<HTMLInputElement>('#settings-sell-brokerage');
    const dpCharge = root.querySelector<HTMLInputElement>('#settings-dp-charge');
    const expectedReturn = root.querySelector<HTMLInputElement>('#settings-expected-return');
    const inflation = root.querySelector<HTMLInputElement>('#settings-inflation');
    const fdReturn = root.querySelector<HTMLInputElement>('#settings-fd-return');
    const targetProfit = root.querySelector<HTMLInputElement>('#settings-target-profit');
    const saveBtn = root.querySelector<HTMLButtonElement>('#settings-save');
    const updatedAt = root.querySelector<HTMLElement>('#settings-updated');
    const exportBtn = root.querySelector<HTMLButtonElement>('#settings-export');
    const importBtn = root.querySelector<HTMLButtonElement>('#settings-import');
    const importFile = root.querySelector<HTMLInputElement>('#settings-import-file');
    const importModal = root.querySelector<HTMLDivElement>('#settings-import-modal');
    const importSummary = root.querySelector<HTMLDivElement>('#settings-import-summary');
    const importClose = root.querySelector<HTMLButtonElement>('#settings-import-close');
    const importCancel = root.querySelector<HTMLButtonElement>('#settings-import-cancel');
    const importMerge = root.querySelector<HTMLButtonElement>('#settings-import-merge');
    const importReplace = root.querySelector<HTMLButtonElement>('#settings-import-replace');
    const deleteScope = root.querySelector<HTMLSelectElement>('#settings-delete-scope');
    const deleteBtn = root.querySelector<HTMLButtonElement>('#settings-delete-btn');

    if (
      !feedback ||
      !totalInvestment ||
      !maxAllocation ||
      !l1Zone ||
      !l2Zone ||
      !buyBrokerage ||
      !sellBrokerage ||
      !dpCharge ||
      !expectedReturn ||
      !inflation ||
      !fdReturn ||
      !targetProfit ||
      !saveBtn ||
      !updatedAt ||
      !exportBtn ||
      !importBtn ||
      !importFile ||
      !importModal ||
      !importSummary ||
      !importClose ||
      !importCancel ||
      !importMerge ||
      !importReplace ||
      !deleteScope ||
      !deleteBtn
    ) {
      throw new Error('Settings view failed to initialize');
    }

    const confirmAction = bindConfirmModal(root);

    const loadSettings = async () => {
      const settings = await getUserSettings(session.userId);
      totalInvestment.value = String(settings.totalInvestment || 0);
      maxAllocation.value = String(settings.maxAllocationPct || 0);
      l1Zone.value = String(settings.l1ZonePct || 0);
      l2Zone.value = String(settings.l2ZonePct || 0);
      buyBrokerage.value = String(settings.buyBrokeragePct || 0);
      sellBrokerage.value = String(settings.sellBrokeragePct || 0);
      dpCharge.value = String(settings.dpCharge || 0);
      expectedReturn.value = String(settings.expectedReturnPct || 0);
      inflation.value = String(settings.inflationPct || 0);
      fdReturn.value = String(settings.fdReturnPct || 0);
      targetProfit.value = String(settings.targetProfitPct || 10);
      updatedAt.textContent = `Last updated: ${new Date(settings.updatedAt).toLocaleString()}`;
    };

    const toNumber = (value: string) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const readString = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      return String(value).trim();
    };

    const readNumber = (value: unknown, fallback = 0): number => {
      if (value === null || value === undefined || value === '') return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const readOptionalNumber = (value: unknown): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const readBoolean = (value: unknown): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return false;
        return ['true', 'yes', '1', 'y'].includes(normalized);
      }
      return false;
    };

    const normalizeDate = (value: unknown): string => {
      if (!value) return '';
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      const asString = String(value).trim();
      const parsed = new Date(asString);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
      return asString;
    };

    const normalizeTimestamp = (value: unknown): string => {
      if (!value) return new Date().toISOString();
      if (value instanceof Date) return value.toISOString();
      const parsed = new Date(String(value));
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      return new Date().toISOString();
    };

    const mergeById = <T extends { id: string }>(existing: T[], incoming: T[]): T[] => {
      const map = new Map(existing.map((row) => [row.id, row]));
      incoming.forEach((row) => map.set(row.id, row));
      return Array.from(map.values());
    };

    const makeSheet = (rows: Record<string, unknown>[], headers: string[]) => {
      const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
      if (!rows.length) {
        headers.forEach((header, index) => {
          const cell = XLSX.utils.encode_cell({ r: 0, c: index });
          sheet[cell] = { t: 's', v: header };
        });
        sheet['!ref'] = XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: 0, c: headers.length - 1 }
        });
      }
      sheet['!cols'] = headers.map(() => ({ wch: 18 }));
      return sheet;
    };

    saveBtn.addEventListener('click', async () => {
      clearAlert(feedback);
      const label = saveBtn.textContent || 'Save Settings';
      setBusy(saveBtn, true, label);
      try {
        const settings = {
          userId: session.userId,
          totalInvestment: toNumber(totalInvestment.value),
          maxAllocationPct: toNumber(maxAllocation.value),
          l1ZonePct: toNumber(l1Zone.value),
          l2ZonePct: toNumber(l2Zone.value),
          buyBrokeragePct: toNumber(buyBrokerage.value),
          sellBrokeragePct: toNumber(sellBrokerage.value),
          dpCharge: toNumber(dpCharge.value),
          expectedReturnPct: toNumber(expectedReturn.value),
          inflationPct: toNumber(inflation.value),
          fdReturnPct: toNumber(fdReturn.value),
          targetProfitPct: toNumber(targetProfit.value),
          updatedAt: new Date().toISOString()
        };
        await saveUserSettings(settings);
        await queueSnapshot(session.userId);
        await loadSettings();
        showAlert(feedback, 'success', 'Settings saved.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(saveBtn, false, label);
      }
    });

    const closeImportModal = () => {
      importModal.classList.remove('show');
      importModal.setAttribute('aria-hidden', 'true');
    };

    const openImportModal = () => {
      importModal.classList.add('show');
      importModal.setAttribute('aria-hidden', 'false');
    };

    importModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'modal') {
        closeImportModal();
      }
    });
    importClose.addEventListener('click', closeImportModal);
    importCancel.addEventListener('click', closeImportModal);

    type ImportBundle = {
      trades: TradeRecord[];
      tradesPresent: boolean;
      transactions: TransactionRecord[];
      transactionsPresent: boolean;
      recurring: TransactionRecord[];
      recurringPresent: boolean;
      goals: GoalPlan[];
      goalsPresent: boolean;
      recoveryPlans: RecoveryPlan[];
      recoveryPlansPresent: boolean;
      recoveryLossLegs: Array<RecoveryLossLeg & { planId: string }>;
      recoveryLossLegsPresent: boolean;
      settings: Partial<UserSettings> | null;
      settingsPresent: boolean;
    };

    let pendingImport: ImportBundle | null = null;

    const parseTradeRows = (rows: Record<string, unknown>[]): TradeRecord[] =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          const side = (readString(row.side).toUpperCase() as TradeSide) || 'BUY';
          return {
            id,
            userId: session.userId,
            symbol: readString(row.symbol),
            side,
            quantity: readNumber(row.quantity),
            price: readNumber(row.price),
            tradeDate: normalizeDate(row.tradeDate),
            exitPrice: readOptionalNumber(row.exitPrice),
            notes: readString(row.notes) || undefined,
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt)
          };
        })
        .filter((row) => row.symbol && row.tradeDate);

    const parseTransactionRows = (rows: Record<string, unknown>[], forceTemplate: boolean): TransactionRecord[] =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          const frequency = readString(row.recurrence_frequency || row.recurrenceFrequency);
          const intervalDays = readOptionalNumber(row.recurrence_intervalDays || row.recurrenceIntervalDays);
          const recurrence =
            frequency.length > 0
              ? {
                  frequency: frequency as RecurrenceFrequency,
                  intervalDays:
                    frequency === 'CUSTOM'
                      ? intervalDays || 1
                      : intervalDays && intervalDays > 0
                        ? intervalDays
                        : undefined
                }
              : null;
          const isTemplate = forceTemplate ? true : readBoolean(row.isTemplate);
          const isRecurring = isTemplate || readBoolean(row.isRecurring) || Boolean(recurrence);
          const statusRaw = readString(row.status);
          const status =
            statusRaw === 'CLOSED' ? 'CLOSED' : statusRaw === 'OPEN' ? 'OPEN' : undefined;
          return {
            id,
            userId: session.userId,
            type: (readString(row.type).toUpperCase() || 'EXPENSE') as TransactionRecord['type'],
            amount: readNumber(row.amount),
            category: readString(row.category),
            date: normalizeDate(row.date),
            notes: readString(row.notes) || undefined,
            personName: readString(row.personName) || null,
            dueDate: readString(row.dueDate) || null,
            status: status as TransactionRecord['status'],
            paidAmount: readOptionalNumber(row.paidAmount),
            linkedId: readString(row.linkedId) || null,
            isRecurring,
            recurrence: isRecurring ? recurrence : null,
            nextRun: isTemplate ? (normalizeDate(row.nextRun) || null) : null,
            recurrenceEnd: isTemplate ? (normalizeDate(row.recurrenceEnd) || null) : null,
            isTemplate,
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt)
          } as TransactionRecord;
        })
        .filter((row) => row.category && row.date);

    const parseGoalRows = (rows: Record<string, unknown>[]): GoalPlan[] =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          const status = readString(row.status) === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';
          return {
            id,
            userId: session.userId,
            name: readString(row.name),
            targetAmount: readNumber(row.targetAmount),
            targetYear: readNumber(row.targetYear),
            targetDate: readString(row.targetDate) || null,
            status: status as GoalPlan['status'],
            notes: readString(row.notes) || undefined,
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt)
          } as GoalPlan;
        })
        .filter((row) => row.name);

    const parseRecoveryPlanRows = (rows: Record<string, unknown>[]): RecoveryPlan[] =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          const status = readString(row.status) === 'CLOSED' ? 'CLOSED' : 'ACTIVE';
          return {
            id,
            userId: session.userId,
            status: status as RecoveryPlan['status'],
            lossTradeId: readString(row.lossTradeId) || undefined,
            lossSymbol: readString(row.lossSymbol),
            lossQuantity: readNumber(row.lossQuantity),
            lossSellPrice: readNumber(row.lossSellPrice),
            lossAmount: readNumber(row.lossAmount),
            lossTradeDate: normalizeDate(row.lossTradeDate),
            lossHoldDays: readOptionalNumber(row.lossHoldDays),
            recoveryTrades: [],
            notes: readString(row.notes) || undefined,
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt),
            closedAt: readString(row.closedAt) || null
          } as RecoveryPlan;
        })
        .filter((row) => row.lossSymbol && row.lossTradeDate);

    const parseRecoveryLossRows = (
      rows: Record<string, unknown>[]
    ): Array<RecoveryLossLeg & { planId: string }> =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          return {
            id,
            planId: readString(row.planId),
            tradeId: readString(row.tradeId) || undefined,
            symbol: readString(row.symbol),
            quantity: readNumber(row.quantity),
            sellPrice: readNumber(row.sellPrice),
            lossAmount: readNumber(row.lossAmount),
            tradeDate: normalizeDate(row.tradeDate),
            holdDays: readOptionalNumber(row.holdDays),
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt)
          } as RecoveryLossLeg & { planId: string };
        })
        .filter((row) => row.planId && row.symbol);

    const parseRecoveryLegRows = (rows: Record<string, unknown>[]): Array<RecoveryLeg & { planId: string }> =>
      rows
        .map((row) => {
          const id = readString(row.id) || crypto.randomUUID();
          return {
            id,
            planId: readString(row.planId),
            tradeId: readString(row.tradeId) || undefined,
            symbol: readString(row.symbol),
            quantity: readNumber(row.quantity),
            buyPrice: readNumber(row.buyPrice),
            investedAmount: readNumber(row.investedAmount),
            createdAt: normalizeTimestamp(row.createdAt),
            updatedAt: normalizeTimestamp(row.updatedAt)
          };
        })
        .filter((row) => row.planId && row.symbol);

    const parseSettingsRow = (rows: Record<string, unknown>[]): Partial<UserSettings> | null => {
      if (!rows.length) return null;
      const row = rows[0] || {};
      const patch: Partial<UserSettings> = {};
      const totalInvestment = readOptionalNumber(row.totalInvestment);
      const maxAllocationPct = readOptionalNumber(row.maxAllocationPct);
      const l1ZonePct = readOptionalNumber(row.l1ZonePct);
      const l2ZonePct = readOptionalNumber(row.l2ZonePct);
      const buyBrokeragePct = readOptionalNumber(row.buyBrokeragePct);
      const sellBrokeragePct = readOptionalNumber(row.sellBrokeragePct);
      const dpCharge = readOptionalNumber(row.dpCharge);
      const expectedReturnPct = readOptionalNumber(row.expectedReturnPct);
      const inflationPct = readOptionalNumber(row.inflationPct);
      const fdReturnPct = readOptionalNumber(row.fdReturnPct);
      const targetProfitPct = readOptionalNumber(row.targetProfitPct);

      if (totalInvestment !== null) patch.totalInvestment = totalInvestment;
      if (maxAllocationPct !== null) patch.maxAllocationPct = maxAllocationPct;
      if (l1ZonePct !== null) patch.l1ZonePct = l1ZonePct;
      if (l2ZonePct !== null) patch.l2ZonePct = l2ZonePct;
      if (buyBrokeragePct !== null) patch.buyBrokeragePct = buyBrokeragePct;
      if (sellBrokeragePct !== null) patch.sellBrokeragePct = sellBrokeragePct;
      if (dpCharge !== null) patch.dpCharge = dpCharge;
      if (expectedReturnPct !== null) patch.expectedReturnPct = expectedReturnPct;
      if (inflationPct !== null) patch.inflationPct = inflationPct;
      if (fdReturnPct !== null) patch.fdReturnPct = fdReturnPct;
      if (targetProfitPct !== null) patch.targetProfitPct = targetProfitPct;

      patch.updatedAt = row.updatedAt ? normalizeTimestamp(row.updatedAt) : new Date().toISOString();
      return patch;
    };

    const parseWorkbook = async (file: File): Promise<ImportBundle> => {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const tradesSheet = workbook.Sheets['Trades'];
      const transactionsSheet = workbook.Sheets['Transactions'];
      const recurringSheet = workbook.Sheets['Recurring'];
      const goalsSheet = workbook.Sheets['Goals'];
      const recoveryPlansSheet = workbook.Sheets['RecoveryPlans'];
      const recoveryLegsSheet = workbook.Sheets['RecoveryLegs'];
      const recoveryLossSheet = workbook.Sheets['RecoveryLossLegs'];
      const settingsSheet = workbook.Sheets['Settings'];

      const tradesRows = tradesSheet ? (XLSX.utils.sheet_to_json(tradesSheet, { defval: '' }) as Record<string, unknown>[]) : [];
      const transactionRows = transactionsSheet
        ? (XLSX.utils.sheet_to_json(transactionsSheet, { defval: '' }) as Record<string, unknown>[])
        : [];
      const recurringRows = recurringSheet
        ? (XLSX.utils.sheet_to_json(recurringSheet, { defval: '' }) as Record<string, unknown>[])
        : [];
      const goalRows = goalsSheet ? (XLSX.utils.sheet_to_json(goalsSheet, { defval: '' }) as Record<string, unknown>[]) : [];
      const recoveryPlanRows = recoveryPlansSheet
        ? (XLSX.utils.sheet_to_json(recoveryPlansSheet, { defval: '' }) as Record<string, unknown>[])
        : [];
      const recoveryLegRows = recoveryLegsSheet
        ? (XLSX.utils.sheet_to_json(recoveryLegsSheet, { defval: '' }) as Record<string, unknown>[])
        : [];
      const recoveryLossRows = recoveryLossSheet
        ? (XLSX.utils.sheet_to_json(recoveryLossSheet, { defval: '' }) as Record<string, unknown>[])
        : [];
      const settingsRows = settingsSheet
        ? (XLSX.utils.sheet_to_json(settingsSheet, { defval: '' }) as Record<string, unknown>[])
        : [];

      const plans = parseRecoveryPlanRows(recoveryPlanRows);
      const legs = parseRecoveryLegRows(recoveryLegRows);
      const lossLegs = parseRecoveryLossRows(recoveryLossRows);
      if (legs.length && plans.length) {
        const map = new Map(plans.map((plan) => [plan.id, plan]));
        legs.forEach((leg) => {
          const plan = map.get(leg.planId);
          if (plan) {
            const { planId: _planId, ...rest } = leg;
            plan.recoveryTrades.push(rest);
          }
        });
      }
      if (lossLegs.length && plans.length) {
        const map = new Map(plans.map((plan) => [plan.id, plan]));
        lossLegs.forEach((leg) => {
          const plan = map.get(leg.planId);
          if (plan) {
            const { planId: _planId, ...rest } = leg;
            if (!plan.lossTrades) {
              plan.lossTrades = [];
            }
            plan.lossTrades.push(rest);
          }
        });
      }

      return {
        trades: parseTradeRows(tradesRows),
        tradesPresent: Boolean(tradesSheet),
        transactions: parseTransactionRows(transactionRows, false),
        transactionsPresent: Boolean(transactionsSheet),
        recurring: parseTransactionRows(recurringRows, true),
        recurringPresent: Boolean(recurringSheet),
        goals: parseGoalRows(goalRows),
        goalsPresent: Boolean(goalsSheet),
        recoveryPlans: plans,
        recoveryPlansPresent: Boolean(recoveryPlansSheet || recoveryLegsSheet || recoveryLossSheet),
        recoveryLossLegs: lossLegs,
        recoveryLossLegsPresent: Boolean(recoveryLossSheet),
        settings: parseSettingsRow(settingsRows),
        settingsPresent: Boolean(settingsSheet)
      };
    };

    const applyImport = async (mode: 'merge' | 'replace', bundle: ImportBundle) => {
      if (bundle.tradesPresent) {
        if (mode === 'replace') {
          await replaceTradesForUser(session.userId, bundle.trades);
        } else {
          const existing = await listTrades(session.userId);
          await replaceTradesForUser(session.userId, mergeById(existing, bundle.trades));
        }
      }

      if (bundle.goalsPresent) {
        if (mode === 'replace') {
          await replaceGoalsForUser(session.userId, bundle.goals);
        } else {
          const existing = await listGoals(session.userId);
          await replaceGoalsForUser(session.userId, mergeById(existing, bundle.goals));
        }
      }

      if (bundle.recoveryPlansPresent) {
        if (mode === 'replace') {
          await replaceRecoveryPlansForUser(session.userId, bundle.recoveryPlans);
        } else {
          const existing = await listRecoveryPlans(session.userId);
          await replaceRecoveryPlansForUser(session.userId, mergeById(existing, bundle.recoveryPlans));
        }
      }

      if (bundle.transactionsPresent || bundle.recurringPresent) {
        const existing = await listTransactions(session.userId);
        const importedAll = [...bundle.transactions, ...bundle.recurring];
        if (mode === 'replace') {
          if (bundle.transactionsPresent && bundle.recurringPresent) {
            await replaceTransactionsForUser(session.userId, importedAll);
          } else if (bundle.transactionsPresent) {
            const templates = existing.filter((row) => row.isTemplate);
            await replaceTransactionsForUser(session.userId, [...templates, ...bundle.transactions]);
          } else if (bundle.recurringPresent) {
            const history = existing.filter((row) => !row.isTemplate);
            await replaceTransactionsForUser(session.userId, [...history, ...bundle.recurring]);
          }
        } else {
          await replaceTransactionsForUser(session.userId, mergeById(existing, importedAll));
        }
      }

      if (bundle.settingsPresent && bundle.settings) {
        const existing = await getUserSettings(session.userId);
        await saveUserSettings({
          ...existing,
          ...bundle.settings,
          userId: session.userId,
          updatedAt: bundle.settings.updatedAt || existing.updatedAt
        });
      }

      await queueSnapshot(session.userId);
    };

    const buildSummary = (bundle: ImportBundle) => {
      const settingsCount = bundle.settings ? '1' : '0';
      importSummary.innerHTML = `
        <div class="d-grid gap-1">
          <div>Trades: ${bundle.trades.length}</div>
          <div>Transactions: ${bundle.transactions.length}</div>
          <div>Recurring: ${bundle.recurring.length}</div>
          <div>Goals: ${bundle.goals.length}</div>
          <div>Recovery Plans: ${bundle.recoveryPlans.length}</div>
          <div>Recovery Loss Legs: ${bundle.recoveryLossLegs.length}</div>
          <div>Settings: ${settingsCount}</div>
        </div>
      `;
    };

    exportBtn.addEventListener('click', async () => {
      clearAlert(feedback);
      const label = exportBtn.textContent || 'Export Excel';
      setBusy(exportBtn, true, label);
      try {
        const [trades, transactions, goals, recoveryPlans, settings] = await Promise.all([
          listTrades(session.userId),
          listTransactions(session.userId),
          listGoals(session.userId),
          listRecoveryPlans(session.userId),
          getUserSettings(session.userId)
        ]);
        const history = transactions.filter((row) => !row.isTemplate);
        const recurring = transactions.filter((row) => row.isTemplate);

        const tradeRows = trades.map((trade) => ({
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          quantity: trade.quantity,
          price: trade.price,
          tradeDate: trade.tradeDate,
          exitPrice: trade.exitPrice ?? '',
          notes: trade.notes ?? '',
          createdAt: trade.createdAt,
          updatedAt: trade.updatedAt
        }));

        const transactionRows = history.map((row) => ({
          id: row.id,
          type: row.type,
          amount: row.amount,
          category: row.category,
          date: row.date,
          notes: row.notes ?? '',
          personName: row.personName ?? '',
          dueDate: row.dueDate ?? '',
          status: row.status ?? '',
          paidAmount: row.paidAmount ?? '',
          linkedId: row.linkedId ?? '',
          isRecurring: row.isRecurring ?? false,
          recurrence_frequency: row.recurrence?.frequency ?? '',
          recurrence_intervalDays: row.recurrence?.intervalDays ?? '',
          nextRun: row.nextRun ?? '',
          recurrenceEnd: row.recurrenceEnd ?? '',
          isTemplate: row.isTemplate ?? false,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        }));

        const recurringRows = recurring.map((row) => ({
          id: row.id,
          type: row.type,
          amount: row.amount,
          category: row.category,
          date: row.date,
          notes: row.notes ?? '',
          personName: row.personName ?? '',
          dueDate: row.dueDate ?? '',
          status: row.status ?? '',
          paidAmount: row.paidAmount ?? '',
          linkedId: row.linkedId ?? '',
          isRecurring: row.isRecurring ?? true,
          recurrence_frequency: row.recurrence?.frequency ?? '',
          recurrence_intervalDays: row.recurrence?.intervalDays ?? '',
          nextRun: row.nextRun ?? '',
          recurrenceEnd: row.recurrenceEnd ?? '',
          isTemplate: true,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        }));

        const goalRows = goals.map((goal) => ({
          id: goal.id,
          name: goal.name,
          targetAmount: goal.targetAmount,
          targetYear: goal.targetYear,
          targetDate: goal.targetDate ?? '',
          status: goal.status,
          notes: goal.notes ?? '',
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt
        }));

        const recoveryPlanRows = recoveryPlans.map((plan) => ({
          id: plan.id,
          status: plan.status,
          lossTradeId: plan.lossTradeId ?? '',
          lossSymbol: plan.lossSymbol,
          lossQuantity: plan.lossQuantity,
          lossSellPrice: plan.lossSellPrice,
          lossAmount: plan.lossAmount,
          lossTradeDate: plan.lossTradeDate,
          lossHoldDays: plan.lossHoldDays ?? '',
          notes: plan.notes ?? '',
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          closedAt: plan.closedAt ?? ''
        }));

        const recoveryLegRows = recoveryPlans.flatMap((plan) =>
          plan.recoveryTrades.map((leg) => ({
            id: leg.id,
            planId: plan.id,
            tradeId: leg.tradeId ?? '',
            symbol: leg.symbol,
            quantity: leg.quantity,
            buyPrice: leg.buyPrice,
            investedAmount: leg.investedAmount,
            createdAt: leg.createdAt,
            updatedAt: leg.updatedAt
          }))
        );

        const recoveryLossRows = recoveryPlans.flatMap((plan) => {
          const lossTrades =
            plan.lossTrades && plan.lossTrades.length
              ? plan.lossTrades
              : [
                  {
                    id: plan.lossTradeId || `${plan.id}-loss`,
                    tradeId: plan.lossTradeId,
                    symbol: plan.lossSymbol,
                    quantity: plan.lossQuantity,
                    sellPrice: plan.lossSellPrice,
                    lossAmount: plan.lossAmount,
                    tradeDate: plan.lossTradeDate,
                    holdDays: plan.lossHoldDays ?? null,
                    createdAt: plan.createdAt,
                    updatedAt: plan.updatedAt
                  }
                ];
          return lossTrades.map((leg) => ({
            id: leg.id,
            planId: plan.id,
            tradeId: leg.tradeId ?? '',
            symbol: leg.symbol,
            quantity: leg.quantity,
            sellPrice: leg.sellPrice,
            lossAmount: leg.lossAmount,
            tradeDate: leg.tradeDate,
            holdDays: leg.holdDays ?? '',
            createdAt: leg.createdAt,
            updatedAt: leg.updatedAt
          }));
        });

        const settingsRows = [
          {
            totalInvestment: settings.totalInvestment,
            maxAllocationPct: settings.maxAllocationPct,
            l1ZonePct: settings.l1ZonePct,
            l2ZonePct: settings.l2ZonePct,
            buyBrokeragePct: settings.buyBrokeragePct,
            sellBrokeragePct: settings.sellBrokeragePct,
            dpCharge: settings.dpCharge,
            expectedReturnPct: settings.expectedReturnPct,
            inflationPct: settings.inflationPct,
            fdReturnPct: settings.fdReturnPct,
            targetProfitPct: settings.targetProfitPct,
            updatedAt: settings.updatedAt
          }
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(tradeRows, [
            'id',
            'symbol',
            'side',
            'quantity',
            'price',
            'tradeDate',
            'exitPrice',
            'notes',
            'createdAt',
            'updatedAt'
          ]),
          'Trades'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(transactionRows, [
            'id',
            'type',
            'amount',
            'category',
            'date',
            'notes',
            'personName',
            'dueDate',
            'status',
            'paidAmount',
            'linkedId',
            'isRecurring',
            'recurrence_frequency',
            'recurrence_intervalDays',
            'nextRun',
            'recurrenceEnd',
            'isTemplate',
            'createdAt',
            'updatedAt'
          ]),
          'Transactions'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(recurringRows, [
            'id',
            'type',
            'amount',
            'category',
            'date',
            'notes',
            'personName',
            'dueDate',
            'status',
            'paidAmount',
            'linkedId',
            'isRecurring',
            'recurrence_frequency',
            'recurrence_intervalDays',
            'nextRun',
            'recurrenceEnd',
            'isTemplate',
            'createdAt',
            'updatedAt'
          ]),
          'Recurring'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(goalRows, [
            'id',
            'name',
            'targetAmount',
            'targetYear',
            'targetDate',
            'status',
            'notes',
            'createdAt',
            'updatedAt'
          ]),
          'Goals'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(recoveryPlanRows, [
            'id',
            'status',
            'lossTradeId',
            'lossSymbol',
            'lossQuantity',
            'lossSellPrice',
            'lossAmount',
            'lossTradeDate',
            'lossHoldDays',
            'notes',
            'createdAt',
            'updatedAt',
            'closedAt'
          ]),
          'RecoveryPlans'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(recoveryLegRows, [
            'id',
            'planId',
            'tradeId',
            'symbol',
            'quantity',
            'buyPrice',
            'investedAmount',
            'createdAt',
            'updatedAt'
          ]),
          'RecoveryLegs'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(recoveryLossRows, [
            'id',
            'planId',
            'tradeId',
            'symbol',
            'quantity',
            'sellPrice',
            'lossAmount',
            'tradeDate',
            'holdDays',
            'createdAt',
            'updatedAt'
          ]),
          'RecoveryLossLegs'
        );
        XLSX.utils.book_append_sheet(
          wb,
          makeSheet(settingsRows, [
            'totalInvestment',
            'maxAllocationPct',
            'l1ZonePct',
            'l2ZonePct',
            'buyBrokeragePct',
            'sellBrokeragePct',
            'dpCharge',
            'expectedReturnPct',
            'inflationPct',
            'fdReturnPct',
            'targetProfitPct',
            'updatedAt'
          ]),
          'Settings'
        );

        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(
          now.getHours()
        ).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const filename = `finance-app-backup-${stamp}.xlsx`;
        XLSX.writeFile(wb, filename);
        showAlert(feedback, 'success', 'Backup exported.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(exportBtn, false, label);
      }
    });

    importBtn.addEventListener('click', () => {
      importFile.value = '';
      importFile.click();
    });

    importFile.addEventListener('change', async () => {
      clearAlert(feedback);
      const file = importFile.files?.[0];
      if (!file) return;
      try {
        pendingImport = await parseWorkbook(file);
        const hasAnySheet =
          pendingImport.tradesPresent ||
          pendingImport.transactionsPresent ||
          pendingImport.recurringPresent ||
          pendingImport.goalsPresent ||
          pendingImport.recoveryPlansPresent ||
          pendingImport.recoveryLossLegsPresent ||
          pendingImport.settingsPresent;
        if (!hasAnySheet) {
          pendingImport = null;
          throw new Error('No supported sheets found in this file.');
        }
        buildSummary(pendingImport);
        openImportModal();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    const runImport = async (mode: 'merge' | 'replace') => {
      if (!pendingImport) return;
      const button = mode === 'merge' ? importMerge : importReplace;
      const label = button.textContent || 'Import';
      setBusy(button, true, label);
      try {
        await applyImport(mode, pendingImport);
        await loadSettings();
        showAlert(feedback, 'success', `Import ${mode === 'merge' ? 'merged' : 'replaced'} successfully.`);
        closeImportModal();
        pendingImport = null;
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(button, false, label);
      }
    };

    importMerge.addEventListener('click', () => void runImport('merge'));
    importReplace.addEventListener('click', () => void runImport('replace'));

    deleteBtn.addEventListener('click', async () => {
      clearAlert(feedback);
      const scope = deleteScope.value;
      const title = scope === 'all' ? 'Delete All Data' : 'Delete Section Data';
      const ok = await confirmAction({
        title,
        message:
          scope === 'all'
            ? 'This will delete trades, transactions, recurring templates, goals, and settings for this user. Continue?'
            : `This will delete ${scope} data for this user. Continue?`,
        confirmLabel: 'Delete',
        tone: 'danger'
      });
      if (!ok) return;
      const label = deleteBtn.textContent || 'Delete Data';
      setBusy(deleteBtn, true, label);
      try {
        if (scope === 'trades') {
          await replaceTradesForUser(session.userId, []);
        } else if (scope === 'transactions') {
          const existing = await listTransactions(session.userId);
          await replaceTransactionsForUser(
            session.userId,
            existing.filter((row) => row.isTemplate)
          );
        } else if (scope === 'recurring') {
          const existing = await listTransactions(session.userId);
          await replaceTransactionsForUser(
            session.userId,
            existing.filter((row) => !row.isTemplate)
          );
        } else if (scope === 'goals') {
          await replaceGoalsForUser(session.userId, []);
        } else if (scope === 'settings') {
          await deleteUserSettings(session.userId);
          await getUserSettings(session.userId);
          await loadSettings();
        } else if (scope === 'all') {
          await replaceTradesForUser(session.userId, []);
          await replaceGoalsForUser(session.userId, []);
          await replaceTransactionsForUser(session.userId, []);
          await deleteUserSettings(session.userId);
          await getUserSettings(session.userId);
          await loadSettings();
        }
        await queueSnapshot(session.userId);
        showAlert(feedback, 'success', 'Data cleared.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(deleteBtn, false, label);
      }
    });

    await loadSettings();
  })();
}

