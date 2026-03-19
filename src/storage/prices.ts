import { PRICES_STORE } from '../core/constants';
import type { LivePrice } from '../core/types';
import { openFinanceDb } from './db';

export async function upsertLivePrices(prices: Record<string, LivePrice>): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(PRICES_STORE, 'readwrite');
  const store = tx.objectStore(PRICES_STORE);
  for (const price of Object.values(prices)) {
    if (!price?.ticker) continue;
    store.put(price);
  }
  await tx.done;
}

export async function listLivePrices(): Promise<LivePrice[]> {
  const db = await openFinanceDb();
  return db.getAll(PRICES_STORE);
}
