import { logActions, logTypes } from './protocol.ts';

/** AppFile as GET /get-files returns it. */
export interface RemoteFolder {
  id: number;
  name: string;
  path: string;
  observer: boolean;
  autoValidateSync: boolean;
}

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
 * log lines of one operation together.
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

  /** Id of the user that owns the API key: the routing key of this driver's command queue. */
  identity(): Promise<string> {
    return this.request<string>('GET', '/driver-identity');
  }

  folders(traceId = ''): Promise<RemoteFolder[]> {
    return this.request<RemoteFolder[]>('GET', '/get-files', { traceId });
  }

  async newTraceId(): Promise<string> {
    return String(await this.request<number>('GET', '/get-trace-id'));
  }

  /** Registers the backup and returns the presigned MinIO URL to PUT the zip to. */
  createStoredFile(appFileId: number, originalFileSize: number, traceId: string) {
    return this.request<{ appStoredFileId: number; uploadUrl: string }>('POST', '/create-app-stored-file', {
      body: { appFileId, originalFileSize },
      traceId,
    });
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
