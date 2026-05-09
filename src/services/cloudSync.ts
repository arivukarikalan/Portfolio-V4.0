import type { SnapshotPayload, UserSession } from '../core/types';
import { postApi, getApi } from './api';
import { getSyncState, setPendingPayload, clearPendingPayload, setSyncState } from '../storage/sync';
import { addActivityLog, listActivityLogs } from '../storage/activity';
import { listTrades, replaceTradesForUser } from '../storage/trades';
import { listTransactions, replaceTransactionsForUser } from '../storage/transactions';
import { listGoals, replaceGoalsForUser } from '../storage/goals';
import { listRecoveryPlans, replaceRecoveryPlansForUser } from '../storage/recoveryPlans';
import { listReentryPlans, replaceReentryPlansForUser } from '../storage/reentryPlans';
import { listExitStrategies, replaceExitStrategiesForUser } from '../storage/exitStrategies';
import { getAppConfig } from './config';
import { syncLivePrices } from './livePrices';
import { upsertLivePrices } from '../storage/prices';
import { getUserSettings, saveUserSettings } from '../storage/settings';
import { loadMappingOverrides, mergeMappingOverrides } from '../storage/mappingOverrides';
import { getSession } from '../storage/db';

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export type SnapshotSummary = {
  snapshotId: string;
  timestamp: string;
  updatedAt: string;
  tradesCount: number;
  transactionsCount: number;
  goalsCount: number;
  recoveryPlansCount: number;
  reentryPlansCount: number;
  exitStrategiesCount: number;
  settingsPresent: boolean;
  totalItems: number;
  isEmpty: boolean;
  invalid?: boolean;
  lastTradeDate?: string;
  lastTransactionDate?: string;
};

export type PriceRefreshSummary = {
  requested: number;
  success: number;
  failedTickers: string[];
  failureReasons: Record<string, string>;
};

let started = false;
let syncTimer: number | null = null;
let priceTimer: number | null = null;
let pendingTimer: number | null = null;
let pendingBuild = false;
let currentStatus: SyncStatus = 'idle';
let currentConfig: { maxSnapshots: number; livePriceRefreshSec: number; cloudSyncIntervalMin: number; toastAutoCloseSec: number } | null = null;
let activeSyncUserId: string | null = null;
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
    (payload.recoveryPlans?.length || 0) +
    (payload.reentryPlans?.length || 0) +
    (payload.exitStrategies?.length || 0) +
    overrideCount;
  return `${count} items`;
}

function snapshotDataCount(payload?: SnapshotPayload): number {
  if (!payload) return 0;
  return (
    (payload.trades?.length || 0) +
    (payload.transactions?.length || 0) +
    (payload.goals?.length || 0) +
    (payload.recoveryPlans?.length || 0) +
    (payload.reentryPlans?.length || 0) +
    (payload.exitStrategies?.length || 0)
  );
}

function summaryDataCount(summary: SnapshotSummary): number {
  return (
    (summary.tradesCount || 0) +
    (summary.transactionsCount || 0) +
    (summary.goalsCount || 0) +
    (summary.recoveryPlansCount || 0) +
    (summary.reentryPlansCount || 0) +
    (summary.exitStrategiesCount || 0)
  );
}

