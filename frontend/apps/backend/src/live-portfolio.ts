import { z } from 'zod';
import type {
  PortfolioBalance,
  PortfolioFill,
  PortfolioFuturesPosition,
  PortfolioMarginPosition,
  PortfolioOrder,
  PortfolioSnapshotResponse,
} from '@gate-crossex/shared-types';
import type { PrivateCrossExEvent, PrivateStreamStatus } from './private-stream.js';

const OPEN_ORDER_STATES = new Set(['PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED']);
const MAX_RECENT_FILLS = 100;
const MAX_PENDING_EVENTS = 500;
const EMIT_INTERVAL_MS = 50;

export interface LivePortfolioMetadata {
  source: 'cache' | 'rest' | 'websocket';
  sequence: number;
  lastEventAt: string | null;
  lastReconciledAt: string | null;
  stream: PrivateStreamStatus;
}

export type LivePortfolioSnapshot = PortfolioSnapshotResponse & { live: LivePortfolioMetadata };

export type LivePortfolioMessage =
  | { type: 'portfolio.snapshot'; payload: LivePortfolioSnapshot }
  | { type: 'portfolio.cleared'; payload: null }
  | { type: 'private-stream.status'; payload: PrivateStreamStatus };

type Listener = (message: LivePortfolioMessage) => void;

const PositionPushSchema = z.object({
  position_id: z.string(),
  symbol: z.string(),
  position_side: z.string(),
  initial_margin: z.string().optional(),
  maintenance_margin: z.string().optional(),
  position_qty: z.string().optional(),
  position_value: z.string().optional(),
  upnl: z.string().optional(),
  upnl_rate: z.string().optional(),
  entry_price: z.string().optional(),
  mark_price: z.string().optional(),
  leverage: z.string().optional(),
  max_leverage: z.string().optional(),
  risk_limit: z.string().optional(),
  fee: z.string().optional(),
  funding_fee: z.string().optional(),
  funding_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  closed_pnl: z.string().optional(),
}).passthrough();

const MarginPositionPushSchema = z.object({
  position_id: z.string(),
  symbol: z.string(),
  position_side: z.string(),
  initial_margin: z.string().optional(),
  maintenance_margin: z.string().optional(),
  asset_qty: z.string().optional(),
  asset_coin: z.string().optional(),
  position_value: z.string().optional(),
  liability: z.string().optional(),
  liability_coin: z.string().optional(),
  interest: z.string().optional(),
  max_position_qty: z.string().optional(),
  entry_price: z.string().optional(),
  index_price: z.string().optional(),
  upnl: z.string().optional(),
  upnl_rate: z.string().optional(),
  leverage: z.string().optional(),
  max_leverage: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
}).passthrough();

const AssetPushSchema = z.object({
  coin: z.string(),
  exchange_type: z.string(),
  balance: z.string().optional(),
  upnl: z.string().optional(),
  equity: z.string().optional(),
  futures_initial_margin: z.string().optional(),
  futures_maintenance_margin: z.string().optional(),
  borrowing_initial_margin: z.string().optional(),
  borrowing_maintenance_margin: z.string().optional(),
  available_balance: z.string().optional(),
  liability: z.string().optional(),
}).passthrough();

const OrderPushSchema = z.object({
  order_id: z.string(),
  text: z.string().optional(),
  client_order_id: z.string().optional(),
  state: z.string(),
  symbol: z.string().optional(),
  side: z.string().optional(),
  type: z.string().optional(),
  attribute: z.string().optional(),
  exchange_type: z.string().optional(),
  business_type: z.string().optional(),
  qty: z.string().optional(),
  quote_qty: z.string().optional(),
  price: z.string().optional(),
  time_in_force: z.string().optional(),
  executed_qty: z.string().optional(),
  executed_amount: z.string().optional(),
  executed_avg_price: z.string().optional(),
  fee_coin: z.string().optional(),
  fee: z.string().optional(),
  reduce_only: z.string().optional(),
  leverage: z.string().optional(),
  reason: z.string().optional(),
  position_side: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
}).passthrough();

