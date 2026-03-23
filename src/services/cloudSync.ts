import type { SnapshotPayload, UserSession } from '../core/types';
import { postApi, getApi } from './api';
import { getSyncState, setPendingPayload, clearPendingPayload, setSyncState } from '../storage/sync';
import { addActivityLog, listActivityLogs } from '../storage/activity';
import { listTrades, replaceTradesForUser } from '../storage/trades';
import { listTransactions, replaceTransactionsForUser } from '../storage/transactions';
import { listGoals, replaceGoalsForUser } from '../storage/goals';
import { getAppConfig } from './config';
import { syncLivePrices } from './livePrices';
import { upsertLivePrices } from '../storage/prices';
import { getUserSettings, saveUserSettings } from '../storage/settings';
import { loadMappingOverrides, mergeMappingOverrides } from '../storage/mappingOverrides';
import { getSession } from '../storage/db';

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

let started = false;
let syncTimer: number | null = null;
let priceTimer: number | null = null;
let pendingTimer: number | null = null;
let pendingBuild = false;
let currentStatus: SyncStatus = 'idle';
let currentConfig: { maxSnapshots: number; livePriceRefreshSec: number; cloudSyncIntervalMin: number; toastAutoCloseSec: number } | null = null;
let panelBound = false;
const PENDING_DEBOUNCE_MS = 2500;

function setIndicator(status: SyncStatus, message?: string): void {
  currentStatus = status;
  const indicator = document.querySelector<HTMLDivElement>('#sync-indicator');
  if (indicator) {
    indicator.dataset.status = status;
    indicator.textContent = message || (status === 'syncing' ? 'Syncing' : status === 'offline' ? 'Offline' : 'Synced');
  }
  const panelStatus = document.querySelector<HTMLSpanElement>('#sync-panel-status');
  if (panelStatus) {
    panelStatus.textContent = status === 'syncing' ? 'Syncing' : status === 'offline' ? 'Offline' : status === 'error' ? 'Error' : 'Synced';
    panelStatus.dataset.status = status;
  }
}

