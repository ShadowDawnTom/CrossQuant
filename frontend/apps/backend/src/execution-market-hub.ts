import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { StablecoinFxOracle, type ExecutionQuote, type QuoteFxReader } from './quote-fx-oracle.js';

export const EXECUTION_VENUES = [
  'GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT',
] as const;
export type ExecutionVenue = typeof EXECUTION_VENUES[number];
/** 新增三所先用于行情认证和模拟盘；真实下单状态机完成专项演练前不能进入严格实盘池。 */
export const LIVE_EXECUTION_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT'] as const satisfies readonly ExecutionVenue[];
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
  quote: ExecutionQuote;
  quoteToUsd: string | null;
  quoteRateAgeMs: number | null;
  quoteRateState: 'healthy' | 'stale' | 'depegged' | 'unavailable';
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
  replaceSymbols?(symbols: readonly string[]): Promise<void>;
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
  stabilityTimer: ReturnType<typeof setTimeout> | null;
  lastMessageAt: number;
}

export interface ExecutionMarketHubOptions {
  symbols?: string[];
  /** 只有严格实盘资产参与整体 health；研究资产缺盘只影响自己的候选。 */
  requiredSymbols?: string[];
  maxBookAgeMs?: number;
  maxExchangeSkewMs?: number;
  maxReceiveSkewMs?: number;
  reconnectBaseMs?: number;
  bootstrapBaseMs?: number;
  rateLimitCooldownMs?: number;
  endpoints?: Partial<Record<ExecutionVenue, { rest: string; websocket: string }>>;
  quoteFx?: QuoteFxReader;
}

export interface ExecutionMarketSample extends ExecutionPairSnapshot {
  sampledAt: string;
}

const DEFAULT_ENDPOINTS: Record<ExecutionVenue, { rest: string; websocket: string }> = {
  GATE: { rest: 'https://api.gateio.ws/api/v4', websocket: 'wss://fx-ws.gateio.ws/v4/ws/usdt' },
  BINANCE: { rest: 'https://fapi.binance.com', websocket: 'wss://fstream.binance.com/ws' },
  OKX: { rest: 'https://openapi.okx.com', websocket: 'wss://ws.okx.com:8443/ws/v5/public' },
  BYBIT: { rest: 'https://api.bybit.com', websocket: 'wss://stream.bybit.com/v5/public/linear' },
  KRAKEN: { rest: 'https://futures.kraken.com', websocket: 'wss://futures.kraken.com/ws/v1' },
  HYPERLIQUID: { rest: 'https://api.hyperliquid.xyz', websocket: 'wss://api.hyperliquid.xyz/ws' },
  DERIBIT: { rest: 'https://www.deribit.com/api/v2', websocket: 'wss://www.deribit.com/ws/api/v2' },
};

const MAX_BUFFERED_DELTAS = 10_000;
const MAX_PUBLISHED_LEVELS = 200;

class SnapshotHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`snapshot_http_${status}`);
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

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

function levels(value: unknown, multiplier = '1'): Level[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Level[] = [];
  for (const row of value) {
    const item = object(row);
    const rawPrice = Array.isArray(row) && row.length >= 2 ? row[0] : item?.p;
    const rawSize = Array.isArray(row) && row.length >= 2 ? row[1] : item?.s;
    const price = positiveText(rawPrice);
    if (!price || (typeof rawSize !== 'string' && typeof rawSize !== 'number')) return null;
    const quantityText = String(rawSize);
    const quantityNumber = Number(quantityText);
    if (!Number.isFinite(quantityNumber) || quantityNumber < 0) return null;
    if (multiplier === '1') {
      // 大部分交易所已经推送基础币数量，热路径不必为每一档价格创建 Decimal 对象。
      parsed.push([price, quantityText]);
      continue;
    }
    try { parsed.push([price, new Decimal(quantityText).mul(multiplier).toString()]); }
    catch { return null; }
  }
  return parsed;
}

function keyedLevels(value: unknown, priceKey: string, sizeKey: string, multiplier = '1'): Level[] | null {
  if (!Array.isArray(value)) return null;
  return levels(value.map((row) => {
    const item = object(row);
    return [item?.[priceKey], item?.[sizeKey]];
  }), multiplier);
}

