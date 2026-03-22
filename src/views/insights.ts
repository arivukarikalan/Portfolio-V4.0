import Chart from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { renderShell, bindShell } from '../ui/shell';
import { lucideIcon } from '../ui/icons';
import { setBusy, showAlert } from '../ui/feedback';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import { initCloudSync, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import type { TradeRecord, UserSettings } from '../core/types';
import { formatDate, formatMoney, formatPct } from '../utils/format';
import { normalizeSymbol } from '../utils/symbols';
import { computeCurrentCycleState, computeCurrentCycleLots } from '../utils/tradeCycles';
import { toErrorMessage } from '../utils/errors';

type HoldingRow = {
  symbol: string;
  qty: number;
  avgBuy: number;
  startDate: string | null;
  lastBuyAvg: number | null;
  ltp: number | null;
};

type MistakeEntry = {
  symbol: string;
  date: string;
  qty: number;
  value: number;
  note: string;
  holdDays?: number;
};

const insightRanges = [
  { id: '1m', label: '1M', days: 30 },
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'All', days: null }
];

const getRangeStart = (rangeId: string) => {
  const range = insightRanges.find((option) => option.id === rangeId);
  if (!range?.days) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - range.days);
  return cutoff.toISOString().slice(0, 10);
};

const sortTrades = (trades: TradeRecord[]) =>
  [...trades].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
    return a.createdAt.localeCompare(b.createdAt);
  });

const computeHoldDays = (start: string | null, end: string | null) => {
  if (!start || !end) return 0;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  const diff = endDate.getTime() - startDate.getTime();
  if (diff < 0) return 0;
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
};

const getLastBuyAverage = (symbol: string, trades: TradeRecord[]) => {
  const relevant = sortTrades(trades).filter(
    (trade) => normalizeSymbol(trade.symbol) === symbol && trade.side === 'BUY'
  );
  if (!relevant.length) return null;
  const lastDate = relevant[relevant.length - 1].tradeDate;
  const batch = relevant.filter((trade) => trade.tradeDate === lastDate);
  const totalQty = batch.reduce((sum, trade) => sum + trade.quantity, 0);
  const totalCost = batch.reduce((sum, trade) => sum + trade.quantity * trade.price, 0);
  return totalQty ? totalCost / totalQty : null;
};

const getLastTradePrice = (symbol: string, trades: TradeRecord[]) => {
  const relevant = sortTrades(trades).filter((trade) => normalizeSymbol(trade.symbol) === symbol);
  return relevant.length ? relevant[relevant.length - 1].price : null;
};

const buildHoldings = (trades: TradeRecord[], priceMap: Map<string, number>): HoldingRow[] => {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  return symbols
    .map((symbol) => {
      const cycle = computeCurrentCycleState(symbol, trades);
      if (cycle.qty <= 0 || cycle.avg === null) return null;
      return {
        symbol,
        qty: cycle.qty,
        avgBuy: cycle.avg,
        startDate: cycle.startDate,
        lastBuyAvg: getLastBuyAverage(symbol, trades),
        ltp: priceMap.get(symbol) ?? null
      };
    })
    .filter((row): row is HoldingRow => Boolean(row));
};

const computeAverageHoldDays = (trades: TradeRecord[]) => {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  const days: number[] = [];
  symbols.forEach((symbol) => {
    const relevant = sortTrades(trades).filter((trade) => normalizeSymbol(trade.symbol) === symbol);
    const lots: Array<{ qty: number; price: number; date: string | null }> = [];
    let cycleStart: string | null = null;

    const consumeLots = (remaining: number, predicate?: (lotDate: string | null) => boolean) => {
      if (remaining <= 0) return 0;
      for (let i = 0; i < lots.length && remaining > 0; i += 1) {
        const lot = lots[i];
        if (predicate && !predicate(lot.date)) continue;
        if (lot.qty > remaining) {
          lot.qty -= remaining;
          remaining = 0;
        } else {
          remaining -= lot.qty;
          lots.splice(i, 1);
          i -= 1;
        }
      }
      return remaining;
    };

    relevant.forEach((trade) => {
      if (trade.side === 'BUY') {
        if (!lots.length) cycleStart = trade.tradeDate || null;
        lots.push({ qty: trade.quantity, price: trade.price, date: trade.tradeDate || null });
      } else if (trade.side === 'SELL') {
        let remaining = trade.quantity;
        const dateKey = trade.tradeDate || null;
        if (dateKey) {
          remaining = consumeLots(remaining, (lotDate) => lotDate === dateKey);
        }
        if (remaining > 0) consumeLots(remaining);
        if (!lots.length && cycleStart && trade.tradeDate) {
          days.push(computeHoldDays(cycleStart, trade.tradeDate));
          cycleStart = null;
        }
      }
    });
  });
  if (!days.length) return 0;
  const sum = days.reduce((total, value) => total + value, 0);
  return sum / days.length;
};

