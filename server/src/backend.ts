import { folderStatuses, logActions, logTypes, type FolderStatus, type Page, type RemoteGroup, type ServerLog } from './protocol.ts';

interface BaseResponse<T> {
  success: boolean;
  data: T;
  errors?: Array<{ message: string }>;
}

export class BackendError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Gameout API, authenticated as the driver (X-API-Key). X-Trace-Application-Id ties the backend's
 * log lines of one operation together. Every call also tells the backend the driver is alive (the
 * web shows the last one).
 */
export class Backend {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, { body, traceId = '' }: { body?: unknown; traceId?: string } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          ...(traceId ? { 'X-Trace-Application-Id': traceId } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      throw new BackendError(0, `Servidor inacessível (${cause?.message ?? (error as Error).message})`);
    }

    const payload = (await response.json().catch(() => null)) as BaseResponse<T> | null;
    if (response.status === 401) throw new BackendError(401, 'API key recusada pelo servidor');
    if (!response.ok || !payload || payload.success === false) {
      throw new BackendError(response.status, payload?.errors?.[0]?.message ?? `HTTP ${response.status} em ${path}`);
    }
    return payload.data;
  }

  groups(traceId = ''): Promise<RemoteGroup[]> {
    return this.request<RemoteGroup[]>('GET', '/get-files', { traceId });
  }

  /** Groups created here keep every version; the web can turn that off. */
  createGroup(name: string, traceId = ''): Promise<RemoteGroup> {
    return this.request<RemoteGroup>('POST', '/upload-file', { body: { name, versionControl: true }, traceId });
  }

  async newTraceId(): Promise<string> {
    return String(await this.request<number>('GET', '/get-trace-id'));
  }

  /** Registers the upload and returns the presigned MinIO url to PUT the zip to. */
  createStoredFile(appFileId: number, originalFileSize: number, traceId: string) {
    return this.request<{ appStoredFileId: number; uploadUrl: string }>('POST', '/create-app-stored-file', {
      body: { appFileId, originalFileSize },
      traceId,
    });
  }

  /** The zip is in MinIO: it becomes a version (and, without version control, replaces the old one). */
  completeStoredFile(appStoredFileId: number, traceId: string): Promise<void> {
    return this.request('POST', '/complete-app-stored-file', { body: { appStoredFileId }, traceId });
  }

  /** The upload failed: the record created for it is dropped. */
  cancelStoredFile(appStoredFileId: number, message: string, traceId: string): Promise<void> {
    return this.request('POST', '/cancel-app-stored-file', { body: { appStoredFileId, message }, traceId });
  }

  /** What the driver found in the folder, shown on the web. */
  setStatus(appFileId: number, status: FolderStatus, message: string | null, traceId = ''): Promise<void> {
    return this.request('PUT', '/update-appfile-status', { body: { appFileId, status: folderStatuses[status], message }, traceId });
  }

  logs(page: number, pageSize: number, search: string): Promise<Page<ServerLog>> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), searchInput: search });
    return this.request<Page<ServerLog>>('GET', `/api/application-log/traces?${query}`);
  }

  /** Mirrors a line to the backend's application log. Never throws: logging must not break a backup. */
  log(message: string, details: string, traceId: string, { action = 'info', exception = false }: { action?: keyof typeof logActions; exception?: boolean } = {}): void {
    if (!traceId) return;
    void this.request('POST', '/api/application-log/add', {
      body: { message, details, type: exception ? logTypes.exception : logTypes.message, action: logActions[action] },
      traceId,
    }).catch(() => undefined);
  }
}