const FillPushSchema = z.object({
  transaction_id: z.string(),
  order_id: z.string(),
  text: z.string().optional(),
  symbol: z.string(),
  exchange_type: z.string(),
  business_type: z.string().optional(),
  side: z.string(),
  qty: z.string(),
  price: z.string(),
  fee: z.string().optional(),
  fee_coin: z.string().optional(),
  fee_rate: z.string().optional(),
  match_role: z.string().optional(),
  rpnl: z.string().optional(),
  position_mode: z.string().optional(),
  position_side: z.string().optional(),
  create_time: z.string(),
}).passthrough();

function timestamp(value: string | undefined, fallback = new Date().toISOString()): string {
  if (!value) return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function replaceById<T>(items: T[], id: (item: T) => string, value: T): T[] {
  const index = items.findIndex((item) => id(item) === id(value));
  if (index < 0) return [...items, value];
  const next = [...items];
  next[index] = value;
  return next;
}

export class LivePortfolioStore {
  private current: LivePortfolioSnapshot | null;
  private stream: PrivateStreamStatus;
  private sequence = 0;
  private readonly pendingEvents: PrivateCrossExEvent[] = [];
  private readonly recentEvents: Array<{ sequence: number; event: PrivateCrossExEvent }> = [];
  private readonly listeners = new Set<Listener>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial: PortfolioSnapshotResponse | null, stream: PrivateStreamStatus) {
    this.stream = stream;
    this.current = initial ? {
      ...initial,
      live: {
        source: 'cache',
        sequence: this.sequence,
        lastEventAt: stream.lastEventAt,
        lastReconciledAt: initial.snapshot.fetchedAt,
        stream,
      },
    } : null;
  }

  stop(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    try { listener({ type: 'private-stream.status', payload: this.stream }); } catch { /* isolated */ }
    if (this.current) {
      try { listener({ type: 'portfolio.snapshot', payload: this.current }); } catch { /* isolated */ }
    }
    return () => this.listeners.delete(listener);
  }

  snapshot(): LivePortfolioSnapshot | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
    this.pendingEvents.length = 0;
    this.recentEvents.length = 0;
    this.broadcast({ type: 'portfolio.cleared', payload: null });
  }

  checkpoint(): number {
    return this.sequence;
  }

  setStreamStatus(status: PrivateStreamStatus): void {
    this.stream = status;
    if (this.current) {
      this.current = {
        ...this.current,
        live: {
          ...this.current.live,
          stream: status,
          lastEventAt: status.lastEventAt ?? this.current.live.lastEventAt,
        },
      };
    }
    this.broadcast({ type: 'private-stream.status', payload: status });
  }

  reconcile(
    response: PortfolioSnapshotResponse,
    source: LivePortfolioMetadata['source'] = 'rest',
    replayAfterSequence?: number,
  ): LivePortfolioSnapshot {
    this.sequence += 1;
    this.current = {
      ...response,
      live: {
        source,
        sequence: this.sequence,
        lastEventAt: this.stream.lastEventAt,
        lastReconciledAt: response.snapshot.fetchedAt,
        stream: this.stream,
      },
    };
    const buffered = [
      ...this.pendingEvents.splice(0),
      ...(replayAfterSequence === undefined
        ? []
        : this.recentEvents
          .filter((entry) => entry.sequence > replayAfterSequence)
          .map((entry) => entry.event)),
    ];
    let replayed = 0;
    for (const event of buffered) {
      if (this.applyEvent(event)) replayed += 1;
    }
    if (replayed > 0) {
      this.current = {
        ...this.current,
        live: {
          ...this.current.live,
          source: 'websocket',
          sequence: this.sequence,
          lastEventAt: this.stream.lastEventAt,
        },
      };
    }
    this.emitNow();
    return this.current;
  }

  markRemoteUnavailable(): void {
    if (!this.current) return;
    this.current = {
      ...this.current,
      dataStatus: 'stale',
      remoteStatus: 'unavailable',
      live: { ...this.current.live, stream: this.stream },
    };
    this.emitNow();
  }

  ingest(event: PrivateCrossExEvent): void {
    if (!this.current) {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > MAX_PENDING_EVENTS) {
        this.pendingEvents.splice(0, this.pendingEvents.length - MAX_PENDING_EVENTS);
      }
      return;
    }
    if (!this.applyEvent(event)) return;
    this.sequence += 1;
    this.recentEvents.push({ sequence: this.sequence, event });
    if (this.recentEvents.length > MAX_PENDING_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_PENDING_EVENTS);
    }
    this.current = {
      ...this.current,
      dataStatus: 'fresh',
      remoteStatus: 'healthy',
      live: {
        ...this.current.live,
        source: 'websocket',
        sequence: this.sequence,
        lastEventAt: this.stream.lastEventAt ?? new Date().toISOString(),
        stream: this.stream,
      },
    };
    this.scheduleEmit();
  }

  private applyEvent(event: PrivateCrossExEvent): boolean {
    if (!this.current) return false;
    if (event.channel === 'position') return this.applyPosition(event.payload);
    if (event.channel === 'margin_position') return this.applyMarginPosition(event.payload);
    if (event.channel === 'asset') return this.applyAsset(event.payload);
    if (event.channel === 'order') return this.applyOrder(event.payload);
    if (event.channel === 'usertrades') return this.applyFill(event.payload);
    return false;
  }

  private applyPosition(payload: Record<string, unknown>): boolean {
    if (!this.current) return false;
    const parsed = PositionPushSchema.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    const positions = this.current.snapshot.futuresPositions;
    const existing = positions.find((position) => position.positionId === value.position_id);
    const quantity = value.position_qty ?? existing?.quantity ?? '0';
    if (value.position_side === 'NONE' || Number(quantity) === 0) {
      this.current = {
        ...this.current,
        snapshot: {
          ...this.current.snapshot,
          futuresPositions: positions.filter((position) => position.positionId !== value.position_id),
        },
      };
      return existing !== undefined;
    }
    const now = new Date().toISOString();
    const position: PortfolioFuturesPosition = {
      positionId: value.position_id,
      symbol: value.symbol,
      positionSide: value.position_side,
      initialMargin: value.initial_margin ?? existing?.initialMargin ?? '0',
      maintenanceMargin: value.maintenance_margin ?? existing?.maintenanceMargin ?? '0',
      quantity,
      value: value.position_value ?? existing?.value ?? '0',
      unrealizedPnl: value.upnl ?? existing?.unrealizedPnl ?? '0',
      unrealizedPnlRate: value.upnl_rate ?? existing?.unrealizedPnlRate ?? '0',
      entryPrice: value.entry_price ?? existing?.entryPrice ?? '0',
      markPrice: value.mark_price ?? existing?.markPrice ?? '0',
      leverage: value.leverage ?? existing?.leverage ?? '0',
      maxLeverage: value.max_leverage ?? existing?.maxLeverage ?? '0',
      riskLimit: value.risk_limit ?? existing?.riskLimit ?? '0',
      fee: value.fee ?? existing?.fee ?? '0',
      fundingFee: value.funding_fee ?? existing?.fundingFee ?? '0',
      fundingTime: timestamp(value.funding_time, existing?.fundingTime ?? now),
      createdAt: timestamp(value.create_time, existing?.createdAt ?? now),
      updatedAt: timestamp(value.update_time, now),
      realizedPnl: value.closed_pnl ?? existing?.realizedPnl ?? '0',
    };
    this.current = {
      ...this.current,
      snapshot: {
        ...this.current.snapshot,
        futuresPositions: replaceById(positions, (item) => item.positionId, position),
      },
    };
    return true;
  }

  private applyMarginPosition(payload: Record<string, unknown>): boolean {
    if (!this.current) return false;
    const parsed = MarginPositionPushSchema.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    const positions = this.current.snapshot.marginPositions;
    const existing = positions.find((position) => position.positionId === value.position_id);
    const assetQuantity = value.asset_qty ?? existing?.assetQuantity ?? '0';
    const liability = value.liability ?? existing?.liability ?? '0';
    if (value.position_side === 'NONE' || (Number(assetQuantity) === 0 && Number(liability) === 0)) {
      this.current = {
        ...this.current,
        snapshot: {
          ...this.current.snapshot,
          marginPositions: positions.filter((position) => position.positionId !== value.position_id),
        },
      };
      return existing !== undefined;
    }
    const now = new Date().toISOString();
    const position: PortfolioMarginPosition = {
      positionId: value.position_id,
      symbol: value.symbol,
      positionSide: value.position_side,
      initialMargin: value.initial_margin ?? existing?.initialMargin ?? '0',
      maintenanceMargin: value.maintenance_margin ?? existing?.maintenanceMargin ?? '0',
      assetQuantity,
      assetCoin: value.asset_coin ?? existing?.assetCoin ?? '',
      value: value.position_value ?? existing?.value ?? '0',
      liability,
      liabilityCoin: value.liability_coin ?? existing?.liabilityCoin ?? '',
      interest: value.interest ?? existing?.interest ?? '0',
      maxPositionQuantity: value.max_position_qty ?? existing?.maxPositionQuantity ?? '0',
      entryPrice: value.entry_price ?? existing?.entryPrice ?? '0',
      indexPrice: value.index_price ?? existing?.indexPrice ?? '0',
      unrealizedPnl: value.upnl ?? existing?.unrealizedPnl ?? '0',
      unrealizedPnlRate: value.upnl_rate ?? existing?.unrealizedPnlRate ?? '0',
      leverage: value.leverage ?? existing?.leverage ?? '0',
      maxLeverage: value.max_leverage ?? existing?.maxLeverage ?? '0',
      createdAt: timestamp(value.create_time, existing?.createdAt ?? now),
      updatedAt: timestamp(value.update_time, now),
    };
    this.current = {
      ...this.current,
      snapshot: {
        ...this.current.snapshot,
        marginPositions: replaceById(positions, (item) => item.positionId, position),
      },
    };
    return true;
  }

  private applyAsset(payload: Record<string, unknown>): boolean {
    if (!this.current) return false;
    const parsed = AssetPushSchema.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    const balances = this.current.snapshot.balances;
    const key = `${value.exchange_type}:${value.coin}`;
    const existing = balances.find((balance) => `${balance.venue}:${balance.coin}` === key);
    const balance: PortfolioBalance = {
      venue: value.exchange_type,
      coin: value.coin,
      balance: value.balance ?? existing?.balance ?? '0',
      unrealizedPnl: value.upnl ?? existing?.unrealizedPnl ?? '0',
      equity: value.equity ?? existing?.equity ?? '0',
      futuresInitialMargin: value.futures_initial_margin ?? existing?.futuresInitialMargin ?? '0',
      futuresMaintenanceMargin: value.futures_maintenance_margin ?? existing?.futuresMaintenanceMargin ?? '0',
      borrowingInitialMargin: value.borrowing_initial_margin ?? existing?.borrowingInitialMargin ?? '0',
      borrowingMaintenanceMargin: value.borrowing_maintenance_margin ?? existing?.borrowingMaintenanceMargin ?? '0',
      availableBalance: value.available_balance ?? existing?.availableBalance ?? '0',
      liability: value.liability ?? existing?.liability ?? '0',
    };
    const nextBalances = replaceById(balances, (item) => `${item.venue}:${item.coin}`, balance);
    this.current = {
      ...this.current,
      snapshot: {
        ...this.current.snapshot,
        // Asset pushes update one exchange/currency allocation. Gate does not include the
        // authoritative account-level available margin or risk totals in this event, and the asset
        // rows are not additive in cross-exchange mode. Preserve the latest REST account metrics
        // until the next reconciliation instead of synthesizing a potentially unsafe total.
        account: this.current.snapshot.account,
        balances: nextBalances,
      },
    };
    return true;
  }

  private applyOrder(payload: Record<string, unknown>): boolean {
    if (!this.current) return false;
    const parsed = OrderPushSchema.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    const orders = this.current.snapshot.openOrders;
    const existing = orders.find((order) => order.orderId === value.order_id);
    if (!OPEN_ORDER_STATES.has(value.state)) {
      this.current = {
        ...this.current,
        snapshot: {
          ...this.current.snapshot,
          openOrders: orders.filter((order) => order.orderId !== value.order_id),
        },
      };
      return existing !== undefined;
    }
    if (!value.symbol && !existing) return false;
    const now = new Date().toISOString();
    const order: PortfolioOrder = {
      orderId: value.order_id,
      clientOrderId: value.client_order_id ?? value.text ?? existing?.clientOrderId ?? '',
      state: value.state,
      symbol: value.symbol ?? existing?.symbol ?? '',
      side: value.side ?? existing?.side ?? '',
      type: value.type ?? existing?.type ?? '',
      attribute: value.attribute ?? existing?.attribute ?? '',
      venue: value.exchange_type ?? existing?.venue ?? '',
      product: value.business_type ?? existing?.product ?? '',
      quantity: value.qty ?? existing?.quantity ?? '0',
      quoteQuantity: value.quote_qty ?? existing?.quoteQuantity ?? '0',
      price: value.price ?? existing?.price ?? '0',
      timeInForce: value.time_in_force ?? existing?.timeInForce ?? '',
      executedQuantity: value.executed_qty ?? existing?.executedQuantity ?? '0',
      executedAmount: value.executed_amount ?? existing?.executedAmount ?? '0',
      executedAveragePrice: value.executed_avg_price ?? existing?.executedAveragePrice ?? '0',
      feeCoin: value.fee_coin ?? existing?.feeCoin ?? '',
      fee: value.fee ?? existing?.fee ?? '0',
      reduceOnly: value.reduce_only ?? existing?.reduceOnly ?? 'false',
      leverage: value.leverage ?? existing?.leverage ?? '0',
      reason: value.reason ?? existing?.reason ?? '',
      positionSide: value.position_side ?? existing?.positionSide ?? 'NONE',
      createdAt: timestamp(value.create_time, existing?.createdAt ?? now),
      updatedAt: timestamp(value.update_time, now),
    };
    this.current = {
      ...this.current,
      snapshot: {
        ...this.current.snapshot,
        openOrders: replaceById(orders, (item) => item.orderId, order),
      },
    };
    return true;
  }

  private applyFill(payload: Record<string, unknown>): boolean {
    if (!this.current) return false;
    const parsed = FillPushSchema.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    if (this.current.snapshot.recentFills.some((fill) => fill.transactionId === value.transaction_id)) return false;
    const fill: PortfolioFill = {
      transactionId: value.transaction_id,
      orderId: value.order_id,
      clientOrderId: value.text ?? '',
      symbol: value.symbol,
      venue: value.exchange_type,
      product: value.business_type ?? '',
      side: value.side,
      quantity: value.qty,
      price: value.price,
      fee: value.fee ?? '0',
      feeCoin: value.fee_coin ?? '',
      feeRate: value.fee_rate ?? '0',
      matchRole: value.match_role ?? '',
      realizedPnl: value.rpnl ?? '0',
      positionMode: value.position_mode ?? '',
      positionSide: value.position_side ?? '',
      createdAt: timestamp(value.create_time),
    };
    this.current = {
      ...this.current,
      snapshot: {
        ...this.current.snapshot,
        recentFills: [fill, ...this.current.snapshot.recentFills]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, MAX_RECENT_FILLS),
      },
    };
    return true;
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, EMIT_INTERVAL_MS);
    this.emitTimer.unref?.();
  }

  private emitNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (this.current) this.broadcast({ type: 'portfolio.snapshot', payload: this.current });
  }

  private broadcast(message: LivePortfolioMessage): void {
    for (const listener of this.listeners) {
      try { listener(message); } catch { /* one local client cannot break other observers */ }
    }
  }
}