function formatShortDate(value?: string): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatInterval(value: number, unit: 'min' | 'sec'): string {
  if (!Number.isFinite(value) || value <= 0) return '--';
  const rounded = Math.round(value);
  return `Every ${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
}

function pendingSummary(payload?: SnapshotPayload): string {
  if (!payload) return '0';
  const overrideCount = payload.mappingOverrides ? Object.keys(payload.mappingOverrides).length : 0;
  const count =
    (payload.trades?.length || 0) +
    (payload.transactions?.length || 0) +
    (payload.goals?.length || 0) +
    (payload.settings ? 1 : 0) +
    overrideCount;
  return `${count} items`;
}

function pendingStatusLabel(state: Awaited<ReturnType<typeof getSyncState>>): string {
  const payload = state.pendingPayload as SnapshotPayload | undefined;
  if (state.pendingChangeCount && state.pendingChangeCount > 0) {
    return `${state.pendingChangeCount} changes`;
  }
  if (payload) return pendingSummary(payload);
  if (state.pendingDirty) return 'Pending changes';
  return 'No pending changes';
}

async function updateSyncLogSummary(): Promise<void> {
  const logContainer = document.querySelector<HTMLDivElement>('#sync-panel-logs');
  if (!logContainer) return;
  const logs = (await listActivityLogs(12)).filter((entry) => entry.type === 'sync' || entry.type === 'price');
  if (!logs.length) {
    logContainer.innerHTML = '<div class="text-muted small">No sync activity yet.</div>';
    return;
  }
  logContainer.innerHTML = logs
    .slice(0, 6)
    .map((entry) => {
      return `
        <div class="sync-log-item">
          <div class="label">${entry.detail}</div>
          <div class="meta">${new Date(entry.ts).toLocaleString()}</div>
        </div>
      `;
    })
    .join('');
}

async function updateNotificationStats(): Promise<void> {
  const state = await getSyncState();
  const lastSync = document.querySelector<HTMLElement>('#notif-last-sync');
  const lastPrice = document.querySelector<HTMLElement>('#notif-last-price');
  const txnCount = document.querySelector<HTMLElement>('#notif-txn-count');
  if (lastSync) {
    lastSync.textContent = formatShortDate(state.lastSyncedAt || state.lastPullAt);
  }
  if (lastPrice) {
    lastPrice.textContent = formatShortDate(state.lastPriceAt);
  }
  if (txnCount) {
    try {
      const session = await getSession();
      if (session) {
        const txns = await listTransactions(session.userId);
        txnCount.textContent = String(txns.length);
      }
    } catch {
      txnCount.textContent = '--';
    }
  }
  const panelInterval = document.querySelector<HTMLElement>('#sync-panel-interval');
  const panelPriceInterval = document.querySelector<HTMLElement>('#sync-panel-price-interval');
  const panelLastPush = document.querySelector<HTMLElement>('#sync-panel-last-push');
  const panelLastPull = document.querySelector<HTMLElement>('#sync-panel-last-pull');
  const panelLastPrice = document.querySelector<HTMLElement>('#sync-panel-last-price');
  const panelPending = document.querySelector<HTMLElement>('#sync-panel-pending');
  const pendingBadge = document.querySelector<HTMLElement>('#sync-pending-badge');
  if (panelInterval && currentConfig) {
    panelInterval.textContent = formatInterval(currentConfig.cloudSyncIntervalMin, 'min');
  }
  if (panelPriceInterval && currentConfig) {
    panelPriceInterval.textContent = formatInterval(currentConfig.livePriceRefreshSec, 'sec');
  }
  if (panelLastPush) {
    panelLastPush.textContent = formatShortDate(state.lastSyncedAt);
  }
  if (panelLastPull) {
    panelLastPull.textContent = formatShortDate(state.lastPullAt);
  }
  if (panelLastPrice) {
    panelLastPrice.textContent = formatShortDate(state.lastPriceAt);
  }
  if (panelPending) {
    panelPending.textContent = pendingStatusLabel(state);
  }
  if (pendingBadge) {
    const count = state.pendingChangeCount || 0;
    if (count > 0) {
      pendingBadge.textContent = String(count);
      pendingBadge.classList.remove('d-none');
      pendingBadge.setAttribute('aria-label', `${count} pending changes`);
    } else {
      pendingBadge.textContent = '';
      pendingBadge.classList.add('d-none');
      pendingBadge.setAttribute('aria-label', 'No pending changes');
    }
  }
  await updateSyncLogSummary();
}

async function buildSnapshot(userId: string): Promise<SnapshotPayload> {
  const [trades, transactions, goals] = await Promise.all([
    listTrades(userId),
    listTransactions(userId),
    listGoals(userId)
  ]);
  const settings = await getUserSettings(userId);
  const mappingOverrides = loadMappingOverrides();
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    trades,
    transactions,
    goals,
    settings,
    mappingOverrides
  };
}

async function applySnapshot(userId: string, payload: SnapshotPayload): Promise<void> {
  if (Array.isArray(payload.trades)) {
    await replaceTradesForUser(userId, payload.trades);
  }
  if (Array.isArray(payload.transactions)) {
    await replaceTransactionsForUser(userId, payload.transactions);
  }
  if (Array.isArray(payload.goals)) {
    await replaceGoalsForUser(userId, payload.goals);
  }
  if (payload.settings && payload.settings.userId === userId) {
    await saveUserSettings(payload.settings);
  }
  if (payload.mappingOverrides) {
    mergeMappingOverrides(payload.mappingOverrides);
  }
}

export async function queueSnapshot(userId: string, options?: { increment?: boolean }): Promise<void> {
  const state = await getSyncState();
  const increment = options?.increment !== false;
  await setSyncState({
    ...state,
    id: 'sync',
    pendingDirty: true,
    pendingSince: new Date().toISOString(),
    pendingChangeCount: increment ? (state.pendingChangeCount || 0) + 1 : state.pendingChangeCount || 0
  });
  if (navigator.onLine) {
    setIndicator('idle', 'Pending');
  } else {
    setIndicator('offline');
  }
  await updateNotificationStats();
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
  }
  pendingTimer = window.setTimeout(() => {
    void buildPendingSnapshot(userId);
  }, PENDING_DEBOUNCE_MS);
}

export async function syncNow(session: UserSession): Promise<void> {
  if (!navigator.onLine) {
    setIndicator('offline');
    return;
  }
  setIndicator('syncing');
  const state = await getSyncState();
  let payload = state.pendingPayload as SnapshotPayload | undefined;
  if (state.pendingDirty) {
    payload = await buildSnapshot(session.userId);
    await setPendingPayload(payload);
  }
  if (!payload) {
    payload = await buildSnapshot(session.userId);
  }
  try {
    await postApi({ mode: 'push', userId: session.userId, payload });
    await clearPendingPayload();
    const latestState = await getSyncState();
    const pendingSince = latestState.pendingSince ? new Date(latestState.pendingSince).getTime() : 0;
    const snapshotAt = payload.updatedAt ? new Date(payload.updatedAt).getTime() : 0;
    const hasNewerChanges = pendingSince > snapshotAt;
    await setSyncState({
      ...latestState,
      id: 'sync',
      pendingDirty: hasNewerChanges,
      pendingSince: hasNewerChanges ? latestState.pendingSince : undefined,
      pendingChangeCount: hasNewerChanges ? latestState.pendingChangeCount : 0,
      lastSyncedAt: new Date().toISOString(),
      lastCloudUpdatedAt: payload.updatedAt,
      lastError: ''
    });
    await addActivityLog('sync', `Cloud push completed (${pendingSummary(payload)}).`);
    await updateNotificationStats();
    setIndicator('idle', 'Synced');
    if (hasNewerChanges) {
      await queueSnapshot(session.userId, { increment: false });
    }
  } catch (error) {
    await setSyncState({
      ...(await getSyncState()),
      id: 'sync',
      pendingDirty: true,
      lastError: String((error as Error)?.message || error || 'sync_failed')
    });
    await addActivityLog('sync', `Cloud push failed (${String((error as Error)?.message || 'error')}).`);
    await updateNotificationStats();
    setIndicator('error', 'Sync failed');
  }
}

async function pullSnapshot(session: UserSession): Promise<void> {
  if (!navigator.onLine) return;
  const state = await getSyncState();
  if (state.pendingPayload || state.pendingDirty) return;
  try {
    const data = await getApi<{ payload?: SnapshotPayload }>({ mode: 'pull', userId: session.userId });
    if (data.payload) {
      const remoteUpdatedAt = data.payload.updatedAt;
      if (remoteUpdatedAt && state.lastCloudUpdatedAt && new Date(remoteUpdatedAt) <= new Date(state.lastCloudUpdatedAt)) {
        await updateNotificationStats();
        return;
      }
      await applySnapshot(session.userId, data.payload);
      await setSyncState({
        ...(await getSyncState()),
        id: 'sync',
        lastPullAt: new Date().toISOString(),
        lastCloudUpdatedAt: remoteUpdatedAt || state.lastCloudUpdatedAt
      });
      await addActivityLog('sync', 'Cloud pull completed.');
      await updateNotificationStats();
    }
  } catch {
    // Ignore pull errors to keep offline safe.
  }
}

export async function pullNow(session: UserSession): Promise<void> {
  if (!navigator.onLine) {
    setIndicator('offline');
    return;
  }
  setIndicator('syncing');
  await pullSnapshot(session);
  setIndicator('idle', 'Synced');
}

export async function syncIfPending(session: UserSession): Promise<void> {
  const state = await getSyncState();
  if (!state.pendingPayload && !state.pendingDirty) {
    await updateNotificationStats();
    return;
  }
  await syncNow(session);
}

async function refreshLivePrices(session: UserSession): Promise<void> {
  const trades = await listTrades(session.userId);
  const tickers = Array.from(new Set(trades.map((trade) => trade.symbol).filter(Boolean)));
  if (!tickers.length) return;
  const result = await syncLivePrices(tickers);
  if (result.prices) {
    await upsertLivePrices(result.prices);
    await setSyncState({
      ...(await getSyncState()),
      id: 'sync',
      lastPriceAt: new Date().toISOString()
    });
    await addActivityLog('price', `Live prices updated (${tickers.length} tickers).`);
    await updateNotificationStats();
  }
}

function bindSyncPanel(session: UserSession): void {
  if (panelBound) return;
  panelBound = true;
  const pushBtn = document.querySelector<HTMLButtonElement>('#sync-panel-push');
  const pullBtn = document.querySelector<HTMLButtonElement>('#sync-panel-pull');
  pushBtn?.addEventListener('click', async () => {
    pushBtn.disabled = true;
    try {
      await syncNow(session);
    } finally {
      pushBtn.disabled = false;
    }
  });
  pullBtn?.addEventListener('click', async () => {
    pullBtn.disabled = true;
    try {
      await pullNow(session);
    } finally {
      pullBtn.disabled = false;
    }
  });
}

export async function initCloudSync(session: UserSession): Promise<void> {
  if (started) return;
  started = true;
  let config = { maxSnapshots: 10, livePriceRefreshSec: 60, cloudSyncIntervalMin: 10, toastAutoCloseSec: 7 };
  try {
    config = await getAppConfig(session.userId);
  } catch {
    // fallback to defaults when offline
  }
  currentConfig = config;
  document.documentElement.dataset.toastAutoCloseSec = String(config.toastAutoCloseSec || 7);
  setIndicator(navigator.onLine ? 'idle' : 'offline');
  await updateNotificationStats();
  bindSyncPanel(session);

  window.addEventListener('online', () => {
    setIndicator('idle');
    void syncIfPending(session);
  });
  window.addEventListener('offline', () => {
    setIndicator('offline');
  });

  const state = await getSyncState();
  const now = Date.now();
  const syncIntervalMs = Math.max(1, config.cloudSyncIntervalMin) * 60 * 1000;
  const lastPull = state.lastPullAt ? new Date(state.lastPullAt).getTime() : 0;
  const hasPending = Boolean(state.pendingPayload || state.pendingDirty);
  const shouldPull = navigator.onLine && !hasPending && (!lastPull || now - lastPull > syncIntervalMs);
  const shouldSyncNow = navigator.onLine && hasPending;

  if (shouldPull) {
    void pullSnapshot(session);
  }

  syncTimer = window.setInterval(() => {
    void syncIfPending(session);
  }, syncIntervalMs);

  const priceIntervalMs = Math.max(10, config.livePriceRefreshSec) * 1000;
  priceTimer = window.setInterval(() => {
    if (navigator.onLine) {
      void refreshLivePrices(session);
    }
  }, priceIntervalMs);

  if (navigator.onLine) {
    if (shouldSyncNow) {
      void syncNow(session);
    }
    void refreshLivePrices(session);
  }
}

async function buildPendingSnapshot(userId: string): Promise<void> {
  if (pendingBuild) return;
  pendingTimer = null;
  pendingBuild = true;
  try {
    const payload = await buildSnapshot(userId);
    await setPendingPayload(payload);
    const state = await getSyncState();
    const pendingSince = state.pendingSince ? new Date(state.pendingSince).getTime() : 0;
    const snapshotAt = payload.updatedAt ? new Date(payload.updatedAt).getTime() : 0;
    const hasNewerChanges = pendingSince > snapshotAt;
    await setSyncState({
      ...state,
      id: 'sync',
      pendingDirty: hasNewerChanges,
      pendingSince: hasNewerChanges ? state.pendingSince : undefined,
      pendingChangeCount: hasNewerChanges ? state.pendingChangeCount : state.pendingChangeCount || 0
    });
    await updateNotificationStats();
    if (navigator.onLine && !hasNewerChanges) {
      const session = await getSession();
      if (session) {
        await syncNow(session);
      }
    } else if (hasNewerChanges) {
      await queueSnapshot(userId, { increment: false });
    }
  } finally {
    pendingBuild = false;
  }
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function stopCloudSync(): void {
  if (syncTimer) window.clearInterval(syncTimer);
  if (priceTimer) window.clearInterval(priceTimer);
  if (pendingTimer) window.clearTimeout(pendingTimer);
  syncTimer = null;
  priceTimer = null;
  pendingTimer = null;
  started = false;
}

