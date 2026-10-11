import WebSocket from 'ws';
import { say, setLink } from './events.ts';

const reconnectDelay = 5000;

/**
 * Keeps a WebSocket open to the backend so it knows the driver is online (GET /driver-is-connected
 * lists the "drive" clients). The backend authenticates it with the type=drive cookie and X-API-Key.
 * No messages are exchanged: commands come through RabbitMQ.
 */
export class PresenceLink {
  private readonly url: string;
  private readonly apiKey: string;
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(url: string, apiKey: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.removeAllListeners();
    this.socket?.terminate();
    this.socket = null;
    setLink('socket', 'off');
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, reconnectDelay);
  }

  private connect(): void {
    setLink('socket', 'connecting', this.url);
    const socket = new WebSocket(this.url, {
      headers: { 'X-API-Key': this.apiKey, Cookie: 'type=drive' },
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    let failure = '';

    socket.on('open', () => {
      setLink('socket', 'ok', this.url);
      say('[OK] Presença registrada no servidor (WebSocket)', 'ok');
    });
    socket.on('unexpected-response', (_request, response) => {
      failure = `HTTP ${response.statusCode}`;
      socket.terminate();
    });
    socket.on('error', (error) => {
      failure ||= error.message;
    });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      const detail = failure || reason.toString() || `código ${code}`;
      setLink('socket', 'error', `Desconectado (${detail}), reconectando…`);
      this.schedule();
    });
  }
}
