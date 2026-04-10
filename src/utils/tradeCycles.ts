import type { TradeRecord } from '../core/types';
import { normalizeSymbol } from './symbols';
import { compareTradeExecutionAsc } from './tradeOrdering';

export function computeCurrentCycleState(
  symbol: string,
  trades: TradeRecord[],
  ignoreId?: string
): { qty: number; cost: number; avg: number | null; startDate: string | null } {
  const lots = computeCurrentCycleLots(symbol, trades, ignoreId);
  const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
  const startDate = lots.length ? lots[0].date : null;
  return { qty, cost, avg: qty > 0 ? cost / qty : null, startDate };
}

export function computeCurrentCycleLots(
  symbol: string,
  trades: TradeRecord[],
  ignoreId?: string
): Array<{ qty: number; price: number; date: string | null }> {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return [];
  const relevant = trades
    .filter((trade) => trade.id !== ignoreId && normalizeSymbol(trade.symbol) === normalized)
    .sort(compareTradeExecutionAsc);

  const lots: Array<{ qty: number; price: number; date: string | null }> = [];

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

  const grouped = new Map<string, { buys: TradeRecord[]; sellQty: number }>();
  relevant.forEach((trade) => {
    const tradeQty = Number(trade.quantity);
    const tradePrice = Number(trade.price);
    if (!Number.isFinite(tradeQty) || tradeQty <= 0) return;
    const key = trade.tradeDate || '';
    const entry = grouped.get(key) || { buys: [], sellQty: 0 };
    if (trade.side === 'BUY') {
      if (!Number.isFinite(tradePrice) || tradePrice <= 0) return;
      entry.buys.push(trade);
    } else if (trade.side === 'SELL') {
      entry.sellQty += tradeQty;
    }
    grouped.set(key, entry);
  });

  const dates = Array.from(grouped.keys()).sort();
  dates.forEach((date) => {
    const entry = grouped.get(date);
    if (!entry) return;
    entry.buys.sort(compareTradeExecutionAsc);
    entry.buys.forEach((buy) => {
      lots.push({
        qty: buy.quantity,
        price: buy.price,
        date: date || null
      });
    });
    let remaining = entry.sellQty;
    if (remaining > 0) {
      const dateKey = date || null;
      if (dateKey) {
        remaining = consumeLots(remaining, (lotDate) => lotDate === dateKey);
      }
      consumeLots(remaining);
    }
  });

  return lots;
}
