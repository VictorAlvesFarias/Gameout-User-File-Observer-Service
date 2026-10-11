export type LogLevel = 'info' | 'step' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  text: string;
}

export type LinkStatus = 'off' | 'connecting' | 'ok' | 'error';

export interface Link {
  status: LinkStatus;
  message: string;
}

export type FolderStatus = 'Pending' | 'Processing' | 'Synced' | 'Unsynced' | 'PathNotFounded' | 'LockedFiles';

/** How this PC feeds a group (kept only in this PC). */
export interface LocalFolder {
  path: string;
  observer: boolean;
  autoValidateSync: boolean;
}

/** A Gameout group and how this PC feeds it. */
export interface Folder {
  id: number;
  name: string;
  versionControl: boolean;
  status: FolderStatus | null;
  statusMessage: string | null;
  lastSyncedAt: string | null;
  lastSyncedSize: number | null;
  /** null: this PC doesn't feed the group. */
  local: LocalFolder | null;
  watching: boolean;
  problem: string | null;
  lastSync: { at: string; ok: boolean; message: string } | null;
}

export interface CurrentJob {
  appFileId: number;
  name: string;
  phase: 'scan' | 'zip' | 'upload';
  bytes: number;
  total: number | null;
  startedAt: string;
}

export interface DriverState {
  configured: boolean;
  backend: Link;
  folders: Folder[];
  checkedAt: string | null;
  queue: number[];
  current: CurrentJob | null;
}

export interface Notice {
  kind: 'ok' | 'error';
  message: string;
}

export interface Settings {
  backendUrl: string;
}

export interface PublicSettings extends Settings {
  hasApiKey: boolean;
  /** null outside the desktop app. */
  autoStart: boolean | null;
  /** The native folder dialog exists only in the desktop app. */
  canPickFolder: boolean;
}

export interface SettingsInput extends Settings {
  /** undefined keeps the stored value, "" removes it. */
  apiKey?: string;
}

/** A line of the backend's application log. */
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
