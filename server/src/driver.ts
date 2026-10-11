import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from './backend.ts';
import { compareWithLastSync, isAccessible, scanFolder, uploadFile, zipFolder } from './backup.ts';
import { notify, say, setLink, state, updateState, type CurrentJob, type Folder } from './events.ts';
import { statusName, type FolderStatus, type Page, type RemoteGroup, type ServerLog } from './protocol.ts';
import { load, saveLocalFolder, type LocalFolder } from './store.ts';
import { FolderWatchers } from './watchers.ts';

/** How often the groups are read again: picks up changes made on the web and tells it the driver is alive. */
const pollInterval = 60_000;
const retryDelay = 15_000;

let backend: Backend | null = null;
let backendUrl = '';
let pollTimer: NodeJS.Timeout | null = null;
/** Bumped on every (re)start, so results of an older run are ignored. */
let generation = 0;
const pending = new Map<number, string>();
let processing = false;
/** Path each watcher was started with, to restart it only when the folder changes. */
const watchedPaths = new Map<number, string>();

const watchers = new FolderWatchers(
  (folderId) => void folderChanged(folderId),
  (folderId, error) => {
    watchedPaths.delete(folderId);
    patchFolder(folderId, { watching: false, problem: `Observação interrompida: ${error.message}` });
    say(`[!] ${folderName(folderId)}: observação interrompida (${error.message})`, 'warn');
  },
);

const folderName = (id: number) => state.folders.find((folder) => folder.id === id)?.name ?? `#${id}`;
const findFolder = (id: number) => state.folders.find((folder) => folder.id === id);

function patchFolder(id: number, patch: Partial<Folder>): void {
  updateState({ folders: state.folders.map((folder) => (folder.id === id ? { ...folder, ...patch } : folder)) });
}

/** Reports what was found in a folder; a failure only goes to the local log. */
function sendStatus(appFileId: number, status: FolderStatus, message: string | null, traceId = ''): void {
  patchFolder(appFileId, { status, statusMessage: message });
  backend?.setStatus(appFileId, status, message, traceId).catch((error: Error) => say(`[!] Status de ${folderName(appFileId)} não enviado: ${error.message}`, 'warn'));
}

// ------------------------------------------------------------------ lifecycle

/** Connects with the saved settings. Without an API key it waits to be configured. */
export async function startDriver(): Promise<void> {
  const run = ++generation;
  const { settings, secrets } = await load();
  const configured = Boolean(settings.backendUrl && secrets.apiKey);
  updateState({ configured });

  if (!configured) {
    setLink('off', 'Informe o endereço do servidor e a API key nas Configurações.');
    return;
  }

  backend = new Backend(settings.backendUrl, secrets.apiKey);
  backendUrl = settings.backendUrl;
  setLink('connecting', backendUrl);

  if (!(await refreshFolders())) {
    if (run !== generation) return;
    pollTimer = setTimeout(() => void startDriver(), retryDelay);
    return;
  }
  if (run !== generation) return;

  say(`[OK] Conectado a ${backendUrl}`, 'ok');
  // Changes made while the driver was closed: compare every folder that asks for it.
  for (const folder of state.folders) {
    if (folder.local?.autoValidateSync && folder.watching) void checkStatus(folder.id);
  }
  schedulePoll(run);
}

function schedulePoll(run: number): void {
  pollTimer = setTimeout(async () => {
    if (run !== generation) return;
    await refreshFolders();
    if (run === generation) schedulePoll(run);
  }, pollInterval);
}

export async function stopDriver(): Promise<void> {
  generation++;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  watchers.closeAll();
  watchedPaths.clear();
  backend = null;
  setLink('off');
}

export async function restartDriver(): Promise<void> {
  await stopDriver();
  await startDriver();
}

export const isBusy = () => processing;

// ------------------------------------------------------------------ groups and folders

/** Joins a group from the backend with this PC's settings for it. */
export function toFolder(group: RemoteGroup, local: LocalFolder | null, previous?: Folder): Folder {
  return {
    id: group.id,
    name: group.name,
    versionControl: group.versionControl,
    status: statusName(group.status),
    statusMessage: group.statusMessage,
    lastSyncedAt: group.lastSyncedAt,
    lastSyncedSize: group.lastSyncedSize,
    local,
    watching: previous?.watching ?? false,
    problem: previous?.problem ?? null,
    lastSync: previous?.lastSync ?? null,
  };
}

/** Why a folder can't be used right now, or null. */
async function folderProblem(path: string): Promise<{ status: FolderStatus; message: string } | null> {
  if (!existsSync(path)) return { status: 'PathNotFounded', message: 'Pasta não encontrada neste PC' };
  if (!(await isAccessible(path))) return { status: 'LockedFiles', message: 'Arquivos em uso por outro programa' };
  return null;
}

/**
 * Reads the groups from the backend, joins them with the local settings and (re)starts the watchers
 * that changed. Returns whether the backend answered.
 */