export async function listCloudSnapshots(session: UserSession, limit = 30): Promise<SnapshotSummary[]> {
  const data = await postApi<{ rows: SnapshotSummary[] }>({
    mode: 'list_snapshots',
    userId: session.userId,
    sessionToken: session.sessionToken,
    limit
  });
  return Array.isArray(data.rows) ? data.rows : [];
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

async function updateNotificationStats(userId?: string): Promise<void> {
  const state = await getSyncState(userId);
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
      if (session && (!userId || session.userId === userId)) {
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
  const [trades, transactions, goals, recoveryPlans, reentryPlans, exitStrategies] = await Promise.all([
    listTrades(userId),
    listTransactions(userId),
    listGoals(userId),
    listRecoveryPlans(userId),
    listReentryPlans(userId),
    listExitStrategies(userId)
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
    mappingOverrides,
    recoveryPlans,
    reentryPlans,
    exitStrategies
  };
}

export async function applySnapshot(userId: string, payload: SnapshotPayload): Promise<void> {
  if (Array.isArray(payload.trades)) {
    await replaceTradesForUser(userId, payload.trades);
  }
  if (Array.isArray(payload.transactions)) {
    await replaceTransactionsForUser(userId, payload.transactions);
  }
  if (Array.isArray(payload.goals)) {
    await replaceGoalsForUser(userId, payload.goals);
  }
  if (Array.isArray(payload.recoveryPlans)) {
    await replaceRecoveryPlansForUser(userId, payload.recoveryPlans);
  }
  if (Array.isArray(payload.reentryPlans)) {
    await replaceReentryPlansForUser(userId, payload.reentryPlans);
  }
  if (Array.isArray(payload.exitStrategies)) {
    await replaceExitStrategiesForUser(userId, payload.exitStrategies);
  }
  if (payload.settings && payload.settings.userId === userId) {
    await saveUserSettings(payload.settings);
  }
  if (payload.mappingOverrides) {
    mergeMappingOverrides(payload.mappingOverrides);
  }
}

async function preventEmptySnapshotPush(userId: string, payload: SnapshotPayload): Promise<boolean> {
  if (snapshotDataCount(payload) > 0) return false;
  let rows: SnapshotSummary[] = [];
  try {
    const session = await getSession();
    if (!session || session.userId !== userId) {
      throw new Error('Signed-in session is required to check cloud history.');
    }
    rows = await listCloudSnapshots(session, 10);
  } catch {
    throw new Error('Empty local data was not pushed because cloud history could not be checked.');
  }
  const hasCloudData = rows.some((row) => summaryDataCount(row) > 0);
  const message = hasCloudData
    ? 'Empty local data was not pushed. Restore a cloud snapshot from Settings instead.'
    : 'Empty local data was not pushed.';
  await clearPendingPayload(userId);
  await setSyncState({
    ...(await getSyncState(userId)),
    id: 'sync',
    pendingDirty: false,
    pendingSince: undefined,
    pendingChangeCount: 0,
    lastError: message
  }, userId);
  await addActivityLog('sync', message);
  await updateNotificationStats(userId);
  setIndicator('idle', hasCloudData ? 'Restore needed' : 'Synced');
  return true;
}

export async function restoreCloudSnapshot(session: UserSession, snapshotId: string): Promise<SnapshotPayload> {
  if (!navigator.onLine) {
    setIndicator('offline');
    throw new Error('Connect to the internet to restore a cloud snapshot.');
  }
  setIndicator('syncing');
  const data = await postApi<{ payload: SnapshotPayload; summary?: SnapshotSummary; message?: string }>({
    mode: 'restore_snapshot',
    userId: session.userId,
    sessionToken: session.sessionToken,
    snapshotId
  });
  if (!data.payload) {
    throw new Error('Snapshot restore did not return data.');
  }
  await applySnapshot(session.userId, data.payload);
  await clearPendingPayload(session.userId);
  await setSyncState({
    ...(await getSyncState(session.userId)),
    id: 'sync',
    pendingDirty: false,
    pendingSince: undefined,
    pendingChangeCount: 0,
    lastPullAt: new Date().toISOString(),
    lastCloudUpdatedAt: data.payload.updatedAt,
    lastError: ''
  }, session.userId);
  await addActivityLog('sync', `Cloud snapshot restored (${pendingSummary(data.payload)}).`);
  await updateNotificationStats(session.userId);
  setIndicator('idle', 'Restored');
  return data.payload;
}

export async function queueSnapshot(userId: string, options?: { increment?: boolean }): Promise<void> {
  const state = await getSyncState(userId);
  const increment = options?.increment !== false;
  await setSyncState({
    ...state,
    id: 'sync',
    pendingDirty: true,
    pendingSince: new Date().toISOString(),
    pendingChangeCount: increment ? (state.pendingChangeCount || 0) + 1 : state.pendingChangeCount || 0
  }, userId);
  if (navigator.onLine) {
    setIndicator('idle', 'Pending');
  } else {
    setIndicator('offline');
  }
  await updateNotificationStats(userId);
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
    throw new Error('Connect to the internet to sync cloud data.');
  }
  setIndicator('syncing');
  const state = await getSyncState(session.userId);
  let payload = state.pendingPayload as SnapshotPayload | undefined;
  if (state.pendingDirty) {
    payload = await buildSnapshot(session.userId);
    await setPendingPayload(payload, session.userId);
  }
  if (!payload) {
    payload = await buildSnapshot(session.userId);
  }
  try {
    if (await preventEmptySnapshotPush(session.userId, payload)) return;
    await postApi({ mode: 'push', userId: session.userId, sessionToken: session.sessionToken, payload });
    await clearPendingPayload(session.userId);
    const latestState = await getSyncState(session.userId);
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
    }, session.userId);
    await addActivityLog('sync', `Cloud push completed (${pendingSummary(payload)}).`);
    await updateNotificationStats(session.userId);
    setIndicator('idle', 'Synced');
    if (hasNewerChanges) {
      await queueSnapshot(session.userId, { increment: false });
    }
  } catch (error) {
    const message = String((error as Error)?.message || error || 'sync_failed');
    await setSyncState({
      ...(await getSyncState(session.userId)),
      id: 'sync',
      pendingDirty: true,
      lastError: message
    }, session.userId);
    await addActivityLog('sync', `Cloud push failed (${message}).`);
    await updateNotificationStats(session.userId);
    setIndicator('error', 'Sync failed');
    throw new Error(message);
  }
}

