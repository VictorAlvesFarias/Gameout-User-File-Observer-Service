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

// RabbitMQ names: letters, digits and the separators the backend uses (gameout.driver.commands).
const amqpName = /^[A-Za-z0-9._:-]+$/;

export const amqpNameField = (body: Body, field: string, label: string, fallback: string) =>
  text(body, field, label, { max: 200, pattern: amqpName, patternMessage: `${label}: use letras, números, ponto, hífen e dois-pontos` }) || fallback;
