/**
 * Contracts shared with Gameout-Backend (Domain/Queues/AppFileDtos and Application/Types there).
 * The backend serializes commands in camelCase and reads events ignoring case.
 */

export const commandTypes = {
  startBackup: 'StartBackup',
  refreshWatchers: 'RefreshWatchers',
  /** Status check: PayloadJson carries the last synced size and date. */
  scanDirectories: 'ScanDirectories',
  deleteBackup: 'DeleteBackup',
  updateConfiguration: 'UpdateConfiguration',
  heartbeat: 'Heartbeat',
} as const;

export interface DriverCommand {
  command: string;
  appFileId: number;
  appStoredFileId: number | null;
  userId: string;
  path: string;
  traceId: string;
  createdAtUtc: string;
  payloadJson: string | null;
}

export interface StatusCheckPayload {
  appFileId: number;
  path: string;
  lastSyncedFileSize: number | null;
  lastSyncedFileDate: string | null;
}

export type DriverEventType = 'Heartbeat' | 'Progress' | 'Error' | 'Completed' | 'Started';

export interface DriverEvent {
  event: DriverEventType;
  userId: string;
  appFileId: number;
  appStoredFileId?: number | null;
  traceId: string;
  message: string;
  details?: string | null;
  progress?: number | null;
  /** AppFileStatusTypes name (Synced, Unsynced...) or AppStoredFileStatusTypes name (Complete, Error). */
  status?: string | null;
  objectKey?: string | null;
  originalFileSize?: number | null;
  createdAtUtc: string;
}

/** AppFileStatusTypes, by name (that is how the driver reports them). */
export type FolderStatus = 'Pending' | 'Processing' | 'Synced' | 'Unsynced' | 'PathNotFounded' | 'LockedFiles';

export const logTypes = { exception: 2, message: 4 } as const;
export const logActions = { error: 1, warning: 2, success: 3, info: 4 } as const;

/** Wire format is camelCase, but older senders used PascalCase: read keys ignoring case. */
export function parseCommand(raw: string): DriverCommand {
  const source = JSON.parse(raw) as Record<string, unknown>;
  const value = (name: string) => Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return {
    command: String(value('command') ?? ''),
    appFileId: Number(value('appFileId') ?? 0),
    appStoredFileId: value('appStoredFileId') === null || value('appStoredFileId') === undefined ? null : Number(value('appStoredFileId')),
    userId: String(value('userId') ?? ''),
    path: String(value('path') ?? ''),
    traceId: String(value('traceId') ?? ''),
    createdAtUtc: String(value('createdAtUtc') ?? ''),
    payloadJson: typeof value('payloadJson') === 'string' ? (value('payloadJson') as string) : null,
  };
}

export function parseStatusCheck(json: string | null, fallback: { appFileId: number; path: string }): StatusCheckPayload {
  const source = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  const value = (name: string) => Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const size = value('lastSyncedFileSize');
  const date = value('lastSyncedFileDate');
  return {
    appFileId: Number(value('appFileId') ?? fallback.appFileId),
    path: String(value('path') ?? fallback.path),
    lastSyncedFileSize: size === null || size === undefined ? null : Number(size),
    lastSyncedFileDate: typeof date === 'string' ? date : null,
  };
}
