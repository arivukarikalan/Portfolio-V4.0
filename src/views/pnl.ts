import Chart from 'chart.js/auto';
import type { ChartConfiguration, Chart as ChartJS, TooltipItem } from 'chart.js';
import { renderShell, bindShell } from '../ui/shell';
import { setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import type { TradeRecord, UserSettings } from '../core/types';
import { initCloudSync, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import { formatDate, formatMoney, formatPct } from '../utils/format';
import { normalizeSymbol } from '../utils/symbols';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { toErrorMessage } from '../utils/errors';

type RealizedEntry = {
  symbol: string;
  date: string;
  qty: number;
  proceeds: number;
  cost: number;
  pnl: number;
};

type Lot = {
  qty: number;
  price: number;
  date: string | null;
};

const pnlRanges = [
  { id: '1m', label: '1M', days: 30 },
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'All', days: null }
];

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

const formatCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1
});

const formatCompactMoney = (value: number) => formatCompact.format(value);

function buildRealizedEntries(trades: TradeRecord[]): RealizedEntry[] {
  const sorted = trades
    .filter((trade) => trade.tradeDate && Number.isFinite(trade.quantity) && Number.isFinite(trade.price))
    .sort((a, b) => {
      if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
      return a.createdAt.localeCompare(b.createdAt);
    });

  const byDate = new Map<string, TradeRecord[]>();
  sorted.forEach((trade) => {
    const key = trade.tradeDate;
    const list = byDate.get(key) || [];
    list.push(trade);
    byDate.set(key, list);
  });

  const dates = Array.from(byDate.keys()).sort();
  const lotsBySymbol = new Map<string, Lot[]>();
  const realized: RealizedEntry[] = [];

  const consumeLots = (lots: Lot[], qty: number, predicate?: (lot: Lot) => boolean) => {
    let remaining = qty;
    let cost = 0;
    for (let i = 0; i < lots.length && remaining > 0; i += 1) {
      const lot = lots[i];
      if (predicate && !predicate(lot)) continue;
      if (lot.qty > remaining) {
        cost += remaining * lot.price;
        lot.qty -= remaining;
        remaining = 0;
      } else {
        cost += lot.qty * lot.price;
        remaining -= lot.qty;
        lots.splice(i, 1);
        i -= 1;
      }
    }
    return { remaining, cost };
  };

  dates.forEach((date) => {
    const dayTrades = byDate.get(date) || [];
    const buys = dayTrades.filter((trade) => trade.side === 'BUY');
    const sells = dayTrades.filter((trade) => trade.side === 'SELL');

    buys.forEach((trade) => {
      const symbol = normalizeSymbol(trade.symbol);
      if (!symbol) return;
      const lots = lotsBySymbol.get(symbol) || [];
      lots.push({ qty: trade.quantity, price: trade.price, date });
      lotsBySymbol.set(symbol, lots);
    });

    sells.forEach((trade) => {
      const symbol = normalizeSymbol(trade.symbol);
      if (!symbol) return;
      const lots = lotsBySymbol.get(symbol);
      if (!lots || !lots.length) return;
      let remaining = trade.quantity;
      let cost = 0;
      if (date) {
        const sameDay = consumeLots(lots, remaining, (lot) => lot.date === date);
        remaining = sameDay.remaining;
        cost += sameDay.cost;
      }
      if (remaining > 0) {
        const fifo = consumeLots(lots, remaining);
        remaining = fifo.remaining;
        cost += fifo.cost;
      }
      const matchedQty = trade.quantity - remaining;
      if (matchedQty <= 0) return;
      const proceeds = matchedQty * trade.price;
      const pnl = proceeds - cost;
      realized.push({
        symbol,
        date: trade.tradeDate,
        qty: matchedQty,
        proceeds,
        cost,
        pnl
      });
    });
  });

  return realized.sort((a, b) => a.date.localeCompare(b.date));
}

