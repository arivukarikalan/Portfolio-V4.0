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

type HoldingRow = {
  symbol: string;
  qty: number;
  avgPrice: number | null;
  invested: number;
  ltp: number | null;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  holdDays: number | null;
  firstTrade: string | null;
  lastTrade: string | null;
};

type FilterState = {
  query: string;
  mode: 'all' | 'profit' | 'loss' | 'allocation';
};

const chartPalette = ['#38bdf8', '#a78bfa', '#f97316', '#facc15', '#34d399', '#f472b6', '#22d3ee'];
const compactCurrency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1
});

const formatCompactMoney = (value: number) => compactCurrency.format(value);
const isDarkTheme = () => document.documentElement.getAttribute('data-theme') === 'dark';

function buildTradeRanges(trades: TradeRecord[]): Map<string, { first: string; last: string }> {
  const map = new Map<string, { first: string; last: string }>();
  trades.forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    if (!symbol || !trade.tradeDate) return;
    const existing = map.get(symbol);
    if (!existing) {
      map.set(symbol, { first: trade.tradeDate, last: trade.tradeDate });
      return;
    }
    if (trade.tradeDate < existing.first) existing.first = trade.tradeDate;
    if (trade.tradeDate > existing.last) existing.last = trade.tradeDate;
  });
  return map;
}

 

