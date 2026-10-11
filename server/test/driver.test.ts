import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareWithLastSync, scanFolder, uploadFile, zipFolder } from '../src/backup.ts';
import { toFolder } from '../src/driver.ts';
import { configurePaths, dataFile } from '../src/paths.ts';
import { statusName } from '../src/protocol.ts';
import { defaultSettings, load, parseSettings, saveLocalFolder } from '../src/store.ts';
import { folderPath } from '../src/validation.ts';

async function sampleFolder() {
  const root = await mkdtemp(join(tmpdir(), 'driver-test-'));
  await mkdir(join(root, 'saves', 'slot1'), { recursive: true });
  await writeFile(join(root, 'config.ini'), 'volume=10\n');
  await writeFile(join(root, 'saves', 'slot1', 'game.sav'), Buffer.alloc(200_000, 7));
  return root;
}

test('a group joins the backend data with this PC folder', () => {
  const group = { id: 4, name: 'Elden Ring', versionControl: true, status: 4, statusMessage: 'Alterada', lastSyncedAt: '2026-10-11T12:00:00Z', lastSyncedSize: 10 };
  const local = { path: 'C:\\Saves\\ER', observer: true, autoValidateSync: false };
  const folder = toFolder(group, local);
  assert.equal(folder.status, 'Unsynced');
  assert.equal(folder.local, local);
  assert.equal(folder.lastSyncedSize, 10);
  assert.equal(toFolder(group, null).local, null);
  // What this PC saw survives a refresh.
  const lastSync = { at: '2026-10-11T12:00:00Z', ok: true, message: '2 arquivo(s)' };
  assert.equal(toFolder(group, local, { ...folder, lastSync }).lastSync, lastSync);
  assert.equal(statusName(6), 'LockedFiles');
  assert.equal(statusName(99), null);
});

test('status check: same size and nothing newer is synced', async () => {
  const root = await sampleFolder();
  try {
    const scan = await scanFolder(root);
    assert.equal(scan.files.length, 2);
    assert.equal(scan.totalSize, 200_010);
    assert.deepEqual(scan.files.map((file) => file.entry).sort(), ['config.ini', 'saves/slot1/game.sav']);

    // The backend sends the version date in UTC ("Z").
    const last = { lastSyncedSize: 200_010, lastSyncedAt: new Date(Date.now() + 60_000).toISOString() };
    assert.equal(compareWithLastSync(scan, last), 'Synced');
    assert.equal(compareWithLastSync(scan, { ...last, lastSyncedSize: 5 }), 'Unsynced');
    assert.equal(compareWithLastSync(scan, { ...last, lastSyncedAt: '2020-01-01T00:00:00Z' }), 'Unsynced');
    assert.equal(compareWithLastSync(scan, { ...last, lastSyncedSize: null }), 'Unsynced');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('zip contains every file with forward-slash paths', async () => {
  const root = await sampleFolder();
  const target = join(tmpdir(), `driver-test-${Date.now()}.zip`);
  try {
    const scan = await scanFolder(root);
    let progress = 0;
    const size = await zipFolder(scan, target, (bytes) => (progress = bytes));
    const zip = await readFile(target);
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    assert.equal(size, zip.length);
    assert.ok(zip.includes(Buffer.from('saves/slot1/game.sav')));
    assert.equal(progress, scan.totalSize);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { force: true });
  }
});

test('a file that disappears fails the zip instead of hanging it', async () => {
  const root = await sampleFolder();
  const target = join(tmpdir(), `driver-test-${Date.now()}.zip`);
  try {
    const scan = await scanFolder(root);
    await rm(join(root, 'saves', 'slot1', 'game.sav'));
    await assert.rejects(
      Promise.race([zipFolder(scan, target, () => undefined), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('hung')), 5000))]),
      (error: Error) => error.message !== 'hung',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { force: true });
  }
});

