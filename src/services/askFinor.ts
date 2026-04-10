import type { TradeRecord, TransactionRecord, ExitStrategyScenario, UserSettings } from '../core/types';
import { postApi } from './api';
import { listTrades } from '../storage/trades';
import { listTransactions } from '../storage/transactions';
import { listGoals } from '../storage/goals';
import { listExitStrategies } from '../storage/exitStrategies';
import { getUserSettings } from '../storage/settings';
import { listLivePrices } from '../storage/prices';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { compareTradeExecutionAsc } from '../utils/tradeOrdering';
import { normalizeSymbol } from '../utils/symbols';

export type AskFinorMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  responseMs?: number;
};

type HoldingBrief = {
  symbol: string;
  qty: number;
  avgBuy: number | null;
  invested: number;
  effectiveInvested: number;
  ltp: number | null;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number | null;
  allocationPct: number | null;
  holdDays: number | null;
  breakEvenSellPrice: number | null;
  targetSellPrice: number | null;
};

type TradeSymbolSummary = {
  symbol: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  netQty: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
};

export type AskFinorContext = {
  generatedAt: string;
  user: {
    userId: string;
    name: string;
  };
  settings: {
    targetProfitPct: number;
    maxAllocationPct: number;
    totalInvestment: number;
    buyBrokeragePct: number;
    sellBrokeragePct: number;
    dpCharge: number;
  };
  portfolio: {
    holdingsCount: number;
    invested: number;
    currentValue: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number | null;
    readyToExitCount: number;
    highAllocationCount: number;
    topHoldings: HoldingBrief[];
    holdings: HoldingBrief[];
  };
  trades: {
    totalTrades: number;
    buyTrades: number;
    sellTrades: number;
    firstTradeDate: string | null;
    lastTradeDate: string | null;
    recentTrades: Array<{
      date: string;
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      price: number;
      amount: number;
    }>;
    realizedHistory: Array<{
      date: string;
      symbol: string;
      pnl: number;
    }>;
    monthlyActivity: Array<{
      month: string;
      tradeCount: number;
      buyValue: number;
      sellValue: number;
    }>;
    stockSummaries: TradeSymbolSummary[];
    mostTradedSymbols: TradeSymbolSummary[];
  };
  pnl: {
    realizedPnl: number;
    unrealizedPnl: number;
    netPnl: number;
    fees: number;
    topNetWinners: Array<{ symbol: string; netPnl: number }>;
    topNetLosers: Array<{ symbol: string; netPnl: number }>;
  };
  finance: {
    totalTransactions: number;
    income: number;
    expenses: number;
    investments: number;
    borrowed: number;
    lent: number;
    openBorrowed: number;
    openLent: number;
    monthlyFlow: Array<{
      month: string;
      income: number;
      expenses: number;
      investments: number;
    }>;
    topExpenseCategories: Array<{ category: string; amount: number }>;
    topIncomeCategories: Array<{ category: string; amount: number }>;
    thisMonthTopExpenseCategories: Array<{ category: string; amount: number }>;
    thisMonthTopIncomeCategories: Array<{ category: string; amount: number }>;
    monthlyExpenseCategories: Array<{ month: string; categories: Array<{ category: string; amount: number }> }>;
    monthlyIncomeCategories: Array<{ month: string; categories: Array<{ category: string; amount: number }> }>;
    recentTransactions: Array<{
      date: string;
      type: string;
      category: string;
      amount: number;
    }>;
  };
  goals: {
    totalGoals: number;
    activeGoals: number;
    completedGoals: number;
    activeTargetAmount: number;
    items: Array<{
      name: string;
      targetAmount: number;
      targetYear: number;
      targetDate: string | null;
      status: string;
    }>;
  };
  exitStrategies: {
    total: number;
    active: number;
    closed: number;
    byMode: Array<{ mode: string; count: number }>;
    items: Array<{
      name: string;
      mode: string;
      status: string;
      sourceSymbols: string[];
      entrySymbols: string[];
      sourceLoss: number;
      createdAt: string;
    }>;
  };
};

type AskFinorApiResponse = {
  answer: string;
  model?: string;
};

export type AskFinorRateLimitInfo = {
  provider: 'gemini';
  model: string;
  retryAfterSeconds: number | null;
  resetHint: string;
  quotaMetric?: string | null;
  docsUrl?: string | null;
  message: string;
};

export class AskFinorRateLimitError extends Error {
  readonly info: AskFinorRateLimitInfo;

