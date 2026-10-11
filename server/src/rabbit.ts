import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { say, setLink } from './events.ts';
import { parseCommand, type DriverCommand, type DriverEvent } from './protocol.ts';
import type { Settings } from './store.ts';

const reconnectDelay = 5000;

export interface RabbitOptions {
  settings: Settings;
  password: string;
  userId: string;
  onCommand: (command: DriverCommand) => Promise<void>;
}

/**
 * The driver's side of the backend's RabbitMQ contract:
 * - commands: queue <prefix><userId>, bound to the command exchange with the user id as routing key
 *   (the backend publishes with appFile.UserId);
 * - events: published to the event exchange with the backend's queue name as routing key.
 * Reconnects on its own while started.
 */
export class RabbitLink {
  private readonly options: RabbitOptions;
  private connection: ChannelModel | null = null;
  private publisher: Channel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private warnedDrop = false;

  constructor(options: RabbitOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const connection = this.connection;
    this.connection = null;
    this.publisher = null;
    await connection?.close().catch(() => undefined);
    setLink('rabbit', 'off');
  }

  /** Events are best effort: without a connection they are dropped, with one warning per outage. */
  publish(event: DriverEvent): void {
    const { settings } = this.options;
    if (!this.publisher) {
      if (!this.warnedDrop) say('[!] RabbitMQ desconectado: o progresso e o status das pastas não chegam ao servidor até reconectar', 'warn');
      this.warnedDrop = true;
      return;
    }
    this.publisher.publish(settings.eventExchange, settings.eventQueue, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
    });
  }

  private url(): string {
    const { settings, password } = this.options;
    const credentials = `${encodeURIComponent(settings.rabbitUser)}:${encodeURIComponent(password)}`;
    return `amqp://${credentials}@${settings.rabbitHost}:${settings.rabbitPort}/${encodeURIComponent(settings.rabbitVirtualHost)}`;
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, reconnectDelay);
  }

  private async connect(): Promise<void> {
    const { settings, userId, onCommand } = this.options;
    const queue = `${settings.driverQueuePrefix}${userId}`;
    setLink('rabbit', 'connecting', `${settings.rabbitHost}:${settings.rabbitPort}`);

    try {
      const connection = await amqp.connect(this.url(), { timeout: 10_000 });
      if (this.stopped) {
        await connection.close();
        return;
      }
      this.connection = connection;
      connection.on('error', (error: Error) => say(`[!] RabbitMQ: ${error.message}`, 'warn'));
      connection.on('close', () => {
        this.connection = null;
        this.publisher = null;
        if (this.stopped) return;
        setLink('rabbit', 'error', 'Conexão perdida, reconectando…');
        this.schedule();
      });

      const consumer = await connection.createChannel();
      await consumer.assertExchange(settings.commandExchange, 'direct', { durable: true });
      await consumer.assertQueue(queue, { durable: true, exclusive: false, autoDelete: false });
      await consumer.bindQueue(queue, settings.commandExchange, userId);
      await consumer.prefetch(settings.prefetch);
      await consumer.consume(queue, (message) => {
        if (!message) return;
        let command: DriverCommand;
        try {
          command = parseCommand(message.content.toString('utf8'));
        } catch {
          say('[!] Comando inválido descartado', 'warn');
          consumer.ack(message);
          return;
        }
        // Acknowledged after handling; a failure is logged, not redelivered forever.
        onCommand(command)
          .catch((error: Error) => say(`[X] Comando ${command.command}: ${error.message}`, 'error'))
          .finally(() => consumer.ack(message));
      });

      const publisher = await connection.createChannel();
      await publisher.assertExchange(settings.eventExchange, 'direct', { durable: true });
      this.publisher = publisher;
      this.warnedDrop = false;

      setLink('rabbit', 'ok', `Fila ${queue}`);
      say(`[OK] RabbitMQ conectado (fila ${queue})`, 'ok');
    } catch (error) {
      const message = (error as Error).message;
      setLink('rabbit', 'error', /ACCESS_REFUSED|403/.test(message) ? 'Usuário ou senha do RabbitMQ recusados' : message);
      this.schedule();
    }
  }
}
