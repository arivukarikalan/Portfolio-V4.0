import Chart from 'chart.js/auto';
import type { Chart as ChartJS, ChartConfiguration } from 'chart.js';
import { renderShell, bindShell } from '../ui/shell';
import { lucideIcon } from '../ui/icons';
import { setBusy, showAlert } from '../ui/feedback';
import { listTransactions } from '../storage/transactions';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { listGoals } from '../storage/goals';
import { getUserSettings } from '../storage/settings';
import { initCloudSync, refreshLivePricesNow, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import type { GoalPlan, TradeRecord, TransactionRecord, TransactionType } from '../core/types';
import { formatDateTime, formatMoney } from '../utils/format';
import { normalizeSymbol } from '../utils/symbols';
import { computeCurrentCycleState } from '../utils/tradeCycles';

type HoldingValue = {
  symbol: string;
  qty: number;
  invested: number;
  currentValue: number;
};

type MonthBucket = {
  key: string;
  label: string;
  income: number;
  expense: number;
  invest: number;
  liquid: number;
  other: number;
  borrowed: number;
  lent: number;
  repay: number;
  receive: number;
};

const rangeOptions = [
  { id: '1m', label: '1M', months: 1 },
  { id: '3m', label: '3M', months: 3 },
  { id: '6m', label: '6M', months: 6 },
  { id: '1y', label: '1Y', months: 12 },
  { id: 'all', label: 'All', months: null }
];

const monthLabel = (value: string): string => {
  const [year, month] = value.split('-').map((part) => Number(part));
  if (!year || !month) return value;
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
};

const monthKey = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map((part) => Number(part));
  if (!day || !month || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
};

const buildHoldings = (trades: TradeRecord[], priceMap: Map<string, number>): HoldingValue[] => {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  return symbols
    .map((symbol) => {
      const cycle = computeCurrentCycleState(symbol, trades);
      if (cycle.qty <= 0) return null;
      const ltp = priceMap.get(symbol) ?? null;
      const currentValue = ltp ? cycle.qty * ltp : cycle.cost;
      return {
        symbol,
        qty: cycle.qty,
        invested: cycle.cost,
        currentValue
      };
    })
    .filter((row): row is HoldingValue => Boolean(row))
    .sort((a, b) => b.currentValue - a.currentValue);
};

const getBucket = (map: Map<string, MonthBucket>, key: string): MonthBucket => {
  const existing = map.get(key);
  if (existing) return existing;
  const bucket: MonthBucket = {
    key,
    label: monthLabel(key),
    income: 0,
    expense: 0,
    invest: 0,
    liquid: 0,
    other: 0,
    borrowed: 0,
    lent: 0,
    repay: 0,
    receive: 0
  };
  map.set(key, bucket);
  return bucket;
};

const isTemplate = (row: TransactionRecord) => Boolean(row.isTemplate);

const isCashIn = (type: TransactionType) => type === 'INCOME' || type === 'DEBT_RECEIVE';
const isCashOut = (type: TransactionType) => type === 'EXPENSE' || type === 'DEBT_REPAY';

const monthsUntilTargetYear = (targetYear: number): number => {
  const now = new Date();
  const target = new Date(targetYear, 11, 31);
  const months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()) + 1;
  return Math.max(1, months);
};

const requiredMonthlyWithReturn = (
  target: number,
  current: number,
  months: number,
  annualReturnPct: number
): number => {
  if (months <= 0) return Math.max(0, target - current);
  const r = annualReturnPct > 0 ? annualReturnPct / 100 / 12 : 0;
  if (r === 0) {
    return Math.max(0, (target - current) / months);
  }
  const a = Math.pow(1 + r, months);
  const numerator = target - current * a;
  if (numerator <= 0) return 0;
  return (numerator * r) / (a - 1);
};

const projectedMonthsToTarget = (
  target: number,
  current: number,
  monthlyContribution: number,
  annualReturnPct: number
): number | null => {
  if (current >= target) return 0;
  const r = annualReturnPct > 0 ? annualReturnPct / 100 / 12 : 0;
  if (monthlyContribution <= 0) {
    if (r <= 0 || current <= 0) return null;
    const ratio = target / current;
    if (ratio <= 1) return 0;
    return Math.ceil(Math.log(ratio) / Math.log(1 + r));
  }
  if (r === 0) {
    return Math.ceil((target - current) / monthlyContribution);
  }
  const a = (target * r + monthlyContribution) / (current * r + monthlyContribution);
  if (!Number.isFinite(a) || a <= 1) return 0;
  return Math.ceil(Math.log(a) / Math.log(1 + r));
};

