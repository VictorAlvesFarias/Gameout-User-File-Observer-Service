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

export interface Folder {
  id: number;
  name: string;
  path: string;
  observer: boolean;
  autoValidateSync: boolean;
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
  userId: string | null;
  backend: Link;
  rabbit: Link;
  socket: Link;
  folders: Folder[];
  queue: number[];
  current: CurrentJob | null;
}

export interface Notice {
  kind: 'ok' | 'error';
  message: string;
}

export interface Settings {
  backendUrl: string;
  socketUrl: string;
  rabbitHost: string;
  rabbitPort: number;
  rabbitVirtualHost: string;
  rabbitUser: string;
  commandExchange: string;
  eventExchange: string;
  driverQueuePrefix: string;
  eventQueue: string;
  prefetch: number;
}

export interface PublicSettings extends Settings {
  effectiveSocketUrl: string;
  hasApiKey: boolean;
  hasRabbitPassword: boolean;
  /** null outside the desktop app. */
  autoStart: boolean | null;
}

export interface SettingsInput extends Settings {
  /** undefined keeps the stored value, "" removes it. */
  apiKey?: string;
  rabbitPassword?: string;
}
