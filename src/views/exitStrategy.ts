import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, flashInline, setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { renderConfirmModal, bindConfirmModal } from '../ui/confirm';
import { listTrades } from '../storage/trades';
import { listLivePrices } from '../storage/prices';
import { getUserSettings } from '../storage/settings';
import {
  addExitStrategy,
  deleteExitStrategy,
  listExitStrategies,
  updateExitStrategy
} from '../storage/exitStrategies';
import { initCloudSync, queueSnapshot, syncNow } from '../services/cloudSync';
import { requireSession } from './guards';
import type {
  ExitStrategyEntryLeg,
  ExitStrategyMode,
  ExitStrategyScenario,
  ExitStrategySourceLeg,
  TradeRecord,
  UserSettings
} from '../core/types';
import { coerceNumber, formatDate, formatMoney, formatPct } from '../utils/format';
import { toErrorMessage } from '../utils/errors';
import { normalizeSymbol } from '../utils/symbols';
import { mergeImportedTrades, type MergedTrade } from '../utils/mergedTrades';

type SourceSnapshot = {
  avgCost: number | null;
  realizedLoss: number;
  realizedPnl: number;
  holdDays: number | null;
};

type ScenarioDraft = {
  id?: string;
  mode: ExitStrategyMode;
  name: string;
  notes: string;
  status: 'ACTIVE' | 'CLOSED';
  sourceLegs: ExitStrategySourceLeg[];
  entryLegs: ExitStrategyEntryLeg[];
  createdAt?: string;
  closedAt?: string | null;
};

type StrategyMetrics = {
  valid: boolean;
  issues: string[];
  entrySymbol: string | null;
  sourceLossAmount: number;
  sourceRecoveredTarget: number;
  entryQty: number;
  entryGross: number;
  entryBuyCharges: number;
  entryNetCost: number;
  targetProfitAmount: number;
  futureDeliveryCharge: number;
  futureSellRatePct: number;
  breakEvenExitPrice: number | null;
  recoverLossExitPrice: number | null;
  targetExitPrice: number | null;
  estimatedNetPnlAtCurrent: number | null;
  estimatedOverallAtCurrent: number | null;
  currentLtp: number | null;
  priceGapToTarget: number | null;
  priceGapPctToTarget: number | null;
};

type StrategySummary = ExitStrategyScenario & {
  label: string;
  metrics: StrategyMetrics;
};

type QuickSuggestion = {
  id: string;
  mode: ExitStrategyMode;
  title: string;
  subtitle: string;
  sourceTradeIds: string[];
  entryTradeIds: string[];
};

const modeOptions: Array<{ value: ExitStrategyMode; label: string; subtitle: string }> = [
  { value: 'REENTRY', label: 'Re-entry', subtitle: 'Sell at loss, buy the same stock lower, and plan the new exit.' },
  { value: 'SWAP', label: 'Stock Swap', subtitle: 'Sell a loser, rotate into another stock, and recover through that exit.' },
  { value: 'INTRADAY', label: 'Intraday', subtitle: 'Plan the exact same-day exit needed to hit your target net profit.' }
];

const modeLabel = (mode: ExitStrategyMode): string =>
  modeOptions.find((option) => option.value === mode)?.label || mode;

const sortTrades = (trades: TradeRecord[]): TradeRecord[] =>
  [...trades].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
    return a.createdAt.localeCompare(b.createdAt);
  });

const createDraft = (mode: ExitStrategyMode = 'REENTRY'): ScenarioDraft => ({
  mode,
  name: '',
  notes: '',
  status: 'ACTIVE',
  sourceLegs: [],
  entryLegs: [],
  closedAt: null
});

function computeSellSnapshot(trade: TradeRecord, trades: TradeRecord[]): SourceSnapshot {
  if (trade.side !== 'SELL') {
    return { avgCost: null, realizedLoss: 0, realizedPnl: 0, holdDays: null };
  }
  const symbol = normalizeSymbol(trade.symbol);
  if (!symbol) {
    return { avgCost: null, realizedLoss: 0, realizedPnl: 0, holdDays: null };
  }
  const relevant = sortTrades(trades).filter((item) => normalizeSymbol(item.symbol) === symbol);
  const lots: Array<{ qty: number; price: number; date: string | null }> = [];

  const consumeLots = (remaining: number) => {
    for (let i = 0; i < lots.length && remaining > 0; i += 1) {
      const lot = lots[i];
      if (lot.qty > remaining) {
        lot.qty -= remaining;
        remaining = 0;
      } else {
        remaining -= lot.qty;
        lots.splice(i, 1);
        i -= 1;
      }
    }
  };

  for (const item of relevant) {
    if (item.id === trade.id) {
      const totalQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
      const totalCost = lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
      const avgCost = totalQty > 0 ? totalCost / totalQty : null;
      const realizedPnl = avgCost !== null ? (Number(trade.price) - avgCost) * Number(trade.quantity) : 0;
      const realizedLoss = Math.max(0, -realizedPnl);
      let holdDays: number | null = null;
      if (lots.length && trade.tradeDate) {
        const start = lots[0].date ? new Date(lots[0].date) : null;
        const end = new Date(trade.tradeDate);
        if (start && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          holdDays = Math.max(0, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
        }
      }
      return { avgCost, realizedLoss, realizedPnl, holdDays };
    }
    if (item.side === 'BUY') {
      lots.push({ qty: item.quantity, price: item.price, date: item.tradeDate || null });
    } else if (item.side === 'SELL') {
      consumeLots(item.quantity);
    }
  }

  return { avgCost: null, realizedLoss: 0, realizedPnl: 0, holdDays: null };
}

function sourceLegFromMergedTrade(mergedTrade: MergedTrade, trades: TradeRecord[]): ExitStrategySourceLeg {
  const snapshots = mergedTrade.trades.map((trade) => ({ trade, snapshot: computeSellSnapshot(trade, trades) }));
  const quantity = mergedTrade.trades.reduce((sum, trade) => sum + trade.quantity, 0);
  const weightedSell = mergedTrade.trades.reduce((sum, trade) => sum + trade.quantity * trade.price, 0);
  const weightedCost = snapshots.reduce(
    (sum, item) => sum + item.trade.quantity * (item.snapshot.avgCost ?? item.trade.price),
    0
  );
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tradeId: mergedTrade.id,
    symbol: normalizeSymbol(mergedTrade.symbol),
    quantity,
    sellPrice: quantity > 0 ? weightedSell / quantity : mergedTrade.price,
    avgCost: quantity > 0 ? weightedCost / quantity : mergedTrade.price,
    realizedLoss: snapshots.reduce((sum, item) => sum + item.snapshot.realizedLoss, 0),
    tradeDate: mergedTrade.tradeDate,
    createdAt: now,
    updatedAt: now
  };
}

