/**
 * Contracts shared with Gameout-Backend. Every exchange starts on the driver, over HTTP with the
 * API key: the backend never calls the driver.
 */

/** AppFileStatusTypes (Application/Types there), sent by value. */
export const folderStatuses = {
  Pending: 1,
  Processing: 2,
  Synced: 3,
  Unsynced: 4,
  PathNotFounded: 5,
  LockedFiles: 6,
} as const;

export type FolderStatus = keyof typeof folderStatuses;

export const statusName = (value: number): FolderStatus | null =>
  (Object.keys(folderStatuses) as FolderStatus[]).find((name) => folderStatuses[name] === value) ?? null;

/** A group as GET /get-files returns it (AppFileResponseDto). */
export interface RemoteGroup {
  id: number;
  name: string;
  versionControl: boolean;
  status: number;
  statusMessage: string | null;
  /** Latest confirmed version (UTC) and the folder size it had. */
  lastSyncedAt: string | null;
  lastSyncedSize: number | null;
}

/** ApplicationLogResponseDto, one page at a time. */
export interface ServerLog {
  id: number;
  message: string;
  details: string | null;
  traceId: number;
  type: string;
  action: string;
  createDate: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export const logTypes = { exception: 2, message: 4 } as const;
export const logActions = { error: 1, warning: 2, success: 3, info: 4 } as const;