test('upload sends the whole file with Content-Length (no chunked encoding)', async () => {
  const file = join(tmpdir(), `driver-upload-${Date.now()}.zip`);
  await writeFile(file, Buffer.alloc(300_000, 1));
  const received: { length?: string; chunked?: string; bytes: number; method?: string } = { bytes: 0 };
  const server = createServer((req, res) => {
    received.method = req.method;
    received.length = req.headers['content-length'];
    received.chunked = req.headers['transfer-encoding'];
    req.on('data', (chunk: Buffer) => (received.bytes += chunk.length));
    req.on('end', () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    let last = 0;
    await uploadFile(`http://127.0.0.1:${port}/bucket/key?X-Amz-Signature=abc`, file, (sent) => (last = sent));
    assert.equal(received.method, 'PUT');
    assert.equal(received.length, '300000');
    assert.equal(received.chunked, undefined);
    assert.equal(received.bytes, 300_000);
    assert.equal(last, 300_000);
  } finally {
    server.close();
    await rm(file, { force: true });
  }
});

test('upload failure carries the MinIO answer', async () => {
  const file = join(tmpdir(), `driver-upload-${Date.now()}.zip`);
  await writeFile(file, 'x');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 403;
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await assert.rejects(uploadFile(`http://127.0.0.1:${port}/x`, file, () => undefined), /403.*SignatureDoesNotMatch/);
  } finally {
    server.close();
    await rm(file, { force: true });
  }
});

test('settings: server address validation', () => {
  assert.equal(parseSettings({ ...defaultSettings(), backendUrl: 'https://localhost:7000/' }).backendUrl, 'https://localhost:7000');
  assert.throws(() => parseSettings({ backendUrl: 'ftp://x' }));
  assert.throws(() => parseSettings({ backendUrl: '' }));
});

test('folders must be full Windows paths', () => {
  assert.equal(folderPath({ path: 'C:\\Jogos\\Saves\\' }, 'path', 'Pasta'), 'C:\\Jogos\\Saves');
  assert.equal(folderPath({ path: 'd:/games/saves' }, 'path', 'Pasta'), 'd:\\games\\saves');
  assert.equal(folderPath({ path: 'C:\\' }, 'path', 'Pasta'), 'C:\\');
  assert.equal(folderPath({ path: '\\\\nas\\backup\\saves' }, 'path', 'Pasta'), '\\\\nas\\backup\\saves');
  assert.throws(() => folderPath({ path: 'saves' }, 'path', 'Pasta'), /caminho completo/);
  assert.throws(() => folderPath({ path: 'C:saves' }, 'path', 'Pasta'), /caminho completo/);
  assert.throws(() => folderPath({ path: '' }, 'path', 'Pasta'), /obrigatório/);
});

test('data of older versions drops the RabbitMQ settings and keeps the folders per group', async () => {
  const home = await mkdtemp(join(tmpdir(), 'driver-home-'));
  configurePaths({ dataDir: home });
  try {
    const old = { settings: { backendUrl: 'http://srv:8201', rabbitHost: 'srv', socketUrl: '' }, protectedSecrets: { rabbitPassword: 'cipher' } };
    await writeFile(dataFile(), JSON.stringify(old));
    const loaded = await load();
    assert.deepEqual(loaded.settings, { backendUrl: 'http://srv:8201' });
    assert.equal(loaded.secrets.apiKey, '');
    assert.deepEqual(loaded.folders, {});

    await saveLocalFolder(7, { path: 'C:\\Saves', observer: true, autoValidateSync: true });
    const saved = JSON.parse(await readFile(dataFile(), 'utf8'));
    assert.deepEqual(saved.folders['7'], { path: 'C:\\Saves', observer: true, autoValidateSync: true });
    assert.equal(saved.protectedSecrets.rabbitPassword, undefined);
    assert.equal((await load()).folders['7'].path, 'C:\\Saves');

    await saveLocalFolder(7, null);
    assert.deepEqual(JSON.parse(await readFile(dataFile(), 'utf8')).folders, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('mtime is kept on scanned files', async () => {
  const root = await sampleFolder();
  try {
    const old = new Date('2024-01-02T03:04:05Z');
    await utimes(join(root, 'config.ini'), old, old);
    const scan = await scanFolder(root);
    assert.equal(scan.files.find((file) => file.entry === 'config.ini')?.mtimeMs, old.getTime());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
