import { createReadStream, createWriteStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { FolderStatus, StatusCheckPayload } from './protocol.ts';

export interface ScannedFile {
  path: string;
  /** Path inside the zip, with forward slashes. */
  entry: string;
  size: number;
  mtimeMs: number;
}

export interface FolderScan {
  files: ScannedFile[];
  totalSize: number;
  /** Most recent modification, in ms. */
  newest: number | null;
}

/** Every file under the folder (recursively), with its size and modification time. */
export async function scanFolder(root: string): Promise<FolderScan> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    files.push({ path, entry: relative(root, path).split(sep).join('/'), size: info.size, mtimeMs: info.mtimeMs });
  }
  return {
    files,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    newest: files.length ? Math.max(...files.map((file) => file.mtimeMs)) : null,
  };
}

/**
 * Whether the files at the top of the folder can be opened for reading. A game holding its save
 * files open (Windows sharing violation) makes a backup fail, so the folder is reported as locked.
 */
export async function isAccessible(root: string): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const handle = await open(join(root, entry.name), 'r');
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

const counter = (onBytes: (bytes: number) => void) =>
  new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });

/** Zips the scanned files into target; files are opened one at a time, as the zip is written. */
export async function zipFolder(scan: FolderScan, target: string, onProgress: (bytesRead: number) => void): Promise<number> {
  const zip = new yazl.ZipFile();
  let read = 0;

  for (const file of scan.files) {
    zip.addReadStreamLazy(file.entry, { mtime: new Date(file.mtimeMs), size: file.size }, (callback) => {
      const input = createReadStream(file.path);
      const counted = counter((bytes) => {
        read += bytes;
        onProgress(read);
      });
      // A file that can't be read (locked by a game) must fail the zip, not leave it waiting. yazl
      // doesn't listen to its read streams' errors, so the error is handed to the zip itself.
      input.on('error', (error) => {
        counted.destroy();
        zip.emit('error', error);
      });
      callback(null, input.pipe(counted));
    });
  }
  zip.end();

  const output = createWriteStream(target);
  const failed = new Promise<never>((_resolve, reject) => {
    zip.on('error', (error: Error) => {
      output.destroy();
      reject(error);
    });
  });
  const written = pipeline(zip.outputStream, output);
  // When the zip fails, aborting the output rejects this too: the zip error is the one reported.
  written.catch(() => undefined);
  await Promise.race([written, failed]);
  return (await stat(target)).size;
}

/**
 * PUTs the zip to the presigned MinIO URL. Content-Length is sent explicitly: S3 presigned uploads
 * reject chunked transfer encoding.
 */
export async function uploadFile(url: string, file: string, onProgress: (bytesSent: number, total: number) => void): Promise<void> {
  const total = (await stat(file)).size;
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  let sent = 0;

  await new Promise<void>((resolve, reject) => {
    const request = client.request(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': total },
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve();
        else reject(new Error(`MinIO respondeu HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    request.on('error', reject);

    const input = createReadStream(file);
    input.on('error', reject);
    input
      .pipe(
        counter((bytes) => {
          sent += bytes;
          onProgress(sent, total);
        }),
      )
      .pipe(request);
  });
}

/**
 * Compares the folder with the last synced backup, like the .NET driver did: a different total size,
 * or any file changed after the backup, means it is out of sync. Dates without a zone are local time
 * on both sides.
 */
export function compareWithLastSync(scan: FolderScan, payload: StatusCheckPayload): FolderStatus {
  if (payload.lastSyncedFileSize === null || payload.lastSyncedFileDate === null) return 'Unsynced';
  if (payload.lastSyncedFileSize !== scan.totalSize) return 'Unsynced';
  const syncedAt = Date.parse(payload.lastSyncedFileDate);
  if (Number.isNaN(syncedAt)) return 'Unsynced';
  return scan.newest !== null && scan.newest > syncedAt ? 'Unsynced' : 'Synced';
}
