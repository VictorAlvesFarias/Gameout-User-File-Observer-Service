import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareWithLastSync, scanFolder, uploadFile, zipFolder } from '../src/backup.ts';
import { parseCommand, parseStatusCheck } from '../src/protocol.ts';
import { parseSettings, socketUrlOf, defaultSettings } from '../src/store.ts';

async function sampleFolder() {
  const root = await mkdtemp(join(tmpdir(), 'driver-test-'));
  await mkdir(join(root, 'saves', 'slot1'), { recursive: true });
  await writeFile(join(root, 'config.ini'), 'volume=10\n');
  await writeFile(join(root, 'saves', 'slot1', 'game.sav'), Buffer.alloc(200_000, 7));
  return root;
}

test('commands are read in camelCase (backend) and PascalCase (old senders)', () => {
  const camel = parseCommand('{"command":"StartBackup","appFileId":3,"userId":"u-1","path":"C:\\\\Games","traceId":"42","payloadJson":null}');
  assert.equal(camel.command, 'StartBackup');
  assert.equal(camel.appFileId, 3);
  assert.equal(camel.path, 'C:\\Games');
  const pascal = parseCommand('{"Command":"ScanDirectories","AppFileId":7,"PayloadJson":"{\\"LastSyncedFileSize\\":10}"}');
  assert.equal(pascal.command, 'ScanDirectories');
  assert.equal(pascal.appFileId, 7);
  assert.equal(parseStatusCheck(pascal.payloadJson, { appFileId: 7, path: 'x' }).lastSyncedFileSize, 10);
});

test('status check: same size and nothing newer is synced', async () => {
  const root = await sampleFolder();
  try {
    const scan = await scanFolder(root);
    assert.equal(scan.files.length, 2);
    assert.equal(scan.totalSize, 200_010);
    assert.deepEqual(scan.files.map((file) => file.entry).sort(), ['config.ini', 'saves/slot1/game.sav']);

    const later = new Date(Date.now() + 60_000);
    const localIso = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    const payload = { appFileId: 1, path: root, lastSyncedFileSize: 200_010, lastSyncedFileDate: localIso(later) };
    assert.equal(compareWithLastSync(scan, payload), 'Synced');
    assert.equal(compareWithLastSync(scan, { ...payload, lastSyncedFileSize: 5 }), 'Unsynced');
    assert.equal(compareWithLastSync(scan, { ...payload, lastSyncedFileDate: '2020-01-01T00:00:00' }), 'Unsynced');
    assert.equal(compareWithLastSync(scan, { ...payload, lastSyncedFileSize: null }), 'Unsynced');
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

test('settings: validation and the derived WebSocket address', () => {
  const settings = parseSettings({ ...defaultSettings(), backendUrl: 'https://localhost:7000/' });
  assert.equal(settings.backendUrl, 'https://localhost:7000');
  assert.equal(socketUrlOf(settings), 'wss://localhost:7000/ws');
  assert.equal(socketUrlOf({ ...settings, socketUrl: 'ws://other:1/ws' }), 'ws://other:1/ws');
  assert.throws(() => parseSettings({ ...defaultSettings(), backendUrl: 'ftp://x' }));
  assert.throws(() => parseSettings({ ...defaultSettings(), rabbitPort: 70000 }));
  assert.throws(() => parseSettings({ ...defaultSettings(), commandExchange: 'bad name' }));
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