function calculateFees(trades: TradeRecord[], settings: UserSettings | null, fromDate: string | null) {
  const buyRate = settings?.buyBrokeragePct || 0;
  const sellRate = settings?.sellBrokeragePct || 0;
  const dpCharge = settings?.dpCharge || 0;
  let buyFees = 0;
  let sellFees = 0;
  let dpFees = 0;

  trades.forEach((trade) => {
    if (fromDate && trade.tradeDate < fromDate) return;
    const amount = trade.quantity * trade.price;
    if (trade.side === 'BUY') {
      buyFees += (amount * buyRate) / 100;
    } else {
      sellFees += (amount * sellRate) / 100;
      dpFees += dpCharge;
    }
  });

  return {
    buyFees,
    sellFees,
    dpFees,
    total: buyFees + sellFees + dpFees
  };
}

function computeUnrealized(trades: TradeRecord[], priceMap: Map<string, number>) {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  let invested = 0;
  let value = 0;
  symbols.forEach((symbol) => {
    const cycle = computeCurrentCycleState(symbol, trades);
    if (cycle.qty <= 0) return;
    invested += cycle.cost;
    const ltp = priceMap.get(symbol);
    value += ltp ? cycle.qty * ltp : cycle.cost;
  });
  return {
    invested,
    value,
    pnl: value - invested
  };
}