const analyzeMistakes = (trades: TradeRecord[], settings: UserSettings | null) => {
  const targetPct = settings?.targetProfitPct || 10;
  const l1 = settings?.l1ZonePct || 0;
  const l2 = settings?.l2ZonePct || 0;
  const earlyExits: MistakeEntry[] = [];
  const lossBookings: MistakeEntry[] = [];
  const badAverages: MistakeEntry[] = [];

  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  symbols.forEach((symbol) => {
    const relevant = sortTrades(trades).filter((trade) => normalizeSymbol(trade.symbol) === symbol);
    const lots: Array<{ qty: number; price: number; date: string | null }> = [];
    let cycleStart: string | null = null;

    const getAvg = () => {
      const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
      const cost = lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
      return qty ? cost / qty : 0;
    };

    const consumeLots = (remaining: number, predicate?: (lotDate: string | null) => boolean) => {
      if (remaining <= 0) return 0;
      for (let i = 0; i < lots.length && remaining > 0; i += 1) {
        const lot = lots[i];
        if (predicate && !predicate(lot.date)) continue;
        if (lot.qty > remaining) {
          lot.qty -= remaining;
          remaining = 0;
        } else {
          remaining -= lot.qty;
          lots.splice(i, 1);
          i -= 1;
        }
      }
      return remaining;
    };

    relevant.forEach((trade) => {
      if (trade.side === 'BUY') {
        if (!lots.length) cycleStart = trade.tradeDate || null;
        const avgBefore = getAvg();
        const tradeDateKey = trade.tradeDate || '';
        const hasPriorPosition = lots.some((lot) => (lot.date || '') < tradeDateKey);
        if (avgBefore > 0 && hasPriorPosition && (l1 > 0 || l2 > 0)) {
          const dropPct = ((avgBefore - trade.price) / avgBefore) * 100;
          if (l1 > 0 && dropPct < l1) {
            badAverages.push({
              symbol,
              date: trade.tradeDate,
              qty: trade.quantity,
              value: trade.price,
              note: `Above L1/L2 (drop ${dropPct.toFixed(2)}%)`
            });
          } else if (l2 > 0 && l2 > l1 && dropPct < l2) {
            badAverages.push({
              symbol,
              date: trade.tradeDate,
              qty: trade.quantity,
              value: trade.price,
              note: `Above L2 (drop ${dropPct.toFixed(2)}%)`
            });
          }
        }
        lots.push({ qty: trade.quantity, price: trade.price, date: trade.tradeDate || null });
      } else if (trade.side === 'SELL') {
        if (!lots.length) return;
        const avgBefore = getAvg();
        const returnPct = avgBefore ? ((trade.price - avgBefore) / avgBefore) * 100 : 0;
        const holdDays = computeHoldDays(cycleStart, trade.tradeDate || null);
        if (returnPct < 0) {
          lossBookings.push({
            symbol,
            date: trade.tradeDate,
            qty: trade.quantity,
            value: (trade.price - avgBefore) * trade.quantity,
            note: `Loss ${formatPct(returnPct)}`,
            holdDays
          });
        } else if (returnPct < targetPct) {
          const targetPrice = avgBefore * (1 + targetPct / 100);
          earlyExits.push({
            symbol,
            date: trade.tradeDate,
            qty: trade.quantity,
            value: (targetPrice - trade.price) * trade.quantity,
            note: `Below target ${targetPct}%`,
            holdDays
          });
        }
        let remaining = trade.quantity;
        const dateKey = trade.tradeDate || null;
        if (dateKey) remaining = consumeLots(remaining, (lotDate) => lotDate === dateKey);
        if (remaining > 0) consumeLots(remaining);
        if (!lots.length) cycleStart = null;
      }
    });
  });

  return { earlyExits, lossBookings, badAverages };
};

