import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dataFile, paths } from './paths.ts';
import { protect, unprotect } from './secrets.ts';
import { amqpNameField, integer, text, url, type Body } from './validation.ts';

/** Everything that is not secret. The names match the backend's appsettings (RabbitMQ section). */
export interface Settings {
  backendUrl: string;
  /** Empty: derived from backendUrl (http -> ws, + /ws). */
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

export interface Secrets {
  apiKey: string;
  rabbitPassword: string;
}

export type SecretName = keyof Secrets;

interface Data {
  settings: Settings;
  /** DPAPI ciphertext (base64) per secret. */
  protectedSecrets: Partial<Record<SecretName, string>>;
}

/** Defaults match My-Personal-Compose (backend on 8201, RabbitMQ user "admin"). */
export const defaultSettings = (): Settings => ({
  backendUrl: 'http://localhost:8201',
  socketUrl: '',
  rabbitHost: 'localhost',
  rabbitPort: 5672,
  rabbitVirtualHost: '/',
  rabbitUser: 'admin',
  commandExchange: 'gameout.driver.commands',
  eventExchange: 'gameout.driver.events',
  driverQueuePrefix: 'gameout.driver.commands.',
  eventQueue: 'gameout.driver.events.backend',
  prefetch: 10,
});

export function parseSettings(body: Body): Settings {
  const defaults = defaultSettings();
  return {
    backendUrl: url(body, 'backendUrl', 'Endereço do servidor', ['http:', 'https:']),
    socketUrl: url(body, 'socketUrl', 'Endereço do WebSocket', ['ws:', 'wss:'], { required: false }),
    rabbitHost: text(body, 'rabbitHost', 'Servidor do RabbitMQ', { required: true, max: 200, pattern: /^[A-Za-z0-9.-]+$/ }),
    rabbitPort: integer(body, 'rabbitPort', 'Porta do RabbitMQ', 1, 65535, defaults.rabbitPort),
    rabbitVirtualHost: text(body, 'rabbitVirtualHost', 'Virtual host', { max: 100 }) || '/',
    rabbitUser: text(body, 'rabbitUser', 'Usuário do RabbitMQ', { required: true, max: 100 }),
    commandExchange: amqpNameField(body, 'commandExchange', 'Exchange de comandos', defaults.commandExchange),
    eventExchange: amqpNameField(body, 'eventExchange', 'Exchange de eventos', defaults.eventExchange),
    driverQueuePrefix: amqpNameField(body, 'driverQueuePrefix', 'Prefixo da fila', defaults.driverQueuePrefix),
    eventQueue: amqpNameField(body, 'eventQueue', 'Fila de eventos', defaults.eventQueue),
    prefetch: integer(body, 'prefetch', 'Prefetch', 1, 100, defaults.prefetch),
  };
}

async function readData(): Promise<Data> {
  if (!existsSync(dataFile())) return { settings: defaultSettings(), protectedSecrets: {} };
  const saved = JSON.parse(await readFile(dataFile(), 'utf8')) as Partial<Data>;
  return { settings: { ...defaultSettings(), ...saved.settings }, protectedSecrets: saved.protectedSecrets ?? {} };
}

async function writeData(data: Data): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  const tmp = dataFile() + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, dataFile());
}

// Decrypted once and kept in memory: DPAPI goes through PowerShell (~1 s).
let cache: { settings: Settings; secrets: Secrets } | null = null;

export async function load(): Promise<{ settings: Settings; secrets: Secrets }> {
  if (cache) return cache;
  const data = await readData();
  const names = Object.keys(data.protectedSecrets) as SecretName[];
  const plain = await unprotect(names.map((name) => data.protectedSecrets[name] as string));
  const secrets: Secrets = { apiKey: '', rabbitPassword: '' };
  names.forEach((name, index) => (secrets[name] = plain[index]));
  cache = { settings: data.settings, secrets };
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
  cache = { settings, secrets };
}

export const socketUrlOf = (settings: Settings) => settings.socketUrl || `${settings.backendUrl.replace(/^http/, 'ws')}/ws`;
