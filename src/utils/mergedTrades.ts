import type { TradeRecord, TradeSide } from '../core/types';
import { normalizeSymbol } from './symbols';
import { compareTradeExecutionAsc } from './tradeOrdering';

export type MergedTrade = {
  id: string;
  symbol: string;
  side: TradeSide;
  tradeDate: string;
  quantity: number;
  price: number;
  amount: number;
  trades: TradeRecord[];
  fillCount: number;
  importBased: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
};

function sortTrades(trades: TradeRecord[]): TradeRecord[] {
  return [...trades].sort(compareTradeExecutionAsc);
}

export function mergeImportedTrades(trades: TradeRecord[]): MergedTrade[] {
  const groups = new Map<string, TradeRecord[]>();
  const order: string[] = [];

  sortTrades(trades).forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    if (!symbol) return;
    const key = trade.importId
      ? `import:${trade.tradeDate}|${symbol}|${trade.side}`
      : `raw:${trade.id}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(trade);
    } else {
      groups.set(key, [trade]);
      order.push(key);
    }
  });

  return order.map((key) => {
    const bucket = groups.get(key) || [];
    const quantity = bucket.reduce((sum, trade) => sum + trade.quantity, 0);
    const amount = bucket.reduce((sum, trade) => sum + trade.quantity * trade.price, 0);
    const first = bucket[0];
    const notes = Array.from(new Set(bucket.map((trade) => (trade.notes || '').trim()).filter(Boolean))).join(' | ');
    return {
      id: key.startsWith('raw:') ? first.id : `merged:${first.tradeDate}|${normalizeSymbol(first.symbol)}|${first.side}`,
      symbol: first.symbol,
      side: first.side,
      tradeDate: first.tradeDate,
      quantity,
      price: quantity > 0 ? amount / quantity : first.price,
      amount,
      trades: bucket,
      fillCount: bucket.length,
      importBased: Boolean(first.importId),
      createdAt: bucket
        .map((trade) => trade.createdAt)
        .sort((a, b) => a.localeCompare(b))[0],
      updatedAt: bucket
        .map((trade) => trade.updatedAt)
        .sort((a, b) => b.localeCompare(a))[0],
      notes: notes || undefined
    };
  });
}
