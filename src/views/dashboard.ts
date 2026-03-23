import Chart from 'chart.js/auto';
import type { ChartConfiguration, Chart as ChartJS, TooltipItem } from 'chart.js';
import { renderShell, bindShell } from '../ui/shell';
import { setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import type { TradeRecord } from '../core/types';
import { initCloudSync, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import { formatDateTime, formatMoney, formatPct } from '../utils/format';
import { normalizeSymbol } from '../utils/symbols';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { toErrorMessage } from '../utils/errors';

type HoldingSnapshot = {
  symbol: string;
  qty: number;
  invested: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  holdDays: number;
};

type TrendPoint = {
  date: string;
  invested: number;
  value: number;
};

const chartPalette = ['#38bdf8', '#a78bfa', '#f97316', '#facc15', '#34d399', '#f472b6', '#22d3ee'];
const compactCurrency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1
});

const formatCompactMoney = (value: number) => compactCurrency.format(value);

const rangeOptions = [
  { id: '1m', label: '1M', days: 30 },
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'All', days: null }
];

const isDarkTheme = () => document.documentElement.getAttribute('data-theme') === 'dark';


function groupByDate(trades: TradeRecord[]): Map<string, TradeRecord[]> {
  const map = new Map<string, TradeRecord[]>();
  trades.forEach((trade) => {
    const key = trade.tradeDate || '';
    if (!key) return;
    const list = map.get(key) || [];
    list.push(trade);
    map.set(key, list);
  });
  return map;
}

function buildHoldings(trades: TradeRecord[], priceMap: Map<string, number>): HoldingSnapshot[] {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  return symbols
    .map((symbol) => {
      const cycle = computeCurrentCycleState(symbol, trades);
      if (cycle.qty <= 0) return null;
      const ltp = priceMap.get(symbol) ?? null;
      const currentValue = ltp ? cycle.qty * ltp : cycle.cost;
      const pnl = currentValue - cycle.cost;
      const pnlPct = cycle.cost > 0 ? (pnl / cycle.cost) * 100 : 0;
      const holdDays =
        cycle.startDate && !Number.isNaN(new Date(cycle.startDate).getTime())
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(cycle.startDate).getTime()) / (1000 * 60 * 60 * 24))
            )
          : 0;
      return {
        symbol,
        qty: cycle.qty,
        invested: cycle.cost,
        currentValue,
        pnl,
        pnlPct,
        holdDays
      };
    })
    .filter((row): row is HoldingSnapshot => Boolean(row))
    .sort((a, b) => b.currentValue - a.currentValue);
}

function buildTrend(trades: TradeRecord[]): TrendPoint[] {
  const grouped = groupByDate(trades);
  const dates = Array.from(grouped.keys()).sort();
  let runningQty: Record<string, number> = {};
  let runningCost: Record<string, number> = {};

  return dates.map((date) => {
    const rows = grouped.get(date) || [];
    rows.forEach((trade) => {
      const symbol = normalizeSymbol(trade.symbol);
      if (!symbol) return;
      runningQty[symbol] = runningQty[symbol] || 0;
      runningCost[symbol] = runningCost[symbol] || 0;
      if (trade.side === 'BUY') {
        runningQty[symbol] += trade.quantity;
        runningCost[symbol] += trade.quantity * trade.price;
      } else {
        const qtyToSell = trade.quantity;
        const currentQty = runningQty[symbol];
        if (currentQty <= 0) return;
        const avg = runningCost[symbol] / currentQty;
        runningQty[symbol] = Math.max(0, currentQty - qtyToSell);
        runningCost[symbol] = Math.max(0, runningCost[symbol] - avg * qtyToSell);
      }
    });
    const invested = Object.values(runningCost).reduce((sum, value) => sum + value, 0);
    return {
      date,
      invested,
      value: invested
    };
  });
}

