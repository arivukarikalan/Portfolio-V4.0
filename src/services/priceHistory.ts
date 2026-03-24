import { postApi } from './api';

export type PriceHistoryPoint = {
  date: string;
  close: number;
};

export type PriceHistoryResult = {
  ticker: string;
  points: PriceHistoryPoint[];
  latest?: number;
};

export async function fetchPriceHistory(params: {
  ticker: string;
  from?: string;
  to?: string;
  days?: number;
}): Promise<PriceHistoryResult> {
  const data = await postApi<PriceHistoryResult>({
    mode: 'price_history',
    ticker: params.ticker,
    from: params.from || '',
    to: params.to || '',
    days: params.days || ''
  });
  return {
    ticker: data.ticker || params.ticker,
    points: Array.isArray(data.points) ? data.points : [],
    latest: data.latest
  };
}