  constructor(info: AskFinorRateLimitInfo) {
    super(info.message);
    this.name = 'AskFinorRateLimitError';
    this.info = info;
  }
}

type AskFinorRequest = {
  userId: string;
  question: string;
  context: AskFinorContext;
  conversation: AskFinorMessage[];
};

type RealizedEntry = {
  date: string;
  symbol: string;
  pnl: number;
};

type Lot = {
  qty: number;
  price: number;
  date: string | null;
};

function toMonthKey(date: string): string {
  return date ? date.slice(0, 7) : 'Unknown';
}

function daysBetween(from: string | null, to: Date): number | null {
  if (!from) return null;
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.floor((to.getTime() - start.getTime()) / 86400000));
}

function sumBy<T>(rows: T[], getter: (row: T) => number): number {
  return rows.reduce((total, row) => total + getter(row), 0);
}

function takeTop<T>(rows: T[], limit: number, sortBy: (row: T) => number): T[] {
  return [...rows].sort((a, b) => sortBy(b) - sortBy(a)).slice(0, limit);
}

function buildRealizedEntries(trades: TradeRecord[]): RealizedEntry[] {
  const sorted = [...trades]
    .filter((trade) => trade.tradeDate && Number.isFinite(trade.quantity) && Number.isFinite(trade.price))
    .sort(compareTradeExecutionAsc);

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

  const groupedByDate = new Map<string, TradeRecord[]>();
  sorted.forEach((trade) => {
    const rows = groupedByDate.get(trade.tradeDate) || [];
    rows.push(trade);
    groupedByDate.set(trade.tradeDate, rows);
  });

  const dates = Array.from(groupedByDate.keys()).sort();
  dates.forEach((date) => {
    const dayTrades = groupedByDate.get(date) || [];
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
      const lots = symbol ? lotsBySymbol.get(symbol) : null;
      if (!symbol || !lots || !lots.length) return;
      let remaining = trade.quantity;
      let cost = 0;
      const sameDay = consumeLots(lots, remaining, (lot) => lot.date === date);
      remaining = sameDay.remaining;
      cost += sameDay.cost;
      if (remaining > 0) {
        const fifo = consumeLots(lots, remaining);
        remaining = fifo.remaining;
        cost += fifo.cost;
      }
      const matchedQty = trade.quantity - remaining;
      if (matchedQty <= 0) return;
      const pnl = matchedQty * trade.price - cost;
      realized.push({ date, symbol, pnl });
    });
  });

  return realized;
}

function calculateFees(trades: TradeRecord[], settings: UserSettings): number {
  const buyRate = settings.buyBrokeragePct || 0;
  const sellRate = settings.sellBrokeragePct || 0;
  const dpCharge = settings.dpCharge || 0;
  let total = 0;
  trades.forEach((trade) => {
    const amount = trade.quantity * trade.price;
    if (trade.side === 'BUY') {
      total += (amount * buyRate) / 100;
    } else {
      total += (amount * sellRate) / 100;
      total += dpCharge;
    }
  });
  return total;
}

function buildTradeSymbolSummary(
  trades: TradeRecord[],
  realizedEntries: RealizedEntry[],
  holdings: HoldingBrief[]
): TradeSymbolSummary[] {
  const realizedMap = new Map<string, number>();
  realizedEntries.forEach((entry) => {
    realizedMap.set(entry.symbol, (realizedMap.get(entry.symbol) || 0) + entry.pnl);
  });

  const holdingMap = new Map(holdings.map((holding) => [holding.symbol, holding]));
  const summaryMap = new Map<string, TradeSymbolSummary>();

  trades.forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    if (!symbol) return;
    const existing =
      summaryMap.get(symbol) || {
        symbol,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        buyQty: 0,
        sellQty: 0,
        buyValue: 0,
        sellValue: 0,
        netQty: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        netPnl: 0
      };
    existing.tradeCount += 1;
    if (trade.side === 'BUY') {
      existing.buyCount += 1;
      existing.buyQty += trade.quantity;
      existing.buyValue += trade.quantity * trade.price;
      existing.netQty += trade.quantity;
    } else {
      existing.sellCount += 1;
      existing.sellQty += trade.quantity;
      existing.sellValue += trade.quantity * trade.price;
      existing.netQty -= trade.quantity;
    }
    summaryMap.set(symbol, existing);
  });

  summaryMap.forEach((entry, symbol) => {
    entry.realizedPnl = realizedMap.get(symbol) || 0;
    entry.unrealizedPnl = holdingMap.get(symbol)?.unrealizedPnl || 0;
    entry.netPnl = entry.realizedPnl + entry.unrealizedPnl;
  });

  return Array.from(summaryMap.values()).sort((a, b) => b.tradeCount - a.tradeCount);
}

