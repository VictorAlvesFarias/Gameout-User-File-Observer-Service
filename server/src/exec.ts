import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called for every complete output line (stdout and stderr), as it arrives. */
  onLine?: (line: string) => void;
}

// wsl.exe prints its own messages as UTF-16; dropping NULs makes them readable either way.
const clean = (text: string) => text.replace(/\0/g, '');

export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      windowsHide: true,
      signal: options.signal,
      timeout: options.timeoutMs,
    });
    const output = { stdout: '', stderr: '' };
    const pending = { stdout: '', stderr: '' };

    for (const stream of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8');
      // Progress bars redraw the same line with \r: treat it as a line end so they show up live.
      const flushLines = (final: boolean) => {
        const lines = pending[stream].split(/\r?\n|\r/);
        pending[stream] = final ? '' : (lines.pop() ?? '');
        for (const line of lines) if (line.trim()) options.onLine?.(line);
      };
      child[stream].on('data', (chunk: Buffer) => {
        const text = clean(decoder.write(chunk));
        output[stream] += text;
        if (options.onLine) {
          pending[stream] += text;
          flushLines(false);
        }
      });
      child[stream].on('end', () => {
        const rest = clean(decoder.end());
        output[stream] += rest;
        if (options.onLine) {
          pending[stream] += rest;
          flushLines(true);
        }
      });
    }

    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, ...output }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

/** Runs a PowerShell command and returns its standard output (UTF-8). */
export async function powershell(command: string, options: ExecOptions & { sta?: boolean } = {}): Promise<ExecResult> {
  const prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(options.sta ? ['-STA'] : []), '-Command', prefix + command];
  return exec('powershell.exe', args, options);
}
