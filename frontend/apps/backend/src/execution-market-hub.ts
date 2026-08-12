import WebSocket from 'ws';

export const EXECUTION_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT'] as const;
export type ExecutionVenue = typeof EXECUTION_VENUES[number];
export type ExecutionQuality = 'BOOTSTRAPPING' | 'LIVE_UNSYNCHRONIZED' | 'LIVE_SYNCHRONIZED';

type Level = readonly [price: string, quantity: string];

interface Delta {
  first: number;
  last: number;
  previous: number | null;
  exchangeTimestamp: number;
  bids: Level[];
  asks: Level[];
}

interface MutableBook {
  bids: Map<string, string>;
  asks: Map<string, string>;
  sequence: number | null;
  exchangeTimestamp: number;
  receivedAt: number;
  synchronized: boolean;
  rebuilding: boolean;
  buffered: Delta[];
  rebuilds: number;
  sequenceGaps: number;
  lastError: string | null;
  generation: number;
}

export interface ExecutionBookSnapshot {
  venue: ExecutionVenue;
  symbol: string;
  base: string;
  quote: 'USDT';
  bids: Level[];
  asks: Level[];
  sequence: number | null;
  exchangeTimestamp: string | null;
  receivedAt: string | null;
  ageMs: number | null;
  synchronized: boolean;
  connectionState: 'connecting' | 'healthy' | 'reconnecting' | 'disconnected';
  rebuilds: number;
  sequenceGaps: number;
  lastError: string | null;
}

export interface ExecutionPairSnapshot {
  base: string;
  longVenue: ExecutionVenue;
  shortVenue: ExecutionVenue;
  quality: ExecutionQuality;
  reasons: string[];
  exchangeSkewMs: number | null;
  receiveSkewMs: number | null;
  longBook: ExecutionBookSnapshot;
  shortBook: ExecutionBookSnapshot;
  certifiedAt: string | null;
}

export interface ExecutionMarketHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'stopped';
  updatedAt: string;
  symbols: string[];
  venues: Array<{
    venue: ExecutionVenue;
    connectionState: ExecutionBookSnapshot['connectionState'];
    readyBooks: number;
    totalBooks: number;
    reconnects: number;
    lastMessageAt: string | null;
  }>;
}

export interface ExecutionMarketReader {
  start(): void;
  stop(): void;
  health(now?: number): ExecutionMarketHealth;
  book(venue: ExecutionVenue, base: string, now?: number): ExecutionBookSnapshot;
  pair(base: string, longVenue: ExecutionVenue, shortVenue: ExecutionVenue, now?: number): ExecutionPairSnapshot;
}

interface VenueConnection {
  socket: WebSocket | null;
  state: ExecutionBookSnapshot['connectionState'];
  reconnects: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  lastMessageAt: number;
}

export interface ExecutionMarketHubOptions {
  symbols?: string[];
  maxBookAgeMs?: number;
  maxExchangeSkewMs?: number;
  maxReceiveSkewMs?: number;
  reconnectBaseMs?: number;
  endpoints?: Partial<Record<ExecutionVenue, { rest: string; websocket: string }>>;
}

export interface ExecutionMarketSample extends ExecutionPairSnapshot {
  sampledAt: string;
}

const DEFAULT_ENDPOINTS: Record<ExecutionVenue, { rest: string; websocket: string }> = {
  GATE: { rest: 'https://api.gateio.ws/api/v4', websocket: 'wss://fx-ws.gateio.ws/v4/ws/usdt' },
  BINANCE: { rest: 'https://fapi.binance.com', websocket: 'wss://fstream.binance.com/public/ws' },
  OKX: { rest: 'https://openapi.okx.com', websocket: 'wss://ws.okx.com:8443/ws/v5/public' },
  BYBIT: { rest: 'https://api.bybit.com', websocket: 'wss://stream.bybit.com/v5/public/linear' },
};

