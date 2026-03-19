import { postApi } from './api';

export type NseRow = {
  symbol: string;
  name: string;
  isin?: string;
};

export type TickerRequest = {
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

type CacheEntry<T> = { ts: number; rows: T[] };

const NSE_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_CACHE_TTL_MS = 60 * 1000;

function readCacheEntry<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed?.rows || !parsed.ts) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, rows: T[]): void {
  try {
    const payload: CacheEntry<T> = { ts: Date.now(), rows };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore cache writes
  }
}

function clearCache(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore cache clearing
  }
}

export async function listNseMasterForUser(
  userId: string,
  options?: { force?: boolean }
): Promise<NseRow[]> {
  const cacheKey = `finor:nse:${userId}`;
  if (!options?.force) {
    const cached = readCacheEntry<NseRow>(cacheKey);
    if (cached && Date.now() - cached.ts <= NSE_CACHE_TTL_MS) return cached.rows;
  }
  const data = await postApi<{ rows: NseRow[] }>({ mode: 'list_nse_master_user', userId });
  const rows = data.rows || [];
  writeCache(cacheKey, rows);
  return rows;
}

export async function listTickerRequests(
  userId: string,
  options?: { force?: boolean }
): Promise<TickerRequest[]> {
  const cacheKey = `finor:ticker-req:${userId}`;
  if (!options?.force) {
    const cached = readCacheEntry<TickerRequest>(cacheKey);
    if (cached) {
      const age = Date.now() - cached.ts;
      const hasPending = cached.rows.some(
        (row) => String(row.status || '').toUpperCase() === 'PENDING'
      );
      if (!hasPending && age <= REQUEST_CACHE_TTL_MS) return cached.rows;
      if (hasPending && age <= REQUEST_CACHE_TTL_MS) return cached.rows;
    }
  }
  const data = await postApi<{ rows: TickerRequest[] }>({ mode: 'list_ticker_requests', userId });
  const rows = data.rows || [];
  writeCache(cacheKey, rows);
  return rows;
}

export async function createTickerRequest(params: {
  userId: string;
  userName: string;
  rawSymbol: string;
  note?: string;
}): Promise<{ requestId: string }> {
  const data = await postApi<{ requestId: string }>({
    mode: 'create_ticker_request',
    userId: params.userId,
    userName: params.userName,
    rawSymbol: params.rawSymbol,
    note: params.note || ''
  });
  clearCache(`finor:ticker-req:${params.userId}`);
  return data;
}

export function clearNseMasterCache(userId: string): void {
  clearCache(`finor:nse:${userId}`);
}

export function clearTickerRequestCache(userId: string): void {
  clearCache(`finor:ticker-req:${userId}`);
}
