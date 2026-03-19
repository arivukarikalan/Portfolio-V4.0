import { ACTIVITY_STORE } from '../core/constants';
import { openFinanceDb, type ActivityLogEntry } from './db';

export type { ActivityLogEntry } from './db';

export async function addActivityLog(type: string, detail: string): Promise<ActivityLogEntry> {
  const entry: ActivityLogEntry = {
    id: crypto.randomUUID(),
    type,
    detail,
    ts: new Date().toISOString()
  };
  const db = await openFinanceDb();
  await db.put(ACTIVITY_STORE, entry);
  return entry;
}

export async function listActivityLogs(limit = 100): Promise<ActivityLogEntry[]> {
  const db = await openFinanceDb();
  const rows = await db.getAll(ACTIVITY_STORE);
  rows.sort((a, b) => b.ts.localeCompare(a.ts));
  return rows.slice(0, limit);
}

export async function clearActivityLogs(): Promise<void> {
  const db = await openFinanceDb();
  await db.clear(ACTIVITY_STORE);
}
