import { postApi } from './api';

export type AppConfig = {
  maxSnapshots: number;
  livePriceRefreshSec: number;
  cloudSyncIntervalMin: number;
  toastAutoCloseSec: number;
};

export async function getAppConfig(userId: string): Promise<AppConfig> {
  const data = await postApi<AppConfig>({ mode: 'get_public_config', userId });
  return {
    maxSnapshots: Number(data.maxSnapshots || 10),
    livePriceRefreshSec: Number(data.livePriceRefreshSec || 60),
    cloudSyncIntervalMin: Number(data.cloudSyncIntervalMin || 10),
    toastAutoCloseSec: Number.isFinite(Number(data.toastAutoCloseSec)) ? Number(data.toastAutoCloseSec) : 7
  };
}
