import { renderShell, bindShell } from '../ui/shell';
import { setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import { initCloudSync, refreshLivePricesNow } from '../services/cloudSync';
import { requireSession } from './guards';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { normalizeSymbol } from '../utils/symbols';
import { formatDateTime, formatMoney, formatPct } from '../utils/format';
import { toErrorMessage } from '../utils/errors';
import { calculateSellOutcome } from '../utils/sellMath';
import type { TradeRecord, UserSettings } from '../core/types';

type SellPlannerHolding = {
  symbol: string;
  qty: number;
  avgBuy: number | null;
  invested: number;
  ltp: number | null;
  currentValue: number | null;
  currentPnl: number | null;
  currentPnlPct: number | null;
  breakEvenSellPrice: number | null;
  targetSellPrice: number | null;
};

type StoredPlan = Record<string, number>;

function getStorageKey(userId: string): string {
  return `finance-app-v4:sell-planner:${userId}`;
}

function loadStoredPlan(userId: string): StoredPlan {
  try {
    const raw = window.localStorage.getItem(getStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).reduce<StoredPlan>((acc, [symbol, value]) => {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) acc[symbol] = num;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function saveStoredPlan(userId: string, plan: StoredPlan): void {
  window.localStorage.setItem(getStorageKey(userId), JSON.stringify(plan));
}

function buildHoldings(trades: TradeRecord[], settings: UserSettings, priceMap: Map<string, number>): SellPlannerHolding[] {
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));
  return symbols
    .map((symbol) => {
      const cycle = computeCurrentCycleState(symbol, trades);
      if (cycle.qty <= 0) return null;
      const ltp = priceMap.get(symbol) ?? null;
      const currentValue = ltp !== null ? cycle.qty * ltp : null;
      const currentPnl = currentValue !== null ? currentValue - cycle.cost : null;
      const currentPnlPct = currentPnl !== null && cycle.cost > 0 ? (currentPnl / cycle.cost) * 100 : null;
      const referenceOutcome = calculateSellOutcome({
        qty: cycle.qty,
        invested: cycle.cost,
        sellPrice: ltp && ltp > 0 ? ltp : cycle.avg || 0,
        settings
      });
      return {
        symbol,
        qty: cycle.qty,
        avgBuy: cycle.avg,
        invested: cycle.cost,
        ltp,
        currentValue,
        currentPnl,
        currentPnlPct,
        breakEvenSellPrice: referenceOutcome?.breakEvenSellPrice ?? null,
        targetSellPrice: referenceOutcome?.targetSellPrice ?? null
      } satisfies SellPlannerHolding;
    })
    .filter((row): row is SellPlannerHolding => Boolean(row))
    .sort((a, b) => (b.currentValue ?? b.invested) - (a.currentValue ?? a.invested));
}

export function renderSellPlannerView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading sell planner...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'sell-planner',
      title: 'Sell Planner',
      subtitle: 'Estimate outcome from your own planned sell prices.',
      content: `
        <div class="sell-planner-page">
          <div id="sell-planner-feedback" class="alert d-none" role="alert"></div>

          <div class="card sell-planner-hero shadow-sm border-0 mb-3">
            <div class="card-body d-flex flex-wrap justify-content-between align-items-center gap-3">
              <div>
                <div class="target-eyebrow">Manual exit view</div>
                <h2 class="h5 mb-1 section-title">
                  <span class="section-icon">${lucideIcon('calculator')}</span>
                  Sell Planner
                </h2>
                <div class="text-muted small">Enter the sell price you have in mind for each holding and see expected profit, return, charges, and totals.</div>
              </div>
              <div class="d-flex flex-wrap gap-2 sell-planner-actions">
                <button class="btn btn-outline-secondary btn-sm" id="sell-planner-sync">${lucideIcon('refresh-ccw')} Sync</button>
                <button class="btn btn-outline-secondary btn-sm" id="sell-planner-fill-ltp">Use LTP for All</button>
                <button class="btn btn-outline-secondary btn-sm" id="sell-planner-fill-target">Use Target for All</button>
                <button class="btn btn-light btn-sm border" id="sell-planner-clear">Clear Prices</button>
              </div>
            </div>
          </div>

          <div class="row g-3 mb-3">
            <div class="col-6 col-lg-3">
              <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label"><span class="label-icon teal">${lucideIcon('layers')}</span> Planned Holdings</div>
                  <div class="h5 mb-0" id="sell-planner-count">--</div>
                  <div class="text-muted small" id="sell-planner-count-meta">Enter a price to include a row</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label"><span class="label-icon amber">${lucideIcon('wallet')}</span> Invested Basis</div>
                  <div class="h5 mb-0" id="sell-planner-invested">--</div>
                  <div class="text-muted small" id="sell-planner-invested-meta">Based on selected holdings only</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label"><span class="label-icon indigo">${lucideIcon('banknote')}</span> Net Proceeds</div>
                  <div class="h5 mb-0" id="sell-planner-net">--</div>
                  <div class="text-muted small" id="sell-planner-charges">Charges --</div>
                </div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div class="card target-kpi target-kpi-card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="text-muted small kpi-label"><span class="label-icon rose">${lucideIcon('sparkles')}</span> Overall P/L</div>
                  <div class="h5 mb-0" id="sell-planner-profit">--</div>
                  <div class="text-muted small" id="sell-planner-return">Return --</div>
                </div>
              </div>
            </div>
          </div>

          <div class="card sell-planner-table-card shadow-sm border-0">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                <div>
                  <div class="target-eyebrow">Planner table</div>
                  <h3 class="h6 mb-0 section-title">Current Holdings with Manual Sell Price</h3>
                  <div class="text-muted small" id="sell-planner-last-refresh">--</div>
                </div>
                <div class="text-muted small">Whole-holding sell only in this version.</div>
              </div>
              <div class="table-responsive">
                <table class="table table-sm target-table align-middle w-100 mobile-stack sell-planner-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="text-end">Qty</th>
                      <th class="text-end">Avg Buy</th>
                      <th class="text-end">LTP</th>
                      <th class="text-end">Planned Sell</th>
                      <th class="text-end">Net Proceeds</th>
                      <th class="text-end">Est. P/L</th>
                      <th class="text-end">Return %</th>
                      <th class="text-end">Quick Fill</th>
                    </tr>
                  </thead>
                  <tbody id="sell-planner-body"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#sell-planner-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#sell-planner-sync');
    const fillLtpButton = root.querySelector<HTMLButtonElement>('#sell-planner-fill-ltp');
    const fillTargetButton = root.querySelector<HTMLButtonElement>('#sell-planner-fill-target');
    const clearButton = root.querySelector<HTMLButtonElement>('#sell-planner-clear');
    const countEl = root.querySelector<HTMLDivElement>('#sell-planner-count');
    const countMetaEl = root.querySelector<HTMLDivElement>('#sell-planner-count-meta');
    const investedEl = root.querySelector<HTMLDivElement>('#sell-planner-invested');
    const investedMetaEl = root.querySelector<HTMLDivElement>('#sell-planner-invested-meta');
    const netEl = root.querySelector<HTMLDivElement>('#sell-planner-net');
    const chargesEl = root.querySelector<HTMLDivElement>('#sell-planner-charges');
    const profitEl = root.querySelector<HTMLDivElement>('#sell-planner-profit');
    const returnEl = root.querySelector<HTMLDivElement>('#sell-planner-return');
    const lastRefreshEl = root.querySelector<HTMLDivElement>('#sell-planner-last-refresh');
    const tableBody = root.querySelector<HTMLTableSectionElement>('#sell-planner-body');

    if (
      !feedback ||
      !syncButton ||
      !fillLtpButton ||
      !fillTargetButton ||
      !clearButton ||
      !countEl ||
      !countMetaEl ||
      !investedEl ||
      !investedMetaEl ||
      !netEl ||
      !chargesEl ||
      !profitEl ||
      !returnEl ||
      !lastRefreshEl ||
      !tableBody
    ) {
      throw new Error('Sell planner view failed to initialize');
    }

    let holdings: SellPlannerHolding[] = [];
    let settings: UserSettings | null = null;
    let plan = loadStoredPlan(session.userId);

    const persistPlan = () => {
      const next: StoredPlan = {};
      holdings.forEach((holding) => {
        const value = Number(plan[holding.symbol] || 0);
        if (Number.isFinite(value) && value > 0) next[holding.symbol] = value;
      });
      plan = next;
      saveStoredPlan(session.userId, plan);
    };

    const renderSummary = () => {
      const rows: Array<{
        holding: SellPlannerHolding;
        outcome: NonNullable<ReturnType<typeof calculateSellOutcome>>;
      }> = [];
      holdings.forEach((holding) => {
        const plannedSellPrice = Number(plan[holding.symbol] || 0);
        if (!(plannedSellPrice > 0) || !settings) return;
        const outcome = calculateSellOutcome({
          qty: holding.qty,
          invested: holding.invested,
          sellPrice: plannedSellPrice,
          settings
        });
        if (outcome) rows.push({ holding, outcome });
      });

      const totalCount = rows.length;
      const invested = rows.reduce((sum, row) => sum + row.outcome.effectiveInvested, 0);
      const net = rows.reduce((sum, row) => sum + row.outcome.netProceeds, 0);
      const charges = rows.reduce((sum, row) => sum + row.outcome.totalCharges, 0);
      const profit = rows.reduce((sum, row) => sum + row.outcome.estimatedProfit, 0);
      const returnPct = invested > 0 ? (profit / invested) * 100 : null;

      countEl.textContent = String(totalCount);
      countMetaEl.textContent = totalCount ? `Using ${totalCount} manual sell price${totalCount > 1 ? 's' : ''}` : 'Enter a price to include a row';
      investedEl.textContent = formatMoney(totalCount ? invested : null);
      investedMetaEl.textContent = totalCount ? `Cost basis after buy charges` : 'Based on selected holdings only';
      netEl.textContent = formatMoney(totalCount ? net : null);
      chargesEl.textContent = `Charges ${formatMoney(totalCount ? charges : null)}`;
      profitEl.textContent = formatMoney(totalCount ? profit : null);
      profitEl.classList.toggle('text-success', totalCount > 0 && profit >= 0);
      profitEl.classList.toggle('text-danger', totalCount > 0 && profit < 0);
      returnEl.textContent = `Return ${formatPct(returnPct)}`;
      returnEl.classList.toggle('text-success', (returnPct ?? 0) >= 0);
      returnEl.classList.toggle('text-danger', (returnPct ?? 0) < 0);
    };

    const renderRows = () => {
      if (!holdings.length) {
        tableBody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">No open holdings found.</td></tr>';
        renderSummary();
        return;
      }

      tableBody.innerHTML = holdings
        .map((holding) => {
          const plannedSellPrice = Number(plan[holding.symbol] || 0);
          const outcome =
            plannedSellPrice > 0 && settings
              ? calculateSellOutcome({
                  qty: holding.qty,
                  invested: holding.invested,
                  sellPrice: plannedSellPrice,
                  settings
                })
              : null;
          const profitClass = !outcome ? 'text-muted' : outcome.estimatedProfit >= 0 ? 'text-success' : 'text-danger';
          const returnClass = !outcome ? 'text-muted' : (outcome.returnPct ?? 0) >= 0 ? 'text-success' : 'text-danger';
          return `
            <tr>
              <td data-label="Symbol" data-role="summary" data-summary="ticker">
                <div class="fw-semibold">${holding.symbol}</div>
              </td>
              <td class="text-end" data-label="Invested" data-role="summary" data-summary="invested">
                ${formatMoney(holding.invested)}
                <div class="text-muted small">Qty ${holding.qty}</div>
              </td>
              <td class="text-end" data-label="Target" data-role="summary" data-summary="target">
                ${formatMoney(holding.targetSellPrice)}
                <div class="text-muted small">LTP ${formatMoney(holding.ltp)}</div>
              </td>
              <td class="text-end" data-label="Avg Buy" data-role="detail">${formatMoney(holding.avgBuy)}</td>
              <td class="text-end" data-label="Planned Sell" data-role="planner-input">
                <input class="form-control form-control-sm sell-planner-input ms-auto" type="number" step="0.01" min="0" placeholder="Sell price" data-role="planned-price" data-symbol="${holding.symbol}" value="${plannedSellPrice > 0 ? plannedSellPrice.toFixed(2) : ''}" />
                <div class="text-muted small mt-1">Break-even ${formatMoney(holding.breakEvenSellPrice)}</div>
              </td>
              <td class="text-end" data-label="Net Proceeds" data-role="detail">
                ${formatMoney(outcome?.netProceeds ?? null)}
                <div class="text-muted small">${outcome ? `Charges ${formatMoney(outcome.totalCharges)}` : 'Enter a price'}</div>
              </td>
              <td class="text-end ${profitClass}" data-label="Est. P/L" data-role="detail">
                ${formatMoney(outcome?.estimatedProfit ?? null)}
                <div class="text-muted small">${holding.currentPnl !== null ? `Current ${formatMoney(holding.currentPnl)}` : 'No live price'}</div>
              </td>
              <td class="text-end ${returnClass}" data-label="Return %" data-role="detail">
                ${formatPct(outcome?.returnPct ?? null)}
                <div class="text-muted small">${holding.currentPnlPct !== null ? `Current ${formatPct(holding.currentPnlPct)}` : '--'}</div>
              </td>
              <td class="text-end" data-label="Quick Fill" data-role="action">
                <div class="d-flex flex-wrap justify-content-end gap-1 sell-planner-row-actions">
                  <button class="btn btn-outline-secondary btn-sm" type="button" data-role="fill-ltp" data-symbol="${holding.symbol}" ${holding.ltp ? '' : 'disabled'}>LTP</button>
                  <button class="btn btn-outline-secondary btn-sm" type="button" data-role="fill-target" data-symbol="${holding.symbol}" ${holding.targetSellPrice ? '' : 'disabled'}>Target</button>
                  <button class="btn btn-light border btn-sm" type="button" data-role="clear-row" data-symbol="${holding.symbol}">Clear</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');

      renderSummary();
    };

    const refreshData = async () => {
      const [trades, priceRows, userSettings] = await Promise.all([
        listTrades(session.userId),
        listLivePrices(),
        getUserSettings(session.userId)
      ]);
      settings = userSettings;
      const priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, Number(row.price || 0)] : null;
          })
          .filter((row): row is [string, number] => Array.isArray(row) && Number.isFinite(row[1]))
      );
      const latestPriceAt = priceRows.reduce<string | null>((latest, row) => {
        if (!row?.fetchedAt) return latest;
        if (!latest) return row.fetchedAt;
        return row.fetchedAt > latest ? row.fetchedAt : latest;
      }, null);
      lastRefreshEl.textContent = `Last refresh: ${formatDateTime(latestPriceAt)}`;
      holdings = buildHoldings(trades, userSettings, priceMap);
      persistPlan();
      renderRows();
    };

    const updatePlanValue = (symbol: string, rawValue: string, rerender = true) => {
      const value = Number(rawValue);
      if (Number.isFinite(value) && value > 0) {
        plan[symbol] = value;
      } else {
        delete plan[symbol];
      }
      persistPlan();
      if (rerender) renderRows();
      else renderSummary();
    };

    const fillRow = (symbol: string, mode: 'ltp' | 'target') => {
      const holding = holdings.find((row) => row.symbol === symbol);
      if (!holding) return;
      const nextValue = mode === 'ltp' ? holding.ltp : holding.targetSellPrice;
      if (!(nextValue && nextValue > 0)) return;
      plan[symbol] = Number(nextValue.toFixed(2));
      persistPlan();
      renderRows();
    };

    const fillAll = (mode: 'ltp' | 'target') => {
      holdings.forEach((holding) => {
        const nextValue = mode === 'ltp' ? holding.ltp : holding.targetSellPrice;
        if (nextValue && nextValue > 0) {
          plan[holding.symbol] = Number(nextValue.toFixed(2));
        }
      });
      persistPlan();
      renderRows();
      showAlert(feedback, 'success', mode === 'ltp' ? 'Filled all holdings with current LTP.' : 'Filled all holdings with target prices.');
    };

    tableBody.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || target.dataset.role !== 'planned-price') return;
      updatePlanValue(String(target.dataset.symbol || ''), target.value, false);
    });

    tableBody.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || target.dataset.role !== 'planned-price') return;
      updatePlanValue(String(target.dataset.symbol || ''), target.value, true);
    });

    tableBody.addEventListener('click', (event) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-role]');
      if (!trigger) return;
      const symbol = String(trigger.dataset.symbol || '');
      const role = String(trigger.dataset.role || '');
      if (role === 'fill-ltp') fillRow(symbol, 'ltp');
      if (role === 'fill-target') fillRow(symbol, 'target');
      if (role === 'clear-row') {
        delete plan[symbol];
        persistPlan();
        renderRows();
      }
    });

    fillLtpButton.addEventListener('click', () => fillAll('ltp'));
    fillTargetButton.addEventListener('click', () => fillAll('target'));
    clearButton.addEventListener('click', () => {
      plan = {};
      persistPlan();
      renderRows();
      showAlert(feedback, 'info', 'Manual sell prices cleared.');
    });

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        const summary = await refreshLivePricesNow(session);
        await refreshData();
        showAlert(
          feedback,
          summary.success > 0 ? 'success' : 'warning',
          summary.requested
            ? `Live prices refreshed (${summary.success}/${summary.requested} updated).`
            : 'No tickers found to refresh.'
        );
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    try {
      await refreshData();
    } catch (error) {
      showAlert(feedback, 'danger', toErrorMessage(error));
    }
  })();
}
