declare module 'ws' {
  export default class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    constructor(url: string);
    on(event: 'open' | 'close' | 'error' | 'pong', listener: (...args: unknown[]) => void): this;
    on(event: 'message', listener: (data: { toString(): string }) => void): this;
    send(data: string): void;
    ping(): void;
    close(): void;
    terminate(): void;
  }

  export class WebSocketServer {
    constructor(options: { host?: string; port?: number; autoPong?: boolean });
    address(): { port: number } | string | null;
    once(event: 'listening', listener: () => void): this;
    once(event: 'connection', listener: (socket: WebSocket) => void): this;
    on(event: 'connection', listener: (socket: WebSocket) => void): this;
    readonly clients: Set<WebSocket>;
    close(callback?: () => void): void;
  }

  export type { WebSocket };
}