const MAX_BUFFERED_DELTAS = 10_000;
const MAX_PUBLISHED_LEVELS = 200;

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? text : null;
}

function levels(value: unknown, multiplier = 1): Level[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Level[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = positiveText(row[0]);
    const rawQuantity = typeof row[1] === 'string' || typeof row[1] === 'number' ? Number(row[1]) : Number.NaN;
    if (!price || !Number.isFinite(rawQuantity) || rawQuantity < 0) return null;
    parsed.push([price, String(rawQuantity * multiplier)]);
  }
  return parsed;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function iso(timestamp: number): string | null {
  return timestamp > 0 && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nativeSymbol(venue: ExecutionVenue, base: string): string {
  if (venue === 'GATE') return `${base}_USDT`;
  if (venue === 'OKX') return `${base}-USDT-SWAP`;
  return `${base}USDT`;
}

function applyLevels(target: Map<string, string>, updates: readonly Level[]): void {
  for (const [price, quantity] of updates) {
    if (Number(quantity) === 0) target.delete(price);
    else target.set(price, quantity);
  }
}

function sortedLevels(source: Map<string, string>, descending: boolean): Level[] {
  return [...source.entries()]
    .sort((a, b) => descending ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))
    .slice(0, MAX_PUBLISHED_LEVELS);
}

/**
 * 单个交易所盘口副本。所有增量先过序列检查，断序时立即失效，禁止继续提供可交易行情。
 */
export class OrderBookReplica {
  readonly state: MutableBook = {
    bids: new Map(), asks: new Map(), sequence: null, exchangeTimestamp: 0, receivedAt: 0,
    synchronized: false, rebuilding: false, buffered: [], rebuilds: 0, sequenceGaps: 0, lastError: null, generation: 0,
  };

  constructor(readonly venue: ExecutionVenue, readonly base: string) {}

  beginRebuild(reason: string | null = null): number {
    this.state.synchronized = false;
    this.state.rebuilding = true;
    this.state.sequence = null;
    this.state.buffered = [];
    this.state.rebuilds += 1;
    this.state.lastError = reason;
    this.state.generation += 1;
    return this.state.generation;
  }

  buffer(delta: Delta): boolean {
    if (this.state.buffered.length >= MAX_BUFFERED_DELTAS) {
      this.gap('delta_buffer_overflow');
      return false;
    }
    this.state.buffered.push(delta);
    return true;
  }

  seed(bids: Level[], asks: Level[], sequence: number, exchangeTimestamp: number, receivedAt: number): void {
    this.state.bids = new Map(bids.filter(([, quantity]) => Number(quantity) > 0));
    this.state.asks = new Map(asks.filter(([, quantity]) => Number(quantity) > 0));
    this.state.sequence = sequence;
    this.state.exchangeTimestamp = exchangeTimestamp;
    this.state.receivedAt = receivedAt;
    this.state.synchronized = true;
    this.state.rebuilding = false;
    this.state.lastError = null;
  }

  apply(delta: Delta, mode: 'range' | 'previous' | 'monotonic'): boolean {
    const current = this.state.sequence;
    if (!this.state.synchronized || current === null) return this.buffer(delta);
    if (delta.last <= current) {
      // 交易所会发送空增量作为保活；它能证明连接仍活着，但不能改变本地序列。
      if (delta.last === current && delta.bids.length === 0 && delta.asks.length === 0) {
        this.state.exchangeTimestamp = delta.exchangeTimestamp;
        this.state.receivedAt = Date.now();
      }
      return true;
    }
    const continuous = mode === 'previous'
      ? delta.previous === current
      : mode === 'monotonic'
        ? delta.last > current
        : delta.first <= current + 1 && delta.last >= current + 1;
    if (!continuous) {
      this.gap(`sequence_gap:${current}->${delta.first}/${delta.previous ?? 'none'}-${delta.last}`);
      return false;
    }
    applyLevels(this.state.bids, delta.bids);
    applyLevels(this.state.asks, delta.asks);
    this.state.sequence = delta.last;
    this.state.exchangeTimestamp = delta.exchangeTimestamp;
    this.state.receivedAt = Date.now();
    return true;
  }

  private gap(reason: string): void {
    this.state.synchronized = false;
    this.state.rebuilding = false;
    this.state.sequenceGaps += 1;
    this.state.lastError = reason;
  }
}

/**
 * 四所永续合约执行行情服务。REST 负责启动基线，WebSocket 增量负责持续更新和断序检测。
 */
export class ExecutionMarketHub {
  private readonly symbols: string[];
  private readonly books = new Map<string, OrderBookReplica>();
  private readonly connections = new Map<ExecutionVenue, VenueConnection>();
  private readonly multipliers = new Map<string, number>();
  private readonly endpoints: Record<ExecutionVenue, { rest: string; websocket: string }>;
  private readonly maxBookAgeMs: number;
  private readonly maxExchangeSkewMs: number;
  private readonly maxReceiveSkewMs: number;
  private readonly reconnectBaseMs: number;
  private stopped = true;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    options: ExecutionMarketHubOptions = {},
  ) {
    this.symbols = [...new Set((options.symbols ?? ['BTC', 'ETH']).map((item) => item.trim().toUpperCase()).filter(Boolean))];
    if (this.symbols.length === 0 || this.symbols.length > 20) throw new Error('execution market symbols must contain 1 to 20 assets');
    this.maxBookAgeMs = options.maxBookAgeMs ?? 1_500;
    this.maxExchangeSkewMs = options.maxExchangeSkewMs ?? 750;
    this.maxReceiveSkewMs = options.maxReceiveSkewMs ?? 750;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.endpoints = { ...DEFAULT_ENDPOINTS };
    for (const venue of EXECUTION_VENUES) {
      if (options.endpoints?.[venue]) this.endpoints[venue] = options.endpoints[venue]!;
      this.connections.set(venue, {
        socket: null, state: 'disconnected', reconnects: 0, reconnectAttempt: 0,
        reconnectTimer: null, heartbeatTimer: null, lastMessageAt: 0,
        handshakeTimer: null,
      });
      for (const base of this.symbols) this.books.set(this.key(venue, base), new OrderBookReplica(venue, base));
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const venue of EXECUTION_VENUES) void this.startVenue(venue);
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections.values()) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      connection.socket?.close();
      connection.socket = null;
      connection.state = 'disconnected';
      connection.reconnectTimer = null;
      connection.heartbeatTimer = null;
      connection.handshakeTimer = null;
    }
  }

  health(now = Date.now()): ExecutionMarketHealth {
    const venues = EXECUTION_VENUES.map((venue) => {
      const connection = this.connections.get(venue)!;
      const replicas = this.symbols.map((base) => this.books.get(this.key(venue, base))!);
      return {
        venue, connectionState: connection.state,
        readyBooks: replicas.filter((book) => this.isLive(book, connection, now)).length,
        totalBooks: replicas.length, reconnects: connection.reconnects, lastMessageAt: iso(connection.lastMessageAt),
      };
    });
    const ready = venues.reduce((sum, venue) => sum + venue.readyBooks, 0);
    const total = venues.reduce((sum, venue) => sum + venue.totalBooks, 0);
    return {
      state: this.stopped ? 'stopped' : ready === total ? 'healthy' : ready === 0 ? 'starting' : 'degraded',
      updatedAt: new Date(now).toISOString(), symbols: [...this.symbols], venues,
    };
  }

  book(venue: ExecutionVenue, base: string, now = Date.now()): ExecutionBookSnapshot {
    const normalized = base.toUpperCase();
    const replica = this.books.get(this.key(venue, normalized));
    if (!replica) throw new Error('execution_market_not_configured');
    const state = replica.state;
    const connection = this.connections.get(venue)!;
    return {
      venue, symbol: nativeSymbol(venue, normalized), base: normalized, quote: 'USDT',
      bids: sortedLevels(state.bids, true), asks: sortedLevels(state.asks, false), sequence: state.sequence,
      exchangeTimestamp: iso(state.exchangeTimestamp), receivedAt: iso(state.receivedAt),
      ageMs: state.receivedAt > 0 ? Math.max(0, now - state.receivedAt) : null,
      synchronized: this.isLive(replica, connection, now), connectionState: connection.state,
      rebuilds: state.rebuilds, sequenceGaps: state.sequenceGaps, lastError: state.lastError,
    };
  }

  pair(base: string, longVenue: ExecutionVenue, shortVenue: ExecutionVenue, now = Date.now()): ExecutionPairSnapshot {
    const longBook = this.book(longVenue, base, now);
    const shortBook = this.book(shortVenue, base, now);
    const reasons: string[] = [];
    if (longVenue === shortVenue) reasons.push('same_venue');
    if (!longBook.synchronized) reasons.push(`long_${longVenue.toLowerCase()}_not_live`);
    if (!shortBook.synchronized) reasons.push(`short_${shortVenue.toLowerCase()}_not_live`);
    if (longBook.asks.length === 0) reasons.push('long_asks_missing');
    if (shortBook.bids.length === 0) reasons.push('short_bids_missing');
    const longExchange = Date.parse(longBook.exchangeTimestamp ?? '');
    const shortExchange = Date.parse(shortBook.exchangeTimestamp ?? '');
    const longReceived = Date.parse(longBook.receivedAt ?? '');
    const shortReceived = Date.parse(shortBook.receivedAt ?? '');
    const exchangeSkewMs = Number.isFinite(longExchange) && Number.isFinite(shortExchange) ? Math.abs(longExchange - shortExchange) : null;
    const receiveSkewMs = Number.isFinite(longReceived) && Number.isFinite(shortReceived) ? Math.abs(longReceived - shortReceived) : null;
    if (exchangeSkewMs === null || exchangeSkewMs > this.maxExchangeSkewMs) reasons.push('exchange_timestamp_skew');
    if (receiveSkewMs === null || receiveSkewMs > this.maxReceiveSkewMs) reasons.push('receive_timestamp_skew');
    const quality: ExecutionQuality = reasons.length === 0 ? 'LIVE_SYNCHRONIZED'
      : longBook.sequence === null || shortBook.sequence === null ? 'BOOTSTRAPPING' : 'LIVE_UNSYNCHRONIZED';
    return {
      base: base.toUpperCase(), longVenue, shortVenue, quality, reasons, exchangeSkewMs, receiveSkewMs,
      longBook, shortBook, certifiedAt: quality === 'LIVE_SYNCHRONIZED' ? new Date(now).toISOString() : null,
    };
  }

  private key(venue: ExecutionVenue, base: string): string { return `${venue}:${base}`; }

  private isLive(book: OrderBookReplica, connection: VenueConnection, now: number): boolean {
    return connection.state === 'healthy' && book.state.synchronized && book.state.sequence !== null
      && book.state.bids.size > 0 && book.state.asks.size > 0
      && book.state.receivedAt > 0 && now - book.state.receivedAt <= this.maxBookAgeMs;
  }

  private async startVenue(venue: ExecutionVenue): Promise<void> {
    if (this.stopped) return;
    try {
      if (venue === 'GATE' || venue === 'OKX') {
        for (const base of this.symbols) await this.loadMultiplier(venue, base);
      }
      this.connect(venue);
    } catch (error) {
      for (const base of this.symbols) {
        const state = this.books.get(this.key(venue, base))!.state;
        state.synchronized = false;
        state.lastError = error instanceof Error ? error.message : 'contract_metadata_failed';
      }
      this.scheduleReconnect(venue);
    }
  }

  private connect(venue: ExecutionVenue): void {
    if (this.stopped) return;
    const connection = this.connections.get(venue)!;
    connection.state = connection.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    const socket = new WebSocket(this.endpoints[venue].websocket);
    connection.socket = socket;
    connection.handshakeTimer = setTimeout(() => {
      if (socket.readyState === 0) socket.terminate();
    }, 10_000);
    connection.handshakeTimer.unref?.();
    socket.on('open', () => {
      if (this.stopped || connection.socket !== socket) return socket.close();
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
      connection.state = 'healthy';
      connection.reconnectAttempt = 0;
      this.subscribe(venue, socket);
      for (const base of this.symbols) {
        const book = this.books.get(this.key(venue, base))!;
        const generation = book.beginRebuild('connection_opened');
        void this.bootstrap(venue, base, book, generation);
      }
      connection.heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (connection.lastMessageAt > 0 && Date.now() - connection.lastMessageAt > 30_000) {
          socket.terminate();
          return;
        }
        if (venue === 'OKX') socket.send('ping');
        else if (venue === 'BYBIT') socket.send(JSON.stringify({ op: 'ping' }));
        else socket.ping();
      }, 15_000);
      connection.heartbeatTimer.unref?.();
    });
    socket.on('message', (payload) => {
      connection.lastMessageAt = Date.now();
      this.onMessage(venue, payload.toString());
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (connection.socket !== socket) return;
      if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      connection.heartbeatTimer = null;
      connection.handshakeTimer = null;
      connection.socket = null;
      for (const base of this.symbols) this.books.get(this.key(venue, base))!.state.synchronized = false;
      if (!this.stopped) this.scheduleReconnect(venue);
    });
  }

  private scheduleReconnect(venue: ExecutionVenue): void {
    const connection = this.connections.get(venue)!;
    connection.state = 'reconnecting';
    connection.reconnects += 1;
    connection.reconnectAttempt += 1;
    const delay = Math.min(30_000, this.reconnectBaseMs * 2 ** Math.min(connection.reconnectAttempt - 1, 6));
    connection.reconnectTimer = setTimeout(() => void this.startVenue(venue), Math.round(delay * (0.8 + Math.random() * 0.4)));
    connection.reconnectTimer.unref?.();
  }

  private subscribe(venue: ExecutionVenue, socket: WebSocket): void {
    if (venue === 'GATE') {
      for (const base of this.symbols) socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000), channel: 'futures.order_book_update', event: 'subscribe',
        payload: [nativeSymbol(venue, base), '100ms', '100'],
      }));
    } else if (venue === 'BINANCE') {
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: this.symbols.map((base) => `${nativeSymbol(venue, base).toLowerCase()}@depth@100ms`), id: Date.now() }));
    } else if (venue === 'OKX') {
      socket.send(JSON.stringify({ op: 'subscribe', args: this.symbols.map((base) => ({ channel: 'books', instId: nativeSymbol(venue, base) })) }));
    } else {
      socket.send(JSON.stringify({ op: 'subscribe', args: this.symbols.map((base) => `orderbook.200.${nativeSymbol(venue, base)}`) }));
    }
  }

  private onMessage(venue: ExecutionVenue, raw: string): void {
    if (raw === 'pong') return;
    let message: Record<string, unknown> | null;
    try { message = object(JSON.parse(raw)); } catch { return; }
    if (!message) return;
    if (venue === 'GATE') this.onGate(message);
    else if (venue === 'BINANCE') this.onBinance(message);
    else if (venue === 'OKX') this.onOkx(message);
    else this.onBybit(message);
  }

  private onGate(message: Record<string, unknown>): void {
    if (message.channel !== 'futures.order_book_update' || message.event !== 'update') return;
    const result = object(message.result);
    if (!result) return;
    const symbol = typeof result.s === 'string' ? result.s : '';
    const base = this.symbols.find((item) => nativeSymbol('GATE', item) === symbol);
    const first = finiteInteger(result.U); const last = finiteInteger(result.u);
    const bids = levels(result.b, this.multiplier('GATE', base)); const asks = levels(result.a, this.multiplier('GATE', base));
    if (!base || first === null || last === null || !bids || !asks) return;
    this.applyOrRebuild('GATE', base, { first, last, previous: null, exchangeTimestamp: finiteInteger(result.t) ?? Date.now(), bids, asks }, 'range');
  }

  private onBinance(message: Record<string, unknown>): void {
    const data = object(message.data) ?? message;
    if (data.e !== 'depthUpdate') return;
    const symbol = typeof data.s === 'string' ? data.s : '';
    const base = this.symbols.find((item) => nativeSymbol('BINANCE', item) === symbol);
    const first = finiteInteger(data.U); const last = finiteInteger(data.u); const previous = finiteInteger(data.pu);
    const bids = levels(data.b); const asks = levels(data.a);
    if (!base || first === null || last === null || previous === null || !bids || !asks) return;
    this.applyOrRebuild('BINANCE', base, { first, last, previous, exchangeTimestamp: finiteInteger(data.E) ?? Date.now(), bids, asks }, 'previous');
  }

  private onOkx(message: Record<string, unknown>): void {
    const argument = object(message.arg);
    if (argument?.channel !== 'books' || typeof argument.instId !== 'string' || !Array.isArray(message.data)) return;
    const base = this.symbols.find((item) => nativeSymbol('OKX', item) === argument.instId);
    const row = object(message.data[0]);
    if (!base || !row) return;
    const sequence = finiteInteger(row.seqId); const previous = finiteInteger(row.prevSeqId);
    const bids = levels(row.bids, this.multiplier('OKX', base)); const asks = levels(row.asks, this.multiplier('OKX', base));
    if (sequence === null || !bids || !asks) return;
    const book = this.books.get(this.key('OKX', base))!;
    if (message.action === 'snapshot') {
      book.seed(bids, asks, sequence, finiteInteger(row.ts) ?? Date.now(), Date.now());
      return;
    }
    if (message.action === 'update' && previous !== null) {
      this.applyOrRebuild('OKX', base, { first: sequence, last: sequence, previous, exchangeTimestamp: finiteInteger(row.ts) ?? Date.now(), bids, asks }, 'previous');
    }
  }

  private onBybit(message: Record<string, unknown>): void {
    if (typeof message.topic !== 'string' || !message.topic.startsWith('orderbook.200.')) return;
    const row = object(message.data);
    if (!row || typeof row.s !== 'string') return;
    const base = this.symbols.find((item) => nativeSymbol('BYBIT', item) === row.s);
    const updateId = finiteInteger(row.u);
    const bids = levels(row.b); const asks = levels(row.a);
    if (!base || updateId === null || !bids || !asks) return;
    const book = this.books.get(this.key('BYBIT', base))!;
    if (message.type === 'snapshot' || updateId === 1) {
      book.seed(bids, asks, updateId, finiteInteger(message.ts) ?? finiteInteger(row.cts) ?? Date.now(), Date.now());
      return;
    }
    // `seq` 是跨频道序号，不能拿来判断本频道连续性；本地盘口按 update id 严格连续，疑似丢包就重建。
    this.applyOrRebuild('BYBIT', base, {
      first: updateId, last: updateId, previous: null, exchangeTimestamp: finiteInteger(message.ts) ?? Date.now(), bids, asks,
    }, 'monotonic');
  }

  private applyOrRebuild(venue: ExecutionVenue, base: string, delta: Delta, mode: 'range' | 'previous' | 'monotonic'): void {
    const book = this.books.get(this.key(venue, base))!;
    if (!book.state.synchronized) {
      if (!book.state.rebuilding) {
        const generation = book.beginRebuild(book.state.lastError);
        book.buffer(delta);
        void this.bootstrap(venue, base, book, generation);
      } else {
        book.buffer(delta);
      }
      return;
    }
    if (!book.apply(delta, mode) && !book.state.rebuilding) {
      const generation = book.beginRebuild(book.state.lastError);
      void this.bootstrap(venue, base, book, generation);
    }
  }

  private multiplier(venue: ExecutionVenue, base: string | undefined): number {
    return base ? this.multipliers.get(this.key(venue, base)) ?? 1 : 1;
  }

  private async bootstrap(venue: ExecutionVenue, base: string, book: OrderBookReplica, generation: number): Promise<void> {
    try {
      const snapshot = await this.fetchSnapshot(venue, base);
      if (book.state.generation !== generation) return;
      const buffered = [...book.state.buffered];
      if (venue === 'OKX' || venue === 'BYBIT') {
        // REST 快照与这两所的 WS 序列没有官方桥接规则，只能等 WS snapshot 后才能认证。
        if (!book.state.synchronized) book.state.rebuilding = true;
        return;
      }
      book.seed(snapshot.bids, snapshot.asks, snapshot.sequence, snapshot.exchangeTimestamp, Date.now());
      if (venue === 'BINANCE') {
        const firstIndex = buffered.findIndex((delta) => delta.last >= snapshot.sequence
          && delta.first <= snapshot.sequence && delta.last >= snapshot.sequence);
        if (firstIndex === -1) throw new Error('binance_snapshot_bridge_missing');
        if (firstIndex >= 0) {
          const first = buffered[firstIndex]!;
          applyLevels(book.state.bids, first.bids);
          applyLevels(book.state.asks, first.asks);
          book.state.sequence = first.last;
          book.state.exchangeTimestamp = first.exchangeTimestamp;
          book.state.receivedAt = Date.now();
          for (const delta of buffered.slice(firstIndex + 1)) {
            if (!book.apply(delta, 'previous')) throw new Error(book.state.lastError ?? 'bootstrap_replay_failed');
          }
        }
        return;
      }
      const snapshotSequence = snapshot.sequence;
      for (const delta of buffered) {
        if (!book.apply(delta, 'range')) throw new Error(book.state.lastError ?? 'bootstrap_replay_failed');
      }
      if ((book.state.sequence ?? snapshotSequence) <= snapshotSequence) throw new Error('gate_snapshot_bridge_missing');
    } catch (error) {
      // WS snapshot 可能先于较慢的 REST 请求到达；不能让过期的 REST 失败覆盖已经同步的盘口。
      if (book.state.generation === generation && !book.state.synchronized) {
        book.state.rebuilding = false;
        book.state.lastError = error instanceof Error ? error.message : 'snapshot_bootstrap_failed';
      }
    }
  }

  private async fetchSnapshot(venue: ExecutionVenue, base: string): Promise<{ bids: Level[]; asks: Level[]; sequence: number; exchangeTimestamp: number }> {
    const symbol = nativeSymbol(venue, base);
    let url: string;
    if (venue === 'GATE') url = `${this.endpoints.GATE.rest}/futures/usdt/order_book?contract=${symbol}&limit=100&with_id=true`;
    else if (venue === 'BINANCE') url = `${this.endpoints.BINANCE.rest}/fapi/v1/depth?symbol=${symbol}&limit=1000`;
    else if (venue === 'OKX') url = `${this.endpoints.OKX.rest}/api/v5/market/books?instId=${encodeURIComponent(symbol)}&sz=400`;
    else url = `${this.endpoints.BYBIT.rest}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`snapshot_http_${response.status}`);
    const payload = object(await response.json());
    if (!payload) throw new Error('snapshot_schema_invalid');
    let bids: Level[] | null = null; let asks: Level[] | null = null;
    let sequence: number | null = null; let exchangeTimestamp = Date.now();
    if (venue === 'GATE') {
      const rawBids = Array.isArray(payload.bids) ? payload.bids.map((row) => { const item = object(row); return [item?.p, item?.s]; }) : null;
      const rawAsks = Array.isArray(payload.asks) ? payload.asks.map((row) => { const item = object(row); return [item?.p, item?.s]; }) : null;
      await this.loadMultiplier(venue, base);
      bids = levels(rawBids, this.multiplier(venue, base)); asks = levels(rawAsks, this.multiplier(venue, base));
      sequence = finiteInteger(payload.id); exchangeTimestamp = Math.round(Number(payload.update) * 1_000) || Date.now();
    } else if (venue === 'BINANCE') {
      bids = levels(payload.bids); asks = levels(payload.asks); sequence = finiteInteger(payload.lastUpdateId);
      exchangeTimestamp = finiteInteger(payload.E) ?? finiteInteger(payload.T) ?? Date.now();
    } else if (venue === 'OKX') {
      const envelope = Array.isArray(payload.data) ? object(payload.data[0]) : null;
      await this.loadMultiplier(venue, base);
      bids = levels(envelope?.bids, this.multiplier(venue, base)); asks = levels(envelope?.asks, this.multiplier(venue, base));
      // 普通 REST books 只用来验证初始深度，WS snapshot 才提供可桥接的序列。
      sequence = finiteInteger(envelope?.seqId) ?? 0; exchangeTimestamp = finiteInteger(envelope?.ts) ?? Date.now();
    } else {
      const result = object(payload.result);
      bids = levels(result?.b); asks = levels(result?.a); sequence = finiteInteger(result?.seq) ?? finiteInteger(result?.u);
      exchangeTimestamp = finiteInteger(payload.time) ?? finiteInteger(result?.ts) ?? Date.now();
    }
    if (!bids || !asks || bids.length === 0 || asks.length === 0 || sequence === null) throw new Error('snapshot_schema_invalid');
    return { bids, asks, sequence, exchangeTimestamp };
  }

  private async loadMultiplier(venue: 'GATE' | 'OKX', base: string): Promise<void> {
    if (this.multipliers.has(this.key(venue, base))) return;
    const symbol = nativeSymbol(venue, base);
    const url = venue === 'GATE'
      ? `${this.endpoints.GATE.rest}/futures/usdt/contracts/${symbol}`
      : `${this.endpoints.OKX.rest}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(symbol)}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`contract_metadata_http_${response.status}`);
    const payload = object(await response.json());
    const row = venue === 'GATE' ? payload : Array.isArray(payload?.data) ? object(payload.data[0]) : null;
    const multiplier = Number(venue === 'GATE' ? row?.quanto_multiplier : row?.ctVal);
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('contract_multiplier_invalid');
    this.multipliers.set(this.key(venue, base), multiplier);
  }
}

/** 每个交易所组合只保存最佳价和质量，不落完整深度，控制长期磁盘占用。 */
export function sampleExecutionPairs(hub: ExecutionMarketReader, symbols: readonly string[], now = Date.now()): ExecutionMarketSample[] {
  const rows: ExecutionMarketSample[] = [];
  for (const base of symbols) {
    for (let longIndex = 0; longIndex < EXECUTION_VENUES.length; longIndex += 1) {
      for (let shortIndex = longIndex + 1; shortIndex < EXECUTION_VENUES.length; shortIndex += 1) {
        const longVenue = EXECUTION_VENUES[longIndex]!;
        const shortVenue = EXECUTION_VENUES[shortIndex]!;
        rows.push({ ...hub.pair(base, longVenue, shortVenue, now), sampledAt: new Date(now).toISOString() });
        rows.push({ ...hub.pair(base, shortVenue, longVenue, now), sampledAt: new Date(now).toISOString() });
      }
    }
  }
  return rows;
}
