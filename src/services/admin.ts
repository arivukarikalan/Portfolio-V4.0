import type { UserRole } from '../core/types';
import { postApi } from './api';

export type PendingRequest = {
  requestId: string;
  name: string;
  loginId: string;
  email?: string;
  requestedAt: string;
  status: string;
};

export type AdminUserRow = {
  userId: string;
  name: string;
  loginId: string;
  email: string;
  role: UserRole;
  status: string;
  createdAt: string;
  approvedAt: string;
  approvedBy: string;
};

export type AdminConfig = {
  maxSnapshots: number;
  livePriceRefreshSec: number;
  cloudSyncIntervalMin: number;
  toastAutoCloseSec: number;
};

export type NseMasterRow = {
  symbol: string;
  name: string;
  isin: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type TickerAdminRequest = {
  requestId: string;
  userId: string;
  userName: string;
  rawSymbol: string;
  status: string;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedTicker?: string;
  note?: string;
};

export async function listPendingRequests(adminUserId: string, adminToken: string): Promise<PendingRequest[]> {
  const data = await postApi<{ rows: PendingRequest[] }>({
    mode: 'list_pending',
    adminUserId: adminUserId.trim(),
    adminToken
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function reviewPendingRequest(input: {
  adminUserId: string;
  adminToken: string;
  requestId: string;
  decision: 'approve' | 'reject';
  role?: UserRole;
  note?: string;
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: input.decision === 'approve' ? 'approve_user' : 'reject_user',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    requestId: input.requestId,
    role: input.role || 'USER',
    note: input.note || ''
  });
  return data.message || 'Completed';
}

export async function listAdminUsers(adminUserId: string, adminToken: string): Promise<AdminUserRow[]> {
  const data = await postApi<{ rows: AdminUserRow[] }>({
    mode: 'list_users',
    adminUserId: adminUserId.trim(),
    adminToken
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function updateAdminUser(input: {
  adminUserId: string;
  adminToken: string;
  userId: string;
  role?: UserRole;
  status?: 'ACTIVE' | 'DISABLED';
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: 'update_user',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    userId: input.userId.trim(),
    role: input.role,
    status: input.status
  });
  return data.message || 'Updated';
}

export async function getAdminConfig(adminUserId: string, adminToken: string): Promise<AdminConfig> {
  const data = await postApi<AdminConfig>({
    mode: 'get_admin_config',
    adminUserId: adminUserId.trim(),
    adminToken
  });
  return {
    maxSnapshots: Number.isFinite(Number(data.maxSnapshots)) ? Number(data.maxSnapshots) : 10,
    livePriceRefreshSec: Number.isFinite(Number(data.livePriceRefreshSec)) ? Number(data.livePriceRefreshSec) : 60,
    cloudSyncIntervalMin: Number.isFinite(Number(data.cloudSyncIntervalMin)) ? Number(data.cloudSyncIntervalMin) : 10,
    toastAutoCloseSec: Number.isFinite(Number(data.toastAutoCloseSec)) ? Number(data.toastAutoCloseSec) : 7
  };
}

export async function setAdminConfig(input: {
  adminUserId: string;
  adminToken: string;
  maxSnapshots: number;
  livePriceRefreshSec: number;
  cloudSyncIntervalMin: number;
  toastAutoCloseSec: number;
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: 'set_admin_config',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    maxSnapshots: Math.max(1, Math.floor(input.maxSnapshots)),
    livePriceRefreshSec: Math.max(10, Math.floor(input.livePriceRefreshSec)),
    cloudSyncIntervalMin: Math.max(1, Math.floor(input.cloudSyncIntervalMin)),
    toastAutoCloseSec: Math.max(1, Math.floor(input.toastAutoCloseSec))
  });
  return data.message || 'Saved';
}

export async function trimSnapshots(input: {
  adminUserId?: string;
  adminToken?: string;
  userId?: string;
}): Promise<void> {
  await postApi({
    mode: 'trim_snapshots',
    adminUserId: input.adminUserId || '',
    adminToken: input.adminToken || '',
    userId: input.userId || ''
  });
}

export async function listNseMaster(adminUserId: string, adminToken: string): Promise<NseMasterRow[]> {
  const data = await postApi<{ rows: NseMasterRow[] }>({
    mode: 'list_nse_master',
    adminUserId: adminUserId.trim(),
    adminToken
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function replaceNseMaster(
  adminUserId: string,
  adminToken: string,
  rows: Array<{ symbol: string; name: string; isin: string }>
): Promise<void> {
  await postApi({
    mode: 'replace_nse_master',
    adminUserId: adminUserId.trim(),
    adminToken,
    rows
  });
}

export async function listTickerRequestsAdmin(adminUserId: string, adminToken: string): Promise<TickerAdminRequest[]> {
  const data = await postApi<{ rows: TickerAdminRequest[] }>({
    mode: 'list_ticker_requests_admin',
    adminUserId: adminUserId.trim(),
    adminToken
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function resolveTickerRequestAdmin(input: {
  adminUserId: string;
  adminToken: string;
  requestId: string;
  status: 'APPROVED' | 'REJECTED';
  resolvedTicker?: string;
  resolvedName?: string;
  note?: string;
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: 'resolve_ticker_request',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    requestId: input.requestId,
    status: input.status,
    resolvedTicker: input.resolvedTicker || '',
    resolvedName: input.resolvedName || '',
    note: input.note || ''
  });
  return data.message || 'Ticker request updated';
}
