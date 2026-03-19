import { APPS_SCRIPT_URL } from '../core/constants';

export type ApiResponse<T> = {
  ok: boolean;
  message?: string;
  data?: T;
};

export function assertAppsScriptUrl(): void {
  if (!APPS_SCRIPT_URL) {
    throw new Error('Apps Script URL is missing. Set VITE_APPS_SCRIPT_URL in your env file.');
  }
}

export async function postApi<T>(body: Record<string, unknown>): Promise<T> {
  assertAppsScriptUrl();
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  if (payload.data === undefined) {
    return {} as T;
  }

  return payload.data;
}

export async function getApi<T>(params: Record<string, string>): Promise<T> {
  assertAppsScriptUrl();
  const endpoint = new URL(APPS_SCRIPT_URL);
  Object.entries(params).forEach(([key, value]) => endpoint.searchParams.set(key, value));
  const response = await fetch(endpoint.toString(), { method: 'GET' });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  if (payload.data === undefined) {
    return {} as T;
  }

  return payload.data;
}