async function pullSnapshot(session: UserSession): Promise<void> {
  if (!navigator.onLine) throw new Error('Connect to the internet to pull cloud data.');
  const state = await getSyncState(session.userId);
  if (state.pendingPayload || state.pendingDirty) {
    throw new Error('Local changes are pending. Push or restore before pulling cloud data.');
  }
  try {
    const data = await getApi<{ payload?: SnapshotPayload }>({
      mode: 'pull',
      userId: session.userId,
      sessionToken: session.sessionToken || ''
    });
    if (data.payload) {
      const remoteUpdatedAt = data.payload.updatedAt;
      if (remoteUpdatedAt && state.lastCloudUpdatedAt && new Date(remoteUpdatedAt) <= new Date(state.lastCloudUpdatedAt)) {
        await updateNotificationStats(session.userId);
        return;
      }
      await applySnapshot(session.userId, data.payload);
      await setSyncState({
        ...(await getSyncState(session.userId)),
        id: 'sync',
        lastPullAt: new Date().toISOString(),
        lastCloudUpdatedAt: remoteUpdatedAt || state.lastCloudUpdatedAt
      }, session.userId);
      await addActivityLog('sync', 'Cloud pull completed.');
      await updateNotificationStats(session.userId);
    }
  } catch (error) {
    const message = String((error as Error)?.message || error || 'pull_failed');
    await setSyncState({
      ...(await getSyncState(session.userId)),
      id: 'sync',
      lastError: message
    }, session.userId);
    await addActivityLog('sync', `Cloud pull failed (${message}).`);
    await updateNotificationStats(session.userId);
    setIndicator('error', 'Pull failed');
    throw new Error(message);
  }
}

export async function pullNow(session: UserSession): Promise<void> {
  if (!navigator.onLine) {
    setIndicator('offline');
    throw new Error('Connect to the internet to pull cloud data.');
  }
  setIndicator('syncing');
  await pullSnapshot(session);
  setIndicator('idle', 'Synced');
}

export async function syncIfPending(session: UserSession): Promise<void> {
  const state = await getSyncState(session.userId);
  if (!state.pendingPayload && !state.pendingDirty) {
    await updateNotificationStats(session.userId);
    return;
  }
  await syncNow(session);
}

export async function refreshLivePricesNow(session: UserSession): Promise<PriceRefreshSummary> {
  if (!navigator.onLine) {
    setIndicator('offline');
    throw new Error('Connect to the internet to refresh live prices.');
  }
  const trades = await listTrades(session.userId);
  const tickers = Array.from(new Set(trades.map((trade) => trade.symbol).filter(Boolean)));
  if (!tickers.length) {
    return { requested: 0, success: 0, failedTickers: [], failureReasons: {} };
  }
  setIndicator('syncing', 'Prices');
  const result = await syncLivePrices(tickers);
  const success = Number(result.success || Object.keys(result.prices || {}).length || 0);
  const failedTickers = Array.isArray(result.failedTickers) ? result.failedTickers : [];
  const failureReasons = result.failureReasons || {};
  if (success > 0) {
    await upsertLivePrices(result.prices);
    await setSyncState({
      ...(await getSyncState(session.userId)),
      id: 'sync',
      lastPriceAt: new Date().toISOString(),
      lastError: ''
    }, session.userId);
    await addActivityLog('price', `Live prices updated (${success}/${tickers.length} tickers).`);
    await updateNotificationStats(session.userId);
    setIndicator('idle', 'Synced');
  } else {
    const firstFailure = failedTickers[0];
    const reason = firstFailure ? failureReasons[firstFailure] : '';
    await addActivityLog('price', `Live price update failed (${tickers.length} tickers${reason ? `: ${reason}` : ''}).`);
    await setSyncState({
      ...(await getSyncState(session.userId)),
      id: 'sync',
      lastError: reason || 'Live price update failed.'
    }, session.userId);
    await updateNotificationStats(session.userId);
    setIndicator('error', 'Price failed');
  }
  return { requested: tickers.length, success, failedTickers, failureReasons };
}