function deribitLevels(value: unknown): Level[] | null {
  if (!Array.isArray(value)) return null;
  return levels(value.map((row) => Array.isArray(row) && row.length >= 3 ? [row[1], row[2]] : row));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function iso(timestamp: number): string | null {
  return timestamp > 0 && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function executionQuote(venue: ExecutionVenue): ExecutionQuote {
  if (venue === 'KRAKEN') return 'USD';
  if (venue === 'HYPERLIQUID' || venue === 'DERIBIT') return 'USDC';
  return 'USDT';
}

export function crossExFutureSymbol(venue: ExecutionVenue, base: string): string {
  return `${venue}_FUTURE_${base.toUpperCase()}_${executionQuote(venue)}`;
}

export function nativeSymbol(venue: ExecutionVenue, base: string): string {
  if (venue === 'GATE') return `${base}_USDT`;
  if (venue === 'OKX') return `${base}-USDT-SWAP`;
  if (venue === 'KRAKEN') {
    const nativeBase = base === 'BTC' ? 'XBT' : base;
    return `PF_${nativeBase}USD`;
  }
  if (venue === 'HYPERLIQUID') return base;
  if (venue === 'DERIBIT') return `${base}_USDC-PERPETUAL`;
  // 各所对千倍面值合约的命名不统一，必须在原生行情层做映射，不能让一个错误主题拖垮整批订阅。
  if (venue === 'BYBIT' && base === 'PEPE') return '1000PEPEUSDT';
  return `${base}USDT`;
}

/** 将原生报价币价格折算成 USD；汇率不可用时必须由上层拒绝候选。 */
export function usdLevels(book: ExecutionBookSnapshot, source: readonly Level[]): Level[] | null {
  if (!book.quoteToUsd) return null;
  const rate = new Decimal(book.quoteToUsd);
  return source.map(([price, quantity]) => [new Decimal(price).mul(rate).toString(), quantity] as const);
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

function bestPrice(source: Map<string, string>, highest: boolean): number | null {
  let best: number | null = null;
  for (const priceText of source.keys()) {
    const price = Number(priceText);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (best === null || (highest ? price > best : price < best)) best = price;
  }
  return best;
}

function bookIsUncrossed(bids: Map<string, string>, asks: Map<string, string>): boolean {
  const bestBid = bestPrice(bids, true);
  const bestAsk = bestPrice(asks, false);
  // 单侧暂时为空会由 isLive 拒绝，但仍要保留序列以便下一条增量恢复；只有两侧都有价时才判断交叉。
  if (bestBid === null || bestAsk === null) return true;
  // 这里每秒会执行数千次；价格在解析时已经验证为有限正数，用数值比较可避免对整本盘口反复排序。
  return bestBid < bestAsk;
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
    this.state.bids.clear();
    this.state.asks.clear();
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

  seed(bids: Level[], asks: Level[], sequence: number, exchangeTimestamp: number, receivedAt: number): boolean {
    const nextBids = new Map(bids.filter(([, quantity]) => Number(quantity) > 0));
    const nextAsks = new Map(asks.filter(([, quantity]) => Number(quantity) > 0));
    if (!bookIsUncrossed(nextBids, nextAsks)) {
      this.state.bids.clear();
      this.state.asks.clear();
      this.state.sequence = null;
      this.state.synchronized = false;
      this.state.rebuilding = false;
      this.state.lastError = 'crossed_order_book';
      this.state.sequenceGaps += 1;
      return false;
    }
    this.state.bids = nextBids;
    this.state.asks = nextAsks;
    this.state.sequence = sequence;
    this.state.exchangeTimestamp = exchangeTimestamp;
    this.state.receivedAt = receivedAt;
    this.state.synchronized = true;
    this.state.rebuilding = false;
    this.state.lastError = null;
    return true;
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
    if (!bookIsUncrossed(this.state.bids, this.state.asks)) {
      this.gap('crossed_order_book');
      this.state.bids.clear();
      this.state.asks.clear();
      return false;
    }
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
 * 七所永续合约执行行情服务。REST 负责启动基线，WebSocket 增量负责持续更新和断序检测。
 */
export class ExecutionMarketHub {
  private readonly symbols: string[];
  private readonly requiredSymbols: Set<string>;
  private readonly books = new Map<string, OrderBookReplica>();
  private readonly connections = new Map<ExecutionVenue, VenueConnection>();
  private readonly multipliers = new Map<string, string>();
  private readonly metadataUnavailable = new Set<string>();
  private readonly metadataLoadedVenues = new Set<'GATE' | 'OKX'>();
  private readonly bootstrapTasks = new Map<string, Promise<void>>();
  private readonly bootstrapAttempts = new Map<string, number>();
  private readonly bootstrapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly venueCooldownUntil = new Map<ExecutionVenue, number>();
  private readonly endpoints: Record<ExecutionVenue, { rest: string; websocket: string }>;
  private readonly maxBookAgeMs: number;
  private readonly maxExchangeSkewMs: number;
  private readonly maxReceiveSkewMs: number;
  private readonly reconnectBaseMs: number;
  private readonly bootstrapBaseMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly quoteFx: QuoteFxReader;
  private stopped = true;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    options: ExecutionMarketHubOptions = {},
  ) {
    this.symbols = [...new Set((options.symbols ?? ['BTC', 'ETH']).map((item) => item.trim().toUpperCase()).filter(Boolean))];
    if (this.symbols.length === 0 || this.symbols.length > 50) throw new Error('execution market symbols must contain 1 to 50 assets');
    this.requiredSymbols = new Set((options.requiredSymbols ?? this.symbols)
      .map((item) => item.trim().toUpperCase()).filter((item) => this.symbols.includes(item)));
    if (this.requiredSymbols.size === 0) throw new Error('execution market required symbols must be configured');
    this.maxBookAgeMs = options.maxBookAgeMs ?? 1_500;
    this.maxExchangeSkewMs = options.maxExchangeSkewMs ?? 750;
    this.maxReceiveSkewMs = options.maxReceiveSkewMs ?? 750;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.bootstrapBaseMs = options.bootstrapBaseMs ?? 1_000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 15 * 60_000;
    this.quoteFx = options.quoteFx ?? new StablecoinFxOracle(fetchImpl);
    this.endpoints = { ...DEFAULT_ENDPOINTS };
    for (const venue of EXECUTION_VENUES) {
      if (options.endpoints?.[venue]) this.endpoints[venue] = options.endpoints[venue]!;
      this.connections.set(venue, {
        socket: null, state: 'disconnected', reconnects: 0, reconnectAttempt: 0,
        reconnectTimer: null, heartbeatTimer: null, lastMessageAt: 0,
        handshakeTimer: null, stabilityTimer: null,
      });
      for (const base of this.symbols) this.books.set(this.key(venue, base), new OrderBookReplica(venue, base));
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.quoteFx.start();
    for (const venue of EXECUTION_VENUES) void this.startVenue(venue);
  }

  stop(): void {
    this.stopped = true;
    this.quoteFx.stop();
    for (const connection of this.connections.values()) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      if (connection.stabilityTimer) clearTimeout(connection.stabilityTimer);
      connection.socket?.close();
      connection.socket = null;
      connection.state = 'disconnected';
      connection.reconnectTimer = null;
      connection.heartbeatTimer = null;
      connection.handshakeTimer = null;
      connection.stabilityTimer = null;
    }
    for (const timer of this.bootstrapTimers.values()) clearTimeout(timer);
    this.bootstrapTimers.clear();
  }

  /**
   * 运行中只替换研究盘口热池。严格实盘资产始终保留；增删主题不重连整所，避免动态筛选制造行情空窗。
   */
  async replaceSymbols(symbols: readonly string[]): Promise<void> {
    const next = [...new Set(symbols.map((item) => item.trim().toUpperCase()).filter(Boolean))];
    for (const asset of this.requiredSymbols) if (!next.includes(asset)) next.unshift(asset);
    if (next.length === 0 || next.length > 50) throw new Error('execution market symbols must contain 1 to 50 assets');
    const removed = this.symbols.filter((asset) => !next.includes(asset));
    const added = next.filter((asset) => !this.symbols.includes(asset));
    if (removed.length === 0 && added.length === 0) return;
    this.symbols.splice(0, this.symbols.length, ...next);
    for (const base of added) {
      for (const venue of EXECUTION_VENUES) this.books.set(this.key(venue, base), new OrderBookReplica(venue, base));
    }
    for (const base of removed) {
      for (const venue of EXECUTION_VENUES) {
        const key = this.key(venue, base);
        const timer = this.bootstrapTimers.get(key);
        if (timer) clearTimeout(timer);
        this.bootstrapTimers.delete(key);
        this.bootstrapAttempts.delete(key);
        this.metadataUnavailable.delete(key);
      }
    }
    // Gate/OKX 合约乘数会影响基础币数量，新增币必须先刷新整所元数据再启动盘口。
    this.metadataLoadedVenues.clear();
    const metadataResults = await Promise.allSettled([this.loadVenueMultipliers('GATE'), this.loadVenueMultipliers('OKX')]);
    (['GATE', 'OKX'] as const).forEach((venue, index) => {
      const result = metadataResults[index];
      if (result?.status !== 'rejected') return;
      for (const base of added) {
        const key = this.key(venue, base);
        this.metadataUnavailable.add(key);
        const state = this.books.get(key)!.state;
        state.lastError = result.reason instanceof Error ? result.reason.message : 'contract_metadata_failed';
      }
    });
    if (!this.stopped) {
      for (const venue of EXECUTION_VENUES) {
        const socket = this.connections.get(venue)?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) continue;
        this.unsubscribeSymbols(venue, socket, removed);
        const activeAdded = added.filter((base) => !this.metadataUnavailable.has(this.key(venue, base)));
        this.subscribeSymbols(venue, socket, activeAdded);
        for (const base of activeAdded) {
          const book = this.books.get(this.key(venue, base))!;
          const generation = book.beginRebuild('hot_pool_added');
          if (venue !== 'BYBIT') this.requestBootstrap(venue, base, book, generation);
        }
      }
    }
    for (const base of removed) {
      for (const venue of EXECUTION_VENUES) this.books.delete(this.key(venue, base));
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
    // 研究专用三所发生故障时保留在逐所状态里，但不能让它们触发实盘核心行情 Kill Switch。
    const requiredBooks = LIVE_EXECUTION_VENUES.flatMap((venue) => [...this.requiredSymbols]
      .map((base) => ({ venue, book: this.books.get(this.key(venue, base))! })));
    const ready = requiredBooks.filter(({ venue, book }) => this.isLive(book, this.connections.get(venue)!, now)).length;
    const total = requiredBooks.length;
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
    const quote = executionQuote(venue);
    const quoteRate = this.quoteFx.rate(quote, now);
    return {
      venue, symbol: nativeSymbol(venue, normalized), base: normalized, quote,
      quoteToUsd: quoteRate.usdRate, quoteRateAgeMs: quoteRate.ageMs, quoteRateState: quoteRate.state,
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
    if (longBook.quoteRateState !== 'healthy') reasons.push(`long_${longBook.quote.toLowerCase()}_fx_${longBook.quoteRateState}`);
    if (shortBook.quoteRateState !== 'healthy') reasons.push(`short_${shortBook.quote.toLowerCase()}_fx_${shortBook.quoteRateState}`);
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
        await this.loadVenueMultipliers(venue);
      }
      this.connect(venue);
    } catch (error) {
      for (const base of this.venueSymbols(venue)) {
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
      // TCP 握手成功不等于订阅成功；至少收到一本有效快照后才能对外宣称行情连接健康。
      connection.state = 'connecting';
      // 连接至少稳定 30 秒后才重置退避；“刚连上就被踢”的错误订阅不能制造重连风暴。
      if (connection.stabilityTimer) clearTimeout(connection.stabilityTimer);
      connection.stabilityTimer = setTimeout(() => {
        if (connection.socket === socket && socket.readyState === WebSocket.OPEN) connection.reconnectAttempt = 0;
      }, 30_000);
      connection.stabilityTimer.unref?.();
      this.subscribe(venue, socket);
      for (const base of this.venueSymbols(venue)) {
        const book = this.books.get(this.key(venue, base))!;
        const generation = book.beginRebuild('connection_opened');
        // Bybit 的 orderbook 主题首包本身就是完整快照。避免 30 个 REST 初始化请求触发 IP 级封禁。
        if (venue !== 'BYBIT') this.requestBootstrap(venue, base, book, generation);
      }
      connection.heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (connection.lastMessageAt > 0 && Date.now() - connection.lastMessageAt > 30_000) {
          socket.terminate();
          return;
        }
        if (venue === 'OKX') socket.send('ping');
        else if (venue === 'BYBIT') socket.send(JSON.stringify({ op: 'ping' }));
        else if (venue === 'HYPERLIQUID') socket.send(JSON.stringify({ method: 'ping' }));
        else if (venue === 'DERIBIT') socket.send(JSON.stringify({
          jsonrpc: '2.0', id: Date.now(), method: 'public/test', params: {},
        }));
        else socket.ping();
      }, 15_000);
      connection.heartbeatTimer.unref?.();
    });
    socket.on('message', (payload) => {
      connection.lastMessageAt = Date.now();
      this.onMessage(venue, payload.toString());
    });
    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : 'unknown';
      for (const base of this.venueSymbols(venue)) {
        this.books.get(this.key(venue, base))!.state.lastError = `websocket_error:${message}`;
      }
    });
    socket.on('close', (code, reason) => {
      if (connection.socket !== socket) return;
      if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      if (connection.stabilityTimer) clearTimeout(connection.stabilityTimer);
      connection.heartbeatTimer = null;
      connection.handshakeTimer = null;
      connection.stabilityTimer = null;
      connection.socket = null;
      const closeReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
      for (const base of this.symbols) {
        const state = this.books.get(this.key(venue, base))!.state;
        state.synchronized = false;
        state.lastError = `websocket_closed:${code}:${closeReason || 'no_reason'}`;
      }
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
    this.subscribeSymbols(venue, socket, this.venueSymbols(venue));
  }

  private subscribeSymbols(venue: ExecutionVenue, socket: WebSocket, symbols: readonly string[]): void {
    if (symbols.length === 0) return;
    if (venue === 'GATE') {
      for (const base of symbols) socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000), channel: 'futures.order_book_update', event: 'subscribe',
        // REST 初始化固定取 100 档，因此 WS 也必须订阅 100 档，否则本地深度会逐步错位。
        payload: [nativeSymbol(venue, base), '100ms', '100'],
      }));
    } else if (venue === 'BINANCE') {
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: symbols.map((base) => `${nativeSymbol(venue, base).toLowerCase()}@depth@100ms`), id: Date.now() }));
    } else if (venue === 'OKX') {
      socket.send(JSON.stringify({ op: 'subscribe', args: symbols.map((base) => ({ channel: 'books', instId: nativeSymbol(venue, base) })) }));
    } else if (venue === 'BYBIT') {
      // 单个无效合约不能污染整所订阅；req_id 也让失败 ACK 能准确落到对应盘口。
      for (const base of symbols) socket.send(JSON.stringify({ req_id: `book:${base}`, op: 'subscribe',
        args: [`orderbook.200.${nativeSymbol(venue, base)}`] }));
    } else if (venue === 'KRAKEN') {
      for (const base of symbols) socket.send(JSON.stringify({ event: 'subscribe', feed: 'book',
        product_ids: [nativeSymbol(venue, base)] }));
    } else if (venue === 'HYPERLIQUID') {
      for (const base of symbols) socket.send(JSON.stringify({
        method: 'subscribe', subscription: { type: 'l2Book', coin: nativeSymbol(venue, base) },
      }));
    } else {
      for (const base of symbols) socket.send(JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${base}`,
        method: 'public/subscribe', params: { channels: [`book.${nativeSymbol(venue, base)}.100ms`] } }));
    }
  }

  private unsubscribeSymbols(venue: ExecutionVenue, socket: WebSocket, symbols: readonly string[]): void {
    if (symbols.length === 0) return;
    if (venue === 'GATE') {
      for (const base of symbols) socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000), channel: 'futures.order_book_update', event: 'unsubscribe',
        payload: [nativeSymbol(venue, base), '100ms', '100'],
      }));
    } else if (venue === 'BINANCE') {
      socket.send(JSON.stringify({ method: 'UNSUBSCRIBE',
        params: symbols.map((base) => `${nativeSymbol(venue, base).toLowerCase()}@depth@100ms`), id: Date.now() }));
    } else if (venue === 'OKX') {
      socket.send(JSON.stringify({ op: 'unsubscribe',
        args: symbols.map((base) => ({ channel: 'books', instId: nativeSymbol(venue, base) })) }));
    } else if (venue === 'BYBIT') {
      for (const base of symbols) socket.send(JSON.stringify({ req_id: `unbook:${base}`, op: 'unsubscribe',
        args: [`orderbook.200.${nativeSymbol(venue, base)}`] }));
    } else if (venue === 'KRAKEN') {
      for (const base of symbols) socket.send(JSON.stringify({ event: 'unsubscribe', feed: 'book',
        product_ids: [nativeSymbol(venue, base)] }));
    } else if (venue === 'HYPERLIQUID') {
      for (const base of symbols) socket.send(JSON.stringify({ method: 'unsubscribe',
        subscription: { type: 'l2Book', coin: nativeSymbol(venue, base) } }));
    } else {
      for (const base of symbols) socket.send(JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-un-${base}`,
        method: 'public/unsubscribe', params: { channels: [`book.${nativeSymbol(venue, base)}.100ms`] } }));
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
    else if (venue === 'BYBIT') this.onBybit(message);
    else if (venue === 'KRAKEN') this.onKraken(message);
    else if (venue === 'HYPERLIQUID') this.onHyperliquid(message);
    else this.onDeribit(message);
    const connection = this.connections.get(venue)!;
    if (this.venueSymbols(venue).some((base) => this.books.get(this.key(venue, base))!.state.synchronized)) {
      connection.state = 'healthy';
    }
  }

  private onGate(message: Record<string, unknown>): void {
    if (message.channel !== 'futures.order_book_update' || message.event !== 'update') return;
    const result = object(message.result);
    if (!result) return;
    const symbol = typeof result.s === 'string' ? result.s : '';
    const base = this.symbols.find((item) => nativeSymbol('GATE', item) === symbol);
    const first = finiteInteger(result.U); const last = finiteInteger(result.u);
    const bids = levels(result.b, this.multiplier('GATE', base)); const asks = levels(result.a, this.multiplier('GATE', base));
    if (!base || last === null || !bids || !asks) return;
    if (result.full === true) {
      const book = this.books.get(this.key('GATE', base))!;
      if (!book.seed(bids, asks, last, finiteInteger(result.t) ?? Date.now(), Date.now())) {
        const generation = book.beginRebuild(book.state.lastError);
        this.requestBootstrap('GATE', base, book, generation);
      }
      return;
    }
    if (first === null) return;
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
    if (message.op === 'subscribe') {
      const requestId = typeof message.req_id === 'string' ? message.req_id : '';
      const base = requestId.startsWith('book:') ? requestId.slice(5) : '';
      if (base && message.success === false) {
        const state = this.books.get(this.key('BYBIT', base))?.state;
        if (state) {
          state.synchronized = false;
          state.lastError = `subscription_rejected:${String(message.ret_msg ?? 'unknown')}`;
        }
      }
      return;
    }
    if (typeof message.topic !== 'string' || !message.topic.startsWith('orderbook.200.')) return;
    const row = object(message.data);
    if (!row || typeof row.s !== 'string') return;
    const base = this.symbols.find((item) => nativeSymbol('BYBIT', item) === row.s);
    const updateId = finiteInteger(row.u);
    const bids = levels(row.b); const asks = levels(row.a);
    if (!base || updateId === null || !bids || !asks) return;
    const book = this.books.get(this.key('BYBIT', base))!;
    if (message.type === 'snapshot' || updateId === 1) {
      if (!book.seed(bids, asks, updateId, finiteInteger(message.ts) ?? finiteInteger(row.cts) ?? Date.now(), Date.now())) {
        this.connections.get('BYBIT')?.socket?.terminate();
      }
      return;
    }
    // `seq` 是跨频道序号，不能拿来判断本频道连续性；本地盘口按 update id 严格连续，疑似丢包就重建。
    this.applyOrRebuild('BYBIT', base, {
      first: updateId, last: updateId, previous: null, exchangeTimestamp: finiteInteger(message.ts) ?? Date.now(), bids, asks,
    }, 'monotonic');
  }

  private onKraken(message: Record<string, unknown>): void {
    if (message.feed !== 'book_snapshot' && message.feed !== 'book') return;
    const product = typeof message.product_id === 'string' ? message.product_id : '';
    const base = this.symbols.find((item) => nativeSymbol('KRAKEN', item) === product);
    const sequence = finiteInteger(message.seq);
    const timestamp = finiteInteger(message.timestamp) ?? Date.now();
    if (!base || sequence === null) return;
    const book = this.books.get(this.key('KRAKEN', base))!;
    if (message.feed === 'book_snapshot') {
      const bids = keyedLevels(message.bids, 'price', 'qty');
      const asks = keyedLevels(message.asks, 'price', 'qty');
      if (!bids || !asks) return;
      book.seed(bids, asks, sequence, timestamp, Date.now());
      return;
    }
    const price = positiveText(message.price);
    const quantity = typeof message.qty === 'string' || typeof message.qty === 'number' ? String(message.qty) : null;
    if (!price || quantity === null || (message.side !== 'buy' && message.side !== 'sell')) return;
    const update: Level = [price, quantity];
    this.applyOrRebuild('KRAKEN', base, {
      first: sequence, last: sequence, previous: null, exchangeTimestamp: timestamp,
      bids: message.side === 'buy' ? [update] : [], asks: message.side === 'sell' ? [update] : [],
    }, 'range');
  }

  private onHyperliquid(message: Record<string, unknown>): void {
    if (message.channel !== 'l2Book') return;
    const data = object(message.data);
    if (!data || typeof data.coin !== 'string' || !Array.isArray(data.levels)) return;
    const base = this.symbols.find((item) => nativeSymbol('HYPERLIQUID', item) === data.coin);
    const bids = keyedLevels(data.levels[0], 'px', 'sz');
    const asks = keyedLevels(data.levels[1], 'px', 'sz');
    const timestamp = finiteInteger(data.time);
    if (!base || !bids || !asks || timestamp === null) return;
    // Hyperliquid 每次推送都是完整 L2 快照，没有增量序号；新块直接原子替换即可。
    this.books.get(this.key('HYPERLIQUID', base))!.seed(bids, asks, timestamp, timestamp, Date.now());
  }

  private onDeribit(message: Record<string, unknown>): void {
    if (message.method !== 'subscription') return;
    const params = object(message.params);
    const data = object(params?.data);
    const channel = typeof params?.channel === 'string' ? params.channel : '';
    if (!data || !channel.startsWith('book.') || typeof data.instrument_name !== 'string') return;
    const base = this.symbols.find((item) => nativeSymbol('DERIBIT', item) === data.instrument_name);
    const changeId = finiteInteger(data.change_id);
    const bids = deribitLevels(data.bids);
    const asks = deribitLevels(data.asks);
    if (!base || changeId === null || !bids || !asks) return;
    const timestamp = finiteInteger(data.timestamp) ?? Date.now();
    const book = this.books.get(this.key('DERIBIT', base))!;
    if (data.type === 'snapshot') {
      book.seed(bids, asks, changeId, timestamp, Date.now());
      return;
    }
    const previous = finiteInteger(data.prev_change_id);
    if (data.type === 'change' && previous !== null) {
      this.applyOrRebuild('DERIBIT', base, {
        first: changeId, last: changeId, previous, exchangeTimestamp: timestamp, bids, asks,
      }, 'previous');
    }
  }

  private applyOrRebuild(venue: ExecutionVenue, base: string, delta: Delta, mode: 'range' | 'previous' | 'monotonic'): void {
    const book = this.books.get(this.key(venue, base))!;
    if (!book.state.synchronized) {
      if (!book.state.rebuilding) {
        const generation = book.beginRebuild(book.state.lastError);
        book.buffer(delta);
        this.requestBootstrap(venue, base, book, generation);
      } else {
        book.buffer(delta);
      }
      return;
    }
    if (!book.apply(delta, mode) && !book.state.rebuilding) {
      // Bybit 的 WS 快照就是权威初始化源；断序后重连可重新获得全量快照，也避免 REST 限频风暴。
      if (venue === 'BYBIT') {
        this.connections.get('BYBIT')?.socket?.terminate();
        return;
      }
      const generation = book.beginRebuild(book.state.lastError);
      this.requestBootstrap(venue, base, book, generation);
    }
  }

  private multiplier(venue: ExecutionVenue, base: string | undefined): string {
    return base ? this.multipliers.get(this.key(venue, base)) ?? '1' : '1';
  }

  private venueSymbols(venue: ExecutionVenue): string[] {
    return this.symbols.filter((base) => !this.metadataUnavailable.has(this.key(venue, base)));
  }

  private requestBootstrap(venue: ExecutionVenue, base: string, book: OrderBookReplica, generation: number): void {
    const key = this.key(venue, base);
    if (this.stopped || !this.symbols.includes(base) || this.bootstrapTasks.has(key) || this.bootstrapTimers.has(key)) return;
    const venueCooldown = this.venueCooldownUntil.get(venue) ?? 0;
    if (venueCooldown > Date.now()) {
      const timer = setTimeout(() => {
        this.bootstrapTimers.delete(key);
        this.requestBootstrap(venue, base, book, book.state.generation);
      }, venueCooldown - Date.now());
      timer.unref?.();
      this.bootstrapTimers.set(key, timer);
      return;
    }
    const task = this.bootstrap(venue, base, book, generation)
      .then(() => { this.bootstrapAttempts.delete(key); })
      .catch((error: unknown) => {
        if (this.stopped || book.state.generation !== generation || book.state.synchronized) return;
        book.state.lastError = error instanceof Error ? error.message : 'snapshot_bootstrap_failed';
        const attempts = (this.bootstrapAttempts.get(key) ?? 0) + 1;
        this.bootstrapAttempts.set(key, attempts);
        // Bybit 的 403 access-too-frequent 是 IP 级封禁；全所共享冷却，不能让逐币重试自维持封禁。
        const rateLimited = error instanceof SnapshotHttpError
          && (error.status === 418 || error.status === 429 || (venue === 'BYBIT' && error.status === 403));
        if (rateLimited) this.venueCooldownUntil.set(venue, Date.now() + Math.max(this.rateLimitCooldownMs, error.retryAfterMs ?? 0));
        const delay = rateLimited
          ? Math.max(this.rateLimitCooldownMs, error.retryAfterMs ?? 0)
          : Math.min(30_000, this.bootstrapBaseMs * 2 ** Math.min(attempts - 1, 5));
        const timer = setTimeout(() => {
          this.bootstrapTimers.delete(key);
          this.requestBootstrap(venue, base, book, book.state.generation);
        }, delay);
        timer.unref?.();
        this.bootstrapTimers.set(key, timer);
      })
      .finally(() => {
        this.bootstrapTasks.delete(key);
        if (!this.stopped && this.symbols.includes(base) && !book.state.synchronized && !this.bootstrapTimers.has(key)) {
          this.requestBootstrap(venue, base, book, book.state.generation);
        }
      });
    this.bootstrapTasks.set(key, task);
  }

  private async bootstrap(venue: ExecutionVenue, base: string, book: OrderBookReplica, generation: number): Promise<void> {
      const snapshot = await this.fetchSnapshot(venue, base);
      if (book.state.generation !== generation) return;
       if (venue === 'OKX' || venue === 'BYBIT' || venue === 'KRAKEN'
         || venue === 'HYPERLIQUID' || venue === 'DERIBIT') {
         // REST 先验证市场和深度；这些频道都会主动发送完整 WS snapshot，收到后才认证。
         if (!book.state.synchronized) book.state.rebuilding = true;
         return;
      }
      if (venue === 'BINANCE') {
        // REST 响应可能比对应的 WS 增量先到，短暂等待同一份快照被增量追上，避免反复请求最新快照。
        await this.waitForSnapshotBridge(book, generation, (delta) => (
          delta.last >= snapshot.sequence && delta.first <= snapshot.sequence
        ));
        const buffered = [...book.state.buffered];
        const firstIndex = buffered.findIndex((delta) => delta.last >= snapshot.sequence
          && delta.first <= snapshot.sequence && delta.last >= snapshot.sequence);
        if (firstIndex === -1) throw new Error('binance_snapshot_bridge_missing');
        book.seed(snapshot.bids, snapshot.asks, snapshot.sequence, snapshot.exchangeTimestamp, Date.now());
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
      await this.waitForSnapshotBridge(book, generation, (delta) => (
        delta.first <= snapshot.sequence + 1 && delta.last >= snapshot.sequence + 1
      ));
      const buffered = [...book.state.buffered];
      const firstIndex = buffered.findIndex(
        (delta) => delta.first <= snapshot.sequence + 1 && delta.last >= snapshot.sequence + 1,
      );
      if (firstIndex === -1) throw new Error('gate_snapshot_bridge_missing');
      book.seed(snapshot.bids, snapshot.asks, snapshot.sequence, snapshot.exchangeTimestamp, Date.now());
      for (const delta of buffered.slice(firstIndex)) {
        if (!book.apply(delta, 'range')) throw new Error(book.state.lastError ?? 'bootstrap_replay_failed');
      }
  }

  /**
   * 等待 WS 增量覆盖刚拿到的 REST 快照序号。
   * 只等当前重建代次，超时仍然失败关闭，不能拿不连续的盘口通过认证。
   */
  private async waitForSnapshotBridge(
    book: OrderBookReplica,
    generation: number,
    matches: (delta: Delta) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (book.state.generation === generation && !book.state.buffered.some(matches)) {
      if (Date.now() >= deadline) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private async fetchSnapshot(venue: ExecutionVenue, base: string): Promise<{ bids: Level[]; asks: Level[]; sequence: number; exchangeTimestamp: number }> {
    const symbol = nativeSymbol(venue, base);
    let url: string;
    let init: RequestInit = { signal: AbortSignal.timeout(8_000) };
    if (venue === 'GATE') url = `${this.endpoints.GATE.rest}/futures/usdt/order_book?contract=${symbol}&limit=100&with_id=true`;
    else if (venue === 'BINANCE') url = `${this.endpoints.BINANCE.rest}/fapi/v1/depth?symbol=${symbol}&limit=1000`;
    else if (venue === 'OKX') url = `${this.endpoints.OKX.rest}/api/v5/market/books?instId=${encodeURIComponent(symbol)}&sz=400`;
    else if (venue === 'BYBIT') url = `${this.endpoints.BYBIT.rest}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`;
    else if (venue === 'KRAKEN') url = `${this.endpoints.KRAKEN.rest}/derivatives/api/v3/orderbook?symbol=${encodeURIComponent(symbol)}`;
    else if (venue === 'HYPERLIQUID') {
      url = `${this.endpoints.HYPERLIQUID.rest}/info`;
      init = { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: symbol }), signal: AbortSignal.timeout(8_000) };
    } else url = `${this.endpoints.DERIBIT.rest}/public/get_order_book?instrument_name=${encodeURIComponent(symbol)}&depth=200`;
    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw new SnapshotHttpError(response.status, retryAfterMs(response.headers.get('retry-after')));
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
    } else if (venue === 'BYBIT') {
      const result = object(payload.result);
      bids = levels(result?.b); asks = levels(result?.a); sequence = finiteInteger(result?.seq) ?? finiteInteger(result?.u);
      exchangeTimestamp = finiteInteger(payload.time) ?? finiteInteger(result?.ts) ?? Date.now();
    } else if (venue === 'KRAKEN') {
      const orderBook = object(payload.orderBook);
      bids = keyedLevels(orderBook?.bids, 'price', 'qty'); asks = keyedLevels(orderBook?.asks, 'price', 'qty'); sequence = 0;
      exchangeTimestamp = Date.parse(String(payload.serverTime ?? '')) || Date.now();
    } else if (venue === 'HYPERLIQUID') {
      bids = keyedLevels(Array.isArray(payload.levels) ? payload.levels[0] : null, 'px', 'sz');
      asks = keyedLevels(Array.isArray(payload.levels) ? payload.levels[1] : null, 'px', 'sz');
      sequence = finiteInteger(payload.time) ?? 0; exchangeTimestamp = finiteInteger(payload.time) ?? Date.now();
    } else {
      const result = object(payload.result);
      bids = deribitLevels(result?.bids); asks = deribitLevels(result?.asks);
      sequence = finiteInteger(result?.change_id) ?? 0; exchangeTimestamp = finiteInteger(result?.timestamp) ?? Date.now();
    }
    if (!bids || !asks || bids.length === 0 || asks.length === 0 || sequence === null) throw new Error('snapshot_schema_invalid');
    return { bids, asks, sequence, exchangeTimestamp };
  }

  private async loadMultiplier(venue: 'GATE' | 'OKX', base: string): Promise<void> {
    if (this.multipliers.has(this.key(venue, base))) return;
    if (this.metadataUnavailable.has(this.key(venue, base))) throw new Error('contract_not_listed');
    const symbol = nativeSymbol(venue, base);
    const url = venue === 'GATE'
      ? `${this.endpoints.GATE.rest}/futures/usdt/contracts/${symbol}`
      : `${this.endpoints.OKX.rest}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(symbol)}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`contract_metadata_http_${response.status}`);
    const payload = object(await response.json());
    const row = venue === 'GATE' ? payload : Array.isArray(payload?.data) ? object(payload.data[0]) : null;
    const rawMultiplier = venue === 'GATE' ? row?.quanto_multiplier : row?.ctVal;
    try {
      const multiplier = new Decimal(String(rawMultiplier));
      if (!multiplier.isFinite() || !multiplier.isPositive()) throw new Error('contract_multiplier_invalid');
      this.multipliers.set(this.key(venue, base), multiplier.toString());
    } catch {
      throw new Error('contract_multiplier_invalid');
    }
  }

  /** 一次拉取整所合约元数据，避免动态热池逐币请求打爆公开 REST 限频。 */
  private async loadVenueMultipliers(venue: 'GATE' | 'OKX'): Promise<void> {
    if (this.metadataLoadedVenues.has(venue)) return;
    const rows: unknown[] = [];
    if (venue === 'GATE') {
      // Gate 单页上限是 100；顺序分页只在服务启动或重连时执行，仍远少于逐币请求。
      for (let offset = 0; offset < 1_000; offset += 100) {
        const response = await this.fetchImpl(`${this.endpoints.GATE.rest}/futures/usdt/contracts?limit=100&offset=${offset}`,
          { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`contract_metadata_http_${response.status}`);
        const page = await response.json() as unknown;
        if (!Array.isArray(page)) throw new Error('contract_metadata_schema_invalid');
        rows.push(...page);
        if (page.length < 100) break;
      }
    } else {
      const response = await this.fetchImpl(`${this.endpoints.OKX.rest}/api/v5/public/instruments?instType=SWAP`,
        { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`contract_metadata_http_${response.status}`);
      const payload = object(await response.json());
      if (!Array.isArray(payload?.data)) throw new Error('contract_metadata_schema_invalid');
      rows.push(...payload.data);
    }
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const value of rows) {
      const row = object(value);
      const symbol = venue === 'GATE' ? row?.name : row?.instId;
      if (row && typeof symbol === 'string') bySymbol.set(symbol, row);
    }
    for (const base of this.symbols) {
      const key = this.key(venue, base);
      const row = bySymbol.get(nativeSymbol(venue, base));
      const rawMultiplier = venue === 'GATE' ? row?.quanto_multiplier : row?.ctVal;
      try {
        const multiplier = new Decimal(String(rawMultiplier));
        if (!multiplier.isFinite() || !multiplier.isPositive()) throw new Error('contract_multiplier_invalid');
        this.multipliers.set(key, multiplier.toString());
        this.metadataUnavailable.delete(key);
      } catch {
        this.metadataUnavailable.add(key);
        const state = this.books.get(key)!.state;
        state.synchronized = false;
        state.lastError = row ? 'contract_multiplier_invalid' : 'contract_not_listed';
      }
    }
    this.metadataLoadedVenues.add(venue);
  }
}

/** 每个交易所组合只保存最佳价和质量，不落完整深度，控制长期磁盘占用。 */
export function sampleExecutionPairs(hub: ExecutionMarketReader, symbols: readonly string[], now = Date.now(),
  venues: readonly ExecutionVenue[] = LIVE_EXECUTION_VENUES): ExecutionMarketSample[] {
  const rows: ExecutionMarketSample[] = [];
  for (const base of symbols) {
    for (let longIndex = 0; longIndex < venues.length; longIndex += 1) {
      for (let shortIndex = longIndex + 1; shortIndex < venues.length; shortIndex += 1) {
        const longVenue = venues[longIndex]!;
        const shortVenue = venues[shortIndex]!;
        rows.push({ ...hub.pair(base, longVenue, shortVenue, now), sampledAt: new Date(now).toISOString() });
        rows.push({ ...hub.pair(base, shortVenue, longVenue, now), sampledAt: new Date(now).toISOString() });
      }
    }
  }
  return rows;
}