export function renderPnlView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading profit &amp; loss...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'pnl',
      title: 'Profit & Loss',
      subtitle: 'Analyze realized results, streaks, and risk exposure.',
      content: `
        <div class="pnl-page">
          <div id="pnl-feedback" class="alert d-none" role="alert"></div>

          <div class="card shadow-sm border-0 pnl-hero mb-3">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
                <div>
                  <div class="pnl-eyebrow">Performance review</div>
                  <h2 class="h5 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('trending-up')}</span>
                    Profit &amp; Loss
                  </h2>
                  <div class="text-muted small">Realized performance, fees, and trade quality signals.</div>
                </div>
                <div class="d-flex align-items-center gap-3 flex-wrap pnl-hero-actions">
                  <div class="form-check form-switch pnl-toggle me-2">
                    <input class="form-check-input" type="checkbox" id="pnl-unrealized">
                    <label class="form-check-label small" for="pnl-unrealized">Show realized only</label>
                  </div>
                  <button class="btn btn-outline-secondary btn-sm" id="pnl-sync">
                    ${lucideIcon('refresh-ccw')} Sync
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="card shadow-sm border-0 pnl-range-card mb-3">
            <div class="card-body">
              <div class="pnl-range" role="group">
                ${pnlRanges
                  .map(
                    (range) =>
                      `<button class="btn btn-sm btn-outline-secondary ${range.id === '6m' ? 'active' : ''}" data-range="${
                        range.id
                      }" type="button">${range.label}</button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-6 col-lg-3">
              <div class="card pnl-kpi shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label">
                    <span class="label-icon teal">${lucideIcon('check-circle')}</span>
                    Realized P/L
                  </div>
                  <div class="h5 mb-0" id="pnl-realized">--</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card pnl-kpi shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label">
                    <span class="label-icon indigo">${lucideIcon('circle-dashed')}</span>
                    Unrealized P/L
                  </div>
                  <div class="h5 mb-0" id="pnl-unrealized-value">--</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card pnl-kpi shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label">
                    <span class="label-icon amber">${lucideIcon('layers')}</span>
                    Net P/L
                  </div>
                  <div class="h5 mb-0" id="pnl-net">--</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card pnl-kpi shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label">
                    <span class="label-icon rose">${lucideIcon('receipt')}</span>
                    Fees
                  </div>
                  <div class="h5 mb-0" id="pnl-fees">--</div>
                  <div class="small text-muted" id="pnl-fees-meta">--</div>
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-lg-7">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="pnl-trend-header">
                    <div>
                      <div class="pnl-eyebrow">Primary view</div>
                      <h3 class="h6 mb-1 section-title">
                        <span class="section-icon">${lucideIcon('line-chart')}</span>
                        P&amp;L Trend
                      </h3>
                      <div class="text-muted small">Realized P/L only (daily).</div>
                    </div>
                    <div class="pnl-trend-metrics">
                      <div>
                        <div class="text-muted small">Total Value</div>
                        <div class="fw-semibold" id="pnl-total-value">--</div>
                      </div>
                      <div>
                        <div class="text-muted small">Cost Basis</div>
                        <div class="fw-semibold" id="pnl-cost-basis">--</div>
                      </div>
                      <div>
                        <div class="text-muted small">Change (1D)</div>
                        <div class="fw-semibold" id="pnl-change">--</div>
                        <div class="small" id="pnl-change-meta">--</div>
                      </div>
                    </div>
                  </div>
                  <div class="chart-wrap">
                    <canvas id="pnl-trend-chart" height="240"></canvas>
                    <div class="chart-empty text-muted small d-none" id="pnl-trend-empty">No realized trades yet.</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-lg-5">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="pnl-overview-header">
                    <div class="pnl-eyebrow">Mix</div>
                    <h3 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('pie-chart')}</span>
                      P&amp;L Overview
                    </h3>
                    <div class="text-muted small">Revenue, expenses, and mix.</div>
                  </div>
                  <div class="pnl-overview-metrics">
                    <div>
                      <div class="text-muted small">Total Revenue</div>
                      <div class="fw-semibold" id="pnl-revenue">--</div>
                    </div>
                    <div>
                      <div class="text-muted small">Operating Expenses</div>
                      <div class="fw-semibold" id="pnl-expenses">--</div>
                    </div>
                    <div>
                      <div class="text-muted small">Net Profit</div>
                      <div class="fw-semibold" id="pnl-net-profit">--</div>
                    </div>
                  </div>
                  <div class="pnl-overview-chart">
                    <div class="chart-wrap pnl-mini-chart">
                      <canvas id="pnl-overview-pie" height="180"></canvas>
                    </div>
                    <div class="pnl-pie-legend">
                      <span><span class="pnl-legend-dot pnl-legend-profit"></span>Profit</span>
                      <span><span class="pnl-legend-dot pnl-legend-loss"></span>Loss</span>
                      <span><span class="pnl-legend-dot pnl-legend-fees"></span>Fees</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-12">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <div class="pnl-eyebrow">Time view</div>
                      <h3 class="h6 mb-0 section-title">
                        <span class="section-icon">${lucideIcon('bar-chart-3')}</span>
                        Monthly P&amp;L
                      </h3>
                    </div>
                    <span class="text-muted small">Profit vs loss by month</span>
                  </div>
                  <div class="chart-wrap">
                    <canvas id="pnl-monthly-bar" height="220"></canvas>
                    <div class="chart-empty text-muted small d-none" id="pnl-monthly-empty">No data for this range.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-12">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <div class="pnl-eyebrow">Symbol view</div>
                      <h3 class="h6 mb-0 section-title">
                        <span class="section-icon">${lucideIcon('bar-chart-4')}</span>
                        Stock-wise P&amp;L
                      </h3>
                    </div>
                    <span class="text-muted small">Based on selected range</span>
                  </div>
                  <div class="chart-wrap">
                    <canvas id="pnl-stock-bar" height="260"></canvas>
                    <div class="chart-empty text-muted small d-none" id="pnl-stock-empty">No trades in this range.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Win Rate</div>
                  <div class="h6 mb-0" id="pnl-win-rate">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Profit Factor</div>
                  <div class="h6 mb-0" id="pnl-profit-factor">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Avg Win</div>
                  <div class="h6 mb-0" id="pnl-avg-win">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Avg Loss</div>
                  <div class="h6 mb-0" id="pnl-avg-loss">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Max Drawdown</div>
                  <div class="h6 mb-0" id="pnl-drawdown">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Expectancy</div>
                  <div class="h6 mb-0" id="pnl-expectancy">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Best Trade</div>
                  <div class="h6 mb-0" id="pnl-best-trade">--</div>
                </div>
              </div>
            </div>
            <div class="col-md-6 col-xl-3">
              <div class="card pnl-stat shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small">Worst Trade</div>
                  <div class="h6 mb-0" id="pnl-worst-trade">--</div>
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3">
            <div class="col-lg-6">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <div class="pnl-eyebrow">Leaders</div>
                      <h3 class="h6 mb-0">Top Winners</h3>
                    </div>
                    <span class="text-muted small" id="pnl-winners-count">--</span>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm pnl-table align-middle">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th class="text-end">P/L</th>
                          <th class="text-end">Qty</th>
                          <th class="text-end">Date</th>
                        </tr>
                      </thead>
                      <tbody id="pnl-winners"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-lg-6">
              <div class="card pnl-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <div class="pnl-eyebrow">Draggers</div>
                      <h3 class="h6 mb-0">Top Losers</h3>
                    </div>
                    <span class="text-muted small" id="pnl-losers-count">--</span>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm pnl-table align-middle">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th class="text-end">P/L</th>
                          <th class="text-end">Qty</th>
                          <th class="text-end">Date</th>
                        </tr>
                      </thead>
                      <tbody id="pnl-losers"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#pnl-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#pnl-sync');
    const includeUnrealizedToggle = root.querySelector<HTMLInputElement>('#pnl-unrealized');

    const realizedEl = root.querySelector<HTMLDivElement>('#pnl-realized');
    const unrealizedEl = root.querySelector<HTMLDivElement>('#pnl-unrealized-value');
    const netEl = root.querySelector<HTMLDivElement>('#pnl-net');
    const feesEl = root.querySelector<HTMLDivElement>('#pnl-fees');
    const feesMetaEl = root.querySelector<HTMLDivElement>('#pnl-fees-meta');

    const winRateEl = root.querySelector<HTMLDivElement>('#pnl-win-rate');
    const profitFactorEl = root.querySelector<HTMLDivElement>('#pnl-profit-factor');
    const avgWinEl = root.querySelector<HTMLDivElement>('#pnl-avg-win');
    const avgLossEl = root.querySelector<HTMLDivElement>('#pnl-avg-loss');
    const drawdownEl = root.querySelector<HTMLDivElement>('#pnl-drawdown');
    const expectancyEl = root.querySelector<HTMLDivElement>('#pnl-expectancy');
    const bestTradeEl = root.querySelector<HTMLDivElement>('#pnl-best-trade');
    const worstTradeEl = root.querySelector<HTMLDivElement>('#pnl-worst-trade');

    const trendCanvas = root.querySelector<HTMLCanvasElement>('#pnl-trend-chart');
    const trendEmpty = root.querySelector<HTMLDivElement>('#pnl-trend-empty');
    const monthlyCanvas = root.querySelector<HTMLCanvasElement>('#pnl-monthly-bar');
    const monthlyEmpty = root.querySelector<HTMLDivElement>('#pnl-monthly-empty');
    const stockCanvas = root.querySelector<HTMLCanvasElement>('#pnl-stock-bar');
    const stockEmpty = root.querySelector<HTMLDivElement>('#pnl-stock-empty');
    const totalValueEl = root.querySelector<HTMLDivElement>('#pnl-total-value');
    const costBasisEl = root.querySelector<HTMLDivElement>('#pnl-cost-basis');
    const changeEl = root.querySelector<HTMLDivElement>('#pnl-change');
    const changeMetaEl = root.querySelector<HTMLDivElement>('#pnl-change-meta');
    const revenueEl = root.querySelector<HTMLDivElement>('#pnl-revenue');
    const expensesEl = root.querySelector<HTMLDivElement>('#pnl-expenses');
    const netProfitEl = root.querySelector<HTMLDivElement>('#pnl-net-profit');
    const overviewPieCanvas = root.querySelector<HTMLCanvasElement>('#pnl-overview-pie');

    const winnersEl = root.querySelector<HTMLTableSectionElement>('#pnl-winners');
    const losersEl = root.querySelector<HTMLTableSectionElement>('#pnl-losers');
    const winnersCountEl = root.querySelector<HTMLSpanElement>('#pnl-winners-count');
    const losersCountEl = root.querySelector<HTMLSpanElement>('#pnl-losers-count');

    let trades: TradeRecord[] = [];
    let realizedEntries: RealizedEntry[] = [];
    let settings: UserSettings | null = null;
    let priceMap = new Map<string, number>();
    let includeUnrealized = false;
    let latestUnrealized = { invested: 0, value: 0, pnl: 0 };
    let rangeId = '6m';
    let trendChart: Chart | null = null;
    let monthlyChart: Chart | null = null;
    let stockChart: Chart | null = null;
    let overviewPieChart: Chart | null = null;

    const getRangeStart = () => {
      const range = pnlRanges.find((option) => option.id === rangeId);
      if (!range?.days) return null;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - range.days);
      return toIsoDate(cutoff);
    };

    const filterEntries = () => {
      const start = getRangeStart();
      return start ? realizedEntries.filter((entry) => entry.date >= start) : realizedEntries;
    };

    const renderTrend = (entries: RealizedEntry[]) => {
      if (!trendCanvas) return;
      if (trendChart) trendChart.destroy();
      if (!entries.length) {
        trendCanvas.classList.add('d-none');
        trendEmpty?.classList.remove('d-none');
        return;
      }
      trendCanvas.classList.remove('d-none');
      trendEmpty?.classList.add('d-none');

      const labels = entries.map((entry) => entry.date);
      const monthLabels = labels.map((label) => label.slice(0, 7));
      const dayMap = new Map<string, number>();
      entries.forEach((entry) => {
        dayMap.set(entry.date, (dayMap.get(entry.date) || 0) + entry.pnl);
      });
      let running = 0;
      const series = labels.map((label) => {
        const value = dayMap.get(label) || 0;
        if (!includeUnrealized) {
          running += value;
          return running;
        }
        return value;
      });

      const totalValue = entries.reduce((sum, entry) => sum + entry.pnl, 0);
      const lastValue = series[series.length - 1] ?? 0;
      const prevValue = series.length > 1 ? series[series.length - 2] : 0;
      const change = lastValue - prevValue;
      const changePct = prevValue ? (change / prevValue) * 100 : 0;

      if (totalValueEl) totalValueEl.textContent = formatMoney(includeUnrealized ? lastValue : totalValue);
      if (costBasisEl) costBasisEl.textContent = latestUnrealized.invested ? formatMoney(latestUnrealized.invested) : '--';
      if (changeEl) {
        changeEl.textContent = formatMoney(change);
        changeEl.classList.toggle('text-success', change >= 0);
        changeEl.classList.toggle('text-danger', change < 0);
      }
      if (changeMetaEl) {
        changeMetaEl.textContent = prevValue ? `${formatPct(changePct)} vs previous` : '--';
        changeMetaEl.classList.toggle('text-success', change >= 0);
        changeMetaEl.classList.toggle('text-danger', change < 0);
      }

      const gradientPlugin = {
        id: 'pnlTrendGradient',
        beforeDatasetsDraw(chart: ChartJS) {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;
          const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(34, 197, 94, 0.35)');
          gradient.addColorStop(1, 'rgba(34, 197, 94, 0.02)');
          const dataset = chart.data.datasets[0];
          dataset.backgroundColor = gradient;
        }
      };

      const config: ChartConfiguration<'line', number[], string> = {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: includeUnrealized ? 'Realized P/L (Daily)' : 'Realized P/L (Cumulative)',
              data: series,
              borderColor: '#22c55e',
              backgroundColor: 'rgba(34, 197, 94, 0.15)',
              tension: 0.2,
              fill: true,
              pointRadius: 0,
              borderWidth: 2
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              position: 'nearest',
              callbacks: {
                label(context: TooltipItem<'line'>) {
                  return `Value: ${formatMoney(context.parsed.y)}`;
                }
              }
            }
          },
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                autoSkip: false,
                maxRotation: 0,
                minRotation: 0,
                callback: (_val, index) => {
                  const month = monthLabels[index];
                  if (!month) return '';
                  const prev = index > 0 ? monthLabels[index - 1] : null;
                  if (index === 0 || month !== prev) {
                    const date = new Date(`${month}-01T00:00:00`);
                    return date.toLocaleDateString('en-IN', { month: 'short' });
                  }
                  return '';
                }
              }
            },
            y: { ticks: { callback: (val) => formatCompactMoney(Number(val)) } }
          }
        },
        plugins: [gradientPlugin]
      };

      trendChart = new Chart(trendCanvas, config);
    };

    const renderOverview = (entries: RealizedEntry[]) => {
      const realizedProfit = entries.filter((entry) => entry.pnl > 0).reduce((sum, entry) => sum + entry.pnl, 0);
      const realizedLoss = entries.filter((entry) => entry.pnl < 0).reduce((sum, entry) => sum + Math.abs(entry.pnl), 0);
      const fees = calculateFees(trades, settings, getRangeStart());
      const netProfit = realizedProfit - realizedLoss - fees.total;

      if (revenueEl) revenueEl.textContent = formatMoney(realizedProfit);
      if (expensesEl) expensesEl.textContent = formatMoney(realizedLoss + fees.total);
      if (netProfitEl) netProfitEl.textContent = formatMoney(netProfit);

      if (overviewPieCanvas) {
        if (overviewPieChart) overviewPieChart.destroy();
        const config: ChartConfiguration<'doughnut', number[], string> = {
          type: 'doughnut',
          data: {
            labels: ['Profit', 'Loss', 'Fees'],
            datasets: [
              {
                data: [realizedProfit, realizedLoss, fees.total],
                backgroundColor: ['#22c55e', '#ef4444', '#f59e0b'],
                borderWidth: 2,
                borderColor: '#ffffff'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            cutout: '60%'
          }
        };
        overviewPieChart = new Chart(overviewPieCanvas, config);
      }
    };

    const renderMonthlyBar = (entries: RealizedEntry[]) => {
      if (!monthlyCanvas) return;
      if (monthlyChart) monthlyChart.destroy();
      if (!entries.length) {
        monthlyCanvas.classList.add('d-none');
        monthlyEmpty?.classList.remove('d-none');
        return;
      }
      monthlyCanvas.classList.remove('d-none');
      monthlyEmpty?.classList.add('d-none');

      const monthMap = new Map<string, number>();
      entries.forEach((entry) => {
        const month = entry.date.slice(0, 7);
        monthMap.set(month, (monthMap.get(month) || 0) + entry.pnl);
      });
      const labels = Array.from(monthMap.keys());
      const values = labels.map((label) => monthMap.get(label) || 0);
      const displayLabels = labels.map((label) => {
        const date = new Date(`${label}-01T00:00:00`);
        return date.toLocaleDateString('en-IN', { month: 'short' });
      });

      const config: ChartConfiguration<'bar' | 'scatter', number[], string> = {
        type: 'bar',
        data: {
          labels: displayLabels,
          datasets: [
            {
              label: 'Monthly P/L',
              data: values,
              backgroundColor: values.map((value) => (value >= 0 ? '#22c55e' : '#ef4444')),
              borderRadius: 8,
              barThickness: 22
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { position: 'nearest' }
          },
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          scales: {
            x: { grid: { display: false } },
            y: { ticks: { callback: (val) => formatCompactMoney(Number(val)) } }
          }
        }
      };

      monthlyChart = new Chart(monthlyCanvas, config);
    };

    const renderStockBar = (entries: RealizedEntry[]) => {
      if (!stockCanvas) return;
      if (stockChart) stockChart.destroy();
      if (!entries.length) {
        stockCanvas.classList.add('d-none');
        stockEmpty?.classList.remove('d-none');
        return;
      }
      stockCanvas.classList.remove('d-none');
      stockEmpty?.classList.add('d-none');

      const symbolMap = new Map<string, { pnl: number; cost: number }>();
      entries.forEach((entry) => {
        const symbol = normalizeSymbol(entry.symbol);
        if (!symbol) return;
        const current = symbolMap.get(symbol) || { pnl: 0, cost: 0 };
        current.pnl += entry.pnl;
        current.cost += entry.cost;
        symbolMap.set(symbol, current);
      });

      const sorted = Array.from(symbolMap.entries()).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
      const limit = 12;
      const visible = sorted.slice(0, limit);
      const maxAbsPnl = visible.reduce((max, row) => Math.max(max, Math.abs(row[1].pnl)), 0) || 1;
      const points = visible.map(([symbol, stats]) => {
        const radius = 6 + (Math.abs(stats.pnl) / maxAbsPnl) * 12;
        return {
          x: stats.pnl,
          y: stats.cost,
          r: Number(radius.toFixed(2)),
          label: symbol,
          pnl: stats.pnl,
          cost: stats.cost
        };
      });
      const colors = points.map((point) => (point.pnl >= 0 ? '#22c55e' : '#ef4444'));

      const config: ChartConfiguration<'bubble', { x: number; y: number; r: number }[], string> = {
        type: 'bubble',
        data: {
          datasets: [
            {
              label: 'Stock P/L',
              data: points,
              backgroundColor: colors,
              borderColor: colors,
              borderWidth: 2,
              hoverBorderWidth: 2
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label(context: TooltipItem<'bubble'>) {
                  const raw = context.raw as { label?: string; pnl?: number; cost?: number };
                  const label = raw.label || context.label || '';
                  const pnl = Number(raw.pnl ?? context.parsed.x);
                  const cost = Number(raw.cost ?? context.parsed.y);
                  return `${label} | P/L ${formatMoney(pnl)} | Invested ${formatMoney(cost)}`;
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { callback: (val) => formatCompactMoney(Number(val)) },
              grid: { color: 'rgba(148, 163, 184, 0.15)' }
            },
            y: {
              ticks: { callback: (val) => formatCompactMoney(Number(val)) },
              grid: { color: 'rgba(148, 163, 184, 0.1)' }
            }
          }
        }
      };

      stockChart = new Chart(stockCanvas, config);
    };

    const renderStats = (entries: RealizedEntry[]) => {
      const totalTrades = entries.length;
      const wins = entries.filter((entry) => entry.pnl > 0);
      const losses = entries.filter((entry) => entry.pnl < 0);
      const winRate = totalTrades ? (wins.length / totalTrades) * 100 : 0;
      const sumWins = wins.reduce((sum, entry) => sum + entry.pnl, 0);
      const sumLosses = losses.reduce((sum, entry) => sum + entry.pnl, 0);
      const avgWin = wins.length ? sumWins / wins.length : 0;
      const avgLoss = losses.length ? sumLosses / losses.length : 0;
      const profitFactor = Math.abs(sumLosses) > 0 ? sumWins / Math.abs(sumLosses) : 0;
      const expectancy = winRate / 100 * avgWin + (1 - winRate / 100) * avgLoss;

      let peak = 0;
      let maxDrawdown = 0;
      let cumulative = 0;
      entries.forEach((entry) => {
        cumulative += entry.pnl;
        if (cumulative > peak) peak = cumulative;
        const drawdown = cumulative - peak;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
      });

      let best: RealizedEntry | null = null;
      let worst: RealizedEntry | null = null;
      entries.forEach((entry) => {
        if (!best || entry.pnl > best.pnl) best = entry;
        if (!worst || entry.pnl < worst.pnl) worst = entry;
      });

      const formatEntry = (entry: RealizedEntry | null) =>
        entry ? `${entry.symbol} ${formatMoney(entry.pnl)}` : '--';

      if (winRateEl) winRateEl.textContent = `${winRate.toFixed(0)}% (${wins.length}/${totalTrades})`;
      if (profitFactorEl) profitFactorEl.textContent = profitFactor ? profitFactor.toFixed(2) : '--';
      if (avgWinEl) avgWinEl.textContent = avgWin ? formatMoney(avgWin) : '--';
      if (avgLossEl) avgLossEl.textContent = avgLoss ? formatMoney(avgLoss) : '--';
      if (drawdownEl) drawdownEl.textContent = maxDrawdown ? formatMoney(maxDrawdown) : '--';
      if (expectancyEl) expectancyEl.textContent = expectancy ? formatMoney(expectancy) : '--';
      if (bestTradeEl) bestTradeEl.textContent = formatEntry(best);
      if (worstTradeEl) worstTradeEl.textContent = formatEntry(worst);
    };

    const renderTables = (entries: RealizedEntry[]) => {
      const winners = [...entries].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
      const losers = [...entries].sort((a, b) => a.pnl - b.pnl).slice(0, 5);

      if (winnersEl) {
        winnersEl.innerHTML = winners
          .map(
            (entry) => `
              <tr>
                <td class="fw-semibold">${entry.symbol}</td>
                <td class="text-end text-success">${formatMoney(entry.pnl)}</td>
                <td class="text-end">${entry.qty}</td>
                <td class="text-end">${formatDate(entry.date)}</td>
              </tr>
            `
          )
          .join('');
      }

      if (losersEl) {
        losersEl.innerHTML = losers
          .map(
            (entry) => `
              <tr>
                <td class="fw-semibold">${entry.symbol}</td>
                <td class="text-end text-danger">${formatMoney(entry.pnl)}</td>
                <td class="text-end">${entry.qty}</td>
                <td class="text-end">${formatDate(entry.date)}</td>
              </tr>
            `
          )
          .join('');
      }

      if (winnersCountEl) winnersCountEl.textContent = `${winners.length} trades`;
      if (losersCountEl) losersCountEl.textContent = `${losers.length} trades`;
    };

    const renderKpis = (entries: RealizedEntry[]) => {
      const realized = entries.reduce((sum, entry) => sum + entry.pnl, 0);
      const unrealized = computeUnrealized(trades, priceMap);
      const fees = calculateFees(trades, settings, getRangeStart());
      const net = realized + (includeUnrealized ? unrealized.pnl : 0) - fees.total;
      latestUnrealized = unrealized;

      if (realizedEl) realizedEl.textContent = formatMoney(realized);
      if (unrealizedEl) unrealizedEl.textContent = formatMoney(unrealized.pnl);
      if (netEl) netEl.textContent = formatMoney(net);
      if (feesEl) feesEl.textContent = formatMoney(-fees.total);
      if (feesMetaEl) feesMetaEl.textContent = `Buy ${formatMoney(fees.buyFees)} | Sell ${formatMoney(fees.sellFees)} | DP ${formatMoney(fees.dpFees)}`;

      realizedEl?.classList.toggle('text-danger', realized < 0);
      realizedEl?.classList.toggle('text-success', realized >= 0);
      unrealizedEl?.classList.toggle('text-danger', unrealized.pnl < 0);
      unrealizedEl?.classList.toggle('text-success', unrealized.pnl >= 0);
      netEl?.classList.toggle('text-danger', net < 0);
      netEl?.classList.toggle('text-success', net >= 0);
    };

    const applyRange = () => {
      const entries = filterEntries();
      renderKpis(entries);
      renderTrend(entries);
      renderOverview(entries);
      renderMonthlyBar(entries);
      renderStockBar(entries);
      renderStats(entries);
      renderTables(entries);
    };

    const refreshData = async () => {
      const [tradeRows, priceRows, settingsRow] = await Promise.all([
        listTrades(session.userId),
        listLivePrices(),
        getUserSettings(session.userId)
      ]);
      trades = tradeRows;
      settings = settingsRow;
      priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, Number(row.price)] : null;
          })
          .filter((row): row is [string, number] => Boolean(row))
      );
      realizedEntries = buildRealizedEntries(trades);
      applyRange();
    };

    syncButton?.addEventListener('click', async () => {
      if (!syncButton) return;
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refreshData();
        if (feedback) showAlert(feedback, 'success', 'P&L refreshed.');
      } catch (error) {
        if (feedback) showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    includeUnrealizedToggle?.addEventListener('change', () => {
      includeUnrealized = Boolean(includeUnrealizedToggle?.checked);
      applyRange();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        rangeId = btn.dataset.range || '6m';
        root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((button) => {
          button.classList.toggle('active', button.dataset.range === rangeId);
        });
        applyRange();
      });
    });

    await refreshData();
  })();
}

