import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossExFutureSymbol, ExecutionMarketHub, nativeSymbol, OrderBookReplica } from './execution-market-hub.js';
import { StaticQuoteFxReader } from './quote-fx-oracle.js';

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

  it('fails closed when a snapshot or incremental update crosses the local book', () => {
    const book = new OrderBookReplica('GATE', 'BTC');
    expect(book.seed([['102', '1']], [['101', '1']], 1, Date.now(), Date.now())).toBe(false);
    expect(book.state).toMatchObject({ synchronized: false, lastError: 'crossed_order_book' });
    expect(book.seed([['100', '1']], [['101', '1']], 2, Date.now(), Date.now())).toBe(true);
    expect(book.apply({ ...delta(3, 3), bids: [['102', '1']], asks: [] }, 'range')).toBe(false);
    expect(book.state).toMatchObject({ synchronized: false, lastError: 'crossed_order_book' });
  });
});

describe('venue payload parsing', () => {
  it('通过 Hyperliquid 元数据为 HIP-3 合约添加 DEX 前缀', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string; dex?: string };
      if (body.type === 'perpDexs') return new Response(JSON.stringify([null, { name: 'xyz' }]), { status: 200 });
      if (body.type === 'meta' && body.dex === 'xyz') {
        return new Response(JSON.stringify({ universe: [{ name: 'xyz:UNITREE' }, { name: 'xyz:SKHX' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ universe: [{ name: 'BTC' }] }), { status: 200 });
    });
    const hub = new ExecutionMarketHub(fetchImpl as typeof fetch, { symbols: ['UNITREE'] });
    const sent: string[] = [];
    const internal = hub as unknown as {
      loadHyperliquidSymbols: () => Promise<void>;
      subscribeSymbols: (venue: 'HYPERLIQUID', socket: { send(value: string): void }, symbols: string[]) => void;
      onHyperliquid: (message: Record<string, unknown>) => void;
      books: Map<string, OrderBookReplica>;
    };
    await internal.loadHyperliquidSymbols();
    internal.subscribeSymbols('HYPERLIQUID', { send: (value) => sent.push(value) }, ['UNITREE']);
    expect(sent[0]).toContain('xyz:UNITREE');
    internal.onHyperliquid({ channel: 'l2Book', data: { coin: 'xyz:UNITREE', time: 1_800_000_000_010,
      levels: [[{ px: '10', sz: '4' }], [{ px: '11', sz: '5' }]] } });
    expect(internal.books.get('HYPERLIQUID:UNITREE')!.state.asks.get('11')).toBe('5');
    expect(crossExFutureSymbol('HYPERLIQUID', 'UNITREE')).toBe('HYPERLIQUID_FUTURE_UNITREE_USDC');
  });

  it('accepts Gate object levels without dropping sequence updates', () => {
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'] });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      multipliers: Map<string, string>;
      onGate: (message: Record<string, unknown>) => void;
    };
    internal.multipliers.set('GATE:BTC', '0.001');
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

  it('atomically replaces a Gate book when full=true and maps Bybit thousand contracts', () => {
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC', 'PEPE'] });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      multipliers: Map<string, string>;
      onGate: (message: Record<string, unknown>) => void;
      onBybit: (message: Record<string, unknown>) => void;
    };
    internal.multipliers.set('GATE:BTC', '1');
    const book = internal.books.get('GATE:BTC')!;
    book.seed([['99', '1']], [['103', '1']], 10, Date.now(), Date.now());
    internal.onGate({ channel: 'futures.order_book_update', event: 'update', result: {
      full: true, s: 'BTC_USDT', U: 11, u: 12, t: Date.now(), b: [{ p: '100', s: '2' }], a: [{ p: '101', s: '3' }],
    } });
    expect([...book.state.bids.entries()]).toEqual([['100', '2']]);
    expect([...book.state.asks.entries()]).toEqual([['101', '3']]);
    internal.onBybit({ op: 'subscribe', req_id: 'book:PEPE', success: false, ret_msg: 'bad topic' });
    expect(internal.books.get('BYBIT:PEPE')!.state.lastError).toBe('subscription_rejected:bad topic');
    expect(nativeSymbol('BYBIT', 'PEPE')).toBe('1000PEPEUSDT');
  });

  it('同步 Kraken、Hyperliquid 与 Deribit 的原生盘口语义', () => {
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'], quoteFx: new StaticQuoteFxReader() });
    const internal = hub as unknown as {
      books: Map<string, OrderBookReplica>;
      onKraken: (message: Record<string, unknown>) => void;
      onHyperliquid: (message: Record<string, unknown>) => void;
      onDeribit: (message: Record<string, unknown>) => void;
    };
    internal.onKraken({ feed: 'book_snapshot', product_id: 'PF_XBTUSD', seq: 10,
      timestamp: 1_800_000_000_000, bids: [{ price: '100', qty: '2' }], asks: [{ price: '101', qty: '3' }] });
    internal.onHyperliquid({ channel: 'l2Book', data: { coin: 'BTC', time: 1_800_000_000_010,
      levels: [[{ px: '100.1', sz: '4' }], [{ px: '101.1', sz: '5' }]] } });
    internal.onDeribit({ method: 'subscription', params: { channel: 'book.BTC_USDC-PERPETUAL.100ms',
      data: { type: 'snapshot', instrument_name: 'BTC_USDC-PERPETUAL', change_id: 20,
        timestamp: 1_800_000_000_020, bids: [['new', '100.2', '6']], asks: [['new', '101.2', '7']] } } });
    internal.onDeribit({ method: 'subscription', params: { channel: 'book.BTC_USDC-PERPETUAL.100ms',
      data: { type: 'change', instrument_name: 'BTC_USDC-PERPETUAL', change_id: 21, prev_change_id: 20,
        timestamp: 1_800_000_000_030, bids: [['change', '100.2', '0']], asks: [['new', '101.3', '8']] } } });

    expect(internal.books.get('KRAKEN:BTC')!.state.bids.get('100')).toBe('2');
    expect(internal.books.get('HYPERLIQUID:BTC')!.state.asks.get('101.1')).toBe('5');
    expect(internal.books.get('DERIBIT:BTC')!.state.bids.has('100.2')).toBe(false);
    expect(internal.books.get('DERIBIT:BTC')!.state.sequence).toBe(21);
    expect(nativeSymbol('KRAKEN', 'DOGE')).toBe('PF_DOGEUSD');
    expect(crossExFutureSymbol('DERIBIT', 'BTC')).toBe('DERIBIT_FUTURE_BTC_USDC');
    expect(nativeSymbol('HYPERLIQUID', 'SKHYNIX')).toBe('SKHX');
    expect(crossExFutureSymbol('HYPERLIQUID', 'SKHYNIX')).toBe('HYPERLIQUID_FUTURE_SKHX_USDC');
  });
});

