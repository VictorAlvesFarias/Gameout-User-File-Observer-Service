import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from './backend.ts';
import { compareWithLastSync, isAccessible, scanFolder, uploadFile, zipFolder } from './backup.ts';
import { notify, say, setLink, state, updateState, type CurrentJob, type Folder } from './events.ts';
import { PresenceLink } from './presence.ts';
import { commandTypes, parseStatusCheck, type DriverCommand, type DriverEvent, type FolderStatus, type StatusCheckPayload } from './protocol.ts';
import { RabbitLink } from './rabbit.ts';
import { load, socketUrlOf } from './store.ts';
import { FolderWatchers } from './watchers.ts';

const identityRetryDelay = 15_000;

interface QueueItem {
  appFileId: number;
  path: string;
  traceId: string;
}

let backend: Backend | null = null;
let rabbit: RabbitLink | null = null;
let presence: PresenceLink | null = null;
let retryTimer: NodeJS.Timeout | null = null;
/** Bumped on every (re)start, so results of an older run are ignored. */
let generation = 0;
const pending = new Map<number, QueueItem>();
let processing = false;

const watchers = new FolderWatchers(
  (folderId) => void folderChanged(folderId),
  (folderId, error) => {
    patchFolder(folderId, { watching: false, problem: `Observação interrompida: ${error.message}` });
    say(`[!] Pasta ${folderName(folderId)}: observação interrompida (${error.message})`, 'warn');
  },
);

const folderName = (id: number) => state.folders.find((folder) => folder.id === id)?.name ?? `#${id}`;

function patchFolder(id: number, patch: Partial<Folder>): void {
  updateState({ folders: state.folders.map((folder) => (folder.id === id ? { ...folder, ...patch } : folder)) });
}

// ------------------------------------------------------------------ lifecycle

/** Connects everything with the saved settings. Without an API key it waits to be configured. */
export async function startDriver(): Promise<void> {
  const run = ++generation;
  const { settings, secrets } = await load();
  const configured = Boolean(settings.backendUrl && secrets.apiKey);
  updateState({ configured });

  if (!configured) {
    setLink('backend', 'off', 'Informe o endereço do servidor e a API key nas Configurações.');
    return;
  }

  backend = new Backend(settings.backendUrl, secrets.apiKey);
  setLink('backend', 'connecting', settings.backendUrl);

  let userId: string;
  try {
    userId = await backend.identity();
  } catch (error) {
    if (run !== generation) return;
    setLink('backend', 'error', (error as Error).message);
    retryTimer = setTimeout(() => void startDriver(), identityRetryDelay);
    return;
  }
  if (run !== generation) return;

  updateState({ userId });
  setLink('backend', 'ok', settings.backendUrl);
  say(`[OK] Conectado a ${settings.backendUrl}`, 'ok');

  rabbit = new RabbitLink({ settings, password: secrets.rabbitPassword, userId, onCommand: handleCommand });
  rabbit.start();
  presence = new PresenceLink(socketUrlOf(settings), secrets.apiKey);
  presence.start();
  await refreshFolders();
}

export async function stopDriver(): Promise<void> {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  watchers.closeAll();
  presence?.stop();
  await rabbit?.stop();
  presence = null;
  rabbit = null;
  backend = null;
  setLink('backend', 'off');
  updateState({ userId: null });
}

export async function restartDriver(): Promise<void> {
  await stopDriver();
  await startDriver();
}

export const isBusy = () => processing;

// ------------------------------------------------------------------ folders

/** Reloads the folders from the backend and watches those that ask for it. */
export async function refreshFolders(traceId = ''): Promise<void> {
  if (!backend) return;
  const run = generation;
  let remote;
  try {
    remote = await backend.folders(traceId);
  } catch (error) {
    say(`[X] Não foi possível buscar as pastas: ${(error as Error).message}`, 'error');
    return;
  }
  if (run !== generation) return;

  watchers.closeAll();
  const previous = new Map(state.folders.map((folder) => [folder.id, folder]));
  const folders: Folder[] = [];

  for (const item of remote) {
    const folder: Folder = {
      id: item.id,
      name: item.name,
      path: item.path,
      observer: item.observer,
      autoValidateSync: item.autoValidateSync,
      watching: false,
      problem: null,
      lastSync: previous.get(item.id)?.lastSync ?? null,
    };

    if (folder.observer || folder.autoValidateSync) {
      if (!existsSync(folder.path)) {
        folder.problem = 'Pasta não encontrada neste PC';
        backend.log('Path not found during watcher setup', `AppFileId: ${folder.id}, Path: ${folder.path}`, traceId, { action: 'error' });
      } else if (!(await isAccessible(folder.path))) {
        folder.problem = 'Arquivos em uso por outro programa';
        backend.log('Directory not accessible (locked files) during watcher setup', `AppFileId: ${folder.id}, Path: ${folder.path}`, traceId, { action: 'error' });
      } else {
        try {
          watchers.watch(folder.id, folder.path);
          folder.watching = true;
        } catch (error) {
          folder.problem = (error as Error).message;
        }
      }
    }
    folders.push(folder);
  }

  updateState({ folders });
  say(`[OK] ${folders.filter((folder) => folder.watching).length} de ${folders.length} pasta(s) observada(s)`, 'ok');
}

