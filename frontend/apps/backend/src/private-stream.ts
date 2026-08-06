import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault } from './credential-vault.js';

const PRIVATE_CHANNELS = ['order', 'asset', 'usertrades', 'position', 'margin_position'] as const;

export interface PrivateCrossExEvent {
  channel: typeof PRIVATE_CHANNELS[number];
  payload: Record<string, unknown>;
}

export type PrivateStreamState =
  | 'disconnected'
  | 'credentials_missing'
  | 'connecting'
  | 'authenticating'
  | 'subscribing'
  | 'live'
  | 'reconnecting'
  | 'authentication_failed';

export interface PrivateStreamStatus {
  state: PrivateStreamState;
  lastEventAt: string | null;
  lastReadyAt: string | null;
  retryAttempt: number;
  lastError: string | null;
}

type Listener = (event: PrivateCrossExEvent) => void;
type StatusListener = (status: PrivateStreamStatus) => void;

const PushSchema = z.object({
  channel: z.enum(PRIVATE_CHANNELS),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const LoginResponseSchema = z.object({
  event: z.literal('login'),
  result: z.object({ code: z.string(), message: z.string() }),
});
const SubscriptionResponseSchema = z.object({
  channel: z.enum(PRIVATE_CHANNELS),
  event: z.literal('subscribe'),
  // CrossEx uses event="subscribe" for both subscription acknowledgements and
  // private data pushes. Acknowledgements echo the requested symbol list,
  // whereas pushes carry an object, so payload is the protocol discriminator.
  payload: z.array(z.string()),
  result: z.object({ code: z.string(), message: z.string() }),
  error: z.unknown().optional(),
});

function websocketSignature(secret: string, channel: string, event: string, time: number): string {
  return createHmac('sha512', secret).update(`channel=${channel}&event=${event}&time=${time}`).digest('hex');
}

function isSuccessfulLoginResponse(value: unknown): boolean {
  const parsed = LoginResponseSchema.safeParse(value);
  return parsed.success && parsed.data.result.code === '100000';
}

export class CrossExPrivateStream {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private retry = 0;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<StatusListener>();
  private status: PrivateStreamStatus = {
    state: 'disconnected',
    lastEventAt: null,
    lastReadyAt: null,
    retryAttempt: 0,
    lastError: null,
  };

  private readonly heartbeatIntervalMs: number;
  private readonly random: () => number;

  constructor(
    private readonly url: string,
    private readonly vault: CredentialVault,
    options: { heartbeatIntervalMs?: number; random?: () => number } = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setStatus('disconnected', null);
  }

  /** Re-read credentials immediately after they are added, changed, or removed. */
  restart(): void {
    if (this.stopped) return;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.retry = 0;
    void this.connect();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    try { listener(this.snapshot()); } catch { /* status observers are isolated */ }
    return () => this.statusListeners.delete(listener);
  }

  snapshot(): PrivateStreamStatus {
    return { ...this.status };
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.heartbeat = null;
    this.retryTimer = null;
  }

  private setStatus(state: PrivateStreamState, lastError: string | null = this.status.lastError): void {
    const next = { ...this.status, state, retryAttempt: this.retry, lastError };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    for (const listener of this.statusListeners) {
      try { listener(this.snapshot()); } catch { /* status observers are isolated */ }
    }
  }

  private markReady(): void {
    const now = new Date().toISOString();
    this.retry = 0;
    this.status = {
      ...this.status,
      state: 'live',
      lastReadyAt: now,
      retryAttempt: 0,
      lastError: null,
    };
    for (const listener of this.statusListeners) {
      try { listener(this.snapshot()); } catch { /* status observers are isolated */ }
    }
  }

  private markEvent(): void {
    const now = new Date().toISOString();
    const becameReady = this.status.state !== 'live';
    this.status = {
      ...this.status,
      state: 'live',
      lastEventAt: now,
      lastReadyAt: becameReady ? now : this.status.lastReadyAt,
      retryAttempt: 0,
      lastError: null,
    };
    this.retry = 0;
    if (becameReady) {
      for (const listener of this.statusListeners) {
        try { listener(this.snapshot()); } catch { /* status observers are isolated */ }
      }
    }
  }

  private scheduleRetry(baseDelayMs = 2_000, preserveState = false): void {
    if (this.stopped || this.retryTimer) return;
    const exponential = Math.min(30_000, baseDelayMs * 2 ** Math.min(4, this.retry));
    const wait = Math.round(exponential * (0.85 + this.random() * 0.3));
    this.retry += 1;
    if (!preserveState) this.setStatus('reconnecting', this.status.lastError);
    else this.status = { ...this.status, retryAttempt: this.retry };
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    const credentials = await this.vault.get(DEFAULT_CREDENTIAL_PROFILE).catch(() => null);
    if (this.stopped || this.socket) return;
    if (!credentials) {
      this.setStatus('credentials_missing', null);
      this.scheduleRetry(30_000, true);
      return;
    }

    this.setStatus(this.retry === 0 ? 'connecting' : 'reconnecting', null);
    const socket = new WebSocket(this.url);
    this.socket = socket;
    const pendingChannels = new Set<string>();
    let alive = true;

    const subscribeChannels = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      pendingChannels.clear();
      this.setStatus('subscribing', null);
      const time = Math.floor(Date.now() / 1_000);
      for (const channel of PRIVATE_CHANNELS) {
        pendingChannels.add(channel);
        socket.send(JSON.stringify({ time, event: 'subscribe', channel, request_id: randomUUID(), payload: ['!all'] }));
      }
    };

    socket.on('pong', () => { alive = true; });
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.setStatus('authenticating', null);
      const time = Math.floor(Date.now() / 1_000);
      socket.send(JSON.stringify({
        time,
        event: 'login',
        request_id: randomUUID(),
        payload: {
          method: 'api_key',
          api_key: credentials.apiKey,
          sign: websocketSignature(credentials.apiSecret, '', 'login', time),
        },
      }));
      alive = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, this.heartbeatIntervalMs);
      this.heartbeat.unref?.();
    });

    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      alive = true;
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); } catch { return; }

      if (isSuccessfulLoginResponse(raw)) {
        subscribeChannels();
        return;
      }
      const login = LoginResponseSchema.safeParse(raw);
      if (login.success) {
        this.setStatus('authentication_failed', login.data.result.message || login.data.result.code);
        socket.close();
        return;
      }

      const subscription = SubscriptionResponseSchema.safeParse(raw);
      if (subscription.success) {
        if (subscription.data.result.code !== '100000' || subscription.data.error !== undefined) {
          this.setStatus('reconnecting', `subscription_${subscription.data.channel}_failed`);
          socket.close();
          return;
        }
        pendingChannels.delete(subscription.data.channel);
        if (pendingChannels.size === 0) this.markReady();
        return;
      }

      const parsed = PushSchema.safeParse(raw);
      if (!parsed.success) return;
      this.markEvent();
      for (const listener of this.listeners) {
        try {
          listener({ channel: parsed.data.channel, payload: parsed.data.payload });
        } catch { /* a throwing listener must not tear down the private stream socket */ }
      }
    });

    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.socket = null;
      if (this.stopped) return;
      const authFailed = this.status.state === 'authentication_failed';
      this.scheduleRetry(authFailed ? 30_000 : 2_000, authFailed);
    });
  }
}

export { isSuccessfulLoginResponse, websocketSignature };
