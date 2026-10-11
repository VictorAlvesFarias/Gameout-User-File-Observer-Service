import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dataFile, paths } from './paths.ts';
import { protect, unprotect } from './secrets.ts';
import { url, type Body } from './validation.ts';

export interface Settings {
  backendUrl: string;
}

export interface Secrets {
  apiKey: string;
}

export type SecretName = keyof Secrets;

/**
 * How this PC feeds a group: which folder, and what to do when it changes. Kept only here, so each
 * PC can use its own folder for the same group.
 */
export interface LocalFolder {
  path: string;
  /** Changes start a backup. */
  observer: boolean;
  /** Changes mark the group as unsynced. */
  autoValidateSync: boolean;
}

interface Data {
  settings: Settings;
  /** DPAPI ciphertext (base64) per secret. */
  protectedSecrets: Partial<Record<SecretName, string>>;
  /** By group id. */
  folders: Record<string, LocalFolder>;
}

/** Default matches My-Personal-Compose (backend on 8201). */
export const defaultSettings = (): Settings => ({
  backendUrl: 'http://localhost:8201',
});

export function parseSettings(body: Body): Settings {
  return {
    backendUrl: url(body, 'backendUrl', 'Endereço do servidor', ['http:', 'https:']),
  };
}

const secretNames: SecretName[] = ['apiKey'];

async function readData(): Promise<Data> {
  if (!existsSync(dataFile())) return { settings: defaultSettings(), protectedSecrets: {}, folders: {} };
  const saved = JSON.parse(await readFile(dataFile(), 'utf8')) as Partial<Data>;
  // Older versions also kept RabbitMQ and WebSocket settings (and the broker password): dropped here.
  const protectedSecrets: Data['protectedSecrets'] = {};
  for (const name of secretNames) if (saved.protectedSecrets?.[name]) protectedSecrets[name] = saved.protectedSecrets[name];
  return {
    settings: { backendUrl: saved.settings?.backendUrl || defaultSettings().backendUrl },
    protectedSecrets,
    folders: saved.folders ?? {},
  };
}

async function writeData(data: Data): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  const tmp = dataFile() + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, dataFile());
}

// Decrypted once and kept in memory: DPAPI goes through PowerShell (~1 s).
let cache: { settings: Settings; secrets: Secrets; folders: Record<string, LocalFolder> } | null = null;

export async function load(): Promise<{ settings: Settings; secrets: Secrets; folders: Record<string, LocalFolder> }> {
  if (cache) return cache;
  const data = await readData();
  const names = Object.keys(data.protectedSecrets) as SecretName[];
  const plain = await unprotect(names.map((name) => data.protectedSecrets[name] as string));
  const secrets: Secrets = { apiKey: '' };
  names.forEach((name, index) => (secrets[name] = plain[index]));
  cache = { settings: data.settings, secrets, folders: data.folders };
  return cache;
}

/** Saves settings and the secrets that were sent (undefined keeps, "" removes). */
export async function save(settings: Settings, changes: Partial<Secrets>): Promise<void> {
  const data = await readData();
  const current = await load();
  const secrets = { ...current.secrets };
  const toProtect: SecretName[] = [];

  for (const [name, value] of Object.entries(changes) as Array<[SecretName, string | undefined]>) {
    if (value === undefined) continue;
    secrets[name] = value;
    if (value) toProtect.push(name);
    else delete data.protectedSecrets[name];
  }

  const ciphertexts = await protect(toProtect.map((name) => secrets[name]));
  toProtect.forEach((name, index) => (data.protectedSecrets[name] = ciphertexts[index]));
  data.settings = settings;
  await writeData(data);
  cache = { settings, secrets, folders: data.folders };
}

/** Sets (or, with null, forgets) how this PC feeds a group. */
export async function saveLocalFolder(groupId: number, folder: LocalFolder | null): Promise<void> {
  const data = await readData();
  const current = await load();
  if (folder) data.folders[String(groupId)] = folder;
  else delete data.folders[String(groupId)];
  await writeData(data);
  cache = { ...current, folders: data.folders };
}