export function renderFinanceView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading finance dashboard...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'finance',
      title: 'Finance Dashboard',
      subtitle: 'Track net worth, cashflow, and financial goals in one place.',
      content: `
        <div class="finance-page">
          <div id="finance-feedback" class="alert d-none" role="alert"></div>
          <div class="card finance-hero shadow-sm border-0">
            <div class="card-body d-flex flex-wrap justify-content-between align-items-center gap-3">
              <div>
                <div class="finance-eyebrow">Money Snapshot</div>
                <h2 class="h5 mb-1 section-title">Finance Dashboard</h2>
                <div class="text-muted small">Net worth growth, cashflow insights, and future plans.</div>
              </div>
              <button class="btn btn-outline-secondary btn-sm" id="finance-sync">
                ${lucideIcon('refresh-ccw')} Sync
              </button>
            </div>
          </div>

          <div class="row g-3">
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('sparkles')}</span>
                  Net Worth
                </div>
                <div class="h6 mb-0" id="finance-kpi-networth">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('banknote')}</span>
                  Liquid Assets
                </div>
                <div class="h6 mb-0" id="finance-kpi-liquid">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('trending-up')}</span>
                  Investments
                </div>
                <div class="h6 mb-0" id="finance-kpi-invest">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('hand-coins')}</span>
                  Total Debt
                </div>
                <div class="h6 mb-0" id="finance-kpi-debt">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('wallet')}</span>
                  Total Lent
                </div>
                <div class="h6 mb-0" id="finance-kpi-lent">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-xl-2">
            <div class="card shadow-sm border-0 h-100 finance-kpi finance-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('activity')}</span>
                  Monthly Cashflow
                </div>
                <div class="h6 mb-0" id="finance-kpi-cashflow">--</div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-lg-8">
            <div class="card shadow-sm border-0 h-100 finance-networth-card">
              <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
                  <div>
                    <div class="finance-networth-kicker">Net Worth</div>
                    <div class="finance-networth-value" id="finance-networth-value">--</div>
                    <div class="d-flex flex-wrap align-items-center gap-2 finance-networth-change-row">
                      <span class="finance-networth-change" id="finance-networth-change">--</span>
                      <span class="finance-networth-change-pct" id="finance-networth-change-pct">--</span>
                      <span class="finance-networth-period" id="finance-networth-period">vs selected range</span>
                    </div>
                    <div class="text-muted small mt-1" id="finance-networth-meta">Last refresh: --</div>
                  </div>
                  <div class="btn-group btn-group-sm finance-range" role="group">
                    ${rangeOptions
                      .map(
                        (option) =>
                          `<button class="btn btn-outline-secondary" type="button" data-range="${option.id}">${option.label}</button>`
                      )
                      .join('')}
                  </div>
                </div>
                <div class="finance-chart-wrap finance-chart-lg finance-networth-plot">
                  <canvas id="finance-networth-chart" height="140"></canvas>
                  <div class="finance-chart-hoverline d-none" id="finance-networth-hoverline"></div>
                  <div class="finance-chart-tooltip d-none" id="finance-networth-tooltip"></div>
                  <div class="chart-empty text-muted small d-none" id="finance-networth-empty">No data yet.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-4">
            <div class="card shadow-sm border-0 h-100 finance-section-card">
              <div class="card-body">
                <div class="finance-eyebrow">Spending</div>
                <h3 class="h6 mb-1 section-title">Expense Breakdown</h3>
                <div class="text-muted small mb-2">Top categories this period.</div>
                <div class="finance-chart-wrap finance-chart-sm">
                  <canvas id="finance-expense-chart" height="180"></canvas>
                  <div class="chart-empty text-muted small d-none" id="finance-expense-empty">No expenses yet.</div>
                </div>
                <div class="finance-list mt-3" id="finance-expense-list"></div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-lg-7">
            <div class="card shadow-sm border-0 h-100 finance-section-card">
              <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                  <div>
                    <div class="finance-eyebrow">Cashflow</div>
                    <h3 class="h6 mb-1 section-title">Income vs Expense vs Savings</h3>
                    <div class="text-muted small">Monthly cashflow summary.</div>
                  </div>
                </div>
                <div class="finance-chart-wrap finance-chart-md">
                  <canvas id="finance-cashflow-chart" height="160"></canvas>
                  <div class="chart-empty text-muted small d-none" id="finance-cashflow-empty">No cashflow data yet.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-5">
            <div class="card shadow-sm border-0 h-100 finance-section-card">
              <div class="card-body">
                <div class="finance-eyebrow">Obligations</div>
                <h3 class="h6 mb-1 section-title">Debt & Lending Overview</h3>
                <div class="finance-debt-grid">
                  <div class="finance-debt-card">
                    <div class="label">Borrowed Outstanding</div>
                    <div class="value" id="finance-debt-out">--</div>
                    <div class="meta" id="finance-debt-open">--</div>
                  </div>
                  <div class="finance-debt-card">
                    <div class="label">Lent Outstanding</div>
                    <div class="value" id="finance-lent-out">--</div>
                    <div class="meta" id="finance-lent-open">--</div>
                  </div>
                </div>
                <div class="finance-list mt-3" id="finance-debt-list"></div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100 finance-section-card">
              <div class="card-body">
                <div class="finance-eyebrow">Automation</div>
                <h3 class="h6 mb-2 section-title">Recurring Payments</h3>
                <div class="text-muted small mb-2" id="finance-recurring-meta">--</div>
                <div class="finance-list" id="finance-recurring-list"></div>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100 finance-section-card">
              <div class="card-body">
                <div class="finance-eyebrow">Planning</div>
                <h3 class="h6 mb-2 section-title">Goals & Plans</h3>
                <div class="finance-goal-meta mb-2" id="finance-goal-meta">--</div>
                <div class="finance-list" id="finance-goal-list"></div>
              </div>
            </div>
          </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#finance-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#finance-sync');
    const kpiNetworth = root.querySelector<HTMLElement>('#finance-kpi-networth');
    const kpiLiquid = root.querySelector<HTMLElement>('#finance-kpi-liquid');
    const kpiInvest = root.querySelector<HTMLElement>('#finance-kpi-invest');
    const kpiDebt = root.querySelector<HTMLElement>('#finance-kpi-debt');
    const kpiLent = root.querySelector<HTMLElement>('#finance-kpi-lent');
    const kpiCashflow = root.querySelector<HTMLElement>('#finance-kpi-cashflow');
    const networthValue = root.querySelector<HTMLElement>('#finance-networth-value');
    const networthChange = root.querySelector<HTMLElement>('#finance-networth-change');
    const networthChangePct = root.querySelector<HTMLElement>('#finance-networth-change-pct');
    const networthPeriod = root.querySelector<HTMLElement>('#finance-networth-period');
    const networthMeta = root.querySelector<HTMLElement>('#finance-networth-meta');
    const networthCanvas = root.querySelector<HTMLCanvasElement>('#finance-networth-chart');
    const networthHoverline = root.querySelector<HTMLDivElement>('#finance-networth-hoverline');
    const networthTooltip = root.querySelector<HTMLDivElement>('#finance-networth-tooltip');
    const networthEmpty = root.querySelector<HTMLDivElement>('#finance-networth-empty');
    const expenseCanvas = root.querySelector<HTMLCanvasElement>('#finance-expense-chart');
    const expenseEmpty = root.querySelector<HTMLDivElement>('#finance-expense-empty');
    const expenseList = root.querySelector<HTMLDivElement>('#finance-expense-list');
    const cashflowCanvas = root.querySelector<HTMLCanvasElement>('#finance-cashflow-chart');
    const cashflowEmpty = root.querySelector<HTMLDivElement>('#finance-cashflow-empty');
    const debtOut = root.querySelector<HTMLElement>('#finance-debt-out');
    const debtOpen = root.querySelector<HTMLElement>('#finance-debt-open');
    const lentOut = root.querySelector<HTMLElement>('#finance-lent-out');
    const lentOpen = root.querySelector<HTMLElement>('#finance-lent-open');
    const debtList = root.querySelector<HTMLDivElement>('#finance-debt-list');
    const recMeta = root.querySelector<HTMLDivElement>('#finance-recurring-meta');
    const recList = root.querySelector<HTMLDivElement>('#finance-recurring-list');
    const goalMeta = root.querySelector<HTMLDivElement>('#finance-goal-meta');
    const goalList = root.querySelector<HTMLDivElement>('#finance-goal-list');
    const rangeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.finance-range [data-range]'));

    if (
      !feedback ||
      !syncButton ||
      !kpiNetworth ||
      !kpiLiquid ||
      !kpiInvest ||
      !kpiDebt ||
      !kpiLent ||
      !kpiCashflow ||
      !networthValue ||
      !networthChange ||
      !networthChangePct ||
      !networthPeriod ||
      !networthMeta ||
      !networthCanvas ||
      !networthHoverline ||
      !networthTooltip ||
      !networthEmpty ||
      !expenseCanvas ||
      !expenseEmpty ||
      !expenseList ||
      !cashflowCanvas ||
      !cashflowEmpty ||
      !debtOut ||
      !debtOpen ||
      !lentOut ||
      !lentOpen ||
      !debtList ||
      !recMeta ||
      !recList ||
      !goalMeta ||
      !goalList
    ) {
      throw new Error('Finance view failed to initialize');
    }

    let networthChart: ChartJS | null = null;
    let expenseChart: ChartJS | null = null;
    let cashflowChart: ChartJS | null = null;
    let rangeSelection = '1y';

    const networthHoverGuide = {
      id: 'networthHoverGuide',
      afterDatasetsDraw(chart: ChartJS<'line'>) {
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0]?.element?.x;
        if (!x || !chartArea) return;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top + 4);
        ctx.lineTo(x, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }
    };

    const hideNetworthTooltip = () => {
      networthHoverline.classList.add('d-none');
      networthTooltip.classList.add('d-none');
    };

    const setNetworthChangeTone = (delta: number) => {
      networthChange.classList.remove('is-positive', 'is-negative');
      networthChangePct.classList.remove('is-positive', 'is-negative');
      const toneClass = delta >= 0 ? 'is-positive' : 'is-negative';
      networthChange.classList.add(toneClass);
      networthChangePct.classList.add(toneClass);
    };

    const buildBuckets = (transactions: TransactionRecord[]): MonthBucket[] => {
      const map = new Map<string, MonthBucket>();
      transactions
        .filter((row) => !isTemplate(row))
        .forEach((row) => {
          const key = monthKey(row.date);
          if (!key) return;
          const bucket = getBucket(map, key);
          const amount = Number(row.amount) || 0;
          switch (row.type) {
            case 'INCOME':
              bucket.income += amount;
              break;
            case 'EXPENSE':
              bucket.expense += amount;
              break;
            case 'INVESTMENT':
              bucket.invest += amount;
              break;
            case 'LIQUID_ASSET':
              bucket.liquid += amount;
              break;
            case 'OTHER_ASSET':
              bucket.other += amount;
              break;
            case 'BORROWED':
              bucket.borrowed += amount;
              break;
            case 'LENT':
              bucket.lent += amount;
              break;
            case 'DEBT_REPAY':
              bucket.repay += amount;
              break;
            case 'DEBT_RECEIVE':
              bucket.receive += amount;
              break;
            default:
              break;
          }
        });
      return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
    };

    const filterBuckets = (buckets: MonthBucket[], range: string): MonthBucket[] => {
      const option = rangeOptions.find((item) => item.id === range) || rangeOptions[3];
      if (!option.months) return buckets;
      return buckets.slice(Math.max(0, buckets.length - option.months));
    };

    const computeNetworthSeries = (buckets: MonthBucket[], holdingsValue: number) => {
      let cumIncome = 0;
      let cumExpense = 0;
      let cumInvest = 0;
      let cumLiquid = 0;
      let cumOther = 0;
      let cumBorrowed = 0;
      let cumLent = 0;
      let cumRepay = 0;
      let cumReceive = 0;
      return buckets.map((bucket) => {
        cumIncome += bucket.income;
        cumExpense += bucket.expense;
        cumInvest += bucket.invest;
        cumLiquid += bucket.liquid;
        cumOther += bucket.other;
        cumBorrowed += bucket.borrowed;
        cumLent += bucket.lent;
        cumRepay += bucket.repay;
        cumReceive += bucket.receive;
        const savings = cumIncome - cumExpense;
        const assets = cumInvest + cumLiquid + cumOther;
        const netLent = cumLent - cumReceive;
        const netDebt = cumBorrowed - cumRepay;
        return savings + assets + holdingsValue + netLent - netDebt;
      });
    };

    const renderCharts = (buckets: MonthBucket[], holdingsValue: number) => {
      const filtered = filterBuckets(buckets, rangeSelection);
      const startIndex = Math.max(0, buckets.length - filtered.length);
      const labels = buckets.slice(startIndex).map((bucket) => bucket.label);
      if (!labels.length) {
        networthEmpty.classList.remove('d-none');
        cashflowEmpty.classList.remove('d-none');
        if (networthChart) networthChart.destroy();
        if (cashflowChart) cashflowChart.destroy();
        networthChart = null;
        cashflowChart = null;
        networthValue.textContent = '--';
        networthChange.textContent = '--';
        networthChangePct.textContent = '--';
        networthPeriod.textContent = 'No data yet';
        hideNetworthTooltip();
        return;
      }
      networthEmpty.classList.add('d-none');
      cashflowEmpty.classList.add('d-none');

      const networthSeries = computeNetworthSeries(buckets, holdingsValue).slice(startIndex);
      const visibleStart = Number(networthSeries[0] || 0);
      const visibleEnd = Number(networthSeries[networthSeries.length - 1] || 0);
      const visibleDelta = visibleEnd - visibleStart;
      const visibleDeltaPct = visibleStart !== 0 ? (visibleDelta / Math.abs(visibleStart)) * 100 : 0;
      const positiveTrend = visibleDelta >= 0;
      const lineColor = positiveTrend ? '#00b386' : '#ef4444';
      const fillTop = positiveTrend ? 'rgba(0, 179, 134, 0.14)' : 'rgba(239, 68, 68, 0.12)';
      const fillBottom = positiveTrend ? 'rgba(0, 179, 134, 0.01)' : 'rgba(239, 68, 68, 0.01)';

      networthValue.textContent = formatMoney(visibleEnd);
      networthChange.textContent = `${visibleDelta >= 0 ? '+' : '-'}${formatMoney(Math.abs(visibleDelta))}`;
      networthChangePct.textContent = `${visibleDeltaPct >= 0 ? '+' : '-'}${Math.abs(visibleDeltaPct).toFixed(2)}%`;
      networthPeriod.textContent = `vs ${labels[0]}${labels.length > 1 ? ` to ${labels[labels.length - 1]}` : ''}`;
      setNetworthChangeTone(visibleDelta);

      if (networthChart) networthChart.destroy();
      const networthGradient = networthCanvas.getContext('2d')?.createLinearGradient(0, 0, 0, networthCanvas.height);
      if (networthGradient) {
        networthGradient.addColorStop(0, fillTop);
        networthGradient.addColorStop(1, fillBottom);
      }
      const networthConfig: ChartConfiguration<'line'> = {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Net Worth',
              data: networthSeries,
              fill: true,
              borderColor: lineColor,
              backgroundColor: networthGradient || fillTop,
              borderWidth: 3,
              pointRadius: 0,
              pointHoverRadius: 5,
              pointHoverBorderWidth: 2,
              pointHoverBorderColor: '#ffffff',
              pointHoverBackgroundColor: lineColor,
              tension: 0.35
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: ({ chart, tooltip }) => {
                if (!tooltip || tooltip.opacity === 0) {
                  hideNetworthTooltip();
                  return;
                }
                const point = tooltip.dataPoints?.[0];
                if (!point) {
                  hideNetworthTooltip();
                  return;
                }
                const plot = chart.canvas.parentElement;
                if (!plot) {
                  hideNetworthTooltip();
                  return;
                }
                const label = String(point.label || '');
                const value = Number(point.parsed.y) || 0;
                const left = tooltip.caretX;
                const top = Math.max(12, tooltip.caretY - 54);
                networthTooltip.innerHTML = `
                  <div class="finance-chart-tooltip-date">${label}</div>
                  <div class="finance-chart-tooltip-value">${formatMoney(value)}</div>
                `;
                networthTooltip.style.left = `${Math.min(Math.max(left, 64), plot.clientWidth - 64)}px`;
                networthTooltip.style.top = `${top}px`;
                networthTooltip.classList.remove('d-none');
                networthHoverline.style.left = `${left}px`;
                networthHoverline.classList.remove('d-none');
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              ticks: {
                color: '#94a3b8',
                maxTicksLimit: 6,
                font: { size: 11 }
              }
            },
            y: {
              display: false,
              grid: { display: false },
              border: { display: false }
            }
          }
        },
        plugins: [networthHoverGuide]
      };
      networthChart = new Chart(networthCanvas, networthConfig);

      const incomeSeries = buckets.slice(startIndex).map((bucket) => bucket.income);
      const expenseSeries = buckets.slice(startIndex).map((bucket) => bucket.expense);
      const savingsSeries = buckets.slice(startIndex).map((bucket) => bucket.income - bucket.expense);
      if (cashflowChart) cashflowChart.destroy();
      const cashflowConfig: ChartConfiguration<'bar'> = {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Income', data: incomeSeries, backgroundColor: '#22c55e' },
            { label: 'Expense', data: expenseSeries, backgroundColor: '#ef4444' },
            { label: 'Savings', data: savingsSeries, backgroundColor: '#0ea5e9' }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom' },
            tooltip: {
              callbacks: {
                label: (context) => `${context.dataset.label}: ${formatMoney(Number(context.parsed.y) || 0)}`
              }
            }
          },
          scales: {
            x: { stacked: false, grid: { display: false } },
            y: {
              ticks: {
                callback: (value) => formatMoney(Number(value) || 0)
              }
            }
          }
        }
      };
      cashflowChart = new Chart(cashflowCanvas, cashflowConfig);
    };

    const renderExpenseBreakdown = (transactions: TransactionRecord[]) => {
      const expenses = transactions.filter((row) => !isTemplate(row) && row.type === 'EXPENSE');
      if (!expenses.length) {
        expenseEmpty.classList.remove('d-none');
        if (expenseChart) expenseChart.destroy();
        expenseChart = null;
        expenseList.innerHTML = '<div class="text-muted small">No expense data yet.</div>';
        return;
      }
      expenseEmpty.classList.add('d-none');
      const byCategory = new Map<string, number>();
      expenses.forEach((row) => {
        const key = row.category || 'Other';
        byCategory.set(key, (byCategory.get(key) || 0) + row.amount);
      });
      const sorted = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]);
      const labels = sorted.map(([label]) => label);
      const values = sorted.map(([, value]) => value);
      const colors = ['#f97316', '#22c55e', '#0ea5e9', '#a855f7', '#eab308', '#ef4444'];
      if (expenseChart) expenseChart.destroy();
      expenseChart = new Chart(expenseCanvas, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [
            {
              data: values,
              backgroundColor: labels.map((_, index) => colors[index % colors.length])
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: true },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => `${context.label}: ${formatMoney(Number(context.parsed) || 0)}`
              }
            }
          },
          cutout: '62%'
        }
      });
      expenseList.innerHTML = sorted
        .slice(0, 5)
        .map(
          ([label, value]) => `
            <div class="finance-list-item">
              <div class="label">${label}</div>
              <div class="value">${formatMoney(value)}</div>
            </div>
          `
        )
        .join('');
    };

    const renderDebtSummary = (transactions: TransactionRecord[]) => {
      const debts = transactions.filter((row) => !isTemplate(row) && (row.type === 'BORROWED' || row.type === 'LENT'));
      const borrowed = debts.filter((row) => row.type === 'BORROWED');
      const lent = debts.filter((row) => row.type === 'LENT');
      const borrowedOutstanding = borrowed.reduce((sum, row) => sum + (row.amount - (row.paidAmount || 0)), 0);
      const lentOutstanding = lent.reduce((sum, row) => sum + (row.amount - (row.paidAmount || 0)), 0);
      debtOut.textContent = formatMoney(borrowedOutstanding);
      debtOpen.textContent = `${borrowed.length} open records`;
      lentOut.textContent = formatMoney(lentOutstanding);
      lentOpen.textContent = `${lent.length} open records`;

      const topBorrowed = borrowed
        .filter((row) => (row.amount - (row.paidAmount || 0)) > 0)
        .sort((a, b) => (b.amount - (b.paidAmount || 0)) - (a.amount - (a.paidAmount || 0)))
        .slice(0, 3);
      const topLent = lent
        .filter((row) => (row.amount - (row.paidAmount || 0)) > 0)
        .sort((a, b) => (b.amount - (b.paidAmount || 0)) - (a.amount - (a.paidAmount || 0)))
        .slice(0, 3);
      const rows: string[] = [];
      topBorrowed.forEach((row) => {
        rows.push(
          `<div class="finance-list-item"><div class="label">Borrowed • ${row.personName || 'Person'}</div><div class="value">-${formatMoney(
            row.amount - (row.paidAmount || 0)
          )}</div></div>`
        );
      });
      topLent.forEach((row) => {
        rows.push(
          `<div class="finance-list-item"><div class="label">Lent • ${row.personName || 'Person'}</div><div class="value">${formatMoney(
            row.amount - (row.paidAmount || 0)
          )}</div></div>`
        );
      });
      debtList.innerHTML = rows.length ? rows.join('') : '<div class="text-muted small">No open debt entries.</div>';
    };

    const renderRecurring = (transactions: TransactionRecord[]) => {
      const templates = transactions.filter((row) => row.isTemplate);
      const recurringIn = templates.filter((row) => isCashIn(row.type)).reduce((sum, row) => sum + row.amount, 0);
      const recurringOut = templates.filter((row) => isCashOut(row.type)).reduce((sum, row) => sum + row.amount, 0);
      recMeta.textContent = `Recurring in ${formatMoney(recurringIn)} • Recurring out ${formatMoney(recurringOut)}`;
      if (!templates.length) {
        recList.innerHTML = '<div class="text-muted small">No recurring templates yet.</div>';
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      recList.innerHTML = templates
        .slice()
        .sort((a, b) => (a.nextRun || '').localeCompare(b.nextRun || ''))
        .slice(0, 6)
        .map((row) => {
          const status = row.nextRun && row.nextRun < today ? 'Due' : 'Upcoming';
          return `
            <div class="finance-list-item">
              <div class="label">${row.category} • ${row.type.replace('_', ' ')}</div>
              <div class="value">${formatMoney(row.amount)}</div>
              <div class="meta">${row.nextRun ? `Next: ${row.nextRun}` : 'No next run'} • ${status}</div>
            </div>
          `;
        })
        .join('');
    };

    const renderGoals = (
      goals: GoalPlan[],
      transactions: TransactionRecord[],
      _trades: TradeRecord[],
      buckets: MonthBucket[],
      holdingsValue: number,
      netWorthCurrent: number,
      expectedReturnPct: number
    ) => {
      if (!goals.length) {
        goalMeta.textContent = 'No goals yet.';
        goalList.innerHTML = '<div class="text-muted small">Add goals from Transactions → Goals & Plans.</div>';
        return;
      }
      const yearNow = new Date().getFullYear();
      const sorted = [...goals].sort((a, b) => a.targetYear - b.targetYear);
      const contributionTxns = transactions.filter(
        (row) =>
          !isTemplate(row) &&
          (row.type === 'INVESTMENT' || row.type === 'LIQUID_ASSET' || row.type === 'OTHER_ASSET')
      );
      const byMonth = new Map<string, number>();
      contributionTxns.forEach((row) => {
        const key = monthKey(row.date);
        if (!key) return;
        const value = Number(row.amount) || 0;
        byMonth.set(key, (byMonth.get(key) || 0) + value);
      });
      const recentBuckets = buckets.slice(-3);
      const recentKeys = recentBuckets.map((bucket) => bucket.key);
      const monthlyAll =
        recentKeys.length > 0
          ? recentKeys.reduce((sum, key) => sum + (byMonth.get(key) || 0), 0) / recentKeys.length
          : 0;
      const netSeries = computeNetworthSeries(buckets, holdingsValue);
      const lastNet = netSeries.slice(-1)[0] || netWorthCurrent;
      const backIndex = Math.max(0, netSeries.length - 1 - Math.min(3, netSeries.length - 1));
      const prevNet = netSeries[backIndex] || lastNet;
      const growthRate = prevNet > 0 ? ((lastNet - prevNet) / prevNet) * 100 : 0;
      const sumByCategory = (types: TransactionType[], keywords: string[]) =>
        contributionTxns
          .filter((row) => types.includes(row.type))
          .filter((row) => keywords.length === 0 || keywords.some((key) => row.category.toLowerCase().includes(key)))
          .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

      const avgMonthlyByCategory = (types: TransactionType[], keywords: string[]) => {
        if (!recentKeys.length) return 0;
        return (
          recentKeys.reduce((sum, key) => {
            const bucketSum = contributionTxns
              .filter((row) => {
                const rowKey = monthKey(row.date);
                if (rowKey !== key) return false;
                if (!types.includes(row.type)) return false;
                if (!keywords.length) return true;
                return keywords.some((term) => row.category.toLowerCase().includes(term));
              })
              .reduce((acc, row) => acc + (Number(row.amount) || 0), 0);
            return sum + bucketSum;
          }, 0) / recentKeys.length
        );
      };

      const goalSummaries = sorted.map((goal) => {
        const yearLeft = Math.max(0, goal.targetYear - yearNow);
        const name = goal.name.toLowerCase();
        let current = 0;
        let monthlyAvg = 0;
        if (name.includes('net worth') || name.includes('networth')) {
          current = netWorthCurrent;
          const last = netSeries.slice(-1)[0] || netWorthCurrent;
          const backIndex = Math.max(0, netSeries.length - 1 - Math.min(3, netSeries.length - 1));
          const prev = netSeries[backIndex] || last;
          const period = Math.max(1, Math.min(3, netSeries.length - 1));
          monthlyAvg = Math.max(0, (last - prev) / period);
        } else if (name.includes('gold')) {
          current = sumByCategory(['OTHER_ASSET', 'INVESTMENT'], ['gold']);
          monthlyAvg = Math.max(0, avgMonthlyByCategory(['OTHER_ASSET', 'INVESTMENT'], ['gold']));
        } else if (name.includes('mutual') || name.includes('mf')) {
          current = sumByCategory(['INVESTMENT'], ['mutual', 'mf']);
          monthlyAvg = Math.max(0, avgMonthlyByCategory(['INVESTMENT'], ['mutual', 'mf']));
        } else if (name.includes('stock') || name.includes('equity')) {
          current = holdingsValue;
          monthlyAvg = Math.max(0, avgMonthlyByCategory(['INVESTMENT'], ['equity', 'stock']));
        } else if (name.includes('fd') || name.includes('fixed') || name.includes('bank')) {
          current = sumByCategory(['LIQUID_ASSET', 'INVESTMENT'], ['fd', 'fixed', 'bank']);
          monthlyAvg = Math.max(0, avgMonthlyByCategory(['LIQUID_ASSET', 'INVESTMENT'], ['fd', 'fixed', 'bank']));
        } else {
          current = sumByCategory(['INVESTMENT', 'LIQUID_ASSET', 'OTHER_ASSET'], []);
          monthlyAvg = Math.max(0, avgMonthlyByCategory(['INVESTMENT', 'LIQUID_ASSET', 'OTHER_ASSET'], []));
        }

        const progress = goal.targetAmount > 0 ? Math.min(100, (current / goal.targetAmount) * 100) : 0;
        const remaining = Math.max(0, goal.targetAmount - current);
        const monthsToGo = monthlyAvg > 0 ? Math.ceil(remaining / monthlyAvg) : null;
        const monthsLeft = monthsUntilTargetYear(goal.targetYear);
        const requiredMonthly = remaining > 0 ? remaining / monthsLeft : 0;
        const requiredWithReturn = requiredMonthlyWithReturn(goal.targetAmount, current, monthsLeft, expectedReturnPct);
        const eta = monthsToGo
          ? new Date(new Date().getFullYear(), new Date().getMonth() + monthsToGo, 1).toLocaleDateString('en-IN', {
              month: 'short',
              year: 'numeric'
            })
          : 'Add contributions';
        const etaReturnMonths = projectedMonthsToTarget(goal.targetAmount, current, monthlyAvg, expectedReturnPct);
        const etaReturn =
          etaReturnMonths !== null
            ? new Date(new Date().getFullYear(), new Date().getMonth() + etaReturnMonths, 1).toLocaleDateString('en-IN', {
                month: 'short',
                year: 'numeric'
              })
            : 'Add contributions';

        const hide = goal.status === 'ACTIVE' && current <= 0 && monthlyAvg <= 0;
        return {
          goal,
          yearLeft,
          current,
          monthlyAvg,
          progress,
          remaining,
          requiredMonthly,
          requiredWithReturn,
          eta,
          etaReturn,
          hide
        };
      });

      const visibleGoals = goalSummaries.filter((item) => !item.hide);
      if (!visibleGoals.length) {
        goalMeta.textContent = 'No active goals with balance.';
        goalList.innerHTML = '<div class="text-muted small">Add contributions or manage goals from Transactions → Goals & Plans.</div>';
        return;
      }

      const nearest = visibleGoals[0].goal;
      const yearsLeft = nearest.targetYear - yearNow;
      goalMeta.textContent = `${visibleGoals.length} goals • Nearest ${nearest.name} (${yearsLeft >= 0 ? yearsLeft : 0} yrs left) • Avg monthly contribution ${formatMoney(
        monthlyAll
      )} • Growth ${growthRate.toFixed(2)}%`;

      goalList.innerHTML = visibleGoals
        .slice(0, 6)
        .map((summary) => {
          const goal = summary.goal;
          return `
            <div class="finance-list-item goal-item">
              <div class="label">${goal.name}</div>
              <div class="value">${formatMoney(goal.targetAmount)}</div>
              <div class="goal-progress">
                <div class="goal-progress-fill" style="width:${summary.progress.toFixed(1)}%"></div>
              </div>
              <div class="meta">${summary.progress.toFixed(1)}% funded • ${goal.targetYear} • ${summary.yearLeft} yrs left</div>
              <div class="meta">Remaining: ${formatMoney(summary.remaining)}</div>
              <div class="meta">Current pace: ${formatMoney(summary.monthlyAvg)}/mo • Required: ${formatMoney(summary.requiredMonthly)}/mo</div>
              <div class="meta">Required with ${expectedReturnPct.toFixed(1)}%: ${formatMoney(summary.requiredWithReturn)}/mo</div>
              <div class="meta">ETA (0%): ${summary.eta} • ETA (${expectedReturnPct.toFixed(1)}%): ${summary.etaReturn}</div>
            </div>
          `;
        })
        .join('');
    };

    const renderKpis = (buckets: MonthBucket[], holdingsValue: number) => {
      const totals = buckets.reduce(
        (acc, bucket) => {
          acc.income += bucket.income;
          acc.expense += bucket.expense;
          acc.invest += bucket.invest;
          acc.liquid += bucket.liquid;
          acc.other += bucket.other;
          acc.borrowed += bucket.borrowed;
          acc.lent += bucket.lent;
          acc.repay += bucket.repay;
          acc.receive += bucket.receive;
          return acc;
        },
        {
          income: 0,
          expense: 0,
          invest: 0,
          liquid: 0,
          other: 0,
          borrowed: 0,
          lent: 0,
          repay: 0,
          receive: 0
        }
      );
      const netDebt = totals.borrowed - totals.repay;
      const netLent = totals.lent - totals.receive;
      const netWorth = computeNetworthSeries(buckets, holdingsValue).slice(-1)[0] || 0;
      const currentMonth = buckets[buckets.length - 1];
      const monthlyCashflow = currentMonth ? currentMonth.income - currentMonth.expense : 0;

      kpiNetworth.textContent = formatMoney(netWorth);
      kpiLiquid.textContent = formatMoney(totals.liquid);
      kpiInvest.textContent = formatMoney(totals.invest + holdingsValue);
      kpiDebt.textContent = formatMoney(netDebt);
      kpiLent.textContent = formatMoney(netLent);
      kpiCashflow.textContent = formatMoney(monthlyCashflow);
    };

    const refreshFinance = async () => {
      const [transactions, trades, prices, goals, settings] = await Promise.all([
        listTransactions(session.userId),
        listTrades(session.userId),
        listLivePrices(),
        listGoals(session.userId),
        getUserSettings(session.userId)
      ]);
      const priceEntries = prices
        .map((row) => {
          const symbol = normalizeSymbol(row.ticker);
          return symbol ? [symbol, Number(row.price) || 0] : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry));
      const priceMap = new Map<string, number>(priceEntries);
      const holdings = buildHoldings(trades, priceMap);
      const holdingsValue = holdings.reduce((sum, row) => sum + row.currentValue, 0);

      const buckets = buildBuckets(transactions);
      renderKpis(buckets, holdingsValue);
      renderCharts(buckets, holdingsValue);
      renderExpenseBreakdown(transactions);
      renderDebtSummary(transactions);
      renderRecurring(transactions);
      const netWorthCurrent = computeNetworthSeries(buckets, holdingsValue).slice(-1)[0] || 0;
      renderGoals(
        goals,
        transactions,
        trades,
        buckets,
        holdingsValue,
        netWorthCurrent,
        settings.expectedReturnPct || 0
      );

      networthMeta.textContent = `Last refresh: ${formatDateTime(new Date().toISOString())}`;
    };

    rangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        rangeButtons.forEach((btn) => btn.classList.remove('active'));
        button.classList.add('active');
        rangeSelection = button.dataset.range || '1y';
        void refreshFinance();
      });
    });
    const defaultRange = rangeButtons.find((btn) => btn.dataset.range === rangeSelection) || rangeButtons[3];
    defaultRange?.classList.add('active');

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refreshLivePricesNow(session);
        await refreshFinance();
        showAlert(feedback, 'success', 'Finance data synced.');
      } catch (error) {
        showAlert(feedback, 'danger', String(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    await refreshFinance();
  })();
}