async function folderChanged(folderId: number): Promise<void> {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder || !backend) return;
  const traceId = await backend.newTraceId().catch(() => '');

  if (!existsSync(folder.path)) {
    watchers.unwatch(folder.id);
    patchFolder(folder.id, { watching: false, problem: 'Pasta não encontrada neste PC' });
    sendStatus(folder.id, 'PathNotFounded', traceId);
    return;
  }

  say(`Pasta ${folder.name} alterada`);
  if (folder.autoValidateSync) sendStatus(folder.id, 'Unsynced', traceId);
  if (folder.observer) enqueue(folder.id, folder.path, traceId);
}

// ------------------------------------------------------------------ commands

async function handleCommand(command: DriverCommand): Promise<void> {
  say(`==> Comando ${command.command} (pasta ${folderName(command.appFileId)})`);
  switch (command.command.toLowerCase()) {
    case commandTypes.refreshWatchers.toLowerCase():
      await refreshFolders(command.traceId);
      break;
    case commandTypes.startBackup.toLowerCase():
      enqueue(command.appFileId, command.path, command.traceId);
      break;
    case commandTypes.scanDirectories.toLowerCase():
      await checkStatus(parseStatusCheck(command.payloadJson, { appFileId: command.appFileId, path: command.path }), command.traceId);
      break;
    case commandTypes.heartbeat.toLowerCase():
      break;
    default:
      say(`[!] Comando ${command.command} não é suportado por este driver`, 'warn');
  }
}

function event(fields: Omit<DriverEvent, 'userId' | 'createdAtUtc'>): void {
  rabbit?.publish({ ...fields, userId: state.userId ?? '', createdAtUtc: new Date().toISOString() });
}

/** The backend reads the AppFile status from the Status field of a Progress event. */
function sendStatus(appFileId: number, status: FolderStatus, traceId: string): void {
  event({ event: 'Progress', appFileId, traceId, message: status, status });
}

