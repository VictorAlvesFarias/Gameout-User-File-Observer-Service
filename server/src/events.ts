export type LogLevel = 'info' | 'step' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  text: string;
}

export type LinkStatus = 'off' | 'connecting' | 'ok' | 'error';

/** One of the three connections the driver keeps: backend API, RabbitMQ and the presence socket. */
export interface Link {
  status: LinkStatus;
  message: string;
}

export interface FolderSync {
  at: string;
  ok: boolean;
  message: string;
}

/** A folder registered in Gameout (an AppFile) as the driver sees it. */
export interface Folder {
  id: number;
  name: string;
  path: string;
  /** Changes start a backup. */
  observer: boolean;
  /** Changes mark the folder as unsynced. */
  autoValidateSync: boolean;
  watching: boolean;
  /** Why the folder is not being watched (missing, locked...). */
  problem: string | null;
  lastSync: FolderSync | null;
}

/** The backup in progress. */
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
  /** Owner of the API key (the routing key of this driver's command queue). */
  userId: string | null;
  backend: Link;
  rabbit: Link;
  socket: Link;
  folders: Folder[];
  /** Folders waiting for a backup, in order. */
  queue: number[];
  current: CurrentJob | null;
}

export interface Notice {
  kind: 'ok' | 'error';
  message: string;
}

type Listener = (event: 'state' | 'log' | 'notice', data: unknown) => void;

const maxLog = 500;
let nextId = 1;
const log: LogEntry[] = [];
const listeners = new Set<Listener>();
const off = (): Link => ({ status: 'off', message: '' });

export const state: DriverState = {
  configured: false,
  userId: null,
  backend: off(),
  rabbit: off(),
  socket: off(),
  folders: [],
  queue: [],
  current: null,
};

function classify(text: string): LogLevel {
  if (/^==>/.test(text)) return 'step';
  if (/^\s*\[OK\]/.test(text)) return 'ok';
  if (/^\s*\[!\]|^Aviso/.test(text)) return 'warn';
  if (/^\s*\[X\]|^Erro|^Falha/.test(text)) return 'error';
  return 'info';
}

export function say(text: string, level?: LogLevel): void {
  const entry: LogEntry = { id: nextId++, time: new Date().toISOString(), level: level ?? classify(text), text: text.trimEnd() };
  log.push(entry);
  if (log.length > maxLog) log.splice(0, log.length - maxLog);
  for (const listener of listeners) listener('log', entry);
}

export function updateState(patch: Partial<DriverState>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener('state', state);
}

export function setLink(name: 'backend' | 'rabbit' | 'socket', status: LinkStatus, message = ''): void {
  if (state[name].status === status && state[name].message === message) return;
  updateState({ [name]: { status, message } });
}

/** Toast in every open window (and a balloon from the tray icon in the desktop app). */
export function notify(kind: Notice['kind'], message: string): void {
  for (const listener of listeners) listener('notice', { kind, message } satisfies Notice);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const recentLog = (limit = 200) => log.slice(-limit);
