import { SYNC_STORE } from '../core/constants';
import type { SnapshotPayload } from '../core/types';
import { openFinanceDb, type SyncState } from './db';

const SYNC_KEY = 'sync';

export async function getSyncState(): Promise<SyncState> {
  const db = await openFinanceDb();
  const record = await db.get(SYNC_STORE, SYNC_KEY);
  if (!record) {
    return { id: SYNC_KEY };
  }
  return record;
}

export async function setSyncState(state: SyncState): Promise<void> {
  const db = await openFinanceDb();
  await db.put(SYNC_STORE, state);
}

export async function setPendingPayload(payload: SnapshotPayload): Promise<void> {
  const state = await getSyncState();
  await setSyncState({
    ...state,
    id: SYNC_KEY,
    pendingPayload: payload
  });
}

export async function clearPendingPayload(): Promise<void> {
  const state = await getSyncState();
  await setSyncState({
    ...state,
    id: SYNC_KEY,
    pendingPayload: undefined
  });
}