export function renderInsightsView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading insights...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'insights',
      title: 'Insights',
      subtitle: 'Strategy analysis, mistakes, and next actions.',
      content: `
        <div id="insights-feedback" class="alert d-none" role="alert"></div>

        <div class="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
          <div>
            <h2 class="h5 mb-1 section-title">
              <span class="section-icon">${lucideIcon('sparkles')}</span>
              Insights
            </h2>
            <div class="text-muted small">Partial sell analysis, mistakes, and buy pack suggestions.</div>
          </div>
          <div class="d-flex align-items-center gap-2">
            <div class="btn-group insights-range" role="group">
              ${insightRanges
                .map(
                  (range) =>
                    `<button class="btn btn-sm btn-outline-secondary ${range.id === 'all' ? 'active' : ''}" data-range="${
                      range.id
                    }" type="button">${range.label}</button>`
                )
                .join('')}
            </div>
            <button class="btn btn-outline-secondary btn-sm" id="insights-sync">
              ${lucideIcon('refresh-ccw')} Sync
            </button>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-lg-7">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('target')}</span>
                    Partial Sell Strategy
                  </h3>
                  <span class="text-muted small" id="partial-hold-benchmark">Hold benchmark: --</span>
                </div>
                <div class="row g-3">
                  <div class="col-md-4">
                    <label class="form-label">Holding</label>
                    <select class="form-select" id="partial-symbol"></select>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Sell Price</label>
                    <input class="form-control" type="number" step="0.01" id="partial-sell-price" />
                    <div class="text-muted small" id="partial-price-hint">--</div>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Sell Qty</label>
                    <input class="form-control" type="number" step="1" min="1" id="partial-sell-qty" />
                    <div class="text-muted small" id="partial-qty-hint">Available --</div>
                  </div>
                </div>
                <div class="mt-3 insight-summary" id="partial-summary"></div>
              </div>
            </div>
          </div>
          <div class="col-lg-5">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('alert-triangle')}</span>
                    Mistakes Overview
                  </h3>
                  <span class="text-muted small" id="mistakes-count">--</span>
                </div>
                <div class="chart-wrap">
                  <canvas id="mistakes-chart" height="240"></canvas>
                  <div class="chart-empty text-muted small d-none" id="mistakes-empty">No mistakes for this range.</div>
                </div>
                <div class="mt-3 insight-summary" id="mistakes-summary"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h3 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('x-circle')}</span>
                  Mistakes Log
                </h3>
                <div id="mistakes-log" class="insight-list"></div>
                <div id="mistakes-pagination" class="mt-2"></div>
              </div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h3 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('shopping-bag')}</span>
                  Buy Pack (Current Holdings)
                </h3>
                <div class="text-muted small mb-2" id="buy-pack-summary">--</div>
                <div class="table-responsive">
                  <table class="table table-sm insight-table align-middle mobile-stack mobile-toggle-details">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th class="text-end">Last Buy Avg</th>
                        <th class="text-end">L1 Entry</th>
                        <th class="text-end">L2 Entry</th>
                        <th class="text-end">LTP</th>
                        <th class="text-end">Suggested Qty</th>
                        <th class="text-end">Amount Required</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody id="buy-pack-body"></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#insights-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#insights-sync');
    const rangeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-range]'));
    const partialSymbol = root.querySelector<HTMLSelectElement>('#partial-symbol');
    const partialSellQty = root.querySelector<HTMLInputElement>('#partial-sell-qty');
    const partialSellPrice = root.querySelector<HTMLInputElement>('#partial-sell-price');
    const partialPriceHint = root.querySelector<HTMLDivElement>('#partial-price-hint');
    const partialQtyHint = root.querySelector<HTMLDivElement>('#partial-qty-hint');
    const partialSummary = root.querySelector<HTMLDivElement>('#partial-summary');
    const partialHoldBenchmark = root.querySelector<HTMLSpanElement>('#partial-hold-benchmark');
    const mistakesChartCanvas = root.querySelector<HTMLCanvasElement>('#mistakes-chart');
    const mistakesEmpty = root.querySelector<HTMLDivElement>('#mistakes-empty');
    const mistakesSummary = root.querySelector<HTMLDivElement>('#mistakes-summary');
    const mistakesCount = root.querySelector<HTMLSpanElement>('#mistakes-count');
    const mistakesLog = root.querySelector<HTMLDivElement>('#mistakes-log');
    const mistakesPagination = root.querySelector<HTMLDivElement>('#mistakes-pagination');
    const buyPackBody = root.querySelector<HTMLTableSectionElement>('#buy-pack-body');
    const buyPackSummary = root.querySelector<HTMLDivElement>('#buy-pack-summary');

    if (
      !feedback ||
      !syncButton ||
      !partialSymbol ||
      !partialSellQty ||
      !partialSellPrice ||
      !partialPriceHint ||
      !partialQtyHint ||
      !partialSummary ||
      !partialHoldBenchmark ||
      !mistakesChartCanvas ||
      !mistakesEmpty ||
      !mistakesSummary ||
      !mistakesCount ||
      !mistakesLog ||
      !mistakesPagination ||
      !buyPackBody ||
      !buyPackSummary
    ) {
      throw new Error('Insights view failed to initialize');
    }

    let trades: TradeRecord[] = [];
    let holdings: HoldingRow[] = [];
    let priceMap = new Map<string, number>();
    let settings: UserSettings | null = null;
    let rangeId = 'all';
    let mistakesChart: Chart | null = null;
    let mistakeFilter: 'all' | 'Early Exit' | 'Loss Booking' | 'Bad Averaging' = 'all';
    let lastMistakes: {
      earlyExits: MistakeEntry[];
      lossBookings: MistakeEntry[];
      badAverages: MistakeEntry[];
    } | null = null;
    let mistakesPage = 1;
    const mistakesPerPage = 7;

    const updateRangeButtons = () => {
      rangeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.range === rangeId);
      });
    };

    const renderPartialSell = () => {
      if (!partialSymbol.value) return;
      const symbol = partialSymbol.value;
      const sellPrice = Number(partialSellPrice.value);
      const holding = holdings.find((row) => row.symbol === symbol);
      if (!holding) return;

      const totalQty = holding.qty;
      const requestedQty = Number(partialSellQty.value);
      const sellQty = Math.min(Math.max(0, requestedQty), totalQty);
      partialQtyHint.textContent = `Available ${totalQty} | Remaining ${Math.max(0, totalQty - sellQty)}`;
      if (!Number.isFinite(sellPrice) || sellPrice <= 0 || sellQty <= 0) {
        partialSummary.innerHTML = '<div class="text-muted small">Enter a valid sell price to simulate.</div>';
        return;
      }
      const lots = computeCurrentCycleLots(symbol, trades).map((lot) => ({ ...lot }));
      let remaining = sellQty;
      let costUsed = 0;
      for (let i = lots.length - 1; i >= 0 && remaining > 0; i -= 1) {
        const lot = lots[i];
        const take = Math.min(lot.qty, remaining);
        costUsed += take * lot.price;
        remaining -= take;
      }
      const avgCost = sellQty > 0 ? costUsed / sellQty : 0;
      const gross = (sellPrice - avgCost) * sellQty;
      const buyFee = costUsed * ((settings?.buyBrokeragePct || 0) / 100);
      const sellFee = sellPrice * sellQty * ((settings?.sellBrokeragePct || 0) / 100);
      const dpFee = sellQty > 0 ? settings?.dpCharge || 0 : 0;
      const net = gross - buyFee - sellFee - dpFee;
      const returnPct = costUsed ? (net / costUsed) * 100 : 0;
      const targetPct = settings?.targetProfitPct || 10;
      const holdDays = computeHoldDays(holding.startDate, new Date().toISOString().slice(0, 10));
      const avgHold = computeAverageHoldDays(trades);
      const goodSell = returnPct >= targetPct && (avgHold ? holdDays >= avgHold : true);
      const verdict =
        returnPct < 0 ? 'Not good (loss)' : goodSell ? 'Good to sell' : 'Caution (early exit)';
      const feeTotal = buyFee + sellFee + dpFee;

      partialSummary.innerHTML = `
        <div class="insight-pill ${goodSell ? 'success' : returnPct < 0 ? 'danger' : 'warning'}">${verdict}</div>
        <div class="insight-grid mt-2">
          <div>
            <div class="text-muted small">Sell Qty</div>
            <div class="fw-semibold">${sellQty.toFixed(2)} / ${totalQty}</div>
          </div>
          <div>
            <div class="text-muted small">Avg Cost</div>
            <div class="fw-semibold">${formatMoney(avgCost)}</div>
          </div>
          <div>
            <div class="text-muted small">Gross P/L</div>
            <div class="fw-semibold">${formatMoney(gross)}</div>
          </div>
          <div>
            <div class="text-muted small">Fees</div>
            <div class="fw-semibold">${formatMoney(feeTotal)}</div>
            <div class="text-muted small">Buy ${formatMoney(buyFee)} | Sell ${formatMoney(sellFee)} | DP ${formatMoney(dpFee)}</div>
          </div>
          <div>
            <div class="text-muted small">Net P/L</div>
            <div class="fw-semibold">${formatMoney(net)}</div>
          </div>
          <div>
            <div class="text-muted small">Return %</div>
            <div class="fw-semibold">${formatPct(returnPct)}</div>
          </div>
          <div>
            <div class="text-muted small">Hold Days</div>
            <div class="fw-semibold">${holdDays} days</div>
          </div>
          <div>
            <div class="text-muted small">Target Profit</div>
            <div class="fw-semibold">${formatPct(targetPct)}</div>
          </div>
          <div>
            <div class="text-muted small">Remaining Qty</div>
            <div class="fw-semibold">${Math.max(0, totalQty - sellQty).toFixed(2)}</div>
          </div>
        </div>
      `;
    };

    const renderMistakeLog = () => {
      if (!lastMistakes) {
        mistakesLog.innerHTML = '<div class="text-muted small">No mistakes detected in this range.</div>';
        mistakesPagination.innerHTML = '';
        return;
      }
      const { earlyExits, lossBookings, badAverages } = lastMistakes;
      const logRows = [
        ...earlyExits.map((entry) => ({ ...entry, type: 'Early Exit' })),
        ...lossBookings.map((entry) => ({ ...entry, type: 'Loss Booking' })),
        ...badAverages.map((entry) => ({ ...entry, type: 'Bad Averaging' }))
      ];
      const filteredRows =
        mistakeFilter === 'all' ? logRows : logRows.filter((entry) => entry.type === mistakeFilter);

      const grouped = new Map<string, (typeof filteredRows)[number] & { count: number }>();
      filteredRows.forEach((entry) => {
        const key = `${entry.type}|${entry.symbol}|${entry.date}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.qty += entry.qty;
          existing.value += entry.value;
          existing.count += 1;
        } else {
          grouped.set(key, { ...entry, count: 1 });
        }
      });

      const groupedRows = Array.from(grouped.values()).sort((a, b) => b.date.localeCompare(a.date));
      const totalPages = Math.max(1, Math.ceil(groupedRows.length / mistakesPerPage));
      if (mistakesPage > totalPages) mistakesPage = totalPages;
      const start = (mistakesPage - 1) * mistakesPerPage;
      const pageRows = groupedRows.slice(start, start + mistakesPerPage);
      mistakesLog.innerHTML = pageRows.length
        ? pageRows
            .map(
              (entry) => `
              <div class="insight-item">
                <div>
                  <div class="fw-semibold">${entry.symbol} <span class="text-muted small">${entry.type}</span></div>
                  <div class="text-muted small">${formatDate(entry.date)} - ${entry.note}${
                    entry.holdDays ? ` (Hold ${entry.holdDays}d)` : ''
                  }</div>
                  <div class="text-muted small">${entry.count > 1 ? `${entry.count} trades merged` : ''}</div>
                </div>
                <div class="text-end">
                  <div class="fw-semibold">${formatMoney(entry.value)}</div>
                  <div class="text-muted small">${entry.qty} qty</div>
                </div>
              </div>
            `
            )
            .join('')
        : '<div class="text-muted small">No mistakes detected in this range.</div>';

      if (totalPages <= 1) {
        mistakesPagination.innerHTML = '';
        return;
      }
      const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
      mistakesPagination.innerHTML = `
        <nav aria-label="Mistakes pagination" class="mistakes-pagination d-flex justify-content-center">
          <ul class="pagination pagination-sm mb-0 flex-wrap">
            <li class="page-item ${mistakesPage === 1 ? 'disabled' : ''}">
              <button class="page-link" data-page="${mistakesPage - 1}" type="button">Prev</button>
            </li>
            ${pages
              .map(
                (page) => `
                  <li class="page-item ${page === mistakesPage ? 'active' : ''}">
                    <button class="page-link" data-page="${page}" type="button">${page}</button>
                  </li>
                `
              )
              .join('')}
            <li class="page-item ${mistakesPage === totalPages ? 'disabled' : ''}">
              <button class="page-link" data-page="${mistakesPage + 1}" type="button">Next</button>
            </li>
          </ul>
        </nav>
      `;
    };

    const renderMistakes = (filtered: TradeRecord[]) => {
      const { earlyExits, lossBookings, badAverages } = analyzeMistakes(filtered, settings);
      lastMistakes = { earlyExits, lossBookings, badAverages };
      mistakesPage = 1;
      const totalMistakes = earlyExits.length + lossBookings.length + badAverages.length;
      mistakesCount.textContent = `${totalMistakes} total`;

      const earlyImpact = earlyExits.reduce((sum, entry) => sum + entry.value, 0);
      const lossImpact = lossBookings.reduce((sum, entry) => sum + entry.value, 0);
      mistakesSummary.innerHTML = `
        <div class="insight-grid">
          <button class="btn btn-sm ${mistakeFilter === 'Early Exit' ? 'btn-warning' : 'btn-outline-warning'}" data-mistake="Early Exit">
            <span class="badge text-bg-warning">${earlyExits.length}</span> Early exits (${formatMoney(earlyImpact)})
          </button>
          <button class="btn btn-sm ${mistakeFilter === 'Loss Booking' ? 'btn-danger' : 'btn-outline-danger'}" data-mistake="Loss Booking">
            <span class="badge text-bg-danger">${lossBookings.length}</span> Loss bookings (${formatMoney(lossImpact)})
          </button>
          <button class="btn btn-sm ${mistakeFilter === 'Bad Averaging' ? 'btn-secondary' : 'btn-outline-secondary'}" data-mistake="Bad Averaging">
            <span class="badge text-bg-secondary">${badAverages.length}</span> Bad averaging
          </button>
        </div>
        <div class="text-muted small mt-2">Showing: ${mistakeFilter === 'all' ? 'All' : mistakeFilter}</div>
      `;

      if (mistakesChart) mistakesChart.destroy();
      if (!totalMistakes) {
        mistakesChartCanvas.classList.add('d-none');
        mistakesEmpty.classList.remove('d-none');
      } else {
        mistakesChartCanvas.classList.remove('d-none');
        mistakesEmpty.classList.add('d-none');
        const config: ChartConfiguration<'bar', number[], string> = {
          type: 'bar',
          data: {
            labels: ['Early Exit', 'Loss Booking', 'Bad Averaging'],
            datasets: [
              {
                label: 'Count',
                data: [earlyExits.length, lossBookings.length, badAverages.length],
                backgroundColor: ['#f59e0b', '#ef4444', '#94a3b8'],
                borderRadius: 8
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false } },
              y: { ticks: { precision: 0 } }
            },
            onClick: (_event, elements) => {
              if (!elements.length) {
                mistakeFilter = 'all';
                renderMistakes(filtered);
                return;
              }
              const index = elements[0].index;
              const label = ['Early Exit', 'Loss Booking', 'Bad Averaging'][index] as
                | 'Early Exit'
                | 'Loss Booking'
                | 'Bad Averaging';
              mistakeFilter = mistakeFilter === label ? 'all' : label;
              renderMistakes(filtered);
            }
          }
        };
        mistakesChart = new Chart(mistakesChartCanvas, config);
      }

      mistakesSummary.querySelectorAll<HTMLButtonElement>('[data-mistake]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = btn.dataset.mistake as 'Early Exit' | 'Loss Booking' | 'Bad Averaging';
          mistakeFilter = mistakeFilter === next ? 'all' : next;
          renderMistakes(filtered);
        });
      });

      renderMistakeLog();
    };

    const renderBuyPack = () => {
      const l1 = settings?.l1ZonePct || 0;
      const l2 = settings?.l2ZonePct || 0;
      const totalInvestment = settings?.totalInvestment || 0;
      const perStockLimit =
        settings && settings.totalInvestment > 0 && settings.maxAllocationPct > 0
          ? (settings.totalInvestment * settings.maxAllocationPct) / 100
          : 0;
      const totalInvested = holdings.reduce((sum, row) => sum + row.avgBuy * row.qty, 0);
      const remainingPortfolio = totalInvestment > 0 ? totalInvestment - totalInvested : null;
      buyPackSummary.textContent =
        totalInvestment > 0
          ? `Portfolio: ${formatMoney(totalInvested)} invested of ${formatMoney(totalInvestment)} | Remaining ${formatMoney(
              Math.max(0, remainingPortfolio ?? 0)
            )}`
          : 'Portfolio totals are not set in settings.';
      buyPackBody.innerHTML = holdings
        .map((row) => {
          const base = row.lastBuyAvg ?? row.avgBuy;
          const l1Entry = base * (1 - l1 / 100);
          const l2Entry = base * (1 - l2 / 100);
          const ltp = row.ltp ?? base;
          const invested = row.avgBuy * row.qty;
          const remainingAllocation = perStockLimit > 0 ? perStockLimit - invested : null;
          const remainingBudget =
            remainingPortfolio !== null ? Math.min(remainingPortfolio, remainingAllocation ?? remainingPortfolio) : null;
          const suggestedQty =
            remainingBudget !== null && remainingBudget > 0 && base > 0
              ? Math.floor(remainingBudget / base)
              : 0;
          const amountRequired = suggestedQty > 0 ? suggestedQty * ltp : 0;
          const status =
            ltp <= l2Entry ? 'L2 Ready' : ltp <= l1Entry ? 'L1 Ready' : 'Wait';
          const badgeClass = status === 'L2 Ready' ? 'text-bg-success' : status === 'L1 Ready' ? 'text-bg-warning' : 'text-bg-secondary';
          const allocationExceeded = remainingAllocation !== null && remainingAllocation <= 0;
          const portfolioExceeded = remainingPortfolio !== null && remainingPortfolio <= 0;
          const allocationLabel = portfolioExceeded
            ? 'Portfolio Budget Exceeds'
            : allocationExceeded
              ? 'Allocation Exceeds'
              : status;
          const allocationBadge = portfolioExceeded ? 'text-bg-danger' : allocationExceeded ? 'text-bg-danger' : badgeClass;
          return `
            <tr>
              <td class="fw-semibold" data-label="Symbol" data-role="summary" data-summary="ticker">${row.symbol}</td>
              <td class="text-end" data-label="Last Buy Avg" data-role="detail">${formatMoney(base)}</td>
              <td class="text-end" data-label="L1 Entry" data-role="detail">${formatMoney(l1Entry)}</td>
              <td class="text-end" data-label="L2 Entry" data-role="detail">${formatMoney(l2Entry)}</td>
              <td class="text-end" data-label="LTP" data-role="summary" data-summary="ltp">${row.ltp ? formatMoney(row.ltp) : '--'}</td>
              <td class="text-end" data-label="Suggested Qty" data-role="summary" data-summary="qty">${perStockLimit > 0 && totalInvestment > 0 ? suggestedQty : '--'}</td>
              <td class="text-end" data-label="Amount Required" data-role="detail">${suggestedQty > 0 ? formatMoney(amountRequired) : '--'}</td>
              <td data-label="Status" data-role="summary" data-summary="status">
                <div class="d-flex flex-column align-items-start gap-1">
                  <span class="badge ${allocationBadge}">${allocationLabel}</span>
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

    const applyRange = () => {
      const start = getRangeStart(rangeId);
      const filtered = start ? trades.filter((trade) => trade.tradeDate >= start) : trades;
      renderMistakes(filtered);
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

      holdings = buildHoldings(trades, priceMap);
      partialSymbol.innerHTML = holdings
        .map((row) => `<option value="${row.symbol}">${row.symbol}</option>`)
        .join('');

      const avgHold = computeAverageHoldDays(trades);
      partialHoldBenchmark.textContent = avgHold ? `Hold benchmark: ${avgHold.toFixed(0)} days` : 'Hold benchmark: --';

      if (holdings.length) {
        const first = holdings[0];
        partialSymbol.value = first.symbol;
        const lastTradePrice = getLastTradePrice(first.symbol, trades);
        const fallbackPrice = first.ltp ?? first.avgBuy;
        partialSellPrice.value = String(lastTradePrice ?? fallbackPrice);
        const defaultQty = Math.max(1, Math.round(first.qty * 0.25));
        partialSellQty.value = String(Math.min(first.qty, defaultQty));
        partialPriceHint.textContent = `Default: last trade price. Last trade ${lastTradePrice ? formatMoney(lastTradePrice) : '--'} | LTP ${
          first.ltp ? formatMoney(first.ltp) : '--'
        }`;
        partialQtyHint.textContent = `Available ${first.qty} | Remaining ${Math.max(0, first.qty - Number(partialSellQty.value))}`;
      } else {
        partialSellPrice.value = '';
        partialPriceHint.textContent = '--';
        partialSellQty.value = '';
        partialQtyHint.textContent = 'Available --';
      }

      renderBuyPack();
      updateRangeButtons();
      applyRange();
      renderPartialSell();
    };

    rangeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        rangeId = btn.dataset.range || 'all';
        updateRangeButtons();
        applyRange();
      });
    });

    partialSymbol.addEventListener('change', () => {
      const symbol = partialSymbol.value;
      const holding = holdings.find((row) => row.symbol === symbol);
      const lastTradePrice = getLastTradePrice(symbol, trades);
      const fallbackPrice = holding?.ltp ?? holding?.avgBuy ?? 0;
      partialSellPrice.value = String(lastTradePrice ?? fallbackPrice);
      partialPriceHint.textContent = `Default: last trade price. Last trade ${lastTradePrice ? formatMoney(lastTradePrice) : '--'} | LTP ${
        holding?.ltp ? formatMoney(holding.ltp) : '--'
      }`;
      if (holding) {
        const defaultQty = Math.max(1, Math.round(holding.qty * 0.25));
        partialSellQty.value = String(Math.min(holding.qty, defaultQty));
        partialQtyHint.textContent = `Available ${holding.qty} | Remaining ${Math.max(0, holding.qty - Number(partialSellQty.value))}`;
      }
      renderPartialSell();
    });
    partialSellQty.addEventListener('input', () => renderPartialSell());
    partialSellPrice.addEventListener('input', () => renderPartialSell());

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refreshData();
        showAlert(feedback, 'success', 'Insights refreshed.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    buyPackBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const toggle = target.closest<HTMLButtonElement>('[data-action="toggle-details"]');
      if (!toggle) return;
      const row = toggle.closest<HTMLTableRowElement>('tr');
      if (!row) return;
      row.classList.toggle('show-details');
      toggle.textContent = row.classList.contains('show-details') ? 'Hide' : 'Details';
    });

    mistakesPagination.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLButtonElement>('[data-page]');
      if (!button) return;
      const nextPage = Number(button.dataset.page);
      if (!Number.isFinite(nextPage) || nextPage < 1) return;
      mistakesPage = nextPage;
      renderMistakeLog();
    });

    await refreshData();
  })();
}

