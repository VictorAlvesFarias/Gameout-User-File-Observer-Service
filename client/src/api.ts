import type { PublicSettings, SettingsInput } from './types';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'x-gameout-driver': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Erro ${response.status}`);
  return data as T;
}

type Ok = { ok: boolean };

export const api = {
  settings: () => request<PublicSettings>('GET', '/settings'),
  saveSettings: (input: SettingsInput) => request<PublicSettings>('PUT', '/settings', input),
  setAutoStart: (enabled: boolean) => request<{ enabled: boolean }>('PUT', '/autostart', { enabled }),
  reconnect: () => request<Ok>('POST', '/reconnect'),
  refreshFolders: () => request<Ok>('POST', '/folders/refresh'),
  syncFolder: (id: number) => request<Ok>('POST', `/folders/${id}/sync`),
  syncAll: () => request<{ queued: number }>('POST', '/folders/sync-all'),
};