function buildHoldings(
  trades: TradeRecord[],
  priceMap: Map<string, number>,
  settings: UserSettings
): HoldingBrief[] {
  const now = new Date();
  const symbols = Array.from(new Set(trades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean)));

  const rows = symbols
    .map((symbol) => {
      const cycle = computeCurrentCycleState(symbol, trades);
      if (cycle.qty <= 0) return null;
      const ltp = priceMap.get(symbol) ?? null;
      const currentValue = ltp !== null ? cycle.qty * ltp : cycle.cost;
      const unrealizedPnl = currentValue - cycle.cost;
      const allocationPct = settings.totalInvestment > 0 ? (currentValue / settings.totalInvestment) * 100 : null;
      const effectiveInvested = cycle.cost * (1 + (settings.buyBrokeragePct || 0) / 100);
      const sellNetFactor = 1 - (settings.sellBrokeragePct || 0) / 100;
      const breakEvenSellPrice =
        cycle.qty > 0 && sellNetFactor > 0 ? (effectiveInvested + (settings.dpCharge || 0)) / (cycle.qty * sellNetFactor) : null;
      const targetSellPrice =
        cycle.qty > 0 && sellNetFactor > 0
          ? (effectiveInvested * (1 + (settings.targetProfitPct || 0) / 100) + (settings.dpCharge || 0)) /
            (cycle.qty * sellNetFactor)
          : null;
      return {
        symbol,
        qty: cycle.qty,
        avgBuy: cycle.avg,
        invested: cycle.cost,
        effectiveInvested,
        ltp,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPct: cycle.cost > 0 ? (unrealizedPnl / cycle.cost) * 100 : null,
        allocationPct,
        holdDays: daysBetween(cycle.startDate, now),
        breakEvenSellPrice,
        targetSellPrice
      } satisfies HoldingBrief;
    })
    .filter((row): row is HoldingBrief => Boolean(row))
    .sort((a, b) => b.currentValue - a.currentValue);

  return rows;
}

function buildMonthlyTradeActivity(trades: TradeRecord[]) {
  const monthMap = new Map<string, { month: string; tradeCount: number; buyValue: number; sellValue: number }>();
  trades.forEach((trade) => {
    const month = toMonthKey(trade.tradeDate);
    const existing = monthMap.get(month) || { month, tradeCount: 0, buyValue: 0, sellValue: 0 };
    existing.tradeCount += 1;
    if (trade.side === 'BUY') existing.buyValue += trade.quantity * trade.price;
    else existing.sellValue += trade.quantity * trade.price;
    monthMap.set(month, existing);
  });
  return Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
}

function buildMonthlyTransactionFlow(transactions: TransactionRecord[]) {
  const monthMap = new Map<string, { month: string; income: number; expenses: number; investments: number }>();
  transactions.forEach((row) => {
    const month = toMonthKey(row.date);
    const existing = monthMap.get(month) || { month, income: 0, expenses: 0, investments: 0 };
    if (row.type === 'INCOME') existing.income += row.amount;
    if (row.type === 'EXPENSE') existing.expenses += row.amount;
    if (row.type === 'INVESTMENT') existing.investments += row.amount;
    monthMap.set(month, existing);
  });
  return Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
}

function buildCategoryTotals(transactions: TransactionRecord[], type: 'INCOME' | 'EXPENSE') {
  const map = new Map<string, number>();
  transactions
    .filter((row) => row.type === type)
    .forEach((row) => {
      const key = String(row.category || 'Other').trim() || 'Other';
      map.set(key, (map.get(key) || 0) + row.amount);
    });
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
}

function buildCategoryTotalsForMonth(transactions: TransactionRecord[], type: 'INCOME' | 'EXPENSE', monthKey: string) {
  const monthRows = transactions.filter((row) => row.type === type && toMonthKey(row.date) === monthKey);
  return buildCategoryTotals(monthRows, type);
}

