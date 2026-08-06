import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault } from './credential-vault.js';
import { CrossExPrivateStream, isSuccessfulLoginResponse, websocketSignature } from './private-stream.js';

async function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('CrossEx private stream liveness', () => {
  it('reports authenticated readiness only after all private channels subscribe', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const parsed = JSON.parse(String(data)) as { event?: string; channel?: string; payload?: unknown };
        if (parsed.event === 'login') {
          socket.send(JSON.stringify({ event: 'login', result: { code: '100000', message: 'success' } }));
        } else if (parsed.event === 'subscribe' && parsed.channel) {
          socket.send(JSON.stringify({
            event: 'subscribe',
            channel: parsed.channel,
            payload: parsed.payload,
            result: { code: '100000', message: 'success' },
          }));
        }
      });
    });
    const vault = new MemoryCredentialVault();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'stream-key', apiSecret: 'stream-secret' });
    const stream = new CrossExPrivateStream(`ws://127.0.0.1:${address.port}`, vault);
    try {
      stream.start();
      await waitFor(() => stream.snapshot().state === 'live');
      expect(stream.snapshot()).toMatchObject({ state: 'live', retryAttempt: 0, lastReadyAt: expect.any(String) });
    } finally {
      stream.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('delivers a documented order push instead of mistaking it for a subscription acknowledgement', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const parsed = JSON.parse(String(data)) as { event?: string; channel?: string; payload?: unknown };
        if (parsed.event === 'login') {
          socket.send(JSON.stringify({ event: 'login', result: { code: '100000', message: 'success' } }));
        } else if (parsed.event === 'subscribe' && parsed.channel) {
          socket.send(JSON.stringify({
            event: 'subscribe',
            channel: parsed.channel,
            payload: parsed.payload,
            result: { code: '100000', message: 'success' },
          }));
        }
      });
    });
    const vault = new MemoryCredentialVault();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'stream-key', apiSecret: 'stream-secret' });
    const stream = new CrossExPrivateStream(`ws://127.0.0.1:${address.port}`, vault);
    const received: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    stream.subscribe((event) => received.push(event));
    try {
      stream.start();
      await waitFor(() => stream.snapshot().state === 'live');
      [...server.clients][0]?.send(JSON.stringify({
        channel: 'order',
        event: 'subscribe',
        payload: {
          order_id: '2072652940337152',
          state: 'FILLED',
          executed_qty: '1',
          executed_avg_price: '144.81',
          update_time: '1785186948000',
        },
        result: { code: '100000', message: 'success' },
        time: 1785186948,
        time_ms: 1785186948000,
      }));
      await waitFor(() => received.length === 1);
      expect(received[0]).toEqual({
        channel: 'order',
        payload: expect.objectContaining({
          order_id: '2072652940337152',
          state: 'FILLED',
          executed_avg_price: '144.81',
        }),
      });
      expect(stream.snapshot().lastEventAt).toEqual(expect.any(String));
    } finally {
      stream.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exposes a stable missing-credentials state without opening a socket', async () => {
    const stream = new CrossExPrivateStream('ws://127.0.0.1:1', new MemoryCredentialVault(), { random: () => 0.5 });
    stream.start();
    try {
      await waitFor(() => stream.snapshot().state === 'credentials_missing');
      expect(stream.snapshot()).toMatchObject({ state: 'credentials_missing', lastReadyAt: null });
    } finally {
      stream.stop();
    }
  });

  it('terminates a private socket whose pings go unanswered and reconnects with a fresh login', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    let logins = 0;
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const parsed = JSON.parse(String(data)) as { event?: string };
        if (parsed.event === 'login') {
          logins += 1;
          socket.send(JSON.stringify({ event: 'login', result: { code: '100000', message: 'success' } }));
        }
      });
    });
    const vault = new MemoryCredentialVault();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'stream-key', apiSecret: 'stream-secret' });
    const stream = new CrossExPrivateStream(`ws://127.0.0.1:${address.port}`, vault, { heartbeatIntervalMs: 25 });
    try {
      stream.start();
      await waitFor(() => logins === 1);
      // The server answers no pings: the stream must terminate the dead socket and log in again.
      await waitFor(() => logins >= 2);
    } finally {
      stream.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('CrossEx private WebSocket authentication', () => {
  it('uses the documented channel/event/time HMAC-SHA512 envelope', () => {
    expect(websocketSignature('test-secret', '', 'login', 1_700_000_000)).toBe(
      '5bd97f59014725e3af32e17ff8e8c4ffcb6e0078a13eedc29299b9ddf69e197af114f7bba5ba5ef8c31f1e35abf2d573ad151a78c995c6d52f08eac44c813b41',
    );
  });

  it('accepts the documented login response event and success code', () => {
    expect(isSuccessfulLoginResponse({ event: 'login', result: { code: '100000', message: 'success' } })).toBe(true);
    expect(isSuccessfulLoginResponse({ event: 'api', result: { code: '100000', message: 'success' } })).toBe(false);
    expect(isSuccessfulLoginResponse({ event: 'login', result: { code: '100006', message: 'Login failed' } })).toBe(false);
  });
});
