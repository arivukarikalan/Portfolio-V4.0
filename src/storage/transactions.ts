import { TRANSACTIONS_STORE } from '../core/constants';
import type { TransactionRecord } from '../core/types';
import { openFinanceDb } from './db';

export type TransactionInput = Omit<TransactionRecord, 'id' | 'createdAt' | 'updatedAt' | 'userId'> & {
  userId: string;
};

export async function listTransactions(userId: string): Promise<TransactionRecord[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(TRANSACTIONS_STORE);
  return all
    .filter((row) => row.userId === userId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function addTransaction(input: TransactionInput): Promise<TransactionRecord> {
  const db = await openFinanceDb();
  const now = new Date().toISOString();
  const record: TransactionRecord = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...input
  };
  await db.put(TRANSACTIONS_STORE, record);
  return record;
}

export async function updateTransaction(
  transactionId: string,
  userId: string,
  updates: Partial<Omit<TransactionRecord, 'id' | 'userId' | 'createdAt'>>
): Promise<TransactionRecord | null> {
  const db = await openFinanceDb();
  const existing = await db.get(TRANSACTIONS_STORE, transactionId);
  if (!existing || existing.userId !== userId) return null;
  const updated: TransactionRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(TRANSACTIONS_STORE, updated);
  return updated;
}

export async function deleteTransaction(transactionId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(TRANSACTIONS_STORE, transactionId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(TRANSACTIONS_STORE, transactionId);
  return true;
}

export async function replaceTransactionsForUser(userId: string, rows: TransactionRecord[]): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(TRANSACTIONS_STORE, 'readwrite');
  const store = tx.objectStore(TRANSACTIONS_STORE);
  const existing = await store.getAll();
  existing.forEach((row) => {
    if (row.userId === userId) {
      store.delete(row.id);
    }
  });
  rows.forEach((row) => {
    if (row.userId === userId) {
      store.put(row);
    }
  });
  await tx.done;
}