function buildMonthlyCategoryBuckets(transactions: TransactionRecord[], type: 'INCOME' | 'EXPENSE') {
  const months = Array.from(new Set(transactions.filter((row) => row.type === type).map((row) => toMonthKey(row.date))))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 8);

  return months.map((month) => ({
    month,
    categories: buildCategoryTotalsForMonth(transactions, type, month)
  }));
}

function buildExitStrategySummary(rows: ExitStrategyScenario[]) {
  const byMode = new Map<string, number>();
  rows.forEach((row) => {
    byMode.set(row.mode, (byMode.get(row.mode) || 0) + 1);
  });
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === 'ACTIVE').length,
    closed: rows.filter((row) => row.status === 'CLOSED').length,
    byMode: Array.from(byMode.entries()).map(([mode, count]) => ({ mode, count })),
    items: rows.slice(0, 5).map((row) => ({
      name: row.name || `${row.mode} scenario`,
      mode: row.mode,
      status: row.status,
      sourceSymbols: Array.from(new Set(row.sourceLegs.map((leg) => normalizeSymbol(leg.symbol)).filter(Boolean))),
      entrySymbols: Array.from(new Set(row.entryLegs.map((leg) => normalizeSymbol(leg.symbol)).filter(Boolean))),
      sourceLoss: row.sourceLegs.reduce((total, leg) => total + (Number(leg.realizedLoss) || 0), 0),
      createdAt: row.createdAt
    }))
  };
}