function entryLegFromMergedTrade(mergedTrade: MergedTrade): ExitStrategyEntryLeg {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tradeId: mergedTrade.id,
    symbol: normalizeSymbol(mergedTrade.symbol),
    quantity: mergedTrade.quantity,
    buyPrice: mergedTrade.price,
    tradeDate: mergedTrade.tradeDate,
    createdAt: now,
    updatedAt: now
  };
}

function buildQuickSuggestions(trades: TradeRecord[]): QuickSuggestion[] {
  const mergedTrades = mergeImportedTrades(trades).sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
    return a.createdAt.localeCompare(b.createdAt);
  });
  const buyTrades = mergedTrades.filter((trade) => trade.side === 'BUY');
  const sellTrades = mergedTrades.filter((trade) => trade.side === 'SELL');
  const suggestions: QuickSuggestion[] = [];
  const seen = new Set<string>();

  for (const sell of [...sellTrades].reverse()) {
    const sameDayBuys = buyTrades.filter(
      (buy) =>
        buy.tradeDate === sell.tradeDate &&
        normalizeSymbol(buy.symbol) === normalizeSymbol(sell.symbol)
    );
    if (sameDayBuys.length) {
      const key = `intraday:${sell.tradeDate}:${normalizeSymbol(sell.symbol)}`;
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          id: key,
          mode: 'INTRADAY',
          title: `${normalizeSymbol(sell.symbol)} intraday setup`,
          subtitle: `${formatDate(sell.tradeDate)} • same-day buy/sell pattern`,
          sourceTradeIds: [],
          entryTradeIds: sameDayBuys.map((trade) => trade.id)
        });
      }
    }

    const reentryBuy = buyTrades.find(
      (buy) =>
        normalizeSymbol(buy.symbol) === normalizeSymbol(sell.symbol) &&
        buy.tradeDate >= sell.tradeDate &&
        new Date(buy.tradeDate).getTime() - new Date(sell.tradeDate).getTime() <= 7 * 24 * 60 * 60 * 1000
    );
    if (reentryBuy) {
      const key = `reentry:${sell.id}:${reentryBuy.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          id: key,
          mode: 'REENTRY',
          title: `${normalizeSymbol(sell.symbol)} re-entry`,
          subtitle: `${formatDate(sell.tradeDate)} -> ${formatDate(reentryBuy.tradeDate)}`,
          sourceTradeIds: [sell.id],
          entryTradeIds: [reentryBuy.id]
        });
      }
    }

    const swapBuy = buyTrades.find(
      (buy) =>
        normalizeSymbol(buy.symbol) !== normalizeSymbol(sell.symbol) &&
        buy.tradeDate >= sell.tradeDate &&
        new Date(buy.tradeDate).getTime() - new Date(sell.tradeDate).getTime() <= 24 * 60 * 60 * 1000
    );
    if (swapBuy) {
      const key = `swap:${sell.id}:${swapBuy.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          id: key,
          mode: 'SWAP',
          title: `${normalizeSymbol(sell.symbol)} -> ${normalizeSymbol(swapBuy.symbol)}`,
          subtitle: `${formatDate(sell.tradeDate)} rotation idea`,
          sourceTradeIds: [sell.id],
          entryTradeIds: [swapBuy.id]
        });
      }
    }
  }

  return suggestions.slice(-8).reverse();
}

