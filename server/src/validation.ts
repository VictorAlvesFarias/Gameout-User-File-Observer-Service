import { win32 } from 'node:path';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);

export type Body = Record<string, unknown>;

const control = /[\r\n\0]/;

export function text(body: Body, field: string, label: string, { required = false, max = 200, pattern = undefined as RegExp | undefined, patternMessage = '' } = {}): string {
  const raw = body[field];
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw badRequest(`${label} inválido`);
  const value = (raw ?? '').trim();
  if (required && !value) throw badRequest(`${label} é obrigatório`);
  if (value.length > max) throw badRequest(`${label} é muito longo`);
  if (control.test(value)) throw badRequest(`${label} não pode ter quebras de linha`);
  if (value && pattern && !pattern.test(value)) throw badRequest(patternMessage || `${label} inválido`);
  return value;
}

export function integer(body: Body, field: string, label: string, min: number, max: number, fallback: number): number {
  const raw = body[field] ?? fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${label} deve ser um número de ${min} a ${max}`);
  }
  return value;
}

/** An absolute http(s) or ws(s) address, stored without the trailing slash. */
export function url(body: Body, field: string, label: string, protocols: string[], { required = true } = {}): string {
  const value = text(body, field, label, { required, max: 500 });
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest(`${label} inválido`);
  }
  if (!protocols.includes(parsed.protocol)) throw badRequest(`${label} deve começar com ${protocols.map((p) => `${p}//`).join(' ou ')}`);
  return value.replace(/\/+$/, '');
}

/** A secret typed in a password field: undefined keeps the stored one, "" removes it. */
export function optionalSecret(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${label} inválida`);
  if (control.test(value)) throw badRequest(`${label} não pode ter quebras de linha`);
  if (value.length > 500) throw badRequest(`${label} é muito longa`);
  return value;
}

export function bool(body: Body, field: string, label: string): boolean {
  const value = body[field] ?? false;
  if (typeof value !== 'boolean') throw badRequest(`${label} inválido`);
  return value;
}

/** An absolute folder on this PC: C:\Games\Saves or \\server\share\saves. */
export function folderPath(body: Body, field: string, label: string): string {
  const value = win32.normalize(text(body, field, label, { required: true, max: 1000 }));
  if (!/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(value)) throw badRequest(`${label} deve ser um caminho completo, como C:\\Jogos\\Saves`);
  // C:\ keeps its slash; any other trailing one goes.
  return value.length > 3 ? value.replace(/\\+$/, '') : value;
}