describe('ExecutionMarketHub certification', () => {
  it('新热池未达到多所实时认证时保留旧池', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/info')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
        return new Response(JSON.stringify(body.type === 'perpDexs' ? [] : { universe: [{ name: 'BTC' }, { name: 'DOGE' }] }), { status: 200 });
      }
      if (url.includes('/futures/usdt/contracts')) return new Response(JSON.stringify([
        { name: 'BTC_USDT', quanto_multiplier: '1' }, { name: 'DOGE_USDT', quanto_multiplier: '1' },
      ]), { status: 200 });
      return new Response(JSON.stringify({ data: [
        { instId: 'BTC-USDT-SWAP', ctVal: '1' }, { instId: 'DOGE-USDT-SWAP', ctVal: '1' },
      ] }), { status: 200 });
    });
    const hub = new ExecutionMarketHub(fetchImpl as typeof fetch, {
      symbols: ['BTC'], requiredSymbols: ['BTC'], symbolStageTimeoutMs: 10,
      quoteFx: new StaticQuoteFxReader(),
    });
    const internal = hub as unknown as { stopped: boolean };
    internal.stopped = false;
    await hub.replaceSymbols(['DOGE']);
    expect(hub.health().symbols).toEqual(['BTC']);
    expect(() => hub.book('BINANCE', 'DOGE')).toThrow('execution_market_not_configured');
    hub.stop();
  });

  it('动态替换研究热池时保留严格资产并初始化新增盘口', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/futures/usdt/contracts')) return new Response(JSON.stringify([
        { name: 'BTC_USDT', quanto_multiplier: '1' }, { name: 'DOGE_USDT', quanto_multiplier: '1' },
      ]), { status: 200 });
      return new Response(JSON.stringify({ data: [
        { instId: 'BTC-USDT-SWAP', ctVal: '1' }, { instId: 'DOGE-USDT-SWAP', ctVal: '1' },
      ] }), { status: 200 });
    });
    const hub = new ExecutionMarketHub(fetchImpl as typeof fetch, {
      symbols: ['BTC'], requiredSymbols: ['BTC'], quoteFx: new StaticQuoteFxReader(),
    });

    await hub.replaceSymbols(['DOGE']);
    expect(hub.health().symbols).toEqual(['BTC', 'DOGE']);
    expect(hub.book('BINANCE', 'DOGE')).toMatchObject({ base: 'DOGE', synchronized: false });
    await hub.replaceSymbols(['BTC']);
    expect(hub.health().symbols).toEqual(['BTC']);
    expect(() => hub.book('BINANCE', 'DOGE')).toThrow('execution_market_not_configured');
  });

  it('按逐所交易规则过滤不存在的研究合约', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/futures/usdt/contracts')) return new Response(JSON.stringify([
        { name: 'BTC_USDT', quanto_multiplier: '1' },
      ]), { status: 200 });
      return new Response(JSON.stringify({ data: [
        { instId: 'BTC-USDT-SWAP', ctVal: '1' }, { instId: 'MSTRX-USDT-SWAP', ctVal: '1' },
      ] }), { status: 200 });
    });
    const hub = new ExecutionMarketHub(fetchImpl as typeof fetch, {
      symbols: ['BTC'], requiredSymbols: ['BTC'], quoteFx: new StaticQuoteFxReader(),
    });

    await hub.replaceSymbols(['MSTRX'], {
      GATE: ['BTC'], BINANCE: ['BTC'], OKX: ['BTC'], BYBIT: ['BTC'],
      KRAKEN: ['BTC', 'MSTRX'], HYPERLIQUID: ['BTC'], DERIBIT: ['BTC'],
    });

    const venues = new Map(hub.health().venues.map((item) => [item.venue, item]));
    expect(venues.get('GATE')?.totalBooks).toBe(1);
    expect(venues.get('KRAKEN')?.totalBooks).toBe(2);
    expect(hub.health().symbols).toEqual(['BTC', 'MSTRX']);
  });

  it('waits for a websocket delta that bridges the REST snapshot', async () => {
    vi.useFakeTimers();
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'] });
    const book = new OrderBookReplica('GATE', 'BTC');
    const generation = book.beginRebuild('test');
    book.buffer(delta(8, 10));
    const internal = hub as unknown as {
      waitForSnapshotBridge: (
        replica: OrderBookReplica,
        currentGeneration: number,
        matches: (update: ReturnType<typeof delta>) => boolean,
      ) => Promise<void>;
    };
    const waiting = internal.waitForSnapshotBridge(
      book,
      generation,
      (update) => update.first <= 11 && update.last >= 11,
    );
    setTimeout(() => book.buffer(delta(11, 12)), 100);
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(book.state.buffered.some((update) => update.first <= 11 && update.last >= 11)).toBe(true);
    hub.stop();
  });

  it('fails closed on stale books and certifies only synchronized, time-aligned pairs', () => {
    const now = 1_800_000_000_000;
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'], maxBookAgeMs: 1_000,
      maxExchangeSkewMs: 100, maxReceiveSkewMs: 100, quoteFx: new StaticQuoteFxReader() });
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
    const hub = new ExecutionMarketHub(fetch, { symbols: ['BTC'], maxExchangeSkewMs: 50,
      quoteFx: new StaticQuoteFxReader() });
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

  it('single-flights failed REST rebuilds and honors rate-limit cooldown', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      return new Response('', { status: 418, headers: { 'retry-after': '5' } });
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
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(requests).toBe(2);
    hub.stop();
  });
});