export async function refreshFolders(traceId = ''): Promise<boolean> {
  if (!backend) return false;
  const run = generation;
  let groups: RemoteGroup[];
  try {
    groups = await backend.groups(traceId);
  } catch (error) {
    if (run !== generation) return false;
    setLink('error', (error as Error).message);
    return false;
  }
  if (run !== generation) return false;
  setLink('ok', backendUrl);

  const { folders: localFolders } = await load();
  const previous = new Map(state.folders.map((folder) => [folder.id, folder]));
  const folders = groups.map((group) => toFolder(group, localFolders[String(group.id)] ?? null, previous.get(group.id)));

  // Groups deleted on the web: forget their folder on this PC.
  for (const id of Object.keys(localFolders)) {
    if (!groups.some((group) => String(group.id) === id)) {
      await saveLocalFolder(Number(id), null);
      say(`Grupo #${id} foi excluído no site; a pasta deixou de ser enviada`);
    }
  }

  const recovered: number[] = [];
  for (const folder of folders) {
    const local = folder.local;
    const wanted = local && (local.observer || local.autoValidateSync) ? local.path : null;
    const before = previous.get(folder.id)?.problem ?? null;

    if (!local) {
      folder.problem = null;
    } else {
      const problem = await folderProblem(local.path);
      folder.problem = problem?.message ?? null;
      // Reported once, when it appears, not on every poll.
      if (problem && problem.message !== before) sendStatus(folder.id, problem.status, problem.message, traceId);
      if (!problem && before && local.autoValidateSync) recovered.push(folder.id);
    }

    if (wanted && !folder.problem) {
      if (watchedPaths.get(folder.id) !== wanted) {
        watchers.unwatch(folder.id);
        try {
          watchers.watch(folder.id, wanted);
          watchedPaths.set(folder.id, wanted);
        } catch (error) {
          watchedPaths.delete(folder.id);
          folder.problem = (error as Error).message;
        }
      }
    } else if (watchedPaths.has(folder.id)) {
      watchers.unwatch(folder.id);
      watchedPaths.delete(folder.id);
    }
    folder.watching = watchedPaths.has(folder.id);
  }

  for (const id of [...watchedPaths.keys()]) {
    if (!folders.some((folder) => folder.id === id)) {
      watchers.unwatch(id);
      watchedPaths.delete(id);
    }
  }

  updateState({ folders, checkedAt: new Date().toISOString() });
  // The folder is back (or the game released its files): its real state is known again.
  for (const id of recovered) void checkStatus(id).catch(() => undefined);
  return true;
}

/** Creates a group on the backend fed by a folder of this PC. */
export async function createGroup(name: string, local: LocalFolder): Promise<void> {
  if (!backend) throw new Error('Servidor desconectado');
  const group = await backend.createGroup(name);
  await saveLocalFolder(group.id, local);
  say(`[OK] Grupo ${group.name} criado`, 'ok');
  await refreshFolders();
  if (local.observer) enqueue(group.id);
}

/** Sets (or, with null, forgets) the folder of this PC that feeds a group. */
export async function setLocalFolder(groupId: number, local: LocalFolder | null): Promise<void> {
  if (!findFolder(groupId)) throw new Error('Grupo não encontrado');
  await saveLocalFolder(groupId, local);
  say(local ? `Pasta de ${folderName(groupId)}: ${local.path}` : `${folderName(groupId)} deixou de ser enviado por este PC`);
  await refreshFolders();
  if (local?.autoValidateSync) await checkStatus(groupId);
}

async function folderChanged(folderId: number): Promise<void> {
  const folder = findFolder(folderId);
  if (!folder?.local || !backend) return;

  const problem = await folderProblem(folder.local.path);
  if (problem?.status === 'PathNotFounded') {
    watchers.unwatch(folder.id);
    watchedPaths.delete(folder.id);
    patchFolder(folder.id, { watching: false, problem: problem.message });
    sendStatus(folder.id, problem.status, problem.message);
    return;
  }

  say(`${folder.name}: pasta alterada`);
  if (folder.local.autoValidateSync) sendStatus(folder.id, 'Unsynced', 'Alterada desde o último envio');
  if (folder.local.observer) enqueue(folder.id);
}

/** Compares the folder with the latest version in the backend and reports the result. */
export async function checkStatus(appFileId: number): Promise<FolderStatus> {
  const folder = findFolder(appFileId);
  if (!folder?.local) throw new Error('Este grupo não tem pasta neste PC');
  if (pending.has(appFileId) || state.current?.appFileId === appFileId) return 'Processing';

  const problem = await folderProblem(folder.local.path);
  if (problem) {
    sendStatus(appFileId, problem.status, problem.message);
    return problem.status;
  }

  try {
    const status = compareWithLastSync(await scanFolder(folder.local.path), folder);
    say(`${folder.name}: ${status === 'Synced' ? 'sincronizado' : 'diferente da última versão'}`);
    sendStatus(appFileId, status, status === 'Synced' ? null : 'Diferente da última versão');
    return status;
  } catch (error) {
    say(`[!] ${folder.name}: não foi possível comparar (${(error as Error).message})`, 'warn');
    sendStatus(appFileId, 'Unsynced', (error as Error).message);
    return 'Unsynced';
  }
}