export function renderDashboardView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading dashboard...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'dashboard',
      title: 'Dashboard',
      subtitle: 'Stay on top of your portfolio at a glance.',
      content: `
        <div id="dashboard-feedback" class="alert d-none" role="alert"></div>

        <div class="dashboard-strip">
          <div class="dashboard-strip-head">
            <div class="dashboard-strip-label section-title">
              <span class="section-icon">${lucideIcon('trending-up')}</span>
              Top gainers
            </div>
          </div>
          <div class="dashboard-strip-items" id="gainer-strip"></div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('wallet')}</span>
                  Invested
                </div>
                <div class="h5 mb-0" id="dash-invested">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('line-chart')}</span>
                  Current Value
                </div>
                <div class="h5 mb-0" id="dash-value">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('activity')}</span>
                  Total P/L
                </div>
                <div class="h5 mb-0" id="dash-pnl">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('percent')}</span>
                  P/L %
                </div>
                <div class="h5 mb-0" id="dash-pnl-pct">--</div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-lg-7">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
                  <div>
                    <h2 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('line-chart')}</span>
                      Portfolio Trend
                    </h2>
                    <div class="text-muted small" id="dash-last-refresh">Last refresh: --</div>
                    <div class="dash-trend-meta">
                      <div class="dash-trend-value" id="trend-value">--</div>
                      <div class="dash-trend-sub" id="trend-change">--</div>
                    </div>
                  </div>
                  <div class="d-flex gap-2 align-items-center">
                    <div class="dash-range" role="group">
                      ${rangeOptions
                        .map(
                          (range) =>
                            `<button class="btn btn-sm btn-outline-secondary ${range.id === '1y' ? 'active' : ''}" data-range="${
                              range.id
                            }" type="button">${range.label}</button>`
                        )
                        .join('')}
                    </div>
                    <button class="btn btn-outline-secondary btn-sm" id="dash-refresh">
                      ${lucideIcon('refresh-ccw')} Sync
                    </button>
                  </div>
                </div>
                <div class="chart-wrap">
                  <canvas id="trend-chart" height="240"></canvas>
                  <div class="chart-empty text-muted small d-none" id="trend-empty">No trend data yet.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-5">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <div>
                    <h2 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('pie-chart')}</span>
                      Allocation Risk
                    </h2>
                    <div class="text-muted small">Top holdings + others.</div>
                  </div>
                </div>
                <div class="chart-wrap chart-wrap-lg">
                  <canvas id="allocation-chart" height="300"></canvas>
                  <div class="chart-empty text-muted small d-none" id="allocation-empty">No holdings yet.</div>
                </div>
                <div class="dash-warning d-none" id="allocation-warning"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-md-6 col-xl-3">
            <div class="card shadow-sm border-0 h-100 dash-insight">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('trending-up')}</span>
                  Biggest Gainer
                </div>
                <div class="h6 mb-1" id="insight-gainer">--</div>
                <div class="small text-success" id="insight-gainer-meta">--</div>
              </div>
            </div>
          </div>
          <div class="col-md-6 col-xl-3">
            <div class="card shadow-sm border-0 h-100 dash-insight">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('trending-down')}</span>
                  Biggest Loser
                </div>
                <div class="h6 mb-1" id="insight-loser">--</div>
                <div class="small text-danger" id="insight-loser-meta">--</div>
              </div>
            </div>
          </div>
          <div class="col-md-6 col-xl-3">
            <div class="card shadow-sm border-0 h-100 dash-insight">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('timer')}</span>
                  Longest Hold
                </div>
                <div class="h6 mb-1" id="insight-hold">--</div>
                <div class="small text-muted" id="insight-hold-meta">--</div>
              </div>
            </div>
          </div>
          <div class="col-md-6 col-xl-3">
            <div class="card shadow-sm border-0 h-100 dash-insight">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('layers')}</span>
                  Highest Allocation
                </div>
                <div class="h6 mb-1" id="insight-alloc">--</div>
                <div class="small text-muted" id="insight-alloc-meta">--</div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3">
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h2 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('bar-chart-3')}</span>
                    Exposure by Value
                  </h2>
                  <span class="text-muted small" id="exposure-count">--</span>
                </div>
                <div class="chart-wrap">
                  <canvas id="exposure-chart" height="200"></canvas>
                  <div class="chart-empty text-muted small d-none" id="exposure-empty">No data yet.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h2 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('activity')}</span>
                    Recent Activity
                  </h2>
                  <a class="btn btn-sm btn-outline-secondary" href="trades.html#history">View All</a>
                </div>
                <div id="recent-activity" class="dash-activity"></div>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#dashboard-feedback');
    const refreshButton = root.querySelector<HTMLButtonElement>('#dash-refresh');
    const gainerStrip = root.querySelector<HTMLDivElement>('#gainer-strip');
    const lastRefresh = root.querySelector<HTMLDivElement>('#dash-last-refresh');
    const dashInvested = root.querySelector<HTMLDivElement>('#dash-invested');
    const dashValue = root.querySelector<HTMLDivElement>('#dash-value');
    const dashPnl = root.querySelector<HTMLDivElement>('#dash-pnl');
    const dashPnlPct = root.querySelector<HTMLDivElement>('#dash-pnl-pct');
    const allocationWarning = root.querySelector<HTMLDivElement>('#allocation-warning');
    const trendValue = root.querySelector<HTMLDivElement>('#trend-value');
    const trendChange = root.querySelector<HTMLDivElement>('#trend-change');

    const insightGainer = root.querySelector<HTMLDivElement>('#insight-gainer');
    const insightGainerMeta = root.querySelector<HTMLDivElement>('#insight-gainer-meta');
    const insightLoser = root.querySelector<HTMLDivElement>('#insight-loser');
    const insightLoserMeta = root.querySelector<HTMLDivElement>('#insight-loser-meta');
    const insightHold = root.querySelector<HTMLDivElement>('#insight-hold');
    const insightHoldMeta = root.querySelector<HTMLDivElement>('#insight-hold-meta');
    const insightAlloc = root.querySelector<HTMLDivElement>('#insight-alloc');
    const insightAllocMeta = root.querySelector<HTMLDivElement>('#insight-alloc-meta');

    const trendCanvas = root.querySelector<HTMLCanvasElement>('#trend-chart');
    const trendEmpty = root.querySelector<HTMLDivElement>('#trend-empty');
    const allocationCanvas = root.querySelector<HTMLCanvasElement>('#allocation-chart');
    const allocationEmpty = root.querySelector<HTMLDivElement>('#allocation-empty');
    const exposureCanvas = root.querySelector<HTMLCanvasElement>('#exposure-chart');
    const exposureEmpty = root.querySelector<HTMLDivElement>('#exposure-empty');
    const exposureCount = root.querySelector<HTMLSpanElement>('#exposure-count');

    let trades: TradeRecord[] = [];
    let holdings: HoldingSnapshot[] = [];
    let trendData: TrendPoint[] = [];
    let allocationChart: Chart | null = null;
    let trendChart: Chart | null = null;
    let exposureChart: Chart | null = null;
    let rangeId = '1y';
    let allocationLimit = 0;
    let priceMap = new Map<string, number>();

    const updateRangeButtons = () => {
      root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.range === rangeId);
      });
    };


    const renderGainerStrip = (items: HoldingSnapshot[]) => {
      if (!gainerStrip) return;
      if (!items.length) {
        gainerStrip.innerHTML = '<div class="text-muted small">No gainers yet.</div>';
        return;
      }
      const avatarColors = ['#e0f2fe', '#ede9fe', '#fff7ed', '#fef3c7', '#d1fae5', '#fce7f3', '#cffafe'];
      gainerStrip.innerHTML = items
        .map((item, index) => {
          const pnlClass = item.pnl >= 0 ? 'text-success' : 'text-danger';
          const color = avatarColors[index % avatarColors.length];
          return `
            <div class="strip-card">
              <div class="strip-details">
                <div class="strip-avatar" style="background:${color}">${item.symbol.slice(0, 1)}</div>
                <div>
                  <div class="strip-symbol">${item.symbol}</div>
                  <div class="strip-price">${formatMoney(item.currentValue / item.qty)}</div>
                </div>
              </div>
              <div class="strip-pnl ${pnlClass}">${formatPct(item.pnlPct)}</div>
            </div>
          `;
        })
        .join('');
    };

    const renderKpis = () => {
      const invested = holdings.reduce((sum, row) => sum + row.invested, 0);
      const value = holdings.reduce((sum, row) => sum + row.currentValue, 0);
      const pnl = value - invested;
      const pnlPct = invested ? (pnl / invested) * 100 : 0;
      if (dashInvested) dashInvested.textContent = formatMoney(invested);
      if (dashValue) dashValue.textContent = formatMoney(value);
      if (dashPnl) dashPnl.textContent = formatMoney(pnl);
      if (dashPnlPct) dashPnlPct.textContent = formatPct(pnlPct);
      if (dashPnl) dashPnl.classList.toggle('text-danger', pnl < 0);
      if (dashPnl) dashPnl.classList.toggle('text-success', pnl >= 0);
      if (dashPnlPct) dashPnlPct.classList.toggle('text-danger', pnlPct < 0);
      if (dashPnlPct) dashPnlPct.classList.toggle('text-success', pnlPct >= 0);
      if (trendValue) trendValue.textContent = formatMoney(value);
      if (trendChange) {
        trendChange.textContent = `${formatMoney(pnl)} (${formatPct(pnlPct)}) from invested`;
        trendChange.classList.toggle('text-danger', pnl < 0);
        trendChange.classList.toggle('text-success', pnl >= 0);
      }
    };

    const renderInsights = (insightsHoldings: HoldingSnapshot[]) => {
      if (!insightsHoldings.length) return;
      const sortedByPnl = [...insightsHoldings].sort((a, b) => b.pnl - a.pnl);
      const sortedByLoss = [...insightsHoldings].sort((a, b) => a.pnl - b.pnl);
      const sortedByHold = [...insightsHoldings].sort((a, b) => b.holdDays - a.holdDays);
      const sortedByAlloc = [...insightsHoldings].sort((a, b) => b.currentValue - a.currentValue);

      const gainer = sortedByPnl[0];
      const loser = sortedByLoss[0];
      const holder = sortedByHold[0];
      const alloc = sortedByAlloc[0];

      if (insightGainer) insightGainer.textContent = gainer.symbol;
      if (insightGainerMeta) insightGainerMeta.textContent = `${formatMoney(gainer.pnl)} (${formatPct(gainer.pnlPct)})`;
      if (insightLoser) insightLoser.textContent = loser.symbol;
      if (insightLoserMeta) insightLoserMeta.textContent = `${formatMoney(loser.pnl)} (${formatPct(loser.pnlPct)})`;
      if (insightHold) insightHold.textContent = holder.symbol;
      if (insightHoldMeta) insightHoldMeta.textContent = `${holder.holdDays} days`;
      if (insightAlloc) insightAlloc.textContent = alloc.symbol;
      if (insightAllocMeta) {
        const pct = allocationLimit > 0 ? (alloc.currentValue / allocationLimit) * 100 : 0;
        insightAllocMeta.textContent = allocationLimit > 0 ? `${pct.toFixed(0)}% of limit` : formatMoney(alloc.currentValue);
      }
    };

    const renderTrend = () => {
      if (!trendCanvas) return;
      if (trendChart) trendChart.destroy();
      const dark = isDarkTheme();
      const axisTick = dark ? '#94a3b8' : '#64748b';
      const gridColor = dark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.2)';
      const range = rangeOptions.find((option) => option.id === rangeId);
      let points = trendData;
      if (range?.days) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - range.days);
        points = trendData.filter((point) => new Date(point.date) >= cutoff);
      }
      if (!points.length) {
        trendCanvas.classList.add('d-none');
        trendEmpty?.classList.remove('d-none');
        return;
      }
      trendCanvas.classList.remove('d-none');
      trendEmpty?.classList.add('d-none');
      const labels = points.map((point) => point.date);
      const series = points.map((point) => point.invested);
      const tickFormatter = (value: unknown, index: number) => {
        const raw = labels[index];
        if (!raw) return String(value);
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return String(raw);
        if (range?.days && range.days <= 31) {
          return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        }
        return date.toLocaleDateString('en-IN', { month: 'short' });
      };
      const gradientPlugin = {
        id: 'trendGradient',
        beforeDatasetsDraw(chart: ChartJS) {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;
          const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
          gradient.addColorStop(1, 'rgba(99, 102, 241, 0.02)');
          const dataset = chart.data.datasets[0];
          dataset.backgroundColor = gradient;
        }
      };
      const lastPointPlugin = {
        id: 'trendLastPoint',
        afterDatasetsDraw(chart: ChartJS) {
          const meta = chart.getDatasetMeta(0);
          if (!meta?.data?.length) return;
          const { ctx } = chart;
          const point = meta.data[meta.data.length - 1];
          ctx.save();
          ctx.beginPath();
          ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#6366f1';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = dark ? '#0b1220' : '#ffffff';
          ctx.stroke();
          ctx.restore();
        }
      };
      const config: ChartConfiguration<'line', number[], string> = {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Portfolio',
              data: series,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.18)',
              tension: 0,
              fill: true,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 5,
              pointHoverBorderWidth: 2,
              pointHoverBackgroundColor: '#6366f1',
              pointHoverBorderColor: '#ffffff'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#0f172a',
              titleColor: '#f8fafc',
              bodyColor: '#f8fafc',
              displayColors: false,
              padding: 10,
              cornerRadius: 10,
              callbacks: {
                label(context: TooltipItem<'line'>) {
                  return `Value: ${formatMoney(context.parsed.y)}`;
                }
              }
            }
          },
          interaction: {
            mode: 'index',
            intersect: false
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: axisTick,
                maxTicksLimit: 6,
                callback: (value, index) => tickFormatter(value, index)
              }
            },
            y: {
              grid: {
                color: gridColor
              },
              ticks: { color: axisTick, callback: (val) => formatCompactMoney(Number(val)) }
            }
          }
        },
        plugins: [gradientPlugin, lastPointPlugin]
      };
      trendChart = new Chart(trendCanvas, config);
    };

    const renderAllocation = () => {
      if (!allocationCanvas) return;
      if (allocationChart) allocationChart.destroy();
      const dark = isDarkTheme();
      const legendText = dark ? '#e2e8f0' : '#334155';
      const top = holdings.slice(0, 5);
      const othersValue = holdings.slice(5).reduce((sum, row) => sum + row.currentValue, 0);
      const labels = [...top.map((row) => row.symbol)];
      const data = [...top.map((row) => row.currentValue)];
      if (othersValue > 0) {
        labels.push('Others');
        data.push(othersValue);
      }
      if (!data.length) {
        allocationCanvas.classList.add('d-none');
        allocationEmpty?.classList.remove('d-none');
        return;
      }
      allocationCanvas.classList.remove('d-none');
      allocationEmpty?.classList.add('d-none');
      const totalValue = data.reduce((sum, value) => sum + value, 0);
      const centerTextPlugin = {
        id: 'centerText',
        afterDraw(chart: ChartJS) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          if (!meta?.data?.length) return;
          const { x, y } = meta.data[0];
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a';
          ctx.font = '600 18px system-ui, -apple-system, "Segoe UI", sans-serif';
          ctx.fillText(formatCompactMoney(totalValue), x, y - 6);
          ctx.fillStyle = dark ? '#94a3b8' : '#94a3b8';
          ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
          ctx.fillText('Total', x, y + 14);
          ctx.restore();
        }
      };
      const config: ChartConfiguration<'doughnut', number[], string> = {
        type: 'doughnut',
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: chartPalette,
              borderWidth: 6,
              borderColor: dark ? '#0b1220' : '#f8fafc',
              borderRadius: 12,
              spacing: 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '58%',
          layout: {
            padding: { top: 8, bottom: 16, left: 8, right: 8 }
          },
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                color: legendText,
                boxWidth: 10,
                padding: 12,
                generateLabels(chart: ChartJS) {
                  const { data } = chart;
                  const dataset = data.datasets[0];
                  if (!dataset || !Array.isArray(dataset.data)) return [];
                  return data.labels!.map((label, index) => {
                    const value = Number(dataset.data[index] ?? 0);
                    const pct = totalValue ? (value / totalValue) * 100 : 0;
                    const labelText = String(label ?? '');
                    return {
                      text: `${labelText} (${pct.toFixed(1)}%)`,
                      fillStyle: Array.isArray(dataset.backgroundColor)
                      ? dataset.backgroundColor[index]
                      : dataset.backgroundColor,
                    strokeStyle: dark ? '#0b1220' : '#ffffff',
                    color: legendText,
                    lineWidth: 0,
                    hidden: false,
                    index
                    };
                  });
                }
              }
            },
            tooltip: {
              position: 'nearest',
              yAlign: 'bottom',
              xAlign: 'center',
              callbacks: {
                label(context: TooltipItem<'doughnut'>) {
                  const value = context.parsed as number;
                  const pct = totalValue ? (value / totalValue) * 100 : 0;
                  return `${context.label}: ${formatMoney(value)} (${pct.toFixed(1)}%)`;
                }
              }
            }
          }
        },
        plugins: [centerTextPlugin]
      };
      allocationChart = new Chart(allocationCanvas, config);

      if (allocationLimit > 0 && allocationWarning) {
        const maxAlloc = holdings[0];
        const pct = (maxAlloc.currentValue / allocationLimit) * 100;
        if (pct > 100) {
          allocationWarning.classList.remove('d-none');
          allocationWarning.textContent = `${maxAlloc.symbol} exceeds allocation limit (${pct.toFixed(0)}%).`;
        } else {
          allocationWarning.classList.add('d-none');
        }
      }
    };

    const renderExposure = () => {
      if (!exposureCanvas) return;
      if (exposureChart) exposureChart.destroy();
      const dark = isDarkTheme();
      const top = holdings.slice(0, 6);
      if (!top.length) {
        exposureCanvas.classList.add('d-none');
        exposureEmpty?.classList.remove('d-none');
        return;
      }
      exposureCanvas.classList.remove('d-none');
      exposureEmpty?.classList.add('d-none');
      if (exposureCount) exposureCount.textContent = `${top.length} tickers`;
      const config: ChartConfiguration<'bar', number[], string> = {
        type: 'bar',
        data: {
          labels: top.map((row) => row.symbol),
          datasets: [
            {
              label: 'Value',
              data: top.map((row) => row.currentValue),
              backgroundColor: chartPalette[0],
              borderRadius: 10,
              barThickness: 18
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          indexAxis: 'y',
          scales: {
            x: {
              grid: { color: dark ? 'rgba(148, 163, 184, 0.2)' : '#eef2f6' },
              ticks: {
                color: dark ? '#94a3b8' : '#64748b',
                callback: (val) => formatMoney(Number(val))
              }
            },
            y: { grid: { display: false }, ticks: { color: dark ? '#94a3b8' : '#64748b' } }
          }
        }
      };
      exposureChart = new Chart(exposureCanvas, config);
    };

    const renderRecent = () => {
      const container = root.querySelector<HTMLDivElement>('#recent-activity');
      if (!container) return;
      const recent = [...trades].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).slice(0, 5);
      if (!recent.length) {
        container.innerHTML = '<div class="text-muted small">No recent trades.</div>';
        return;
      }
      container.innerHTML = recent
        .map((trade) => {
          const sideBadge = trade.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
          return `
            <div class="dash-activity-item">
              <div class="d-flex justify-content-between">
                <div>
                  <div class="fw-semibold">${trade.symbol}</div>
                  <div class="small text-muted">${formatDateTime(trade.tradeDate)}</div>
                </div>
                <div class="text-end">
                  <span class="badge ${sideBadge}">${trade.side}</span>
                  <div class="small">${trade.quantity} @ ${formatMoney(trade.price)}</div>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    };

    const updateMetricHoldings = () => {
      const topGainers = [...holdings].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 8);
      renderGainerStrip(topGainers);
      renderInsights(holdings);
    };

    const refreshDashboard = async () => {
      const [tradeRows, priceRows, settings] = await Promise.all([
        listTrades(session.userId),
        listLivePrices(),
        getUserSettings(session.userId)
      ]);
      trades = tradeRows;
      allocationLimit =
        settings.totalInvestment > 0 && settings.maxAllocationPct > 0
          ? (settings.totalInvestment * settings.maxAllocationPct) / 100
          : 0;
      priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, Number(row.price)] : null;
          })
          .filter((row): row is [string, number] => Boolean(row))
      );
      holdings = buildHoldings(trades, priceMap);
      trendData = buildTrend(trades);

      const latestPriceAt = priceRows.reduce<string | null>((latest, row) => {
        if (!row?.fetchedAt) return latest;
        if (!latest) return row.fetchedAt;
        return row.fetchedAt > latest ? row.fetchedAt : latest;
      }, null);
      if (lastRefresh) lastRefresh.textContent = `Last refresh: ${formatDateTime(latestPriceAt)}`;

      renderKpis();
      updateMetricHoldings();
      renderTrend();
      renderAllocation();
      renderExposure();
      renderRecent();
    };

    const handleThemeChange = () => {
      renderTrend();
      renderAllocation();
      renderExposure();
    };

    window.addEventListener('ui-theme-change', handleThemeChange);

    refreshButton?.addEventListener('click', async () => {
      if (!refreshButton) return;
      const label = refreshButton.textContent || 'Sync';
      setBusy(refreshButton, true, label);
      try {
        await syncNow(session);
        await refreshDashboard();
        if (feedback) showAlert(feedback, 'success', 'Dashboard refreshed.');
      } catch (error) {
        if (feedback) showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(refreshButton, false, label);
      }
    });

    root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        rangeId = btn.dataset.range || '1y';
        updateRangeButtons();
        renderTrend();
      });
    });

    updateRangeButtons();
    await refreshDashboard();
  })();
}

