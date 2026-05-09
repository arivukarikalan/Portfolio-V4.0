import { renderShell, bindShell } from '../ui/shell';
import { setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import type { TradeRecord } from '../core/types';
import { initCloudSync, refreshLivePricesNow, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import { formatDate, formatMoney, formatPct } from '../utils/format';
import { normalizeSymbol } from '../utils/symbols';
import { computeCurrentCycleState, computeCurrentCycleLots } from '../utils/tradeCycles';
import { compareTradeExecutionAsc } from '../utils/tradeOrdering';
import { toErrorMessage } from '../utils/errors';

type Lot = {
  qty: number;
  price: number;
  date: string | null;
};

type OpenTarget = {
  symbol: string;
  qty: number;
  avgBuy: number;
  targetPrice: number;
  ltp: number | null;
  progress: number;
  diff: number;
  startDate: string | null;
};

type BreakdownLot = {
  qty: number;
  price: number;
  targetPrice: number;
  ltp: number | null;
  progress: number | null;
  date: string | null;
};

type ClosedCycle = {
  symbol: string;
  startDate: string | null;
  endDate: string | null;
  buyCost: number;
  sellProceeds: number;
  sellQty: number;
  pnl: number;
  pnlPct: number;
  status: 'COMPLETED' | 'EARLY_EXIT' | 'LOSS';
};

export function renderTargetView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading target planner...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'target',
      title: 'Target Planner',
      subtitle: 'Plan exit targets and track sell readiness.',
      content: `
        <div class="target-page">
          <div id="target-feedback" class="alert d-none" role="alert"></div>

          <div class="card target-hero shadow-sm border-0">
            <div class="card-body d-flex flex-wrap justify-content-between align-items-center gap-3">
              <div>
                <div class="target-eyebrow">Exit Planning</div>
                <h2 class="h5 mb-1 section-title">Target Planner</h2>
                <div class="text-muted small">Track sell readiness, target prices, and expected profit in one place.</div>
              </div>
              <button class="btn btn-outline-secondary btn-sm" id="target-sync">
                ${lucideIcon('refresh-ccw')} Sync
              </button>
            </div>
          </div>

          <div class="row g-3">
          <div class="col-6 col-lg-3">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('percent')}</span>
                  Target Profit %
                </div>
                <div class="h5 mb-0" id="target-profit-pct">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('layers')}</span>
                  Open Positions
                </div>
                <div class="h5 mb-0" id="target-open-count">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('check-circle')}</span>
                  Ready to Exit
                </div>
                <div class="h5 mb-0" id="target-ready-count">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('activity')}</span>
                  Avg Progress
                </div>
                <div class="h5 mb-0" id="target-progress-avg">--</div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-12 col-lg-4">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('wallet')}</span>
                  Total Invested
                </div>
                <div class="h5 mb-0" id="target-total-invested">--</div>
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-4">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('line-chart')}</span>
                  Current Value
                </div>
                <div class="h5 mb-0" id="target-current-value">--</div>
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-4">
            <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('sparkles')}</span>
                  Expected Profit
                </div>
                <div class="h5 mb-0" id="target-expected-profit">--</div>
                <div class="text-muted small" id="target-expected-pct">--</div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-12">
            <div class="card target-section-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                  <div>
                    <div class="target-eyebrow">Tracking</div>
                    <h3 class="h6 mb-0 section-title">Active Targets</h3>
                    <div class="text-muted small" id="target-active-count">--</div>
                  </div>
                  <div class="text-muted small" id="target-sort-note">Sort by name, change, or progress.</div>
                </div>
                <div class="table-responsive">
                  <table class="table table-sm target-table align-middle w-100 mobile-stack mobile-toggle-details">
                    <thead>
                      <tr>
                        <th>
                          <button class="btn btn-link btn-sm p-0 text-decoration-none target-sort" data-sort="symbol">
                            Symbol <span class="target-sort-indicator" data-sort-indicator="symbol"></span>
                          </button>
                        </th>
                        <th class="text-end">Qty</th>
                        <th class="text-end">Avg Buy</th>
                        <th class="text-end">LTP</th>
                        <th class="text-end">
                          <button class="btn btn-link btn-sm p-0 text-decoration-none target-sort" data-sort="chg">
                            Chg % <span class="target-sort-indicator" data-sort-indicator="chg"></span>
                          </button>
                        </th>
                        <th class="text-end">Target</th>
                        <th>
                          <button class="btn btn-link btn-sm p-0 text-decoration-none target-sort" data-sort="progress">
                            Progress <span class="target-sort-indicator" data-sort-indicator="progress"></span>
                          </button>
                        </th>
                        <th>Status</th>
                        <th class="text-end">Expected Profit</th>
                        <th class="text-end">Breakdown</th>
                      </tr>
                    </thead>
                    <tbody id="target-active"></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
          </div>

          <div class="row g-3">
          <div class="col-12 col-lg-3">
            <div class="card target-section-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <div>
                    <div class="target-eyebrow">Signals</div>
                    <h3 class="h6 mb-0 section-title">Ready to Exit</h3>
                  </div>
                  <span class="text-muted small" id="target-ready-badge">--</span>
                </div>
                <div id="target-ready-list" class="target-list"></div>
                <div id="target-ready-pagination" class="mt-2"></div>
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-3">
            <div class="card target-section-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="target-eyebrow">History</div>
                <h3 class="h6 mb-3 section-title">Completed</h3>
                <div id="target-completed" class="target-list"></div>
                <div id="target-completed-pagination" class="mt-2"></div>
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-3">
            <div class="card target-section-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="target-eyebrow">History</div>
                <h3 class="h6 mb-3 section-title">Early Exit</h3>
                <div id="target-early" class="target-list"></div>
                <div id="target-early-pagination" class="mt-2"></div>
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-3">
            <div class="card target-section-card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="target-eyebrow">History</div>
                <h3 class="h6 mb-3 section-title">Loss</h3>
                <div id="target-loss" class="target-list"></div>
                <div id="target-loss-pagination" class="mt-2"></div>
              </div>
            </div>
          </div>
          </div>

          <div class="app-modal" id="target-breakdown-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="modal"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <div>
                    <div class="target-eyebrow">Details</div>
                    <h3 class="h6 mb-0 section-title">Target Breakdown</h3>
                  </div>
                  <button class="btn btn-sm btn-outline-secondary" type="button" data-close="modal">Close</button>
                </div>
                <div class="text-muted small mb-3" id="breakdown-subtitle">--</div>
                <div class="table-responsive">
                  <table class="table table-sm target-table target-breakdown-table align-middle">
                    <thead>
                      <tr>
                        <th>Qty</th>
                        <th class="text-end">Entry</th>
                        <th class="text-end">Target</th>
                        <th class="text-end">LTP</th>
                        <th class="text-end">Progress</th>
                        <th class="text-end">Expected Profit</th>
                        <th class="text-end">Buy Date</th>
                      </tr>
                    </thead>
                    <tbody id="breakdown-body"></tbody>
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

    const feedback = root.querySelector<HTMLDivElement>('#target-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#target-sync');
    const targetProfitPctEl = root.querySelector<HTMLDivElement>('#target-profit-pct');
    const openCountEl = root.querySelector<HTMLDivElement>('#target-open-count');
    const readyCountEl = root.querySelector<HTMLDivElement>('#target-ready-count');
    const progressAvgEl = root.querySelector<HTMLDivElement>('#target-progress-avg');
    const totalInvestedEl = root.querySelector<HTMLDivElement>('#target-total-invested');
    const currentValueEl = root.querySelector<HTMLDivElement>('#target-current-value');
    const expectedProfitEl = root.querySelector<HTMLDivElement>('#target-expected-profit');
    const expectedPctEl = root.querySelector<HTMLDivElement>('#target-expected-pct');
    const activeCountEl = root.querySelector<HTMLSpanElement>('#target-active-count');
    const activeBody = root.querySelector<HTMLTableSectionElement>('#target-active');
    const readyBadge = root.querySelector<HTMLSpanElement>('#target-ready-badge');
    const readyList = root.querySelector<HTMLDivElement>('#target-ready-list');
    const completedList = root.querySelector<HTMLDivElement>('#target-completed');
    const earlyList = root.querySelector<HTMLDivElement>('#target-early');
    const lossList = root.querySelector<HTMLDivElement>('#target-loss');
    const readyPagination = root.querySelector<HTMLDivElement>('#target-ready-pagination');
    const completedPagination = root.querySelector<HTMLDivElement>('#target-completed-pagination');
    const earlyPagination = root.querySelector<HTMLDivElement>('#target-early-pagination');
    const lossPagination = root.querySelector<HTMLDivElement>('#target-loss-pagination');
    const sortButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.target-sort'));
    const sortIndicators = Array.from(root.querySelectorAll<HTMLSpanElement>('.target-sort-indicator'));
    const breakdownModal = root.querySelector<HTMLDivElement>('#target-breakdown-modal');
    const breakdownBody = root.querySelector<HTMLTableSectionElement>('#breakdown-body');
    const breakdownSubtitle = root.querySelector<HTMLDivElement>('#breakdown-subtitle');

    if (
      !feedback ||
      !syncButton ||
      !targetProfitPctEl ||
      !openCountEl ||
      !readyCountEl ||
      !progressAvgEl ||
      !totalInvestedEl ||
      !currentValueEl ||
      !expectedProfitEl ||
      !expectedPctEl ||
      !activeCountEl ||
      !activeBody ||
      !readyBadge ||
      !readyList ||
      !completedList ||
      !earlyList ||
      !lossList ||
      !readyPagination ||
      !completedPagination ||
      !earlyPagination ||
      !lossPagination ||
      !breakdownModal ||
      !breakdownBody ||
      !breakdownSubtitle
    ) {
      throw new Error('Target planner view failed to initialize');
    }

    const consumeLots = (lots: Lot[], qty: number, predicate?: (lot: Lot) => boolean) => {
      let remaining = qty;
      let cost = 0;
      let matchedQty = 0;
      const dates: string[] = [];
      for (let i = 0; i < lots.length && remaining > 0; i += 1) {
        const lot = lots[i];
        if (predicate && !predicate(lot)) continue;
        if (lot.qty > remaining) {
          matchedQty += remaining;
          cost += remaining * lot.price;
          if (lot.date) dates.push(lot.date);
          lot.qty -= remaining;
          remaining = 0;
        } else {
          matchedQty += lot.qty;
          cost += lot.qty * lot.price;
          if (lot.date) dates.push(lot.date);
          remaining -= lot.qty;
          lots.splice(i, 1);
          i -= 1;
        }
      }
      const startDate = dates.length ? dates.sort()[0] : null;
      return { remaining, cost, matchedQty, startDate };
    };

    type SortKey = 'symbol' | 'chg' | 'progress';
    let sortKey: SortKey = 'progress';
    let sortDir: 'asc' | 'desc' = 'desc';
    let currentOpenTargets: OpenTarget[] = [];
    let currentReady: OpenTarget[] = [];
    let currentCompleted: ClosedCycle[] = [];
    let currentEarly: ClosedCycle[] = [];
    let currentLoss: ClosedCycle[] = [];
    let breakdownBySymbol = new Map<string, BreakdownLot[]>();
    let readyPage = 1;
    let completedPage = 1;
    let earlyPage = 1;
    let lossPage = 1;
    const listPageSize = 5;

    const buildTargets = (trades: TradeRecord[], targetPct: number, priceMap: Map<string, number>) => {
      const openTargets: OpenTarget[] = [];
      const completed: ClosedCycle[] = [];
      const earlyExit: ClosedCycle[] = [];
      const loss: ClosedCycle[] = [];

      const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
      symbols.forEach((symbol) => {
        const relevant = trades
          .filter((trade) => normalizeSymbol(trade.symbol) === symbol)
          .sort(compareTradeExecutionAsc);

        const lots: Lot[] = [];
        const grouped = new Map<string, { buys: TradeRecord[]; sells: TradeRecord[] }>();
        relevant.forEach((trade) => {
          const key = trade.tradeDate || '';
          const day = grouped.get(key) || { buys: [], sells: [] };
          if (trade.side === 'BUY') day.buys.push(trade);
          if (trade.side === 'SELL') day.sells.push(trade);
          grouped.set(key, day);
        });

        Array.from(grouped.keys())
          .sort()
          .forEach((date) => {
            const day = grouped.get(date);
            if (!day) return;
            day.buys.sort(compareTradeExecutionAsc).forEach((trade) => {
              if (!(trade.quantity > 0) || !(trade.price > 0)) return;
              lots.push({ qty: trade.quantity, price: trade.price, date: trade.tradeDate || null });
            });
            day.sells.sort(compareTradeExecutionAsc).forEach((trade) => {
              if (!lots.length || !(trade.quantity > 0) || !(trade.price > 0)) return;
              let remaining = trade.quantity;
              let buyCost = 0;
              let sellQty = 0;
              const startDates: string[] = [];
              const dateKey = trade.tradeDate || null;
              if (dateKey) {
                const sameDay = consumeLots(lots, remaining, (lot) => lot.date === dateKey);
                remaining = sameDay.remaining;
                buyCost += sameDay.cost;
                sellQty += sameDay.matchedQty;
                if (sameDay.startDate) startDates.push(sameDay.startDate);
              }
              if (remaining > 0) {
                const fifo = consumeLots(lots, remaining);
                remaining = fifo.remaining;
                buyCost += fifo.cost;
                sellQty += fifo.matchedQty;
                if (fifo.startDate) startDates.push(fifo.startDate);
              }
              if (sellQty <= 0 || buyCost <= 0) return;
              const sellProceeds = sellQty * trade.price;
              const pnl = sellProceeds - buyCost;
              const pnlPct = (pnl / buyCost) * 100;
              let status: ClosedCycle['status'] = 'COMPLETED';
              if (pnlPct < 0) {
                status = 'LOSS';
              } else if (pnlPct < targetPct) {
                status = 'EARLY_EXIT';
              }
              const closed: ClosedCycle = {
                symbol,
                startDate: startDates.length ? startDates.sort()[0] : null,
                endDate: trade.tradeDate || null,
                buyCost,
                sellProceeds,
                sellQty,
                pnl,
                pnlPct,
                status
              };
              if (status === 'COMPLETED') completed.push(closed);
              if (status === 'EARLY_EXIT') earlyExit.push(closed);
              if (status === 'LOSS') loss.push(closed);
            });
          });

        const current = computeCurrentCycleState(symbol, relevant);
        if (current.qty > 0) {
          const qty = current.qty;
          const avgBuy = current.avg ?? 0;
          const targetPrice = avgBuy * (1 + targetPct / 100);
          const ltp = priceMap.get(symbol) ?? null;
          const progress = ltp && targetPrice > avgBuy ? (ltp - avgBuy) / (targetPrice - avgBuy) : 0;
          const diff = ltp ? targetPrice - ltp : targetPrice - avgBuy;
          openTargets.push({
            symbol,
            qty,
            avgBuy,
            targetPrice,
            ltp,
            progress,
            diff,
            startDate: current.startDate
          });
        }
      });

      openTargets.sort((a, b) => (b.ltp ?? 0) - (a.ltp ?? 0));
      completed.sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));
      earlyExit.sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));
      loss.sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));

      return { openTargets, completed, earlyExit, loss };
    };

    const buildBreakdown = (
      symbol: string,
      trades: TradeRecord[],
      targetPct: number,
      priceMap: Map<string, number>
    ): BreakdownLot[] => {
      const lots = computeCurrentCycleLots(symbol, trades);
      const ltp = priceMap.get(symbol) ?? null;
      return lots
        .filter((lot) => lot.qty > 0)
        .map((lot) => {
          const targetPrice = lot.price * (1 + targetPct / 100);
          const progress =
            ltp && targetPrice > lot.price ? ((ltp - lot.price) / (targetPrice - lot.price)) * 100 : null;
          return {
            qty: lot.qty,
            price: lot.price,
            targetPrice,
            ltp,
            progress,
            date: lot.date
          };
        });
    };

    const getHoldDays = (start: string | null, end: string | null) => {
      if (!start || !end) return null;
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
      const diff = endDate.getTime() - startDate.getTime();
      if (diff < 0) return null;
      return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    };

    const renderListLegacy = (container: HTMLElement, rows: ClosedCycle[], empty: string) => {
      if (!rows.length) {
        container.innerHTML = `<div class="text-muted small">${empty}</div>`;
        return;
      }
      container.innerHTML = rows
        .map((row) => {
          const pctClass = row.pnlPct >= 0 ? 'text-success' : 'text-danger';
          const holdDays = getHoldDays(row.startDate, row.endDate);
          const label =
            row.status === 'COMPLETED'
              ? 'Target met'
              : row.status === 'EARLY_EXIT'
                ? 'Below target'
                : 'Net loss';
          return `
            <div class="target-item">
              <div>
                <div class="fw-semibold">${row.symbol}</div>
                <div class="text-muted small">
                  ${formatDate(row.startDate || '')} to ${formatDate(row.endDate || '')}
                  ${holdDays ? `• ${holdDays} days` : ''}
                </div>
                <div class="text-muted small">${label} • ${row.sellQty} qty</div>
              </div>
              <div class="text-end">
                <div class="${pctClass} fw-semibold">${formatPct(row.pnlPct)}</div>
                <div class="text-muted small">${formatMoney(row.pnl)}</div>
              </div>
            </div>
          `;
        })
        .join('');
    };

    void renderListLegacy;

    const renderPagination = (paginationEl: HTMLElement, total: number, page: number) => {
      const totalPages = Math.max(1, Math.ceil(total / listPageSize));
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
        return;
      }
      const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
      paginationEl.innerHTML = `
        <nav aria-label="Target list pagination" class="mistakes-pagination d-flex justify-content-center">
          <ul class="pagination pagination-sm mb-0 flex-wrap">
            <li class="page-item ${page === 1 ? 'disabled' : ''}">
              <button class="page-link" data-page="${page - 1}" type="button">Prev</button>
            </li>
            ${pages
              .map(
                (p) => `
                  <li class="page-item ${p === page ? 'active' : ''}">
                    <button class="page-link" data-page="${p}" type="button">${p}</button>
                  </li>
                `
              )
              .join('')}
            <li class="page-item ${page === totalPages ? 'disabled' : ''}">
              <button class="page-link" data-page="${page + 1}" type="button">Next</button>
            </li>
          </ul>
        </nav>
      `;
    };

    const renderReadyList = (rows: OpenTarget[]) => {
      if (!rows.length) {
        readyList.innerHTML = `<div class="text-muted small">No targets met yet.</div>`;
        readyPagination.innerHTML = '';
        return;
      }
      const totalPages = Math.max(1, Math.ceil(rows.length / listPageSize));
      if (readyPage > totalPages) readyPage = totalPages;
      const start = (readyPage - 1) * listPageSize;
      const slice = rows.slice(start, start + listPageSize);
      readyList.innerHTML = slice
        .map((row) => {
          const changePct = getChangePct(row);
          return `
            <div class="target-item">
              <div>
                <div class="fw-semibold">${row.symbol}</div>
                <div class="text-muted small">${row.qty} qty - Target ${formatMoney(row.targetPrice)}</div>
              </div>
              <div class="text-end">
                <div class="text-success fw-semibold">${row.ltp ? formatMoney(row.ltp) : '--'}</div>
                <div class="text-muted small">${changePct === null ? '--' : formatPct(changePct)}</div>
              </div>
            </div>
          `;
        })
        .join('');
      renderPagination(readyPagination, rows.length, readyPage);
    };

    const renderList = (
      container: HTMLElement,
      paginationEl: HTMLElement,
      rows: ClosedCycle[],
      empty: string,
      page: number
    ) => {
      if (!rows.length) {
        container.innerHTML = `<div class="text-muted small">${empty}</div>`;
        paginationEl.innerHTML = '';
        return;
      }
      const totalPages = Math.max(1, Math.ceil(rows.length / listPageSize));
      const currentPage = Math.min(page, totalPages);
      const start = (currentPage - 1) * listPageSize;
      const slice = rows.slice(start, start + listPageSize);
      container.innerHTML = slice
        .map((row) => {
          const pctClass = row.pnlPct >= 0 ? 'text-success' : 'text-danger';
          const holdDays = getHoldDays(row.startDate, row.endDate);
          const label =
            row.status === 'COMPLETED'
              ? 'Target met'
              : row.status === 'EARLY_EXIT'
                ? 'Below target'
                : 'Net loss';
          return `
            <div class="target-item">
              <div>
                <div class="fw-semibold">${row.symbol}</div>
                <div class="text-muted small">
                  ${formatDate(row.startDate || '')} to ${formatDate(row.endDate || '')}
                  ${holdDays ? ` - ${holdDays} days` : ''}
                </div>
                <div class="text-muted small">${label} - ${row.sellQty} qty</div>
              </div>
              <div class="text-end">
                <div class="${pctClass} fw-semibold">${formatPct(row.pnlPct)}</div>
                <div class="text-muted small">${formatMoney(row.pnl)}</div>
              </div>
            </div>
          `;
        })
        .join('');
      renderPagination(paginationEl, rows.length, currentPage);
    };

    const getChangePct = (row: OpenTarget) => {
      if (row.ltp === null || row.avgBuy <= 0) return null;
      return ((row.ltp - row.avgBuy) / row.avgBuy) * 100;
    };

    const getProgressPct = (row: OpenTarget) => {
      if (row.ltp === null) return null;
      return row.progress * 100;
    };

    const getSortValue = (row: OpenTarget, key: SortKey) => {
      if (key === 'symbol') return 0;
      const value = key === 'chg' ? getChangePct(row) : getProgressPct(row);
      return value ?? Number.NEGATIVE_INFINITY;
    };

    const updateSortIndicators = () => {
      sortIndicators.forEach((indicator) => {
        const key = indicator.dataset.sortIndicator as SortKey | undefined;
        if (!key) return;
        indicator.innerHTML = key === sortKey ? lucideIcon(sortDir === 'asc' ? 'chevron-up' : 'chevron-down') : '';
      });
    };

    const renderActive = (rows: OpenTarget[]) => {
      if (!rows.length) {
        activeBody.innerHTML = `<tr><td colspan="10" class="text-muted">No open positions.</td></tr>`;
        activeCountEl.textContent = `0 holdings`;
        return;
      }
      const sorted = [...rows].sort((a, b) => {
        if (sortKey === 'symbol') {
          const nameCompare = a.symbol.localeCompare(b.symbol);
          return sortDir === 'asc' ? nameCompare : -nameCompare;
        }
        const aValue = getSortValue(a, sortKey);
        const bValue = getSortValue(b, sortKey);
        return sortDir === 'asc' ? aValue - bValue : bValue - aValue;
      });
      updateSortIndicators();
      activeBody.innerHTML = sorted
        .map((row) => {
          const progress = Math.max(0, Math.min(row.progress, 1));
          const pctValue = getProgressPct(row);
          const pctValueSafe = pctValue ?? 0;
          const changePct = getChangePct(row);
          const ready = row.ltp !== null && row.ltp >= row.targetPrice;
          const statusClass = ready
            ? 'target-status ready'
            : pctValueSafe < 0
              ? 'target-status loss'
              : 'target-status';
          const progressClass = ready
            ? 'bg-success'
            : pctValueSafe < 0
              ? 'bg-danger'
              : pctValueSafe >= 70
                ? 'bg-warning'
                : 'bg-info';
          const diffLabel =
            row.ltp === null
              ? 'No price'
              : ready
                ? 'Target met'
                : `${formatMoney(Math.max(row.diff, 0))} to target`;
          const expectedProfit = (row.targetPrice - row.avgBuy) * row.qty;
          return `
            <tr>
              <td class="fw-semibold" data-label="Symbol" data-role="summary" data-summary="ticker">${row.symbol}</td>
              <td class="text-end" data-label="Qty" data-role="detail">${row.qty}</td>
              <td class="text-end" data-label="Avg Buy" data-role="detail">${formatMoney(row.avgBuy)}</td>
              <td class="text-end" data-label="LTP" data-role="summary" data-summary="ltp">${row.ltp ? formatMoney(row.ltp) : '--'}</td>
              <td class="text-end ${changePct !== null && changePct >= 0 ? 'text-success' : 'text-danger'}" data-label="Chg %" data-role="summary" data-summary="chg">
                ${changePct === null ? '--' : formatPct(changePct)}
              </td>
              <td class="text-end" data-label="Target" data-role="detail">${formatMoney(row.targetPrice)}</td>
              <td data-label="Progress" data-role="detail">
                <div class="progress target-progress">
                  <div class="progress-bar ${progressClass}" style="width:${Math.max(progress, 0) * 100}%"></div>
                </div>
                <div class="small text-muted">${diffLabel}</div>
              </td>
              <td data-label="Status" data-role="summary" data-summary="status">
                <span class="${statusClass}">${ready ? 'Ready' : pctValue === null ? '--' : formatPct(pctValue)}</span>
              </td>
              <td class="text-end" data-label="Expected Profit" data-role="detail">${formatMoney(expectedProfit)}</td>
              <td class="text-end" data-label="Breakdown" data-role="action">
                <div class="d-flex flex-column align-items-end gap-1">
                  <button class="btn btn-sm btn-outline-secondary" type="button" data-breakdown="${row.symbol}">
                    ${lucideIcon('list')} View
                  </button>
                  <button class="btn btn-link p-0 text-decoration-none mobile-details-toggle d-md-none" data-action="toggle-details" type="button">
                    Details
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
      activeCountEl.textContent = `${rows.length} holdings`;
    };

    const renderReadyListLegacy = (rows: OpenTarget[]) => {
      if (!rows.length) {
        readyList.innerHTML = `<div class="text-muted small">No targets met yet.</div>`;
        return;
      }
      readyList.innerHTML = rows
        .map((row) => {
          const changePct = getChangePct(row);
          return `
            <div class="target-item">
              <div>
                <div class="fw-semibold">${row.symbol}</div>
                <div class="text-muted small">${row.qty} qty • Target ${formatMoney(row.targetPrice)}</div>
              </div>
              <div class="text-end">
                <div class="text-success fw-semibold">${row.ltp ? formatMoney(row.ltp) : '--'}</div>
                <div class="text-muted small">${changePct === null ? '--' : formatPct(changePct)}</div>
              </div>
            </div>
          `;
        })
        .join('');
    };

    void renderReadyListLegacy;

    const openModal = () => {
      breakdownModal.classList.add('show');
      breakdownModal.setAttribute('aria-hidden', 'false');
    };

    const closeModal = () => {
      breakdownModal.classList.remove('show');
      breakdownModal.setAttribute('aria-hidden', 'true');
    };

    const renderBreakdown = (symbol: string) => {
      const rows = breakdownBySymbol.get(symbol) || [];
      breakdownSubtitle.textContent = `${symbol} split-up targets (${rows.length} lots)`;
      if (!rows.length) {
        breakdownBody.innerHTML = `<tr><td colspan="6" class="text-muted">No open lots found.</td></tr>`;
        return;
      }
      breakdownBody.innerHTML = rows
        .map((row) => {
          const progressLabel = row.progress === null ? '--' : formatPct(row.progress);
          const progressClass = row.progress !== null && row.progress >= 100 ? 'text-success' : 'text-muted';
          const expectedProfit =
            row.price > 0 ? (row.targetPrice - row.price) * row.qty : 0;
          return `
            <tr>
              <td>${row.qty}</td>
              <td class="text-end">${formatMoney(row.price)}</td>
              <td class="text-end">${formatMoney(row.targetPrice)}</td>
              <td class="text-end">${row.ltp ? formatMoney(row.ltp) : '--'}</td>
              <td class="text-end ${progressClass}">${progressLabel}</td>
              <td class="text-end">${formatMoney(expectedProfit)}</td>
              <td class="text-end">${formatDate(row.date || '')}</td>
            </tr>
          `;
        })
        .join('');
    };

    sortButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.sort as SortKey | undefined;
        if (!key) return;
        if (sortKey === key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = key;
          sortDir = key === 'symbol' ? 'asc' : 'desc';
        }
        renderActive(currentOpenTargets);
      });
    });

    activeBody.addEventListener('click', (event) => {
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
      const button = target.closest<HTMLButtonElement>('[data-breakdown]');
      if (!button) return;
      const symbol = button.dataset.breakdown;
      if (!symbol) return;
      renderBreakdown(symbol);
      openModal();
    });

    const bindPagination = (
      paginationEl: HTMLElement,
      setPage: (value: number) => void,
      renderFn: () => void
    ) => {
      paginationEl.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>('[data-page]');
        if (!button) return;
        const nextPage = Number(button.dataset.page);
        if (!Number.isFinite(nextPage) || nextPage < 1) return;
        setPage(nextPage);
        renderFn();
      });
    };

    bindPagination(readyPagination, (value) => (readyPage = value), () =>
      renderReadyList(currentReady)
    );
    bindPagination(completedPagination, (value) => (completedPage = value), () =>
      renderList(completedList, completedPagination, currentCompleted, 'No completed exits yet.', completedPage)
    );
    bindPagination(earlyPagination, (value) => (earlyPage = value), () =>
      renderList(earlyList, earlyPagination, currentEarly, 'No early exits yet.', earlyPage)
    );
    bindPagination(lossPagination, (value) => (lossPage = value), () =>
      renderList(lossList, lossPagination, currentLoss, 'No losses booked yet.', lossPage)
    );

    breakdownModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'modal') {
        closeModal();
      }
    });

    const refresh = async () => {
      const [tradeRows, priceRows, settings] = await Promise.all([
        listTrades(session.userId),
        listLivePrices(),
        getUserSettings(session.userId)
      ]);
      const targetPct = settings.targetProfitPct > 0 ? settings.targetProfitPct : 10;
      targetProfitPctEl.textContent = formatPct(targetPct);

      const priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, Number(row.price)] : null;
          })
          .filter((row): row is [string, number] => Boolean(row))
      );

      const { openTargets, completed, earlyExit, loss } = buildTargets(tradeRows, targetPct, priceMap);
      currentOpenTargets = openTargets;
      currentReady = openTargets.filter((row) => row.ltp !== null && row.ltp >= row.targetPrice);
      currentCompleted = completed;
      currentEarly = earlyExit;
      currentLoss = loss;
      breakdownBySymbol = new Map(
        openTargets.map((row) => [row.symbol, buildBreakdown(row.symbol, tradeRows, targetPct, priceMap)])
      );
      const ready = currentReady;
      const avgProgress =
        openTargets.length > 0
          ? openTargets.reduce((sum, row) => sum + Math.max(0, Math.min(row.progress, 1)), 0) / openTargets.length
          : 0;
      const totalInvested = openTargets.reduce((sum, row) => sum + row.avgBuy * row.qty, 0);
      const currentValue = openTargets.reduce(
        (sum, row) => sum + (row.ltp ?? row.avgBuy) * row.qty,
        0
      );
      const targetValue = openTargets.reduce((sum, row) => sum + row.targetPrice * row.qty, 0);
      const expectedProfit = targetValue - totalInvested;
      const expectedPct = totalInvested > 0 ? (expectedProfit / totalInvested) * 100 : 0;

      openCountEl.textContent = String(openTargets.length);
      readyCountEl.textContent = String(ready.length);
      progressAvgEl.textContent = formatPct(avgProgress * 100);
      readyBadge.textContent = `${ready.length} ready`;
      totalInvestedEl.textContent = formatMoney(totalInvested);
      currentValueEl.textContent = formatMoney(currentValue);
      expectedProfitEl.textContent = formatMoney(expectedProfit);
      expectedPctEl.textContent = `${formatPct(expectedPct)} expected return`;

      readyPage = 1;
      completedPage = 1;
      earlyPage = 1;
      lossPage = 1;

      renderActive(openTargets);
      renderReadyList(ready);
      renderList(completedList, completedPagination, completed, 'No completed exits yet.', completedPage);
      renderList(earlyList, earlyPagination, earlyExit, 'No early exits yet.', earlyPage);
      renderList(lossList, lossPagination, loss, 'No losses booked yet.', lossPage);
    };

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refreshLivePricesNow(session);
        await refresh();
        showAlert(feedback, 'success', 'Target planner refreshed.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    await refresh();
  })();
}

