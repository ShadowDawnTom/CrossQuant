import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { CrossExMarketHub, invalidSymbolsFromMessage, type MarketHubMessage } from './market-hub.js';

type ServerSocket = WebSocketDefault;

interface HubHarness {
  hub: CrossExMarketHub;
  server: WebSocketServer;
  socket: ServerSocket;
  received: Array<Record<string, unknown>>;
  messages: MarketHubMessage[];
}

const harnesses: HubHarness[] = [];

async function createHubHarness(): Promise<HubHarness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing server address');
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`);
  const received: Array<Record<string, unknown>> = [];
  const messages: MarketHubMessage[] = [];
  hub.subscribe((message) => messages.push(message));
  const socketPromise = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  hub.start();
  const socket = await socketPromise;
  socket.on('message', (data: { toString(): string }) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  const harness = { hub, server, socket, received, messages };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.hub.stop();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('CrossEx market subscription recovery', () => {
  it('extracts unsupported symbols from Gate subscription failures', () => {
    expect(invalidSymbolsFromMessage('There are unsupported symbols, invalidSymbols:[BINANCE_FUTURE_PEPE_USDT,DERIBIT_FUTURE_ARB_USDC]')).toEqual([
      'BINANCE_FUTURE_PEPE_USDT',
      'DERIBIT_FUTURE_ARB_USDC',
    ]);
    expect(invalidSymbolsFromMessage('another error')).toEqual([]);
  });
});

describe('CrossEx websocket liveness', () => {
  it('terminates and reconnects a half-dead socket that stops answering pings', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    let connections = 0;
    server.on('connection', () => { connections += 1; });
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, { heartbeatIntervalMs: 25, staleAfterMs: 10_000 });
    try {
      hub.start();
      await waitFor(() => connections === 1);
      // No pongs and no data: the hub must terminate the dead socket and dial again.
      await waitFor(() => connections >= 2, 5_000);
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a stale connection when the feed goes quiet and recovers when data resumes', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    const socketPromise = new Promise<WebSocketDefault>((resolve) => server.once('connection', resolve));
    const hub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`, { heartbeatIntervalMs: 20, staleAfterMs: 50 });
    const messages: MarketHubMessage[] = [];
    hub.subscribe((message) => messages.push(message));
    try {
      hub.start();
      const socket = await socketPromise;
      // Pings are answered (socket is alive) but no pushes arrive: the hub must degrade to stale.
      await waitFor(() => hub.snapshot().connectionState === 'stale', 3_000);
      expect(messages.some((message) => message.type === 'market.snapshot' && message.payload.connectionState === 'stale')).toBe(true);

      socket.send(JSON.stringify({ time: 1, channel: 'ticker', event: 'update', result: {
        s: 'GATE_FUTURE_BTC_USDT', lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
        o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: 1_771_990_800_000,
      } }));
      await waitFor(() => hub.snapshot().connectionState === 'healthy');
    } finally {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('CrossEx price provenance', () => {
  it('never lets funding or open-interest pushes mark seed or stale prices as fresh live data', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const seeded = hub.market(symbol);
    expect(seeded?.source).toBe('demo_seed');

    // Funding and OI pushes arriving before any ticker must not upgrade provenance or freshness.
    socket.send(JSON.stringify({ time: 1, channel: 'funding_rate', event: 'update', result: { s: symbol, r: '0.0003', T: 1_771_990_700_000 } }));
    socket.send(JSON.stringify({ time: 1, channel: 'open_interest', event: 'update', result: { s: symbol, oi: '1234', oiV: '145000000' } }));
    await waitFor(() => hub.market(symbol)?.fundingRate === '0.0003' && hub.market(symbol)?.openInterest === '1234');
    const preTicker = hub.market(symbol);
    expect(preTicker?.source).toBe('demo_seed');
    expect(preTicker?.updatedAt).toBe(seeded?.updatedAt);
    expect(preTicker?.bidPrice).toBe(seeded?.bidPrice);

    const tickerTs = 1_771_990_800_000;
    socket.send(JSON.stringify({ time: 2, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '118500', bp: '118499.5', bs: '2', ap: '118500.5', as: '1.5',
      o: '118000', h: '119000', l: '117500', v: '1000', q: '118000000', ts: tickerTs,
    } }));
    await waitFor(() => hub.market(symbol)?.source === 'gate_crossex_websocket');
    expect(hub.market(symbol)?.updatedAt).toBe(new Date(tickerTs).toISOString());

    // A later funding push updates its own fields but must not refresh price freshness.
    socket.send(JSON.stringify({ time: 3, channel: 'funding_rate', event: 'update', result: { s: symbol, r: '0.0005', T: 1_771_990_900_000 } }));
    await waitFor(() => hub.market(symbol)?.fundingRate === '0.0005');
    const afterFunding = hub.market(symbol);
    expect(afterFunding?.updatedAt).toBe(new Date(tickerTs).toISOString());
    expect(afterFunding?.bidPrice).toBe('118499.5');
    expect(afterFunding?.source).toBe('gate_crossex_websocket');

    // Delayed frames can arrive around a reconnect. They must not roll an executable quote back
    // after a newer source timestamp has already been accepted.
    socket.send(JSON.stringify({ time: 4, channel: 'ticker', event: 'update', result: {
      s: symbol, lp: '108500', bp: '108499.5', bs: '2', ap: '108500.5', as: '1.5',
      o: '108000', h: '109000', l: '107500', v: '1000', q: '108000000', ts: tickerTs - 1_000,
    } }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(hub.market(symbol)?.updatedAt).toBe(new Date(tickerTs).toISOString());
    expect(hub.market(symbol)?.bidPrice).toBe('118499.5');
  });
});

describe('CrossEx dynamic market channels', () => {
  it('chunks every public subscription request at the documented 100-symbol limit', async () => {
    const { hub, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    const definitions = Array.from({ length: 130 }, (_, index) => ({
      symbol: `GATE_FUTURE_DYN${index}_USDT`,
      venue: 'GATE' as const,
      asset: `DYN${index}`,
    }));
    expect(hub.ensureMarkets(definitions)).toBe(true);
    await waitFor(() => received.filter((message) => message.channel === 'ticker' && message.event === 'subscribe').length >= 3);

    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      const dynamicRequests = received.filter((message) =>
        message.channel === channel
        && message.event === 'subscribe'
        && Array.isArray(message.payload)
        && message.payload.some((symbol) => String(symbol).includes('_DYN')),
      );
      expect(dynamicRequests).toHaveLength(2);
      expect(dynamicRequests.every((message) => (message.payload as unknown[]).length <= 100)).toBe(true);
    }
  });

  it('maintains an incremental order book with refcounted upstream subscriptions', async () => {
    const { hub, socket, received, messages } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));

    const releaseFirst = hub.watchOrderBook('GATE_FUTURE_BTC_USDT');
    const releaseSecond = hub.watchOrderBook('GATE_FUTURE_BTC_USDT');
    await waitFor(() => received.some((message) => message.channel === 'order_book_update' && message.event === 'subscribe'));
    expect(received.filter((message) => message.channel === 'order_book_update' && message.event === 'subscribe')).toHaveLength(1);

    socket.send(JSON.stringify({ time: 1, channel: 'order_book_update', event: 'update', result: {
      snapshot: true, ts: 1_771_990_690_844, s: 'GATE_FUTURE_BTC_USDT', U: 1, u: 2,
      a: [['118500.1', '0.5'], ['118500.9', '1.25']],
      b: [['118499.8', '0.75'], ['118498.2', '2']],
    } }));
    await waitFor(() => hub.orderBook('GATE_FUTURE_BTC_USDT') !== null);

    socket.send(JSON.stringify({ time: 2, channel: 'order_book_update', event: 'update', result: {
      snapshot: false, ts: 1_771_990_691_000, s: 'GATE_FUTURE_BTC_USDT', U: 3, u: 4,
      a: [['118500.1', '0']],
      b: [['118499.9', '3.5']],
    } }));
    await waitFor(() => (hub.orderBook('GATE_FUTURE_BTC_USDT')?.bids.length ?? 0) === 3);

    const book = hub.orderBook('GATE_FUTURE_BTC_USDT');
    expect(book?.asks).toEqual([['118500.9', '1.25']]);
    expect(book?.bids).toEqual([['118499.9', '3.5'], ['118499.8', '0.75'], ['118498.2', '2']]);
    expect(messages.some((message) => message.type === 'orderbook.update')).toBe(true);

    releaseFirst();
    expect(received.filter((message) => message.channel === 'order_book_update' && message.event === 'unsubscribe')).toHaveLength(0);
    releaseSecond();
    await waitFor(() => received.some((message) => message.channel === 'order_book_update' && message.event === 'unsubscribe'));
    expect(hub.orderBook('GATE_FUTURE_BTC_USDT')).toBeNull();
  });

  it('attributes raw exchange trade symbols back to the watched CrossEx symbol and dedupes trade ids', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    hub.watchTrades('BINANCE_FUTURE_BTC_USDT');
    await waitFor(() => received.some((message) => message.channel === 'trade' && message.event === 'subscribe'));

    const push = { time: 3, channel: 'trade', event: 'update', result: {
      s: 'BTCUSDT', i: '18473628192', p: '67250.12', q: '0.015', S: 'BUY', ts: 1_771_990_692_000, m: false,
    } };
    socket.send(JSON.stringify(push));
    socket.send(JSON.stringify(push));
    socket.send(JSON.stringify({ ...push, result: { ...push.result, i: '18473628193', S: 'SELL', s: 'BINANCE_FUTURE_BTC_USDT' } }));
    await waitFor(() => hub.recentTrades('BINANCE_FUTURE_BTC_USDT').length === 2);

    const trades = hub.recentTrades('BINANCE_FUTURE_BTC_USDT');
    expect(trades[0]).toMatchObject({ id: '18473628193', side: 'SELL', symbol: 'BINANCE_FUTURE_BTC_USDT' });
    expect(trades[1]).toMatchObject({ id: '18473628192', side: 'BUY', price: '67250.12' });
  });

  it('accumulates kline series, replaces the in-progress candle, and merges REST backfill behind live data', async () => {
    const { hub, socket, received } = await createHubHarness();
    await waitFor(() => received.some((message) => message.channel === 'ticker'));
    hub.watchKlines('OKX_FUTURE_ETH_USDT', '1m');
    await waitFor(() => received.some((message) => message.channel === 'kline_1m' && message.event === 'subscribe'));

    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3860', h: '3865', l: '3859', c: '3862', v: '120.5', t: 1_710_000_000_000, T: 1_710_000_059_999, x: false,
    } }));
    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3860', h: '3870', l: '3859', c: '3869', v: '180.25', t: 1_710_000_000_000, T: 1_710_000_059_999, x: true,
    } }));
    socket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
      s: 'OKX_FUTURE_ETH_USDT', o: '3869', h: '3871', l: '3868', c: '3870', v: '15', t: 1_710_000_060_000, T: 1_710_000_119_999, x: false,
    } }));
    await waitFor(() => hub.candles('OKX_FUTURE_ETH_USDT', '1m').length === 2);

    hub.seedCandles('OKX_FUTURE_ETH_USDT', '1m', [
      { startTime: 1_709_999_940_000, open: '3855', high: '3861', low: '3854', close: '3860', volume: '95', closed: true },
      { startTime: 1_710_000_000_000, open: '9999', high: '9999', low: '9999', close: '9999', volume: '0', closed: true },
    ]);

    const candles = hub.candles('OKX_FUTURE_ETH_USDT', '1m');
    expect(candles.map((candle) => candle.startTime)).toEqual([1_709_999_940_000, 1_710_000_000_000, 1_710_000_060_000]);
    expect(candles[1]).toMatchObject({ close: '3869', closed: true });
    expect(candles[2]).toMatchObject({ close: '3870', closed: false });
  });

  it('never publishes disconnected candle segments as one series', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    hub.seedCandles('BINANCE_FUTURE_BTC_USDT', '1m', [
      { startTime: 0, open: '1', high: '1', low: '1', close: '1', volume: '1', closed: true },
      { startTime: 60_000, open: '1', high: '1', low: '1', close: '1', volume: '1', closed: true },
      { startTime: 600_000, open: '2', high: '2', low: '2', close: '2', volume: '1', closed: true },
      { startTime: 660_000, open: '2', high: '2', low: '2', close: '2', volume: '1', closed: true },
    ]);

    expect(hub.candles('BINANCE_FUTURE_BTC_USDT', '1m').map((item) => item.startTime))
      .toEqual([600_000, 660_000]);
  });
});