export function renderHoldingsView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading holdings...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'holdings',
      title: 'Holdings',
      subtitle: 'Track open positions and current exposure.',
      content: `
        <div id="holdings-feedback" class="alert d-none" role="alert"></div>

        <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h1 class="h5 mb-1 section-title">
              <span class="section-icon">${lucideIcon('pie-chart')}</span>
              Holdings
            </h1>
            <div class="text-muted small">Monitor invested value, P/L, and allocation by ticker.</div>
          </div>
          <div class="d-flex align-items-center gap-2">
            <button class="btn btn-outline-secondary" id="holdings-refresh">
              ${lucideIcon('refresh-ccw')} Refresh Prices
            </button>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('wallet')}</span>
                  Invested
                </div>
                <div class="h5 mb-0" id="kpi-invested">--</div>
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
                <div class="h5 mb-0" id="kpi-value">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('activity')}</span>
                  Unrealized P/L
                </div>
                <div class="h5 mb-0" id="kpi-pnl">--</div>
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
                <div class="h5 mb-0" id="kpi-pnl-pct">--</div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <div>
                    <h2 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('pie-chart')}</span>
                      Allocation
                    </h2>
                    <div class="text-muted small">Top holdings by value.</div>
                  </div>
                </div>
                <div class="chart-wrap">
                  <canvas id="holdings-pie" height="260"></canvas>
                  <div class="chart-empty text-muted small d-none" id="holdings-pie-empty">No holdings yet.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <div>
                    <h2 class="h6 mb-1 section-title">
                      <span class="section-icon">${lucideIcon('timer')}</span>
                      Longest Holds
                    </h2>
                    <div class="text-muted small">Top 5 by holding days.</div>
                  </div>
                </div>
                <div class="chart-wrap">
                  <canvas id="holdings-bar" height="160"></canvas>
                  <div class="chart-empty text-muted small d-none" id="holdings-bar-empty">No holdings yet.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card shadow-sm border-0">
          <div class="card-body">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 holdings-header">
              <div>
                <h2 class="h6 mb-1 section-title">
                  <span class="section-icon">${lucideIcon('list')}</span>
                  Holdings List
                </h2>
                <div class="text-muted small" id="holdings-last-refresh">Last refresh: --</div>
              </div>
              <div class="d-flex align-items-center gap-2 holdings-actions">
                <div class="text-muted small" id="holdings-count">--</div>
              </div>
            </div>

            <div class="row g-2 align-items-end mb-3">
              <div class="col-12 col-md-5">
                <label class="form-label small text-muted">Search</label>
                <div class="input-group input-group-sm">
                  <span class="input-group-text bg-white">${lucideIcon('search')}</span>
                  <input class="form-control" id="holdings-search" placeholder="Search ticker" />
                </div>
              </div>
              <div class="col-12 col-md-7">
                <label class="form-label small text-muted">Quick Filters</label>
                <div class="btn-group btn-group-sm w-100 flex-wrap" role="group">
                  <button class="btn btn-outline-secondary active" data-filter="all" type="button">All</button>
                  <button class="btn btn-outline-secondary" data-filter="profit" type="button">Profit</button>
                  <button class="btn btn-outline-secondary" data-filter="loss" type="button">Loss</button>
                  <button class="btn btn-outline-secondary" data-filter="allocation" type="button">High Allocation</button>
                </div>
              </div>
            </div>

            <div class="table-responsive">
              <table class="table table-sm align-middle trade-table trade-table-soft table-striped table-hover mb-0 mobile-stack mobile-toggle-details holdings-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Hold Days</th>
                    <th>Qty</th>
                    <th>Avg Buy</th>
                    <th class="text-end">LTP</th>
                    <th class="text-end">Current Value</th>
                    <th class="text-end">P/L</th>
                    <th class="text-end">P/L %</th>
                    <th class="text-end">Action</th>
                  </tr>
                </thead>
                <tbody id="holdings-body"></tbody>
              </table>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#holdings-feedback');
    const refreshBtn = root.querySelector<HTMLButtonElement>('#holdings-refresh');
    const tableBody = root.querySelector<HTMLTableSectionElement>('#holdings-body');
    const holdingsCount = root.querySelector<HTMLDivElement>('#holdings-count');
    const lastRefresh = root.querySelector<HTMLDivElement>('#holdings-last-refresh');
    const searchInput = root.querySelector<HTMLInputElement>('#holdings-search');
    const filterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-filter]'));
    const kpiInvested = root.querySelector<HTMLDivElement>('#kpi-invested');
    const kpiValue = root.querySelector<HTMLDivElement>('#kpi-value');
    const kpiPnl = root.querySelector<HTMLDivElement>('#kpi-pnl');
    const kpiPnlPct = root.querySelector<HTMLDivElement>('#kpi-pnl-pct');
    const pieCanvas = root.querySelector<HTMLCanvasElement>('#holdings-pie');
    const barCanvas = root.querySelector<HTMLCanvasElement>('#holdings-bar');
    const pieEmpty = root.querySelector<HTMLDivElement>('#holdings-pie-empty');
    const barEmpty = root.querySelector<HTMLDivElement>('#holdings-bar-empty');

    let trades: TradeRecord[] = [];
    let holdings: HoldingRow[] = [];
    let allocationLimit = 0;
    let allocationChart: Chart | null = null;
    let topChart: Chart | null = null;
    let filters: FilterState = { query: '', mode: 'all' };

    const applyFilters = (rows: HoldingRow[]) => {
      const query = filters.query.toLowerCase();
      return rows.filter((row) => {
        const queryMatch = !query || row.symbol.toLowerCase().includes(query);
        const modeMatch =
          filters.mode === 'all' ||
          (filters.mode === 'profit' && (row.pnl ?? 0) > 0) ||
          (filters.mode === 'loss' && (row.pnl ?? 0) < 0) ||
          (filters.mode === 'allocation' && allocationLimit > 0 && row.invested > allocationLimit);
        return queryMatch && modeMatch;
      });
    };

    const renderRows = (rows: HoldingRow[]) => {
      if (!tableBody) return;
      if (!rows.length) {
        tableBody.innerHTML = '<tr><td colspan="9" class="text-muted text-center py-3">No holdings yet.</td></tr>';
        if (holdingsCount) holdingsCount.textContent = '0 holdings';
        return;
      }
      tableBody.innerHTML = rows
        .map((row) => {
          const pnlClass =
            row.pnl === null ? 'text-muted' : row.pnl >= 0 ? 'text-success' : 'text-danger';
          const pnlPctClass =
            row.pnlPct === null ? 'text-muted' : row.pnlPct >= 0 ? 'text-success' : 'text-danger';
          const toneClass =
            row.pnl === null ? 'holding-row--neutral' : row.pnl >= 0 ? 'holding-row--positive' : 'holding-row--negative';
          const viewParams = new URLSearchParams();
          viewParams.set('symbol', row.symbol);
          if (row.firstTrade) viewParams.set('from', row.firstTrade);
          if (row.lastTrade) viewParams.set('to', row.lastTrade);
          const viewLink = `trades.html?${viewParams.toString()}#history`;
          return `
            <tr class="${toneClass}">
              <td class="fw-semibold" data-label="Ticker" data-role="summary" data-summary="ticker">${row.symbol}</td>
              <td data-label="Hold Days" data-role="summary" data-summary="hold">${row.holdDays ?? '--'}</td>
              <td data-label="Qty" data-role="summary" data-summary="qty">${row.qty}</td>
              <td data-label="Avg Buy" data-role="detail">${row.avgPrice ? formatMoney(row.avgPrice) : '--'}</td>
              <td class="text-end" data-label="LTP" data-role="detail">${row.ltp ? formatMoney(row.ltp) : '--'}</td>
              <td class="text-end" data-label="Current Value" data-role="detail">${row.currentValue ? formatMoney(row.currentValue) : '--'}</td>
              <td class="text-end ${pnlClass}" data-label="P/L" data-role="detail">${row.pnl === null ? '--' : formatMoney(row.pnl)}</td>
              <td class="text-end ${pnlPctClass}" data-label="P/L %" data-role="summary" data-summary="pct">${formatPct(row.pnlPct)}</td>
              <td class="text-end" data-label="Action" data-role="action">
                <div class="d-flex flex-column align-items-end gap-1">
                  <a class="btn btn-sm btn-outline-primary" href="${viewLink}">View</a>
                  <button class="btn btn-link p-0 text-decoration-none mobile-details-toggle d-md-none" data-action="toggle-details" type="button">
                    Details
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
      if (holdingsCount) holdingsCount.textContent = `${rows.length} holdings`;
    };

    const renderKpis = (rows: HoldingRow[]) => {
      const invested = rows.reduce((sum, row) => sum + row.invested, 0);
      const currentValue = rows.reduce((sum, row) => sum + (row.currentValue ?? row.invested), 0);
      const pnl = currentValue - invested;
      const pnlPct = invested ? (pnl / invested) * 100 : null;
      if (kpiInvested) kpiInvested.textContent = formatMoney(invested);
      if (kpiValue) kpiValue.textContent = formatMoney(currentValue);
      if (kpiPnl) kpiPnl.textContent = formatMoney(pnl);
      if (kpiPnlPct) kpiPnlPct.textContent = formatPct(pnlPct);
      if (kpiPnl) kpiPnl.classList.toggle('text-danger', pnl < 0);
      if (kpiPnl) kpiPnl.classList.toggle('text-success', pnl >= 0);
      if (kpiPnlPct) kpiPnlPct.classList.toggle('text-danger', (pnlPct ?? 0) < 0);
      if (kpiPnlPct) kpiPnlPct.classList.toggle('text-success', (pnlPct ?? 0) >= 0);
    };

    const renderCharts = (rows: HoldingRow[]) => {
      if (!pieCanvas || !barCanvas) return;
      if (allocationChart) allocationChart.destroy();
      if (topChart) topChart.destroy();
      const dark = isDarkTheme();
      const legendText = dark ? '#e2e8f0' : '#334155';

      const values = rows
        .map((row) => ({
          symbol: row.symbol,
          value: row.currentValue ?? row.invested
        }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value);

      const top = values.slice(0, 5);
      const othersValue = values.slice(5).reduce((sum, row) => sum + row.value, 0);
      const pieLabels = [...top.map((row) => row.symbol)];
      const pieData = [...top.map((row) => row.value)];
      if (othersValue > 0) {
        pieLabels.push('Others');
        pieData.push(othersValue);
      }

      if (!pieData.length) {
        pieCanvas.classList.add('d-none');
        pieEmpty?.classList.remove('d-none');
      } else {
        pieCanvas.classList.remove('d-none');
        pieEmpty?.classList.add('d-none');
        const totalValue = pieData.reduce((sum, value) => sum + value, 0);
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
            ctx.fillStyle = '#94a3b8';
            ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
            ctx.fillText('Total', x, y + 14);
            ctx.restore();
          }
        };
        const pieConfig: ChartConfiguration<'doughnut', number[], string> = {
          type: 'doughnut',
          data: {
            labels: pieLabels,
            datasets: [
              {
                data: pieData,
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
              padding: { top: 12, bottom: 24, left: 12, right: 12 }
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
                      fontColor: legendText,
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
        allocationChart = new Chart(pieCanvas, pieConfig);
      }

      const holdTop = rows
        .map((row) => ({ symbol: row.symbol, days: row.holdDays ?? 0 }))
        .filter((row) => row.days > 0)
        .sort((a, b) => b.days - a.days)
        .slice(0, 5);

      if (!holdTop.length) {
        barCanvas.classList.add('d-none');
        barEmpty?.classList.remove('d-none');
      } else {
        barCanvas.classList.remove('d-none');
        barEmpty?.classList.add('d-none');
        topChart = new Chart(barCanvas, {
          type: 'bar',
          data: {
            labels: holdTop.map((row) => row.symbol),
            datasets: [
              {
                label: 'Hold Days',
                data: holdTop.map((row) => row.days),
                backgroundColor: chartPalette[0],
                borderRadius: 10,
                barThickness: 16
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false }
            },
            indexAxis: 'y',
            scales: {
              x: { grid: { color: '#eef2f6' }, ticks: { callback: (val) => `${val} d` } },
              y: { grid: { display: false } }
            }
          }
        });
      }
    };

    const refreshHoldings = async () => {
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

      const priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, row] : null;
          })
          .filter((row): row is [string, typeof priceRows[number]] => Boolean(row))
      );
      const latestPriceAt = priceRows.reduce<string | null>((latest, row) => {
        if (!row?.fetchedAt) return latest;
        if (!latest) return row.fetchedAt;
        return row.fetchedAt > latest ? row.fetchedAt : latest;
      }, null);
      if (lastRefresh) {
        lastRefresh.textContent = `Last refresh: ${formatDateTime(latestPriceAt)}`;
      }

      const ranges = buildTradeRanges(trades);
      const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
      holdings = symbols
        .map((symbol) => {
          const cycle = computeCurrentCycleState(symbol, trades);
          if (cycle.qty <= 0) return null;
          const priceRow = priceMap.get(symbol);
          const ltp = priceRow?.price ? Number(priceRow.price) : null;
          const currentValue = ltp ? cycle.qty * ltp : null;
          const pnl = currentValue !== null ? currentValue - cycle.cost : null;
          const pnlPct = pnl !== null && cycle.cost > 0 ? (pnl / cycle.cost) * 100 : null;
          const holdDays =
            cycle.startDate && !Number.isNaN(new Date(cycle.startDate).getTime())
              ? Math.max(
                  0,
                  Math.floor((Date.now() - new Date(cycle.startDate).getTime()) / (1000 * 60 * 60 * 24))
                )
              : null;

          const range = ranges.get(symbol);
          return {
            symbol,
            qty: cycle.qty,
            avgPrice: cycle.avg,
            invested: cycle.cost,
            ltp,
            currentValue,
            pnl,
            pnlPct,
            holdDays,
            firstTrade: cycle.startDate ?? range?.first ?? null,
            lastTrade: range?.last ?? null
          };
        })
        .filter((row): row is HoldingRow => Boolean(row))
        .sort((a, b) => (b.currentValue ?? b.invested) - (a.currentValue ?? a.invested));

      const filtered = applyFilters(holdings);
      renderRows(filtered);
      renderKpis(holdings);
      renderCharts(holdings);
    };

    const handleThemeChange = () => {
      renderCharts(holdings);
    };

    window.addEventListener('ui-theme-change', handleThemeChange);

    const updateFilters = () => {
      filters = {
        ...filters,
        query: searchInput?.value.trim() ?? ''
      };
      renderRows(applyFilters(holdings));
    };

    searchInput?.addEventListener('input', updateFilters);
    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        filterButtons.forEach((btn) => btn.classList.remove('active'));
        button.classList.add('active');
        filters.mode = (button.dataset.filter as FilterState['mode']) || 'all';
        renderRows(applyFilters(holdings));
      });
    });

    tableBody?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const toggle = target.closest<HTMLButtonElement>('[data-action="toggle-details"]');
      if (!toggle) return;
      const row = toggle.closest<HTMLTableRowElement>('tr');
      if (!row) return;
      row.classList.toggle('show-details');
      toggle.textContent = row.classList.contains('show-details') ? 'Hide' : 'Details';
    });

    refreshBtn?.addEventListener('click', async () => {
      if (!refreshBtn) return;
      const label = refreshBtn.textContent || 'Refresh Prices';
      setBusy(refreshBtn, true, label);
      try {
        await syncNow(session);
        await refreshHoldings();
        if (feedback) {
          showAlert(feedback, 'success', 'Live prices refreshed.');
        }
      } catch (error) {
        if (feedback) {
          showAlert(feedback, 'danger', toErrorMessage(error));
        }
      } finally {
        setBusy(refreshBtn, false, label);
      }
    });

    try {
      await refreshHoldings();
    } catch (error) {
      if (feedback) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    }
  })();
}

