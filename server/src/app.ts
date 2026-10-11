import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { desktop } from './desktop.ts';
import { enqueue, refreshFolders, restartDriver, startDriver, syncNow } from './driver.ts';
import { recentLog, say, state, subscribe } from './events.ts';
import { paths } from './paths.ts';
import { load, parseSettings, save, socketUrlOf } from './store.ts';
import { badRequest, HttpError, optionalSecret, type Body } from './validation.ts';

// The API starts backups and stores the server credentials, so only same-machine requests are
// accepted (blocks DNS rebinding), and every state-changing request must carry a custom header
// that cross-site pages can't send without a CORS preflight (which is never granted).
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const body = (req: Request) => (req.body ?? {}) as Body;

/**
 * Trusts the Windows certificate store too, so a backend on https with the ASP.NET development
 * certificate (dotnet dev-certs https --trust) works without turning verification off.
 */
function useSystemCertificates(): void {
  const api = tls as typeof tls & {
    getCACertificates?: (type: string) => string[];
    setDefaultCACertificates?: (certificates: string[]) => void;
  };
  if (!api.getCACertificates || !api.setDefaultCACertificates) return;
  try {
    api.setDefaultCACertificates([...api.getCACertificates('default'), ...api.getCACertificates('system')]);
  } catch {
    // Keep Node's bundled list.
  }
}

/** Settings as the window sees them: secrets only say whether they are set. */
async function publicSettings() {
  const { settings, secrets } = await load();
  return {
    ...settings,
    effectiveSocketUrl: socketUrlOf(settings),
    hasApiKey: Boolean(secrets.apiKey),
    hasRabbitPassword: Boolean(secrets.rabbitPassword),
    autoStart: desktop.autoStart ? desktop.autoStart.get() : null,
  };
}

const folderId = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Pasta inválida');
  return id;
};

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', (req, res, next) => {
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    if (!allowedHosts.has(req.hostname) || (!safeMethod && req.get('x-gameout-driver') !== '1')) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });

  // Live state and log (Server-Sent Events).
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('state', state);
    send('history', recentLog());
    const unsubscribe = subscribe(send);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get('/api/settings', async (_req, res) => {
    res.json(await publicSettings());
  });

  // Saving reconnects everything with the new values.
  app.put('/api/settings', async (req, res) => {
    const settings = parseSettings(body(req));
    await save(settings, {
      apiKey: optionalSecret(body(req).apiKey, 'API key'),
      rabbitPassword: optionalSecret(body(req).rabbitPassword, 'Senha do RabbitMQ'),
    });
    say('==> Configurações salvas, reconectando');
    void restartDriver();
    res.json(await publicSettings());
  });

  app.put('/api/autostart', (req, res) => {
    if (!desktop.autoStart) throw new HttpError(409, 'Disponível só no aplicativo instalado');
    desktop.autoStart.set(body(req).enabled === true);
    res.json({ enabled: desktop.autoStart.get() });
  });

  app.post('/api/reconnect', async (_req, res) => {
    void restartDriver();
    res.json({ ok: true });
  });

  app.post('/api/folders/refresh', async (_req, res) => {
    await refreshFolders();
    res.json({ ok: true });
  });

  app.post('/api/folders/:id/sync', async (req, res) => {
    await syncNow(folderId(req));
    res.json({ ok: true });
  });

  // Every watched folder, one after the other.
  app.post('/api/folders/sync-all', (_req, res) => {
    const folders = state.folders.filter((folder) => folder.watching);
    for (const folder of folders) enqueue(folder.id, folder.path, '');
    res.json({ queued: folders.length });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (existsSync(paths.clientDistDir)) {
    app.use(express.static(paths.clientDistDir));
  }

  app.use(errorHandler);
  return app;
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.name === 'AbortError' || res.headersSent) return;
  const status = typeof error.status === 'number' ? error.status : 500;
  if (status >= 500) say(`Erro: ${error.message}`, 'error');
  res.status(status).json({ error: error.message ?? 'Erro inesperado' });
};

/** Starts the driver and its API (with the built UI, when present) on 127.0.0.1. Port 0 picks a free port. */
export async function startServer(port: number): Promise<{ port: number; close: () => void }> {
  useSystemCertificates();
  void startDriver().catch((error: Error) => say(`[X] ${error.message}`, 'error'));
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, '127.0.0.1', (error?: Error) => {
      if (error) return reject(error);
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
    });
  });
}
