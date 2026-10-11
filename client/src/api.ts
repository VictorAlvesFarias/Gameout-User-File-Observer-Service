import type { FolderStatus, LocalFolder, Page, PublicSettings, ServerLog, SettingsInput } from './types';

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
  checkFolder: (id: number) => request<{ status: FolderStatus }>('POST', `/folders/${id}/check`),
  createGroup: (name: string, local: LocalFolder) => request<Ok>('POST', '/groups', { name, ...local }),
  setLocal: (id: number, local: LocalFolder) => request<Ok>('PUT', `/folders/${id}/local`, local),
  removeLocal: (id: number) => request<Ok>('DELETE', `/folders/${id}/local`),
  pickFolder: () => request<{ path: string | null }>('POST', '/dialog/folder'),
  serverLogs: (page: number, pageSize: number, search: string) =>
    request<Page<ServerLog>>('GET', `/server-logs?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search })}`),
};
