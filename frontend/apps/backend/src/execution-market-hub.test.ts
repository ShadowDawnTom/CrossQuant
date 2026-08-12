import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionMarketHub, OrderBookReplica } from './execution-market-hub.js';

afterEach(() => vi.useRealTimers());

function delta(first: number, last: number, previous: number | null = null) {
  return {
    first, last, previous, exchangeTimestamp: 1_800_000_000_000,
    bids: [['100', '2']] as Array<readonly [string, string]>,
    asks: [['101', '3']] as Array<readonly [string, string]>,
  };
}

describe('OrderBookReplica', () => {
  it('applies a bridged range update and rejects a missing sequence', () => {
    const book = new OrderBookReplica('GATE', 'BTC');
    book.seed([['99', '1']], [['102', '1']], 10, 1_800_000_000_000, Date.now());
    expect(book.apply(delta(10, 11), 'range')).toBe(true);
    expect(book.state.sequence).toBe(11);
    expect(book.apply(delta(13, 13), 'range')).toBe(false);
    expect(book.state.synchronized).toBe(false);
    expect(book.state.sequenceGaps).toBe(1);
  });

  it('requires Binance previous update id continuity', () => {
    const book = new OrderBookReplica('BINANCE', 'BTC');
    book.seed([['99', '1']], [['102', '1']], 20, 1_800_000_000_000, Date.now());
    expect(book.apply(delta(21, 22, 20), 'previous')).toBe(true);
    expect(book.apply(delta(23, 24, 21), 'previous')).toBe(false);
    expect(book.state.lastError).toContain('sequence_gap');
  });

  it('accepts monotonic Bybit update ids without assuming they are contiguous', () => {
    const book = new OrderBookReplica('BYBIT', 'BTC');
    book.seed([['99', '1']], [['102', '1']], 20, 1_800_000_000_000, Date.now());
    expect(book.apply(delta(25, 25), 'monotonic')).toBe(true);
    expect(book.state.sequence).toBe(25);
    expect(book.apply(delta(24, 24), 'monotonic')).toBe(true);
    expect(book.state.sequence).toBe(25);
  });

  it('deletes zero quantity and refreshes an empty heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const book = new OrderBookReplica('OKX', 'ETH');
    book.seed([['100', '1']], [['101', '1']], 30, Date.now(), Date.now());
    expect(book.apply({ ...delta(31, 31, 30), bids: [['100', '0']] }, 'previous')).toBe(true);
    expect(book.state.bids.has('100')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(book.apply({ ...delta(31, 31, 30), bids: [], asks: [], exchangeTimestamp: Date.now() }, 'previous')).toBe(true);
    expect(book.state.receivedAt).toBe(Date.now());
  });
});

describe('venue payload parsing', () => {
  it('accepts Gate object levels without dropping sequence updates', () => {
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'] });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      multipliers: Map<string, number>;
      onGate: (message: Record<string, unknown>) => void;
    };
    internal.multipliers.set('GATE:BTC', 0.001);
    const book = internal.books.get('GATE:BTC')!;
    book.seed([['99', '1']], [['102', '1']], 10, 1_800_000_000_000, Date.now());
    internal.onGate({
      channel: 'futures.order_book_update', event: 'update',
      result: { s: 'BTC_USDT', U: 11, u: 12, t: 1_800_000_000_100, b: [{ p: '100', s: 2000 }], a: [{ p: '101', s: 3000 }] },
    });
    expect(book.state.sequence).toBe(12);
    expect(book.state.bids.get('100')).toBe('2');
    expect(book.state.asks.get('101')).toBe('3');
  });
});

describe('ExecutionMarketHub certification', () => {
  it('fails closed on stale books and certifies only synchronized, time-aligned pairs', () => {
    const now = 1_800_000_000_000;
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'], maxBookAgeMs: 1_000, maxExchangeSkewMs: 100, maxReceiveSkewMs: 100 });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      connections: Map<string, { state: string }>;
    };
    for (const venue of ['GATE', 'BINANCE'] as const) {
      internal.connections.get(venue)!.state = 'healthy';
      internal.books.get(`${venue}:BTC`)!.seed([['100', '1']], [['101', '1']], 1, now, now);
    }
    expect(hub.pair('BTC', 'GATE', 'BINANCE', now).quality).toBe('LIVE_SYNCHRONIZED');
    const stale = hub.pair('BTC', 'GATE', 'BINANCE', now + 1_001);
    expect(stale.quality).toBe('LIVE_UNSYNCHRONIZED');
    expect(stale.reasons).toContain('long_gate_not_live');
  });

  it('rejects pair certification when exchange timestamps are not aligned', () => {
    const now = 1_800_000_000_000;
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'], maxExchangeSkewMs: 50 });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      connections: Map<string, { state: string }>;
    };
    internal.connections.get('GATE')!.state = 'healthy';
    internal.connections.get('BYBIT')!.state = 'healthy';
    internal.books.get('GATE:BTC')!.seed([['100', '1']], [['101', '1']], 1, now, now);
    internal.books.get('BYBIT:BTC')!.seed([['100', '1']], [['101', '1']], 1, now + 51, now);
    const pair = hub.pair('BTC', 'GATE', 'BYBIT', now);
    expect(pair.quality).toBe('LIVE_UNSYNCHRONIZED');
    expect(pair.reasons).toContain('exchange_timestamp_skew');
  });

  it('single-flights failed REST rebuilds and cools down after rate limits', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      return new Response('', { status: 418 });
    });
    const hub = new ExecutionMarketHub(fetchImpl as typeof fetch, {
      symbols: ['BTC'], rateLimitCooldownMs: 1_000,
    });
    const book = new OrderBookReplica('BINANCE', 'BTC');
    const generation = book.beginRebuild('test');
    const internal = hub as unknown as {
      stopped: boolean;
      requestBootstrap: (venue: 'BINANCE', base: string, replica: OrderBookReplica, generation: number) => void;
    };
    internal.stopped = false;
    for (let index = 0; index < 100; index += 1) {
      internal.requestBootstrap('BINANCE', 'BTC', book, generation);
    }
    await vi.runOnlyPendingTimersAsync();
    expect(requests).toBe(2);
    hub.stop();
  });
});