export async function buildAskFinorContext(userId: string, name: string): Promise<AskFinorContext> {
  const [trades, transactions, goals, exitStrategies, settings, prices] = await Promise.all([
    listTrades(userId),
    listTransactions(userId),
    listGoals(userId),
    listExitStrategies(userId),
    getUserSettings(userId),
    listLivePrices()
  ]);

  const priceMap = new Map(
    prices
      .filter((row) => row.ticker && Number.isFinite(Number(row.price)))
      .map((row) => [normalizeSymbol(row.ticker), Number(row.price)])
  );

  const holdings = buildHoldings(trades, priceMap, settings);
  const holdingsInvested = sumBy(holdings, (row) => row.invested);
  const holdingsCurrentValue = sumBy(holdings, (row) => row.currentValue);
  const unrealizedPnl = sumBy(holdings, (row) => row.unrealizedPnl);
  const targetProfitPct = settings.targetProfitPct || 0;
  const highAllocationThreshold = settings.maxAllocationPct || 0;
  const readyToExitCount = holdings.filter((row) => row.avgBuy && row.ltp && row.ltp >= row.avgBuy * (1 + targetProfitPct / 100)).length;
  const highAllocationCount =
    highAllocationThreshold > 0
      ? holdings.filter((row) => (row.allocationPct || 0) >= highAllocationThreshold).length
      : 0;

  const realizedEntries = buildRealizedEntries(trades);
  const realizedPnl = sumBy(realizedEntries, (entry) => entry.pnl);
  const fees = calculateFees(trades, settings);
  const tradeSymbolSummary = buildTradeSymbolSummary(trades, realizedEntries, holdings);
  const topNetWinners = takeTop(
    tradeSymbolSummary.filter((row) => row.netPnl > 0).map((row) => ({ symbol: row.symbol, netPnl: row.netPnl })),
    5,
    (row) => row.netPnl
  );
  const topNetLosers = [...tradeSymbolSummary.filter((row) => row.netPnl < 0)]
    .sort((a, b) => a.netPnl - b.netPnl)
    .slice(0, 5)
    .map((row) => ({ symbol: row.symbol, netPnl: row.netPnl }));
  const currentMonthKey = new Date().toISOString().slice(0, 7);

  return {
    generatedAt: new Date().toISOString(),
    user: {
      userId,
      name
    },
    settings: {
      targetProfitPct: settings.targetProfitPct,
      maxAllocationPct: settings.maxAllocationPct,
      totalInvestment: settings.totalInvestment,
      buyBrokeragePct: settings.buyBrokeragePct,
      sellBrokeragePct: settings.sellBrokeragePct,
      dpCharge: settings.dpCharge
    },
    portfolio: {
      holdingsCount: holdings.length,
      invested: holdingsInvested,
      currentValue: holdingsCurrentValue,
      unrealizedPnl,
      unrealizedPnlPct: holdingsInvested > 0 ? (unrealizedPnl / holdingsInvested) * 100 : null,
      readyToExitCount,
      highAllocationCount,
      topHoldings: holdings.slice(0, 8),
      holdings
    },
    trades: {
      totalTrades: trades.length,
      buyTrades: trades.filter((trade) => trade.side === 'BUY').length,
      sellTrades: trades.filter((trade) => trade.side === 'SELL').length,
      firstTradeDate: trades.length ? trades[trades.length - 1].tradeDate : null,
      lastTradeDate: trades.length ? trades[0].tradeDate : null,
      recentTrades: trades.slice(0, 180).map((trade) => ({
        date: trade.tradeDate,
        symbol: normalizeSymbol(trade.symbol),
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        amount: trade.quantity * trade.price
      })),
      realizedHistory: realizedEntries.slice(-240).map((entry) => ({
        date: entry.date,
        symbol: entry.symbol,
        pnl: entry.pnl
      })),
      monthlyActivity: buildMonthlyTradeActivity(trades),
      stockSummaries: tradeSymbolSummary,
      mostTradedSymbols: tradeSymbolSummary.slice(0, 10)
    },
    pnl: {
      realizedPnl,
      unrealizedPnl,
      netPnl: realizedPnl + unrealizedPnl - fees,
      fees,
      topNetWinners,
      topNetLosers
    },
    finance: {
      totalTransactions: transactions.length,
      income: sumBy(transactions.filter((row) => row.type === 'INCOME'), (row) => row.amount),
      expenses: sumBy(transactions.filter((row) => row.type === 'EXPENSE'), (row) => row.amount),
      investments: sumBy(transactions.filter((row) => row.type === 'INVESTMENT'), (row) => row.amount),
      borrowed: sumBy(transactions.filter((row) => row.type === 'BORROWED'), (row) => row.amount),
      lent: sumBy(transactions.filter((row) => row.type === 'LENT'), (row) => row.amount),
      openBorrowed: sumBy(
        transactions.filter((row) => row.type === 'BORROWED' && (row.status || 'OPEN') === 'OPEN'),
        (row) => Math.max(0, row.amount - Number(row.paidAmount || 0))
      ),
      openLent: sumBy(
        transactions.filter((row) => row.type === 'LENT' && (row.status || 'OPEN') === 'OPEN'),
        (row) => Math.max(0, row.amount - Number(row.paidAmount || 0))
      ),
      monthlyFlow: buildMonthlyTransactionFlow(transactions),
      topExpenseCategories: buildCategoryTotals(transactions, 'EXPENSE'),
      topIncomeCategories: buildCategoryTotals(transactions, 'INCOME'),
      thisMonthTopExpenseCategories: buildCategoryTotalsForMonth(transactions, 'EXPENSE', currentMonthKey),
      thisMonthTopIncomeCategories: buildCategoryTotalsForMonth(transactions, 'INCOME', currentMonthKey),
      monthlyExpenseCategories: buildMonthlyCategoryBuckets(transactions, 'EXPENSE'),
      monthlyIncomeCategories: buildMonthlyCategoryBuckets(transactions, 'INCOME'),
      recentTransactions: transactions.slice(0, 120).map((row) => ({
        date: row.date,
        type: row.type,
        category: row.category,
        amount: row.amount
      }))
    },
    goals: {
      totalGoals: goals.length,
      activeGoals: goals.filter((row) => row.status === 'ACTIVE').length,
      completedGoals: goals.filter((row) => row.status === 'COMPLETED').length,
      activeTargetAmount: sumBy(goals.filter((row) => row.status === 'ACTIVE'), (row) => row.targetAmount),
      items: goals.slice(0, 8).map((row) => ({
        name: row.name,
        targetAmount: row.targetAmount,
        targetYear: row.targetYear,
        targetDate: row.targetDate || null,
        status: row.status
      }))
    },
    exitStrategies: buildExitStrategySummary(exitStrategies)
  };
}

export async function askFinor(input: AskFinorRequest): Promise<AskFinorApiResponse> {
  try {
    return await postApi<AskFinorApiResponse>({
      mode: 'ask_finor',
      userId: input.userId,
      question: input.question,
      context: input.context,
      conversation: input.conversation.slice(-6)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.startsWith('ASK_FINOR_RATE_LIMIT::')) {
      const payload = message.slice('ASK_FINOR_RATE_LIMIT::'.length);
      try {
        const parsed = JSON.parse(payload) as AskFinorRateLimitInfo;
        throw new AskFinorRateLimitError(parsed);
      } catch (parseError) {
        if (parseError instanceof AskFinorRateLimitError) {
          throw parseError;
        }
      }
    }
    throw error;
  }
}