/** Answers a status check: compares the folder with its last synced backup. */
async function checkStatus(payload: StatusCheckPayload, traceId: string): Promise<void> {
  const { appFileId, path } = payload;
  if (pending.has(appFileId) || state.current?.appFileId === appFileId) {
    sendStatus(appFileId, 'Processing', traceId);
    return;
  }
  if (!existsSync(path)) {
    backend?.log('Path not found during status check', `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'error' });
    sendStatus(appFileId, 'PathNotFounded', traceId);
    return;
  }
  try {
    const status = compareWithLastSync(await scanFolder(path), payload);
    say(`Status de ${folderName(appFileId)}: ${status === 'Synced' ? 'sincronizada' : 'desatualizada'}`);
    sendStatus(appFileId, status, traceId);
  } catch (error) {
    backend?.log('Exception while calculating folder statistics', `AppFileId: ${appFileId}, Path: ${path}, Message: ${(error as Error).message}`, traceId, {
      action: 'warning',
      exception: true,
    });
    sendStatus(appFileId, 'Unsynced', traceId);
  }
}

// ------------------------------------------------------------------ backups

/** Queues a backup; a folder already waiting is not queued twice. */
export function enqueue(appFileId: number, path: string, traceId: string): void {
  if (pending.has(appFileId)) return;
  const folderPath = path || state.folders.find((folder) => folder.id === appFileId)?.path || '';
  pending.set(appFileId, { appFileId, path: folderPath, traceId });
  updateState({ queue: [...pending.keys()] });
  void processQueue();
}

/** Backup requested from the window. */
export async function syncNow(appFileId: number): Promise<void> {
  const folder = state.folders.find((item) => item.id === appFileId);
  if (!folder) throw new Error('Pasta não encontrada');
  const traceId = (await backend?.newTraceId().catch(() => '')) ?? '';
  enqueue(folder.id, folder.path, traceId);
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (pending.size > 0) {
      const [item] = pending.values();
      pending.delete(item.appFileId);
      updateState({ queue: [...pending.keys()] });
      await runBackup(item);
    }
  } finally {
    processing = false;
  }
}

let lastProgressPush = 0;
function progress(patch: Partial<CurrentJob>, force = false): void {
  if (!state.current) return;
  const current = { ...state.current, ...patch };
  if (!force && Date.now() - lastProgressPush < 500) {
    state.current = current;
    return;
  }
  lastProgressPush = Date.now();
  updateState({ current });
}

async function runBackup({ appFileId, path, traceId: givenTraceId }: QueueItem): Promise<void> {
  const name = folderName(appFileId);
  const traceId = givenTraceId || ((await backend?.newTraceId().catch(() => '')) ?? '');
  const zip = join(tmpdir(), `gameout-${randomUUID()}.zip`);
  const finish = (ok: boolean, message: string) => patchFolder(appFileId, { lastSync: { at: new Date().toISOString(), ok, message } });
  let appStoredFileId: number | null = null;
  let originalFileSize: number | null = null;

  say(`==> Backup de ${name}`);
  updateState({ current: { appFileId, name, phase: 'scan', bytes: 0, total: null, startedAt: new Date().toISOString() } });

  try {
    if (!backend) throw new Error('Servidor desconectado');
    if (!existsSync(path)) {
      backend.log('Path not found during processing', `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'error' });
      sendStatus(appFileId, 'PathNotFounded', traceId);
      finish(false, 'Pasta não encontrada');
      say(`[X] ${name}: pasta não encontrada (${path})`, 'error');
      return;
    }
    if (!(await isAccessible(path))) {
      backend.log('Locked files detected during processing', `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'error' });
      sendStatus(appFileId, 'LockedFiles', traceId);
      finish(false, 'Arquivos em uso por outro programa');
      say(`[X] ${name}: arquivos em uso por outro programa`, 'error');
      return;
    }

    const scan = await scanFolder(path);
    originalFileSize = scan.totalSize;
    if (scan.files.length === 0) {
      backend.log('No files found in directory during processing', `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'warning' });
      sendStatus(appFileId, 'Synced', traceId);
      finish(true, 'Pasta vazia');
      say(`[!] ${name}: pasta vazia, nada a enviar`, 'warn');
      return;
    }

    progress({ phase: 'zip', bytes: 0, total: scan.totalSize }, true);
    const zipSize = await zipFolder(scan, zip, (bytes) => progress({ bytes }));
    backend.log('ZIP file created successfully', `Size: ${zipSize} bytes, Files: ${scan.files.length}, AppFileId: ${appFileId}`, traceId);

    const created = await backend.createStoredFile(appFileId, scan.totalSize, traceId);
    appStoredFileId = created.appStoredFileId;
    event({ event: 'Started', appFileId, appStoredFileId, traceId, message: 'Backup upload started', originalFileSize });
    event({ event: 'Progress', appFileId, appStoredFileId, traceId, message: 'Uploading ZIP directly to MinIO', progress: 5, originalFileSize });

    progress({ phase: 'upload', bytes: 0, total: zipSize }, true);
    let reported = 5;
    await uploadFile(created.uploadUrl, zip, (sent, total) => {
      progress({ bytes: sent, total });
      const percent = 5 + Math.floor((sent / total) * 90);
      if (percent >= reported + 10) {
        reported = percent;
        event({ event: 'Progress', appFileId, appStoredFileId, traceId, message: 'Uploading ZIP directly to MinIO', progress: percent, originalFileSize });
      }
    });

    event({ event: 'Completed', appFileId, appStoredFileId, traceId, message: 'Backup upload completed', progress: 100, status: 'Complete', originalFileSize });
    backend.log('Direct upload to MinIO completed successfully', `AppFileId: ${appFileId}, AppStoredFileId: ${appStoredFileId}`, traceId, { action: 'success' });
    finish(true, `${scan.files.length} arquivo(s)`);
    say(`[OK] Backup de ${name} enviado`, 'ok');
  } catch (error) {
    const message = (error as Error).message;
    const code = (error as NodeJS.ErrnoException).code;
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    backend?.log('Exception during synchronization processing', `AppFileId: ${appFileId}, Path: ${path}, Message: ${message}`, traceId, {
      action: 'error',
      exception: true,
    });
    event({ event: 'Error', appFileId, appStoredFileId, traceId, message, details: (error as Error).stack ?? null, progress: 0, status: 'Error', originalFileSize });
    sendStatus(appFileId, locked ? 'LockedFiles' : 'Unsynced', traceId);
    finish(false, locked ? 'Arquivos em uso por outro programa' : message);
    say(`[X] Backup de ${name}: ${message}`, 'error');
    notify('error', `Backup de ${name} falhou: ${message}`);
  } finally {
    await rm(zip, { force: true });
    updateState({ current: null });
  }
}