function bindSyncPanel(session: UserSession): void {
  const pushBtn = document.querySelector<HTMLButtonElement>('#sync-panel-push');
  const pullBtn = document.querySelector<HTMLButtonElement>('#sync-panel-pull');
  if (pushBtn?.dataset.boundUser === session.userId && pullBtn?.dataset.boundUser === session.userId) return;
  if (pushBtn) pushBtn.dataset.boundUser = session.userId;
  if (pullBtn) pullBtn.dataset.boundUser = session.userId;
  pushBtn?.addEventListener('click', async () => {
    pushBtn.disabled = true;
    try {
      await syncNow(session);
    } catch {
      // The sync panel status and activity log show the failure details.
    } finally {
      pushBtn.disabled = false;
    }
  });
  pullBtn?.addEventListener('click', async () => {
    pullBtn.disabled = true;
    try {
      await pullNow(session);
    } catch {
      // The sync panel status and activity log show the failure details.
    } finally {
      pullBtn.disabled = false;
    }
  });
}

export async function initCloudSync(session: UserSession): Promise<void> {
  if (started && activeSyncUserId === session.userId) {
    setIndicator(navigator.onLine ? currentStatus === 'offline' ? 'idle' : currentStatus : 'offline');
    await updateNotificationStats(session.userId);
    bindSyncPanel(session);
    return;
  }
  if (started && activeSyncUserId !== session.userId) {
    stopCloudSync();
  }
  started = true;
  activeSyncUserId = session.userId;
  let config = { maxSnapshots: 10, livePriceRefreshSec: 60, cloudSyncIntervalMin: 10, toastAutoCloseSec: 7 };
  try {
    config = await getAppConfig(session.userId);
  } catch {
    // fallback to defaults when offline
  }
  currentConfig = config;
  document.documentElement.dataset.toastAutoCloseSec = String(config.toastAutoCloseSec || 7);
  setIndicator(navigator.onLine ? 'idle' : 'offline');
  await updateNotificationStats(session.userId);
  bindSyncPanel(session);

  window.addEventListener('online', () => {
    setIndicator('idle');
    void syncIfPending(session);
  });
  window.addEventListener('offline', () => {
    setIndicator('offline');
  });

  const state = await getSyncState(session.userId);
  const now = Date.now();
  const syncIntervalMs = Math.max(1, config.cloudSyncIntervalMin) * 60 * 1000;
  const lastPull = state.lastPullAt ? new Date(state.lastPullAt).getTime() : 0;
  const hasPending = Boolean(state.pendingPayload || state.pendingDirty);
  const shouldPull = navigator.onLine && !hasPending && (!lastPull || now - lastPull > syncIntervalMs);
  const shouldSyncNow = navigator.onLine && hasPending;

  if (shouldPull) {
    void pullSnapshot(session).catch(() => undefined);
  }

  syncTimer = window.setInterval(() => {
    void syncIfPending(session).catch(() => undefined);
  }, syncIntervalMs);

  const priceIntervalMs = Math.max(10, config.livePriceRefreshSec) * 1000;
  priceTimer = window.setInterval(() => {
    if (navigator.onLine) {
      void refreshLivePricesNow(session).catch(() => undefined);
    }
  }, priceIntervalMs);

  if (navigator.onLine) {
    if (shouldSyncNow) {
      void syncNow(session).catch(() => undefined);
    }
    void refreshLivePricesNow(session).catch(() => undefined);
  }
}

async function buildPendingSnapshot(userId: string): Promise<void> {
  if (pendingBuild) return;
  pendingTimer = null;
  pendingBuild = true;
  try {
    const payload = await buildSnapshot(userId);
    await setPendingPayload(payload, userId);
    const state = await getSyncState(userId);
    const pendingSince = state.pendingSince ? new Date(state.pendingSince).getTime() : 0;
    const snapshotAt = payload.updatedAt ? new Date(payload.updatedAt).getTime() : 0;
    const hasNewerChanges = pendingSince > snapshotAt;
    await setSyncState({
      ...state,
      id: 'sync',
      pendingDirty: hasNewerChanges,
      pendingSince: hasNewerChanges ? state.pendingSince : undefined,
      pendingChangeCount: hasNewerChanges ? state.pendingChangeCount : state.pendingChangeCount || 0
    }, userId);
    await updateNotificationStats(userId);
    if (navigator.onLine && !hasNewerChanges) {
      const session = await getSession();
      if (session) {
        await syncNow(session).catch(() => undefined);
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
  activeSyncUserId = null;
}

