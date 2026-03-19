import type { LivePrice } from '../core/types';
import { postApi } from './api';

function normalizeTicker(value: string): string {
  return String(value || '').trim().toUpperCase();
}

export type LiveSyncResult = {
  prices: Record<string, LivePrice>;
  success: number;
  failedTickers: string[];
  failureReasons?: Record<string, string>;
};

export async function syncLivePrices(tickers: string[]): Promise<LiveSyncResult> {
  const cleaned = Array.from(new Set(tickers.map((t) => normalizeTicker(t)).filter(Boolean)));
  if (!cleaned.length) return { prices: {}, success: 0, failedTickers: [], failureReasons: {} };
  const data = await postApi<LiveSyncResult>({ mode: 'live_prices', tickers: cleaned });
  return {
    prices: data.prices || {},
    success: Number(data.success || 0),
    failedTickers: Array.isArray(data.failedTickers) ? data.failedTickers : [],
    failureReasons: data.failureReasons || {}
  };
}