export function serverLogs(page: number, pageSize: number, search: string): Promise<Page<ServerLog>> {
  if (!backend) throw new Error('Servidor desconectado');
  return backend.logs(page, pageSize, search);
}

// ------------------------------------------------------------------ backups

/** Queues a backup of a group that has a folder on this PC; one already waiting is not queued twice. */
export function enqueue(appFileId: number, traceId = ''): void {
  if (pending.has(appFileId) || !findFolder(appFileId)?.local) return;
  pending.set(appFileId, traceId);
  updateState({ queue: [...pending.keys()] });
  void processQueue();
}

export function syncNow(appFileId: number): void {
  if (!findFolder(appFileId)?.local) throw new Error('Este grupo não tem pasta neste PC');
  enqueue(appFileId);
}

/** Every group with a folder on this PC, one after the other. */
export function syncAll(): number {
  const folders = state.folders.filter((folder) => folder.local && !folder.problem);
  for (const folder of folders) enqueue(folder.id);
  return folders.length;
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (pending.size > 0) {
      const [[appFileId, traceId]] = pending.entries();
      pending.delete(appFileId);
      updateState({ queue: [...pending.keys()] });
      await runBackup(appFileId, traceId);
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

/** Zips the folder, sends it straight to MinIO and confirms it (or cancels the upload when it fails). */
async function runBackup(appFileId: number, givenTraceId: string): Promise<void> {
  const folder = findFolder(appFileId);
  const path = folder?.local?.path;
  if (!folder || !path) return;
  const name = folder.name;
  const traceId = givenTraceId || ((await backend?.newTraceId().catch(() => '')) ?? '');
  const zip = join(tmpdir(), `gameout-${randomUUID()}.zip`);
  const finish = (ok: boolean, message: string) => patchFolder(appFileId, { lastSync: { at: new Date().toISOString(), ok, message } });
  let appStoredFileId: number | null = null;

  say(`==> Backup de ${name}`);
  updateState({ current: { appFileId, name, phase: 'scan', bytes: 0, total: null, startedAt: new Date().toISOString() } });

  try {
    if (!backend) throw new Error('Servidor desconectado');
    const problem = await folderProblem(path);
    if (problem) {
      backend.log(`${problem.status} during processing`, `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'error' });
      sendStatus(appFileId, problem.status, problem.message, traceId);
      finish(false, problem.message);
      say(`[X] ${name}: ${problem.message.toLowerCase()} (${path})`, 'error');
      return;
    }

    const scan = await scanFolder(path);
    if (scan.files.length === 0) {
      backend.log('No files found in directory during processing', `AppFileId: ${appFileId}, Path: ${path}`, traceId, { action: 'warning' });
      finish(true, 'Pasta vazia');
      say(`[!] ${name}: pasta vazia, nada a enviar`, 'warn');
      return;
    }

    progress({ phase: 'zip', bytes: 0, total: scan.totalSize }, true);
    const zipSize = await zipFolder(scan, zip, (bytes) => progress({ bytes }));
    backend.log('ZIP file created successfully', `Size: ${zipSize} bytes, Files: ${scan.files.length}, AppFileId: ${appFileId}`, traceId);

    const created = await backend.createStoredFile(appFileId, scan.totalSize, traceId);
    appStoredFileId = created.appStoredFileId;
    patchFolder(appFileId, { status: 'Processing', statusMessage: null });

    progress({ phase: 'upload', bytes: 0, total: zipSize }, true);
    await uploadFile(created.uploadUrl, zip, (sent, total) => progress({ bytes: sent, total }));

    await backend.completeStoredFile(appStoredFileId, traceId);
    appStoredFileId = null;
    finish(true, `${scan.files.length} arquivo(s)`);
    say(`[OK] Backup de ${name} enviado`, 'ok');
    await refreshFolders();
  } catch (error) {
    const message = (error as Error).message;
    const code = (error as NodeJS.ErrnoException).code;
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    const shown = locked ? 'Arquivos em uso por outro programa' : message;
    backend?.log('Exception during synchronization processing', `AppFileId: ${appFileId}, Path: ${path}, Message: ${message}`, traceId, {
      action: 'error',
      exception: true,
    });
    if (appStoredFileId !== null) {
      await backend?.cancelStoredFile(appStoredFileId, shown, traceId).catch(() => undefined);
    }
    sendStatus(appFileId, locked ? 'LockedFiles' : 'Unsynced', shown, traceId);
    finish(false, shown);
    say(`[X] Backup de ${name}: ${message}`, 'error');
    notify('error', `Backup de ${name} falhou: ${shown}`);
  } finally {
    await rm(zip, { force: true });
    updateState({ current: null });
  }
}
