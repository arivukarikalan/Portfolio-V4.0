import { SETTINGS_STORE } from '../core/constants';
import type { UserSettings } from '../core/types';
import { openFinanceDb } from './db';

export function defaultSettings(userId: string): UserSettings {
  return {
    userId,
    maxAllocationPct: 0,
    totalInvestment: 0,
    buyBrokeragePct: 0,
    sellBrokeragePct: 0,
    dpCharge: 0,
    expectedReturnPct: 0,
    inflationPct: 0,
    fdReturnPct: 0,
    targetProfitPct: 10,
    l1ZonePct: 0,
    l2ZonePct: 0,
    updatedAt: new Date().toISOString()
  };
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const db = await openFinanceDb();
  const existing = await db.get(SETTINGS_STORE, userId);
  if (existing) return existing;
  const fallback = defaultSettings(userId);
  await db.put(SETTINGS_STORE, fallback);
  return fallback;
}

export async function saveUserSettings(settings: UserSettings): Promise<void> {
  const db = await openFinanceDb();
  await db.put(SETTINGS_STORE, settings);
}