function computeScenarioMetrics(
  scenario: Pick<ExitStrategyScenario, 'mode' | 'sourceLegs' | 'entryLegs'>,
  settings: UserSettings,
  priceMap: Map<string, number>
): StrategyMetrics {
  const issues: string[] = [];
  const entryQty = scenario.entryLegs.reduce((sum, leg) => sum + Number(leg.quantity || 0), 0);
  const entryGross = scenario.entryLegs.reduce(
    (sum, leg) => sum + Number(leg.quantity || 0) * Number(leg.buyPrice || 0),
    0
  );
  const entrySymbols = Array.from(
    new Set(scenario.entryLegs.map((leg) => normalizeSymbol(leg.symbol)).filter(Boolean))
  );
  const entrySymbol = entrySymbols.length === 1 ? entrySymbols[0] : null;
  const sourceLossAmount = scenario.sourceLegs.reduce((sum, leg) => sum + Number(leg.realizedLoss || 0), 0);
  const futureSellRatePct = Math.max(0, Number(settings.sellBrokeragePct || 0));
  const futureSellRate = futureSellRatePct / 100;
  const entryBuyCharges = entryGross * (Math.max(0, Number(settings.buyBrokeragePct || 0)) / 100);
  const entryNetCost = entryGross + entryBuyCharges;
  const targetProfitAmount = entryNetCost * (Math.max(0, Number(settings.targetProfitPct || 0)) / 100);
  const futureDeliveryCharge = scenario.mode === 'INTRADAY' ? 0 : Math.max(0, Number(settings.dpCharge || 0));
  const sourceRecoveredTarget = sourceLossAmount + targetProfitAmount;
  const denominator = entryQty > 0 ? entryQty * Math.max(0.0001, 1 - futureSellRate) : 0;

  if (!scenario.entryLegs.length) issues.push('Add at least one entry leg.');
  if (!entrySymbol) issues.push('Use one target symbol across entry legs.');
  if (entryQty <= 0) issues.push('Entry quantity must be greater than zero.');
  if (entryGross <= 0) issues.push('Entry buy price must be greater than zero.');
  if (scenario.mode !== 'INTRADAY' && !scenario.sourceLegs.length) {
    issues.push('Add at least one source loss leg.');
  }

  const breakEvenExitPrice =
    denominator > 0 ? (entryNetCost + futureDeliveryCharge) / denominator : null;
  const recoverLossExitPrice =
    denominator > 0 ? (entryNetCost + futureDeliveryCharge + sourceLossAmount) / denominator : null;
  const targetExitPrice =
    denominator > 0 ? (entryNetCost + futureDeliveryCharge + sourceRecoveredTarget) / denominator : null;
  const currentLtp = entrySymbol ? priceMap.get(entrySymbol) ?? null : null;

  let estimatedNetPnlAtCurrent: number | null = null;
  let estimatedOverallAtCurrent: number | null = null;
  let priceGapToTarget: number | null = null;
  let priceGapPctToTarget: number | null = null;
  if (currentLtp !== null) {
    const netExitNow = entryQty * currentLtp * (1 - futureSellRate) - futureDeliveryCharge;
    estimatedNetPnlAtCurrent = netExitNow - entryNetCost;
    estimatedOverallAtCurrent = estimatedNetPnlAtCurrent - sourceLossAmount;
    if (targetExitPrice !== null) {
      priceGapToTarget = targetExitPrice - currentLtp;
      priceGapPctToTarget = currentLtp > 0 ? (priceGapToTarget / currentLtp) * 100 : null;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    entrySymbol,
    sourceLossAmount,
    sourceRecoveredTarget,
    entryQty,
    entryGross,
    entryBuyCharges,
    entryNetCost,
    targetProfitAmount,
    futureDeliveryCharge,
    futureSellRatePct,
    breakEvenExitPrice,
    recoverLossExitPrice,
    targetExitPrice,
    estimatedNetPnlAtCurrent,
    estimatedOverallAtCurrent,
    currentLtp,
    priceGapToTarget,
    priceGapPctToTarget
  };
}

function getScenarioLabel(scenario: Pick<ExitStrategyScenario, 'name' | 'mode' | 'entryLegs' | 'sourceLegs'>): string {
  const trimmed = String(scenario.name || '').trim();
  if (trimmed) return trimmed;
  const entrySymbol = normalizeSymbol(scenario.entryLegs[0]?.symbol || '');
  const sourceSymbols = Array.from(
    new Set(scenario.sourceLegs.map((leg) => normalizeSymbol(leg.symbol)).filter(Boolean))
  );
  if (scenario.mode === 'INTRADAY') return entrySymbol ? `${entrySymbol} Intraday` : 'Intraday Strategy';
  if (scenario.mode === 'REENTRY') return entrySymbol ? `${entrySymbol} Re-entry` : 'Re-entry Strategy';
  if (sourceSymbols.length && entrySymbol) return `${sourceSymbols[0]} -> ${entrySymbol}`;
  return `${modeLabel(scenario.mode)} Strategy`;
}

function renderModeBadge(mode: ExitStrategyMode): string {
  const badge =
    mode === 'REENTRY' ? 'text-bg-primary' : mode === 'SWAP' ? 'text-bg-warning' : 'text-bg-info';
  return `<span class="badge ${badge}">${modeLabel(mode)}</span>`;
}

function renderMetric(value: number | null): string {
  return value === null ? '--' : formatMoney(value);
}

export function renderExitStrategyView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading exit strategy...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'exit-strategy',
      title: 'Exit Strategy',
      subtitle: 'Plan the exact exit needed for re-entry, stock swap, and intraday setups.',
      content: `
        <div class="exit-strategy-page">
          <div id="exit-strategy-feedback" class="alert d-none" role="alert"></div>

        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <div>
            <h2 class="h5 mb-1 section-title">
              <span class="section-icon">${lucideIcon('crosshair')}</span>
              Target Exit Planner
            </h2>
            <div class="text-muted small">Model recovery, re-entry, and intraday exits with one clean target view.</div>
          </div>
          <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-outline-secondary" id="exit-sync">${lucideIcon('refresh-ccw')} Sync</button>
            <button class="btn btn-primary" id="exit-new">${lucideIcon('plus')} New Scenario</button>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-md-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small">Saved Scenarios</div>
                <div class="h4 mb-0" id="exit-kpi-total">0</div>
              </div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small">Active Scenarios</div>
                <div class="h4 mb-0" id="exit-kpi-active">0</div>
              </div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small">Target Exit Profit</div>
                <div class="h4 mb-0" id="exit-kpi-target">--</div>
              </div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small">Recent Suggestions</div>
                <div class="h4 mb-0" id="exit-kpi-suggestions">0</div>
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3">
          <div class="col-xl-4">
            <div class="card shadow-sm border-0 mb-3">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('sparkles')}</span>
                    Recent Suggestions
                  </h3>
                  <div class="text-muted small" id="exit-suggestion-count">0 ideas</div>
                </div>
                <div id="exit-suggestions" class="d-flex flex-column gap-2"></div>
              </div>
            </div>

            <div class="card shadow-sm border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('bookmark')}</span>
                    Saved Strategies
                  </h3>
                  <div class="text-muted small" id="exit-scenario-count">0 scenarios</div>
                </div>
                <div id="exit-scenarios" class="d-flex flex-column gap-2"></div>
              </div>
            </div>
          </div>

          <div class="col-xl-8">
            <div class="card shadow-sm border-0 mb-3">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center gap-2 mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('sliders-horizontal')}</span>
                    Scenario Builder
                  </h3>
                  <div class="text-muted small" id="exit-builder-state">New scenario</div>
                </div>

                <div class="row g-3 mb-3">
                  <div class="col-md-4">
                    <label class="form-label">Mode</label>
                    <select class="form-select" id="exit-mode">
                      ${modeOptions
                        .map((option) => `<option value="${option.value}">${option.label}</option>`)
                        .join('')}
                    </select>
                    <div class="form-text text-muted" id="exit-mode-help"></div>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Scenario Name</label>
                    <input class="form-control" id="exit-name" placeholder="e.g. INFY recovery plan" />
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Notes</label>
                    <input class="form-control" id="exit-notes" placeholder="Why this setup?" />
                  </div>
                </div>

                <div class="row g-3">
                  <div class="col-lg-6">
                    <div class="border rounded-3 p-3 h-100">
                      <div class="d-flex justify-content-between align-items-center mb-2">
                        <div class="fw-semibold">Source Loss Legs</div>
                        <span class="badge text-bg-light border" id="exit-source-total">--</span>
                      </div>
                      <div class="d-flex flex-wrap gap-2 mb-2 exit-leg-actions">
                        <select class="form-select form-select-sm w-auto" id="exit-source-trade">
                          <option value="">Add loss sell trade...</option>
                        </select>
                        <button class="btn btn-sm btn-outline-primary" type="button" id="exit-source-add">Add Trade</button>
                        <button class="btn btn-sm btn-outline-secondary" type="button" id="exit-source-manual">Add Manual</button>
                      </div>
                      <div class="table-responsive">
                        <table class="table table-sm align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Symbol</th>
                              <th>Qty</th>
                              <th>Sell</th>
                              <th>Avg Cost</th>
                              <th>Loss</th>
                              <th class="text-end">Action</th>
                            </tr>
                          </thead>
                          <tbody id="exit-source-body"></tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div class="col-lg-6">
                    <div class="border rounded-3 p-3 h-100">
                      <div class="d-flex justify-content-between align-items-center mb-2">
                        <div class="fw-semibold">Entry Legs</div>
                        <span class="badge text-bg-light border" id="exit-entry-total">--</span>
                      </div>
                      <div class="d-flex flex-wrap gap-2 mb-2 exit-leg-actions">
                        <select class="form-select form-select-sm w-auto" id="exit-entry-trade">
                          <option value="">Add buy trade...</option>
                        </select>
                        <button class="btn btn-sm btn-outline-primary" type="button" id="exit-entry-add">Add Trade</button>
                        <button class="btn btn-sm btn-outline-secondary" type="button" id="exit-entry-manual">Add Manual</button>
                      </div>
                      <div class="table-responsive">
                        <table class="table table-sm align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Symbol</th>
                              <th>Qty</th>
                              <th>Buy</th>
                              <th>Date</th>
                              <th class="text-end">Action</th>
                            </tr>
                          </thead>
                          <tbody id="exit-entry-body"></tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="d-flex flex-wrap justify-content-end gap-2 mt-3">
                  <button class="btn btn-outline-secondary" type="button" id="exit-reset">Reset</button>
                  <button class="btn btn-primary" type="button" id="exit-save">Save Scenario</button>
                </div>
              </div>
            </div>

            <div class="card shadow-sm border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center gap-2 mb-3">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('bar-chart-3')}</span>
                    Strategy Output
                  </h3>
                  <div class="text-muted small" id="exit-output-title">Build a scenario to see the target exit.</div>
                </div>
                <div id="exit-output"></div>
              </div>
            </div>
          </div>
        </div>

          ${renderConfirmModal()}
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#exit-strategy-feedback');
    const syncButton = root.querySelector<HTMLButtonElement>('#exit-sync');
    const newButton = root.querySelector<HTMLButtonElement>('#exit-new');
    const kpiTotal = root.querySelector<HTMLElement>('#exit-kpi-total');
    const kpiActive = root.querySelector<HTMLElement>('#exit-kpi-active');
    const kpiTarget = root.querySelector<HTMLElement>('#exit-kpi-target');
    const kpiSuggestions = root.querySelector<HTMLElement>('#exit-kpi-suggestions');
    const suggestionCount = root.querySelector<HTMLElement>('#exit-suggestion-count');
    const suggestionsWrap = root.querySelector<HTMLDivElement>('#exit-suggestions');
    const scenarioCount = root.querySelector<HTMLElement>('#exit-scenario-count');
    const scenariosWrap = root.querySelector<HTMLDivElement>('#exit-scenarios');
    const builderState = root.querySelector<HTMLElement>('#exit-builder-state');
    const modeSelect = root.querySelector<HTMLSelectElement>('#exit-mode');
    const modeHelp = root.querySelector<HTMLElement>('#exit-mode-help');
    const nameInput = root.querySelector<HTMLInputElement>('#exit-name');
    const notesInput = root.querySelector<HTMLInputElement>('#exit-notes');
    const sourceTradeSelect = root.querySelector<HTMLSelectElement>('#exit-source-trade');
    const sourceAdd = root.querySelector<HTMLButtonElement>('#exit-source-add');
    const sourceManual = root.querySelector<HTMLButtonElement>('#exit-source-manual');
    const sourceBody = root.querySelector<HTMLTableSectionElement>('#exit-source-body');
    const sourceTotal = root.querySelector<HTMLElement>('#exit-source-total');
    const entryTradeSelect = root.querySelector<HTMLSelectElement>('#exit-entry-trade');
    const entryAdd = root.querySelector<HTMLButtonElement>('#exit-entry-add');
    const entryManual = root.querySelector<HTMLButtonElement>('#exit-entry-manual');
    const entryBody = root.querySelector<HTMLTableSectionElement>('#exit-entry-body');
    const entryTotal = root.querySelector<HTMLElement>('#exit-entry-total');
    const resetButton = root.querySelector<HTMLButtonElement>('#exit-reset');
    const saveButton = root.querySelector<HTMLButtonElement>('#exit-save');
    const outputTitle = root.querySelector<HTMLElement>('#exit-output-title');
    const output = root.querySelector<HTMLDivElement>('#exit-output');
    const confirmAction = bindConfirmModal(root);

    if (
      !feedback ||
      !syncButton ||
      !newButton ||
      !kpiTotal ||
      !kpiActive ||
      !kpiTarget ||
      !kpiSuggestions ||
      !suggestionCount ||
      !suggestionsWrap ||
      !scenarioCount ||
      !scenariosWrap ||
      !builderState ||
      !modeSelect ||
      !modeHelp ||
      !nameInput ||
      !notesInput ||
      !sourceTradeSelect ||
      !sourceAdd ||
      !sourceManual ||
      !sourceBody ||
      !sourceTotal ||
      !entryTradeSelect ||
      !entryAdd ||
      !entryManual ||
      !entryBody ||
      !entryTotal ||
      !resetButton ||
      !saveButton ||
      !outputTitle ||
      !output
    ) {
      throw new Error('Exit Strategy view failed to initialize');
    }

    let trades: TradeRecord[] = [];
    let scenarios: ExitStrategyScenario[] = [];
    let summaries: StrategySummary[] = [];
    let suggestions: QuickSuggestion[] = [];
    let priceMap = new Map<string, number>();
    let settings = await getUserSettings(session.userId);
    let draft = createDraft();
    let activeScenarioId: string | null = null;

    const queueAndSync = async () => {
      await queueSnapshot(session.userId);
    };

    const setDraft = (next: ScenarioDraft) => {
      draft = next;
      activeScenarioId = next.id || null;
      nameInput.value = next.name;
      notesInput.value = next.notes;
      modeSelect.value = next.mode;
      modeHelp.textContent = modeOptions.find((option) => option.value === next.mode)?.subtitle || '';
      builderState.textContent = next.id ? 'Editing saved scenario' : 'New scenario';
      renderSourceOptions();
      renderEntryOptions();
      renderSourceLegs();
      renderEntryLegs();
      renderOutput();
      renderScenarioList();
    };

    const resetDraft = (mode: ExitStrategyMode = 'REENTRY') => {
      setDraft(createDraft(mode));
    };

    const buildSummaryList = (): StrategySummary[] =>
      scenarios.map((scenario) => ({
        ...scenario,
        label: getScenarioLabel(scenario),
        metrics: computeScenarioMetrics(scenario, settings, priceMap)
      }));

    const renderSuggestionList = () => {
      if (!suggestions.length) {
        suggestionsWrap.innerHTML = '<div class="text-muted small">No recent suggestions yet.</div>';
        suggestionCount.textContent = '0 ideas';
        return;
      }
      suggestionsWrap.innerHTML = suggestions
        .map(
          (suggestion) => `
            <button class="btn btn-light text-start border suggestion-card" type="button" data-suggestion-id="${suggestion.id}">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <div class="fw-semibold">${suggestion.title}</div>
                ${renderModeBadge(suggestion.mode)}
              </div>
              <div class="text-muted small">${suggestion.subtitle}</div>
            </button>
          `
        )
        .join('');
      suggestionCount.textContent = `${suggestions.length} ideas`;
    };

    const renderScenarioList = () => {
      if (!summaries.length) {
        scenariosWrap.innerHTML = '<div class="text-muted small">No saved strategies yet.</div>';
        scenarioCount.textContent = '0 scenarios';
        return;
      }
      scenariosWrap.innerHTML = summaries
        .map((scenario) => {
          const isActive = activeScenarioId === scenario.id;
          const targetExit = renderMetric(scenario.metrics.targetExitPrice);
          const targetGap =
            scenario.metrics.priceGapPctToTarget !== null
              ? formatPct(scenario.metrics.priceGapPctToTarget)
              : '--';
          return `
            <div class="border rounded-3 p-3 ${isActive ? 'scenario-card-active' : ''}">
              <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
                <div class="fw-semibold">${scenario.label}</div>
                ${renderModeBadge(scenario.mode)}
              </div>
              <div class="text-muted small mb-2">Target exit ${targetExit} • Gap ${targetGap}</div>
              <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-sm btn-outline-secondary" type="button" data-action="open-scenario" data-scenario-id="${scenario.id}">View</button>
                <button class="btn btn-sm btn-outline-primary" type="button" data-action="edit-scenario" data-scenario-id="${scenario.id}">Edit</button>
                ${
                  scenario.status === 'ACTIVE'
                    ? `<button class="btn btn-sm btn-outline-success" type="button" data-action="close-scenario" data-scenario-id="${scenario.id}">Close</button>`
                    : ''
                }
                <button class="btn btn-sm btn-outline-danger" type="button" data-action="delete-scenario" data-scenario-id="${scenario.id}">Delete</button>
              </div>
            </div>
          `;
        })
        .join('');
      scenarioCount.textContent = `${summaries.length} scenarios`;
    };

    const renderSourceOptions = () => {
      if (draft.mode === 'INTRADAY') {
        sourceTradeSelect.innerHTML = '<option value="">No source leg needed for intraday</option>';
        sourceTradeSelect.disabled = true;
        sourceAdd.disabled = true;
        sourceManual.disabled = true;
        return;
      }
      sourceTradeSelect.disabled = false;
      sourceAdd.disabled = false;
      sourceManual.disabled = false;
      const usedIds = new Set(draft.sourceLegs.map((leg) => leg.tradeId).filter(Boolean));
      const options = mergeImportedTrades(trades)
        .filter((trade) => trade.side === 'SELL')
        .map((trade) => ({ trade, snapshot: sourceLegFromMergedTrade(trade, trades) }))
        .filter((item) => item.snapshot.realizedLoss > 0)
        .filter((item) => !usedIds.has(item.trade.id))
        .sort((a, b) => {
          if (a.trade.tradeDate !== b.trade.tradeDate) {
            return b.trade.tradeDate.localeCompare(a.trade.tradeDate);
          }
          return b.trade.createdAt.localeCompare(a.trade.createdAt);
        })
        .slice(0, 100)
        .map(
          ({ trade, snapshot }) =>
            `<option value="${trade.id}">${normalizeSymbol(trade.symbol)} • ${trade.quantity} @ ${formatMoney(
              trade.price
            )} • loss ${formatMoney(snapshot.realizedLoss)} • ${formatDate(trade.tradeDate)}</option>`
        )
        .join('');
      sourceTradeSelect.innerHTML = '<option value="">Add loss sell trade...</option>' + options;
    };

    const renderEntryOptions = () => {
      const usedIds = new Set(draft.entryLegs.map((leg) => leg.tradeId).filter(Boolean));
      const sourceSymbols = new Set(draft.sourceLegs.map((leg) => normalizeSymbol(leg.symbol)).filter(Boolean));
      const preferredSymbol =
        draft.mode === 'REENTRY'
          ? draft.sourceLegs[0]?.symbol || ''
          : draft.entryLegs[0]?.symbol || '';
      const options = mergeImportedTrades(trades)
        .filter((trade) => trade.side === 'BUY')
        .filter((trade) => !usedIds.has(trade.id))
        .filter((trade) => {
          const symbol = normalizeSymbol(trade.symbol);
          if (draft.mode === 'REENTRY' && preferredSymbol) return symbol === normalizeSymbol(preferredSymbol);
          if (draft.mode === 'SWAP') return !sourceSymbols.has(symbol);
          return true;
        })
        .sort((a, b) => {
          if (a.tradeDate !== b.tradeDate) return b.tradeDate.localeCompare(a.tradeDate);
          return b.createdAt.localeCompare(a.createdAt);
        })
        .slice(0, 100)
        .map(
          (trade) =>
            `<option value="${trade.id}">${normalizeSymbol(trade.symbol)} • ${trade.quantity} @ ${formatMoney(
              trade.price
            )} • ${formatDate(trade.tradeDate)}</option>`
        )
        .join('');
      entryTradeSelect.innerHTML = '<option value="">Add buy trade...</option>' + options;
    };

    const renderSourceLegs = () => {
      if (draft.mode === 'INTRADAY') {
        sourceBody.innerHTML =
          '<tr><td colspan="6" class="text-muted text-center py-3">Intraday mode does not need source loss legs.</td></tr>';
        sourceTotal.textContent = formatMoney(0);
        return;
      }
      if (!draft.sourceLegs.length) {
        sourceBody.innerHTML =
          '<tr><td colspan="6" class="text-muted text-center py-3">No source loss legs added.</td></tr>';
        sourceTotal.textContent = formatMoney(0);
        return;
      }
      sourceBody.innerHTML = draft.sourceLegs
        .map(
          (leg) => `
            <tr data-source-id="${leg.id}">
              <td><input class="form-control form-control-sm" data-field="symbol" value="${leg.symbol}" /></td>
              <td><input class="form-control form-control-sm" data-field="quantity" type="number" min="1" step="1" value="${leg.quantity}" /></td>
              <td><input class="form-control form-control-sm" data-field="sellPrice" type="number" min="0" step="0.01" value="${leg.sellPrice}" /></td>
              <td><input class="form-control form-control-sm" data-field="avgCost" type="number" min="0" step="0.01" value="${leg.avgCost}" /></td>
              <td class="text-danger">${formatMoney(leg.realizedLoss)}</td>
              <td class="text-end"><button class="btn btn-sm btn-outline-danger" type="button" data-action="remove-source">Remove</button></td>
            </tr>
          `
        )
        .join('');
      sourceTotal.textContent = formatMoney(draft.sourceLegs.reduce((sum, leg) => sum + leg.realizedLoss, 0));
    };

    const renderEntryLegs = () => {
      if (!draft.entryLegs.length) {
        entryBody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No entry legs added.</td></tr>';
        entryTotal.textContent = formatMoney(0);
        return;
      }
      entryBody.innerHTML = draft.entryLegs
        .map(
          (leg) => `
            <tr data-entry-id="${leg.id}">
              <td><input class="form-control form-control-sm" data-field="symbol" value="${leg.symbol}" /></td>
              <td><input class="form-control form-control-sm" data-field="quantity" type="number" min="1" step="1" value="${leg.quantity}" /></td>
              <td><input class="form-control form-control-sm" data-field="buyPrice" type="number" min="0" step="0.01" value="${leg.buyPrice}" /></td>
              <td><input class="form-control form-control-sm" data-field="tradeDate" type="date" value="${leg.tradeDate || ''}" /></td>
              <td class="text-end"><button class="btn btn-sm btn-outline-danger" type="button" data-action="remove-entry">Remove</button></td>
            </tr>
          `
        )
        .join('');
      const total = draft.entryLegs.reduce((sum, leg) => sum + leg.quantity * leg.buyPrice, 0);
      entryTotal.textContent = formatMoney(total);
    };

    const renderOutput = () => {
      const preview: ExitStrategyScenario = {
        id: draft.id || crypto.randomUUID(),
        userId: session.userId,
        mode: draft.mode,
        name: draft.name.trim() || undefined,
        status: draft.status,
        sourceLegs: draft.sourceLegs,
        entryLegs: draft.entryLegs,
        notes: draft.notes.trim() || undefined,
        createdAt: draft.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: draft.closedAt || null
      };
      const metrics = computeScenarioMetrics(preview, settings, priceMap);
      const label = getScenarioLabel(preview);
      outputTitle.textContent = label;

      if (!metrics.valid) {
        output.innerHTML = `
          <div class="border rounded-3 p-3 bg-light">
            <div class="fw-semibold mb-2">Complete the scenario</div>
            <ul class="small mb-0">
              ${metrics.issues.map((issue) => `<li>${issue}</li>`).join('')}
            </ul>
          </div>
        `;
        return;
      }

      const ladderBase = metrics.breakEvenExitPrice || 0;
      const ladderRecover = metrics.recoverLossExitPrice || 0;
      const ladderTarget = metrics.targetExitPrice || 0;
      const ladderCurrent = metrics.currentLtp || 0;
      const ladderMax = Math.max(ladderBase, ladderRecover, ladderTarget, ladderCurrent, 1);
      const ladderWidth = (value: number | null) =>
        value === null ? 0 : Math.max(4, Math.min(100, (value / ladderMax) * 100));
      const currentGapTone =
        metrics.priceGapToTarget === null ? 'text-muted' : metrics.priceGapToTarget <= 0 ? 'text-success' : 'text-danger';
      const overallNow =
        metrics.estimatedOverallAtCurrent === null
          ? '--'
          : metrics.estimatedOverallAtCurrent >= 0
            ? formatMoney(metrics.estimatedOverallAtCurrent)
            : `-${formatMoney(Math.abs(metrics.estimatedOverallAtCurrent))}`;

      output.innerHTML = `
        <div class="row g-3 mb-3">
          <div class="col-md-3">
            <div class="kpi-card h-100">
              <div class="text-muted small">Break-even Exit</div>
              <div class="h5 mb-0">${renderMetric(metrics.breakEvenExitPrice)}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="kpi-card h-100">
              <div class="text-muted small">Recover Loss Exit</div>
              <div class="h5 mb-0">${renderMetric(metrics.recoverLossExitPrice)}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="kpi-card h-100 border-primary">
              <div class="text-muted small">Required Exit Price</div>
              <div class="h5 mb-0">${renderMetric(metrics.targetExitPrice)}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="kpi-card h-100">
              <div class="text-muted small">Current LTP</div>
              <div class="h5 mb-0">${renderMetric(metrics.currentLtp)}</div>
            </div>
          </div>
        </div>

        <div class="border rounded-3 p-3 mb-3">
          <div class="fw-semibold mb-3">Price Ladder</div>
          <div class="exit-ladder">
            <div class="exit-ladder-row">
              <div class="exit-ladder-label">Break-even</div>
              <div class="exit-ladder-bar"><span class="exit-ladder-fill bg-secondary" style="width:${ladderWidth(ladderBase)}%"></span></div>
              <div class="exit-ladder-value">${renderMetric(metrics.breakEvenExitPrice)}</div>
            </div>
            <div class="exit-ladder-row">
              <div class="exit-ladder-label">Recover loss</div>
              <div class="exit-ladder-bar"><span class="exit-ladder-fill bg-warning" style="width:${ladderWidth(ladderRecover)}%"></span></div>
              <div class="exit-ladder-value">${renderMetric(metrics.recoverLossExitPrice)}</div>
            </div>
            <div class="exit-ladder-row">
              <div class="exit-ladder-label">Recover + target</div>
              <div class="exit-ladder-bar"><span class="exit-ladder-fill bg-primary" style="width:${ladderWidth(ladderTarget)}%"></span></div>
              <div class="exit-ladder-value">${renderMetric(metrics.targetExitPrice)}</div>
            </div>
            <div class="exit-ladder-row">
              <div class="exit-ladder-label">Current LTP</div>
              <div class="exit-ladder-bar"><span class="exit-ladder-fill bg-success" style="width:${ladderWidth(ladderCurrent)}%"></span></div>
              <div class="exit-ladder-value">${renderMetric(metrics.currentLtp)}</div>
            </div>
          </div>
        </div>
        <div class="row g-3 mb-3">
          <div class="col-lg-6">
            <div class="border rounded-3 p-3 h-100">
              <div class="fw-semibold mb-2">Breakdown</div>
              <div class="exit-breakdown-row"><span class="text-muted">Entry Symbol</span><span>${metrics.entrySymbol || '--'}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Entry Qty</span><span>${metrics.entryQty}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Entry Gross</span><span>${formatMoney(metrics.entryGross)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Buy Charges</span><span>${formatMoney(metrics.entryBuyCharges)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Net Deployed</span><span>${formatMoney(metrics.entryNetCost)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Source Realized Loss</span><span>${formatMoney(metrics.sourceLossAmount)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Target Profit (${settings.targetProfitPct.toFixed(1)}%)</span><span>${formatMoney(metrics.targetProfitAmount)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Future Sell Brokerage</span><span>${metrics.futureSellRatePct.toFixed(2)}%</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Future Delivery Charge</span><span>${formatMoney(metrics.futureDeliveryCharge)}</span></div>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="border rounded-3 p-3 h-100">
              <div class="fw-semibold mb-2">Live Decision Support</div>
              <div class="exit-breakdown-row"><span class="text-muted">Gap to required exit</span><span class="${currentGapTone}">${renderMetric(metrics.priceGapToTarget)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Gap %</span><span class="${currentGapTone}">${metrics.priceGapPctToTarget === null ? '--' : formatPct(metrics.priceGapPctToTarget)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Net P/L at current LTP</span><span>${renderMetric(metrics.estimatedNetPnlAtCurrent)}</span></div>
              <div class="exit-breakdown-row"><span class="text-muted">Overall after booked loss</span><span>${overallNow}</span></div>
              <div class="mt-3 small text-muted">
                Formula: required exit is calculated net of buy brokerage, future sell brokerage, and delivery charge
                for non-intraday modes.
              </div>
            </div>
          </div>
        </div>

        <div class="row g-3">
          <div class="col-lg-6">
            <div class="border rounded-3 p-3 h-100">
              <div class="fw-semibold mb-2">Source Timeline</div>
              ${
                preview.sourceLegs.length
                  ? preview.sourceLegs
                      .map(
                        (leg) => `
                          <div class="timeline-item">
                            <div class="fw-semibold">${leg.symbol}</div>
                            <div class="text-muted small">${formatDate(leg.tradeDate)} • Sold ${leg.quantity} @ ${formatMoney(leg.sellPrice)}</div>
                            <div class="small text-danger">Booked loss ${formatMoney(leg.realizedLoss)}</div>
                          </div>
                        `
                      )
                      .join('')
                  : '<div class="text-muted small">No source loss leg required in intraday mode.</div>'
              }
            </div>
          </div>
          <div class="col-lg-6">
            <div class="border rounded-3 p-3 h-100">
              <div class="fw-semibold mb-2">Entry Timeline</div>
              ${
                preview.entryLegs.length
                  ? preview.entryLegs
                      .map(
                        (leg) => `
                          <div class="timeline-item">
                            <div class="fw-semibold">${leg.symbol}</div>
                            <div class="text-muted small">${formatDate(leg.tradeDate)} • Bought ${leg.quantity} @ ${formatMoney(leg.buyPrice)}</div>
                            <div class="small text-muted">Capital ${formatMoney(leg.quantity * leg.buyPrice)}</div>
                          </div>
                        `
                      )
                      .join('')
                  : '<div class="text-muted small">No entry legs yet.</div>'
              }
            </div>
          </div>
        </div>
      `;
    };

    const refreshView = () => {
      summaries = buildSummaryList();
      suggestions = buildQuickSuggestions(trades);
      kpiTotal.textContent = String(summaries.length);
      kpiActive.textContent = String(summaries.filter((item) => item.status === 'ACTIVE').length);
      kpiTarget.textContent = `${settings.targetProfitPct.toFixed(1)}%`;
      kpiSuggestions.textContent = String(suggestions.length);
      renderSuggestionList();
      renderScenarioList();
      renderSourceOptions();
      renderEntryOptions();
      renderSourceLegs();
      renderEntryLegs();
      renderOutput();
    };

    const refreshData = async () => {
      const [tradeRows, scenarioRows, livePrices, userSettings] = await Promise.all([
        listTrades(session.userId),
        listExitStrategies(session.userId),
        listLivePrices(),
        getUserSettings(session.userId)
      ]);
      trades = tradeRows;
      scenarios = scenarioRows;
      settings = userSettings;
      priceMap = new Map(
        livePrices.map((price) => [normalizeSymbol(price.ticker), coerceNumber(price.price) ?? 0])
      );
      refreshView();
    };

    modeSelect.addEventListener('change', () => {
      draft.mode = modeSelect.value as ExitStrategyMode;
      if (draft.mode === 'INTRADAY') {
        draft.sourceLegs = [];
      }
      modeHelp.textContent = modeOptions.find((option) => option.value === draft.mode)?.subtitle || '';
      renderSourceOptions();
      renderEntryOptions();
      renderSourceLegs();
      renderOutput();
    });

    nameInput.addEventListener('input', () => {
      draft.name = nameInput.value;
      renderOutput();
      renderScenarioList();
    });
    notesInput.addEventListener('input', () => {
      draft.notes = notesInput.value;
    });

    newButton.addEventListener('click', () => resetDraft(draft.mode));
    resetButton.addEventListener('click', () => resetDraft(draft.mode));

    syncButton.addEventListener('click', async () => {
      const label = syncButton.textContent || 'Sync';
      setBusy(syncButton, true, label);
      try {
        await syncNow(session);
        await refreshData();
        showAlert(feedback, 'success', 'Exit Strategy synced.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(syncButton, false, label);
      }
    });

    sourceAdd.addEventListener('click', () => {
      const tradeId = sourceTradeSelect.value;
      if (!tradeId) return;
      const trade = mergeImportedTrades(trades).find((item) => item.id === tradeId);
      if (!trade) return;
      draft.sourceLegs.push(sourceLegFromMergedTrade(trade, trades));
      renderSourceOptions();
      renderEntryOptions();
      renderSourceLegs();
      renderOutput();
    });

    sourceManual.addEventListener('click', () => {
      const now = new Date().toISOString();
      draft.sourceLegs.push({
        id: crypto.randomUUID(),
        symbol: '',
        quantity: 1,
        sellPrice: 0,
        avgCost: 0,
        realizedLoss: 0,
        tradeDate: new Date().toISOString().slice(0, 10),
        createdAt: now,
        updatedAt: now
      });
      renderSourceLegs();
      renderOutput();
    });

    entryAdd.addEventListener('click', () => {
      const tradeId = entryTradeSelect.value;
      if (!tradeId) return;
      const trade = mergeImportedTrades(trades).find((item) => item.id === tradeId);
      if (!trade) return;
      draft.entryLegs.push(entryLegFromMergedTrade(trade));
      renderEntryOptions();
      renderEntryLegs();
      renderOutput();
    });

    entryManual.addEventListener('click', () => {
      const now = new Date().toISOString();
      draft.entryLegs.push({
        id: crypto.randomUUID(),
        symbol: draft.entryLegs[0]?.symbol || draft.sourceLegs[0]?.symbol || '',
        quantity: 1,
        buyPrice: 0,
        tradeDate: new Date().toISOString().slice(0, 10),
        createdAt: now,
        updatedAt: now
      });
      renderEntryLegs();
      renderOutput();
    });

    sourceBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const action = target.closest<HTMLButtonElement>('[data-action="remove-source"]');
      if (!action) return;
      const row = action.closest<HTMLTableRowElement>('tr[data-source-id]');
      if (!row) return;
      const sourceId = row.dataset.sourceId || '';
      draft.sourceLegs = draft.sourceLegs.filter((leg) => leg.id !== sourceId);
      renderSourceOptions();
      renderEntryOptions();
      renderSourceLegs();
      renderOutput();
    });

    sourceBody.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-source-id]');
      if (!row) return;
      const sourceId = row.dataset.sourceId || '';
      const leg = draft.sourceLegs.find((item) => item.id === sourceId);
      if (!leg) return;
      const field = target.dataset.field as 'symbol' | 'quantity' | 'sellPrice' | 'avgCost' | undefined;
      if (!field) return;
      if (field === 'symbol') leg.symbol = normalizeSymbol(target.value);
      if (field === 'quantity') leg.quantity = Number(target.value || 0);
      if (field === 'sellPrice') leg.sellPrice = Number(target.value || 0);
      if (field === 'avgCost') leg.avgCost = Number(target.value || 0);
      leg.realizedLoss = Math.max(0, (leg.avgCost - leg.sellPrice) * leg.quantity);
      leg.updatedAt = new Date().toISOString();
      renderSourceLegs();
      renderEntryOptions();
      renderOutput();
    });

    entryBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const action = target.closest<HTMLButtonElement>('[data-action="remove-entry"]');
      if (!action) return;
      const row = action.closest<HTMLTableRowElement>('tr[data-entry-id]');
      if (!row) return;
      const entryId = row.dataset.entryId || '';
      draft.entryLegs = draft.entryLegs.filter((leg) => leg.id !== entryId);
      renderEntryOptions();
      renderEntryLegs();
      renderOutput();
    });

    entryBody.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-entry-id]');
      if (!row) return;
      const entryId = row.dataset.entryId || '';
      const leg = draft.entryLegs.find((item) => item.id === entryId);
      if (!leg) return;
      const field = target.dataset.field as 'symbol' | 'quantity' | 'buyPrice' | 'tradeDate' | undefined;
      if (!field) return;
      if (field === 'symbol') leg.symbol = normalizeSymbol(target.value);
      if (field === 'quantity') leg.quantity = Number(target.value || 0);
      if (field === 'buyPrice') leg.buyPrice = Number(target.value || 0);
      if (field === 'tradeDate') leg.tradeDate = target.value;
      leg.updatedAt = new Date().toISOString();
      renderEntryOptions();
      renderEntryLegs();
      renderOutput();
    });

    suggestionsWrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLElement>('[data-suggestion-id]');
      if (!button) return;
      const suggestion = suggestions.find((item) => item.id === button.dataset.suggestionId);
      if (!suggestion) return;
      const mergedTrades = mergeImportedTrades(trades);
      const mergedTradeMap = new Map(mergedTrades.map((trade) => [trade.id, trade]));
      const next = createDraft(suggestion.mode);
      next.sourceLegs = suggestion.sourceTradeIds
        .map((tradeId) => mergedTradeMap.get(tradeId))
        .filter((trade): trade is MergedTrade => Boolean(trade))
        .map((trade) => sourceLegFromMergedTrade(trade, trades));
      next.entryLegs = suggestion.entryTradeIds
        .map((tradeId) => mergedTradeMap.get(tradeId))
        .filter((trade): trade is MergedTrade => Boolean(trade))
        .map((trade) => entryLegFromMergedTrade(trade));
      next.name = suggestion.title;
      setDraft(next);
    });

    scenariosWrap.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLButtonElement>('[data-action]');
      if (!button) return;
      const action = button.dataset.action || '';
      const scenarioId = button.dataset.scenarioId || '';
      const scenario = scenarios.find((item) => item.id === scenarioId);
      if (!scenario) return;

      if (action === 'open-scenario' || action === 'edit-scenario') {
        setDraft({
          id: scenario.id,
          mode: scenario.mode,
          name: scenario.name || '',
          notes: scenario.notes || '',
          status: scenario.status,
          sourceLegs: scenario.sourceLegs.map((leg) => ({ ...leg })),
          entryLegs: scenario.entryLegs.map((leg) => ({ ...leg })),
          createdAt: scenario.createdAt,
          closedAt: scenario.closedAt || null
        });
        return;
      }
      if (action === 'close-scenario') {
        const ok = await confirmAction({
          title: 'Close Exit Strategy',
          message: 'Close this scenario? You can still view it later.',
          confirmLabel: 'Close'
        });
        if (!ok) return;
        await updateExitStrategy(scenario.id, session.userId, {
          status: 'CLOSED',
          closedAt: new Date().toISOString()
        });
        await refreshData();
        await queueAndSync();
        showAlert(feedback, 'success', 'Scenario closed.');
        return;
      }
      if (action === 'delete-scenario') {
        const ok = await confirmAction({
          title: 'Delete Exit Strategy',
          message: 'Delete this scenario? This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger'
        });
        if (!ok) return;
        await deleteExitStrategy(scenario.id, session.userId);
        if (draft.id === scenario.id) {
          resetDraft(draft.mode);
        }
        await refreshData();
        await queueAndSync();
        showAlert(feedback, 'success', 'Scenario deleted.');
      }
    });

    saveButton.addEventListener('click', async () => {
      clearAlert(feedback);
      const scenario: ExitStrategyScenario = {
        id: draft.id || crypto.randomUUID(),
        userId: session.userId,
        mode: draft.mode,
        name: draft.name.trim() || undefined,
        status: draft.status,
        sourceLegs: draft.sourceLegs.map((leg) => ({
          ...leg,
          symbol: normalizeSymbol(leg.symbol),
          updatedAt: new Date().toISOString()
        })),
        entryLegs: draft.entryLegs.map((leg) => ({
          ...leg,
          symbol: normalizeSymbol(leg.symbol),
          updatedAt: new Date().toISOString()
        })),
        notes: draft.notes.trim() || undefined,
        createdAt: draft.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: draft.closedAt || null
      };

      const metrics = computeScenarioMetrics(scenario, settings, priceMap);
      if (!metrics.valid) {
        showAlert(feedback, 'warning', metrics.issues[0] || 'Please complete the scenario.');
        return;
      }

      const label = saveButton.textContent || 'Save Scenario';
      setBusy(saveButton, true, label);
      try {
        if (draft.id) {
          await updateExitStrategy(scenario.id, session.userId, {
            mode: scenario.mode,
            name: scenario.name,
            status: scenario.status,
            sourceLegs: scenario.sourceLegs,
            entryLegs: scenario.entryLegs,
            notes: scenario.notes,
            updatedAt: scenario.updatedAt,
            closedAt: scenario.closedAt
          });
          flashInline(saveButton, 'Updated');
          showAlert(feedback, 'success', 'Exit Strategy updated.');
        } else {
          await addExitStrategy(scenario);
          flashInline(saveButton, 'Saved');
          showAlert(feedback, 'success', 'Exit Strategy saved.');
        }
        await refreshData();
        await queueAndSync();
        setDraft({
          id: scenario.id,
          mode: scenario.mode,
          name: scenario.name || '',
          notes: scenario.notes || '',
          status: scenario.status,
          sourceLegs: scenario.sourceLegs.map((leg) => ({ ...leg })),
          entryLegs: scenario.entryLegs.map((leg) => ({ ...leg })),
          createdAt: scenario.createdAt,
          closedAt: scenario.closedAt || null
        });
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(saveButton, false, label);
      }
    });

    await refreshData();
    resetDraft('REENTRY');
    builderState.textContent = 'New scenario';
    modeHelp.textContent = modeOptions.find((option) => option.value === draft.mode)?.subtitle || '';
    outputTitle.textContent = 'Build a scenario to see the target exit.';
    const firstScenario = summaries[0];
    if (firstScenario) {
      setDraft({
        id: firstScenario.id,
        mode: firstScenario.mode,
        name: firstScenario.name || '',
        notes: firstScenario.notes || '',
        status: firstScenario.status,
        sourceLegs: firstScenario.sourceLegs.map((leg) => ({ ...leg })),
        entryLegs: firstScenario.entryLegs.map((leg) => ({ ...leg })),
        createdAt: firstScenario.createdAt,
        closedAt: firstScenario.closedAt || null
      });
    }
  })();
}
