import type {
  IWebSocketCloseInfo,
  IWebSocketConnectOptions,
  IWebSocketMessageEnvelope,
  IWebSocketMessageHandler,
  IWebSocketTransport,
} from '@mcp-abap-adt/interfaces';

/**
 * Minimal WS-like instance contract to avoid hard dependency on a specific WS library.
 */
interface IWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose:
    | ((event: { code?: number; reason?: string; wasClean?: boolean }) => void)
    | null;
}

interface IWebSocketFactory {
  create(
    url: string,
    protocols?: string | string[],
    options?: IWebSocketConnectOptions,
  ): IWebSocketLike;
}

const WS_OPEN = 1;

export class GenericWebSocketTransport implements IWebSocketTransport {
  private socket: IWebSocketLike | null = null;
  private messageHandlers: Array<IWebSocketMessageHandler<unknown>> = [];
  private openHandlers: Array<() => void | Promise<void>> = [];
  private errorHandlers: Array<(error: Error) => void | Promise<void>> = [];
  private closeHandlers: Array<
    (info: IWebSocketCloseInfo) => void | Promise<void>
  > = [];

  constructor(private readonly factory: IWebSocketFactory) {}

  async connect(
    url: string,
    options?: IWebSocketConnectOptions,
  ): Promise<void> {
    if (this.socket && this.isConnected()) {
      return;
    }

    const connectTimeoutMs = options?.connectTimeoutMs ?? 15000;
    const socket = this.factory.create(url, options?.protocols, options);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`),
        );
      }, connectTimeoutMs);

      socket.onopen = () => {
        clearTimeout(timeoutId);
        this.emitOpen().catch(() => {
          // no-op
        });
        resolve();
      };

      socket.onerror = (event) => {
        clearTimeout(timeoutId);
        const err = this.normalizeError(event, 'WebSocket connection error');
        this.emitError(err).catch(() => {
          // no-op
        });
        reject(err);
      };

      socket.onclose = (event) => {
        clearTimeout(timeoutId);
        const info: IWebSocketCloseInfo = {
          code: typeof event?.code === 'number' ? event.code : 1006,
          reason: event?.reason,
          wasClean: event?.wasClean,
        };
        this.emitClose(info).catch(() => {
          // no-op
        });
      };

      socket.onmessage = (event) => {
        this.handleIncomingMessage(event?.data).catch(() => {
          // no-op
        });
      };
    });
  }

  async disconnect(code?: number, reason?: string): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = null;

    try {
      socket.close(code, reason);
    } catch (error) {
      const err = this.normalizeError(error, 'WebSocket close failed');
      await this.emitError(err);
    }
  }

  async send<T = unknown>(
    message: IWebSocketMessageEnvelope<T>,
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.socket.send(JSON.stringify(message));
  }

  onMessage<T = unknown>(handler: IWebSocketMessageHandler<T>): void {
    this.messageHandlers.push(handler as IWebSocketMessageHandler<unknown>);
  }

  onOpen(handler: () => void | Promise<void>): void {
    this.openHandlers.push(handler);
  }

  onError(handler: (error: Error) => void | Promise<void>): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: (info: IWebSocketCloseInfo) => void | Promise<void>): void {
    this.closeHandlers.push(handler);
  }

  isConnected(): boolean {
    return !!this.socket && this.socket.readyState === WS_OPEN;
  }

  private async handleIncomingMessage(rawData: unknown): Promise<void> {
    try {
      const text =
        typeof rawData === 'string'
          ? rawData
          : rawData instanceof Buffer
            ? rawData.toString('utf8')
            : String(rawData ?? '');

      const parsed = JSON.parse(text) as IWebSocketMessageEnvelope<unknown>;
      for (const handler of this.messageHandlers) {
        await handler(parsed);
      }
    } catch (error) {
      await this.emitError(
        this.normalizeError(error, 'Failed to process WS message'),
      );
    }
  }

  private normalizeError(error: unknown, fallback: string): Error {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === 'string' && error.trim()) {
      return new Error(error.trim());
    }
    return new Error(fallback);
  }

  private async emitOpen(): Promise<void> {
    for (const handler of this.openHandlers) {
      await handler();
    }
  }

  private async emitError(error: Error): Promise<void> {
    for (const handler of this.errorHandlers) {
      await handler(error);
    }
  }

  private async emitClose(info: IWebSocketCloseInfo): Promise<void> {
    for (const handler of this.closeHandlers) {
      await handler(info);
    }
  }
}

export type { IWebSocketFactory, IWebSocketLike };
