import { TRADES_STORE } from '../core/constants';
import type { TradeRecord, TradeSide } from '../core/types';
import { openFinanceDb } from './db';

export type TradeInput = {
  userId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  tradeDate: string;
  exitPrice?: number | null;
  notes?: string;
};

export async function listTrades(userId: string): Promise<TradeRecord[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(TRADES_STORE);
  return all
    .filter((trade) => trade.userId === userId)
    .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
}

export async function addTrade(input: TradeInput): Promise<TradeRecord> {
  const db = await openFinanceDb();
  const now = new Date().toISOString();
  const record: TradeRecord = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...input
  };
  await db.put(TRADES_STORE, record);
  return record;
}

export async function updateTrade(
  tradeId: string,
  userId: string,
  updates: Partial<Omit<TradeRecord, 'id' | 'userId' | 'createdAt'>>
): Promise<TradeRecord | null> {
  const db = await openFinanceDb();
  const existing = await db.get(TRADES_STORE, tradeId);
  if (!existing || existing.userId !== userId) return null;
  const updated: TradeRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(TRADES_STORE, updated);
  return updated;
}

export async function deleteTrade(tradeId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(TRADES_STORE, tradeId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(TRADES_STORE, tradeId);
  return true;
}

export async function replaceTradesForUser(userId: string, trades: TradeRecord[]): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(TRADES_STORE, 'readwrite');
  const store = tx.objectStore(TRADES_STORE);
  const existing = await store.getAll();
  existing.forEach((row) => {
    if (row.userId === userId) {
      store.delete(row.id);
    }
  });
  trades.forEach((trade) => {
    if (trade.userId === userId) {
      store.put(trade);
    }
  });
  await tx.done;
}
