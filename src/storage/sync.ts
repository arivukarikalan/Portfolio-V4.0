import { SYNC_STORE } from '../core/constants';
import type { SnapshotPayload } from '../core/types';
import { openFinanceDb, type SyncState } from './db';

const SYNC_KEY = 'sync';

function syncKey(userId?: string): string {
  return userId ? `${SYNC_KEY}:${userId}` : SYNC_KEY;
}

export async function getSyncState(userId?: string): Promise<SyncState> {
  const db = await openFinanceDb();
  const key = syncKey(userId);
  const record = await db.get(SYNC_STORE, key);
  if (!record) {
    if (userId) {
      const legacy = await db.get(SYNC_STORE, SYNC_KEY);
      if (legacy) return { ...legacy, id: key };
    }
    return { id: key };
  }
  return record;
}

export async function setSyncState(state: SyncState, userId?: string): Promise<void> {
  const db = await openFinanceDb();
  const key = syncKey(userId);
  await db.put(SYNC_STORE, { ...state, id: key });
}

export async function setPendingPayload(payload: SnapshotPayload, userId?: string): Promise<void> {
  const state = await getSyncState(userId);
  await setSyncState({
    ...state,
    id: syncKey(userId),
    pendingPayload: payload
  }, userId);
}

export async function clearPendingPayload(userId?: string): Promise<void> {
  const state = await getSyncState(userId);
  await setSyncState({
    ...state,
    id: syncKey(userId),
    pendingPayload: undefined
  }, userId);
}
