import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { AccountRiskDecision } from './account-risk-guard.js';
import type { AlertDispatcher } from './alert-dispatcher.js';
import type { ExecutionMarketReader, ExecutionPairSnapshot, ExecutionVenue } from './execution-market-hub.js';
import { TradingRuntime, isTerminalOrderState, type ExecutionOrder } from './trading-runtime.js';

const positiveDecimal = z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => new Decimal(value).gt(0));
const executionVenue = z.enum(['GATE', 'BINANCE', 'OKX', 'BYBIT']);

export const StartFundingTradeSchema = z.object({
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9:_-]+$/),
  asset: z.string().regex(/^[A-Z0-9]{2,20}$/),
  longVenue: executionVenue,
  shortVenue: executionVenue,
  quantity: positiveDecimal,
  timeInForce: z.enum(['FOK', 'IOC']).default('FOK'),
  candidateId: z.string().uuid(),
}).superRefine((value, context) => {
  if (value.longVenue === value.shortVenue) {
    context.addIssue({ code: 'custom', path: ['shortVenue'], message: 'venues must differ' });
  }
});
export type StartFundingTrade = z.infer<typeof StartFundingTradeSchema>;

export const FundingCandidateObservationSchema = z.object({
  asset: z.string().regex(/^[A-Z0-9]{2,20}$/),
  longVenue: executionVenue,
  shortVenue: executionVenue,
  quantity: positiveDecimal,
  longRate: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  shortRate: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  netAnnualized: z.string().regex(/^-?\d+(?:\.\d+)?$/),
}).superRefine((value, context) => {
  if (value.longVenue === value.shortVenue) context.addIssue({ code: 'custom', path: ['shortVenue'], message: 'venues must differ' });
});
export type FundingCandidateObservation = z.infer<typeof FundingCandidateObservationSchema>;

export const FundingRateObservationSchema = z.object({
  longRate: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  shortRate: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  observedAt: z.string().datetime(),
});
export const FundingSettlementSchema = z.object({
  expectedFunding: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  actualFunding: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  toleranceUsd: positiveDecimal.default('0.01'),
});

export interface FundingArbitrageLimits {
  enabled: boolean;
  maxNotionalPerLegUsd: string;
  maxConcurrentTrades: number;
  maxUnhedgedMs: number;
  maxNetBaseExposure: string;
  maxEntrySlippageBps: string;
  maxBasisBps: string;
  maxHoldingMs: number;
  confirmationCount: number;
  confirmationWindowMs: number;
  minNetAnnualized: string;
  leverage: string;
}

export interface FundingInstrumentRule {
  symbol: string;
  state: string;
  minSize: string;
  minNotional: string | null;
  lotSize: string;
  tickSize: string;
  maxMarketSize: string | null;
  maxLimitSize: string | null;
}

export interface FundingTradeRecord {
  id: string;
  idempotencyKey: string;
  asset: string;
  longVenue: ExecutionVenue;
  shortVenue: ExecutionVenue;
  requestedQuantity: string;
  openQuantity: string;
  state: string;
  phase: string;
  executionMode: 'FOK' | 'IOC';
  longOrderId: string | null;
  shortOrderId: string | null;
  repairOrderId: string | null;
  failureReason: string | null;
  manualReason: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  feesPaid: string;
  realizedPnl: string;
  expectedFunding: string | null;
  actualFunding: string | null;
}

export interface FundingCandidateRecord {
  id: string; candidateKey: string; asset: string; longVenue: ExecutionVenue; shortVenue: ExecutionVenue;
  quantity: string; longRate: string; shortRate: string; netAnnualized: string; confirmationCount: number;
  state: 'OBSERVING' | 'CONFIRMED' | 'CONSUMED'; firstSeenAt: string; lastSeenAt: string; consumedAt: string | null;
}

interface FundingTradeRow {
  id: string; idempotency_key: string; asset: string; long_venue: ExecutionVenue; short_venue: ExecutionVenue;
  requested_quantity: string; open_quantity: string; state: string; phase: string; execution_mode: 'FOK' | 'IOC';
  long_order_id: string | null; short_order_id: string | null; repair_order_id: string | null;
  failure_reason: string | null; manual_reason: string | null; opened_at: string | null; closed_at: string | null;
  fees_paid: string; realized_pnl: string; expected_funding: string | null; actual_funding: string | null;
  created_at: string; updated_at: string;
}

export interface FundingArbitrageEngineOptions {
  limits: FundingArbitrageLimits;
  accountRiskCheck: (plannedGrossExposureUsd?: string) => AccountRiskDecision | Promise<AccountRiskDecision>;
  loadInstrumentRules: (symbols: string[]) => Promise<FundingInstrumentRule[]>;
  alertDispatcher: AlertDispatcher;
  onKillSwitch: (reason: string) => void | Promise<void>;
  executionGuard?: () => { safe: true } | { safe: false; reason: string };
  orderTimeoutMs?: number;
  now?: () => number;
}

export class FundingArbitrageError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message = code) { super(message); }
}

function fromRow(row: FundingTradeRow): FundingTradeRecord {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, asset: row.asset, longVenue: row.long_venue,
    shortVenue: row.short_venue, requestedQuantity: row.requested_quantity, openQuantity: row.open_quantity,
    state: row.state, phase: row.phase, executionMode: row.execution_mode, longOrderId: row.long_order_id,
    shortOrderId: row.short_order_id, repairOrderId: row.repair_order_id, failureReason: row.failure_reason,
    manualReason: row.manual_reason, openedAt: row.opened_at, closedAt: row.closed_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    feesPaid: row.fees_paid, realizedPnl: row.realized_pnl,
    expectedFunding: row.expected_funding, actualFunding: row.actual_funding,
  };
}

function symbol(venue: ExecutionVenue, asset: string): string { return `${venue}_FUTURE_${asset}_USDT`; }

function clientOrderId(tradeId: string, phase: string, leg: string): string {
  const digest = createHash('sha256').update(`${tradeId}:${phase}:${leg}`).digest('hex').slice(0, 18);
  return `gct-fa-${phase}-${leg}-${digest}`.slice(0, 64);
}

function executablePrice(levels: readonly (readonly [string, string])[], quantity: Decimal): { average: Decimal; last: Decimal } | null {
  let remaining = quantity;
  let notional = new Decimal(0);
  let last = new Decimal(0);
  for (const [priceText, sizeText] of levels) {
    const price = new Decimal(priceText);
    const size = Decimal.min(remaining, new Decimal(sizeText));
    if (size.lte(0)) continue;
    notional = notional.plus(size.mul(price));
    remaining = remaining.minus(size);
    last = price;
    if (remaining.lte(0)) return { average: notional.div(quantity), last };
  }
  return null;
}

function roundToStep(value: Decimal, stepText: string, direction: 'up' | 'down'): Decimal {
  const step = new Decimal(stepText);
  if (!step.isFinite() || !step.gt(0)) throw new FundingArbitrageError('invalid_instrument_step', 409);
  const units = value.div(step);
  return (direction === 'up' ? units.ceil() : units.floor()).mul(step);
}

/**
 * 资金费套利的持久化执行器。普通入场严格 fail-closed；异常修复只能减仓，无法确认时锁死新单并转人工。
 */
export class FundingArbitrageEngine {
  private readonly now: () => number;
  private readonly orderTimeoutMs: number;
  private busy = false;

  constructor(
    private readonly database: Database.Database,
    private readonly runtime: TradingRuntime,
    private readonly market: ExecutionMarketReader,
    private readonly options: FundingArbitrageEngineOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.orderTimeoutMs = options.orderTimeoutMs ?? options.limits.maxUnhedgedMs;
  }

  list(limit = 100): FundingTradeRecord[] {
    return (this.database.prepare('SELECT * FROM funding_arbitrage_trades ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as FundingTradeRow[]).map(fromRow);
  }

  listCandidates(limit = 100): FundingCandidateRecord[] {
    const rows = this.database.prepare('SELECT * FROM funding_arbitrage_candidates ORDER BY last_seen_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({ id: String(row.id), candidateKey: String(row.candidate_key), asset: String(row.asset),
      longVenue: String(row.long_venue) as ExecutionVenue, shortVenue: String(row.short_venue) as ExecutionVenue,
      quantity: String(row.quantity), longRate: String(row.long_rate), shortRate: String(row.short_rate),
      netAnnualized: String(row.net_annualized), confirmationCount: Number(row.confirmation_count),
      state: String(row.state) as FundingCandidateRecord['state'], firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at), consumedAt: row.consumed_at === null ? null : String(row.consumed_at) }));
  }

  /** 同一候选必须连续通过真实盘口和净收益检查，过期观察会从 1 重新计数。 */
  async observeAuthoritativeCandidate(raw: unknown): Promise<FundingCandidateRecord> {
    const observation = FundingCandidateObservationSchema.parse(raw);
    // 不同结算周期必须按实际事件现金流判断，不能再用当前两条费率直接相减。
    if (new Decimal(observation.netAnnualized).lt(this.options.limits.minNetAnnualized)) {
      throw new FundingArbitrageError('funding_net_return_below_threshold', 409);
    }
    this.marketPrecheck({ ...observation, idempotencyKey: 'candidate-check', timeInForce: 'FOK', candidateId: randomUUID() }, false);
    const candidateKey = `${observation.asset}:${observation.longVenue}:${observation.shortVenue}:${observation.quantity}`;
    const previous = this.database.prepare('SELECT * FROM funding_arbitrage_candidates WHERE candidate_key = ?')
      .get(candidateKey) as Record<string, string | number | null> | undefined;
    const now = new Date(this.now()).toISOString();
    const continuous = previous && previous.state !== 'CONSUMED'
      && this.now() - Date.parse(String(previous.last_seen_at)) <= this.options.limits.confirmationWindowMs;
    const count = continuous ? Number(previous.confirmation_count) + 1 : 1;
    const state = count >= Math.max(1, this.options.limits.confirmationCount) ? 'CONFIRMED' : 'OBSERVING';
    const id = continuous ? String(previous.id) : randomUUID();
    if (continuous) {
      this.database.prepare(`UPDATE funding_arbitrage_candidates SET long_rate = ?, short_rate = ?, net_annualized = ?,
        confirmation_count = ?, state = ?, last_seen_at = ? WHERE id = ?`)
        .run(observation.longRate, observation.shortRate, observation.netAnnualized, count, state, now, id);
    } else {
      this.database.prepare(`INSERT INTO funding_arbitrage_candidates
        (id, candidate_key, asset, long_venue, short_venue, quantity, long_rate, short_rate, net_annualized,
         confirmation_count, state, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_key) DO UPDATE SET id=excluded.id, long_rate=excluded.long_rate, short_rate=excluded.short_rate,
        net_annualized=excluded.net_annualized, confirmation_count=excluded.confirmation_count, state=excluded.state,
        first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at, consumed_at=NULL`)
        .run(id, candidateKey, observation.asset, observation.longVenue, observation.shortVenue, observation.quantity,
          observation.longRate, observation.shortRate, observation.netAnnualized, count, state, now, now);
    }
    const candidate = this.listCandidates(500).find((item) => item.id === id)!;
    if (state === 'CONFIRMED') await this.options.alertDispatcher.emit({ eventType: 'funding_candidate_confirmed', severity: 'info',
      message: `${observation.asset} 资金费候选连续确认完成`, details: candidate as unknown as Record<string, unknown>,
      dedupKey: `funding-candidate:${id}` });
    return candidate;
  }

  get(id: string): FundingTradeRecord {
    const row = this.database.prepare('SELECT * FROM funding_arbitrage_trades WHERE id = ?').get(id) as FundingTradeRow | undefined;
    if (!row) throw new FundingArbitrageError('funding_trade_not_found', 404);
    return fromRow(row);
  }

  private event(tradeId: string | null, severity: string, eventType: string, message: string, details: Record<string, unknown> = {}): void {
    this.database.prepare(`INSERT INTO funding_arbitrage_events
      (id, trade_id, severity, event_type, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), tradeId, severity, eventType, message, JSON.stringify(details), new Date(this.now()).toISOString());
  }

  private update(id: string, fields: Record<string, string | null>): FundingTradeRecord {
    const allowed = new Set(['state', 'phase', 'open_quantity', 'long_order_id', 'short_order_id', 'repair_order_id',
      'failure_reason', 'manual_reason', 'entry_long_price', 'entry_short_price', 'exit_long_price', 'exit_short_price',
      'opened_at', 'closed_at']);
    for (const key of ['fees_paid', 'realized_pnl', 'expected_funding', 'actual_funding']) allowed.add(key);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    const updatedAt = new Date(this.now()).toISOString();
    this.database.prepare(`UPDATE funding_arbitrage_trades SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), updatedAt, id);
    return this.get(id);
  }

  private marketPrecheck(input: StartFundingTrade, enforceLiveLimits: boolean): ExecutionPairSnapshot {
    if (enforceLiveLimits && !this.options.limits.enabled) throw new FundingArbitrageError('funding_live_disabled', 403);
    const executionGuard = this.options.executionGuard?.() ?? { safe: true as const };
    if (!executionGuard.safe) throw new FundingArbitrageError('global_kill_switch_active', 409, executionGuard.reason);
    if (enforceLiveLimits) {
      const active = this.database.prepare(`SELECT COUNT(*) AS count FROM funding_arbitrage_trades
        WHERE state NOT IN ('CLOSED', 'REJECTED')`).get() as { count: number };
      if (active.count >= this.options.limits.maxConcurrentTrades) throw new FundingArbitrageError('max_concurrent_trades', 409);
    }
    const pair = this.market.pair(input.asset, input.longVenue, input.shortVenue, this.now());
    if (pair.quality !== 'LIVE_SYNCHRONIZED') {
      throw new FundingArbitrageError('market_not_synchronized', 409, pair.reasons.join(','));
    }
    const quantity = new Decimal(input.quantity);
    const longFill = executablePrice(pair.longBook.asks, quantity);
    const shortFill = executablePrice(pair.shortBook.bids, quantity);
    if (!longFill || !shortFill) throw new FundingArbitrageError('insufficient_order_book_depth', 409);
    const longTop = new Decimal(pair.longBook.asks[0]?.[0] ?? '0');
    const shortTop = new Decimal(pair.shortBook.bids[0]?.[0] ?? '0');
    if (longTop.lte(0) || shortTop.lte(0)) throw new FundingArbitrageError('invalid_order_book', 409);
    const longSlippage = longFill.average.minus(longTop).div(longTop).mul(10_000);
    const shortSlippage = shortTop.minus(shortFill.average).div(shortTop).mul(10_000);
    if (Decimal.max(longSlippage, shortSlippage).gt(this.options.limits.maxEntrySlippageBps)) {
      throw new FundingArbitrageError('entry_slippage_exceeded', 409);
    }
    const basis = longFill.average.minus(shortFill.average).abs()
      .div(longFill.average.plus(shortFill.average).div(2)).mul(10_000);
    if (basis.gt(this.options.limits.maxBasisBps)) throw new FundingArbitrageError('basis_exceeded', 409);
    const maxNotional = Decimal.max(longFill.average, shortFill.average).mul(quantity);
    if (enforceLiveLimits && maxNotional.gt(this.options.limits.maxNotionalPerLegUsd)) {
      throw new FundingArbitrageError('leg_notional_exceeded', 409);
    }
    return pair;
  }

  /**
   * Gate 的每条腿有独立步长和最小名义金额。两腿任一规则缺失或不兼容就拒绝，
   * 保护价也必须按各自 tick size 朝更容易成交的方向取整。
   */
  private async validateInstrumentRules(input: StartFundingTrade, pair: ExecutionPairSnapshot): Promise<{
    longProtection: string; shortProtection: string; projectedGrossExposure: string;
  }> {
    const longSymbol = symbol(input.longVenue, input.asset);
    const shortSymbol = symbol(input.shortVenue, input.asset);
    const rules = await this.options.loadInstrumentRules([longSymbol, shortSymbol]);
    const bySymbol = new Map(rules.map((rule) => [rule.symbol, rule]));
    const quantity = new Decimal(input.quantity);
    const longFill = executablePrice(pair.longBook.asks, quantity);
    const shortFill = executablePrice(pair.shortBook.bids, quantity);
    if (!longFill || !shortFill) throw new FundingArbitrageError('insufficient_order_book_depth', 409);
    for (const [target, fill] of [[longSymbol, longFill], [shortSymbol, shortFill]] as const) {
      const rule = bySymbol.get(target);
      if (!rule || rule.state !== 'live') throw new FundingArbitrageError('instrument_rule_unavailable', 503, target);
      const lot = new Decimal(rule.lotSize);
      const minimum = new Decimal(rule.minSize);
      if (!lot.isFinite() || !lot.gt(0) || !minimum.isFinite() || quantity.lt(minimum) || !quantity.mod(lot).isZero()) {
        throw new FundingArbitrageError('invalid_order_quantity_for_instrument', 400, target);
      }
      if (rule.minNotional !== null && fill.average.mul(quantity).lt(rule.minNotional)) {
        throw new FundingArbitrageError('order_below_minimum_notional', 400, target);
      }
      const maximum = input.timeInForce === 'FOK' ? rule.maxLimitSize : rule.maxMarketSize;
      if (maximum !== null && new Decimal(maximum).gt(0) && quantity.gt(maximum)) {
        throw new FundingArbitrageError('order_above_maximum_size', 400, target);
      }
    }
    return {
      longProtection: roundToStep(longFill.last, bySymbol.get(longSymbol)!.tickSize, 'up').toString(),
      shortProtection: roundToStep(shortFill.last, bySymbol.get(shortSymbol)!.tickSize, 'down').toString(),
      projectedGrossExposure: longFill.average.plus(shortFill.average).mul(quantity).toString(),
    };
  }

  async start(raw: unknown): Promise<FundingTradeRecord> {
    if (this.busy) throw new FundingArbitrageError('funding_engine_busy', 409);
    const input = StartFundingTradeSchema.parse(raw);
    const existing = this.database.prepare('SELECT * FROM funding_arbitrage_trades WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as FundingTradeRow | undefined;
    if (existing) return fromRow(existing);
    const candidate = this.database.prepare(`SELECT * FROM funding_arbitrage_candidates
      WHERE id = ? AND state = 'CONFIRMED' AND consumed_at IS NULL`).get(input.candidateId) as Record<string, string> | undefined;
    if (!candidate || candidate.asset !== input.asset || candidate.long_venue !== input.longVenue
      || candidate.short_venue !== input.shortVenue || candidate.quantity !== input.quantity
      || this.now() - Date.parse(candidate.last_seen_at) > this.options.limits.confirmationWindowMs) {
      throw new FundingArbitrageError('funding_candidate_not_confirmed', 409);
    }
    const pair = this.marketPrecheck(input, true);
    const compliance = await this.validateInstrumentRules(input, pair);
    const risk = await this.options.accountRiskCheck(compliance.projectedGrossExposure);
    if (!risk.safe) throw new FundingArbitrageError(risk.code, 409, risk.reason);
    await this.runtime.prepareStrategyMargin([
      { symbol: symbol(input.longVenue, input.asset), venue: input.longVenue, side: 'BUY', leverage: this.options.limits.leverage,
        estimatedQuantity: input.quantity, estimatedPrice: pair.longBook.asks[0]![0] },
      { symbol: symbol(input.shortVenue, input.asset), venue: input.shortVenue, side: 'SELL', leverage: this.options.limits.leverage,
        estimatedQuantity: input.quantity, estimatedPrice: pair.shortBook.bids[0]![0] },
    ]);
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    this.database.prepare(`INSERT INTO funding_arbitrage_trades
      (id, idempotency_key, asset, long_venue, short_venue, requested_quantity, state, phase, execution_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PRECHECKED', 'ENTRY', ?, ?, ?)`)
      .run(id, input.idempotencyKey, input.asset, input.longVenue, input.shortVenue, input.quantity, input.timeInForce, now, now);
    this.database.prepare("UPDATE funding_arbitrage_candidates SET state = 'CONSUMED', consumed_at = ? WHERE id = ?")
      .run(now, input.candidateId);
    this.event(id, 'info', 'funding_entry_prechecked', '资金费套利入场预检通过', {
      quality: pair.quality, exchangeSkewMs: pair.exchangeSkewMs, receiveSkewMs: pair.receiveSkewMs,
    });
    this.busy = true;
    try { return await this.executeEntry(id, compliance.longProtection, compliance.shortProtection); } finally { this.busy = false; }
  }

  private async submitLeg(trade: FundingTradeRecord, leg: 'long' | 'short', phase: 'entry' | 'exit', quantity: string,
    protectedPrice?: string): Promise<ExecutionOrder> {
    const isLong = leg === 'long';
    const venue = isLong ? trade.longVenue : trade.shortVenue;
    const entry = phase === 'entry';
    const side = isLong ? (entry ? 'BUY' : 'SELL') : (entry ? 'SELL' : 'BUY');
    // FOK 用本次原子盘口能完全成交的最差价做保护限价；平仓固定 IOC，避免不支持 Market+FOK 的交易所语义差异。
    const protectedFok = entry && trade.executionMode === 'FOK';
    return this.runtime.createOrder({ symbol: symbol(venue, trade.asset), side,
      type: protectedFok ? 'LIMIT' : 'MARKET', timeInForce: entry ? trade.executionMode : 'IOC',
      quantity, ...(protectedFok ? { price: protectedPrice } : {}), reduceOnly: !entry }, {
      strategyId: trade.id, strategyLeg: isLong ? 'left' : 'right', riskReducing: !entry,
      clientOrderId: clientOrderId(trade.id, phase, leg),
    });
  }

  private async resolveSubmitted(clientId: string, result: PromiseSettledResult<ExecutionOrder>): Promise<ExecutionOrder | null> {
    if (result.status === 'fulfilled') return result.value;
    const local = this.runtime.getOrderByClientOrderId(clientId);
    if (!local) return null;
    return await this.runtime.refreshOrderFromRemote(local.id).catch(() => null) ?? local;
  }

  private async settle(order: ExecutionOrder | null): Promise<ExecutionOrder | null> {
    if (!order || isTerminalOrderState(order.state)) return order;
    const settled = await this.runtime.awaitTerminalOrder(order.id, this.orderTimeoutMs);
    if (isTerminalOrderState(settled.state)) return settled;
    try { await this.runtime.cancelOrder(settled.id); } catch { /* 查单确认会给最终判断。 */ }
    return await this.runtime.awaitTerminalOrder(settled.id, this.orderTimeoutMs);
  }

  private async executeEntry(id: string, longProtection: string, shortProtection: string): Promise<FundingTradeRecord> {
    let trade = this.update(id, { state: 'SUBMITTING', phase: 'ENTRY' });
    const longClient = clientOrderId(id, 'entry', 'long');
    const shortClient = clientOrderId(id, 'entry', 'short');
    const submitted = await Promise.allSettled([
      this.submitLeg(trade, 'long', 'entry', trade.requestedQuantity, longProtection),
      this.submitLeg(trade, 'short', 'entry', trade.requestedQuantity, shortProtection),
    ]);
    const [longInitial, shortInitial] = await Promise.all([
      this.resolveSubmitted(longClient, submitted[0]!), this.resolveSubmitted(shortClient, submitted[1]!),
    ]);
    trade = this.update(id, { state: 'SETTLING', long_order_id: longInitial?.id ?? null, short_order_id: shortInitial?.id ?? null });
    const [longOrder, shortOrder] = await Promise.all([this.settle(longInitial), this.settle(shortInitial)]);
    return this.finishEntry(trade, longOrder, shortOrder);
  }

  private async finishEntry(trade: FundingTradeRecord, longOrder: ExecutionOrder | null, shortOrder: ExecutionOrder | null): Promise<FundingTradeRecord> {
    if ((longOrder && !isTerminalOrderState(longOrder.state)) || (shortOrder && !isTerminalOrderState(shortOrder.state))) {
      return this.manual(trade.id, 'entry_order_state_unknown', { longState: longOrder?.state, shortState: shortOrder?.state });
    }
    const longFilled = new Decimal(longOrder?.executedQuantity ?? '0');
    const shortFilled = new Decimal(shortOrder?.executedQuantity ?? '0');
    const matched = Decimal.min(longFilled, shortFilled);
    const residual = longFilled.minus(shortFilled);
    if (!residual.isZero()) {
      const repaired = await this.flattenResidual(trade, residual, 'entry');
      if (!repaired) return this.manual(trade.id, 'entry_residual_unresolved', { residual: residual.toString() });
    }
    if (matched.lte(0)) {
      this.event(trade.id, 'warning', 'funding_entry_rejected', '两腿均未形成匹配仓位');
      return this.update(trade.id, { state: 'REJECTED', failure_reason: 'no_matched_fill', open_quantity: '0' });
    }
    const openedAt = new Date(this.now()).toISOString();
    this.event(trade.id, 'info', 'funding_position_opened', '两腿等量仓位已确认', { quantity: matched.toString() });
    return this.update(trade.id, { state: 'OPEN', phase: 'HOLDING', open_quantity: matched.toString(),
      entry_long_price: longOrder?.executedAveragePrice ?? null,
      entry_short_price: shortOrder?.executedAveragePrice ?? null, opened_at: openedAt });
  }

  private async flattenResidual(trade: FundingTradeRecord, residual: Decimal, phase: string): Promise<boolean> {
    const longExcess = residual.gt(0);
    const venue = longExcess ? trade.longVenue : trade.shortVenue;
    const side = longExcess ? 'SELL' : 'BUY';
    const quantity = residual.abs();
    if (quantity.gt(this.options.limits.maxNetBaseExposure) && new Decimal(this.options.limits.maxNetBaseExposure).gt(0)) {
      this.event(trade.id, 'critical', 'net_exposure_limit_exceeded', '单腿净敞口超过修复限制', { quantity: quantity.toString() });
    }
    this.update(trade.id, { state: 'REPAIRING' });
    try {
      const order = await this.runtime.createOrder({ symbol: symbol(venue, trade.asset), side, type: 'MARKET',
        timeInForce: 'IOC', quantity: quantity.toString(), reduceOnly: true }, {
        strategyId: trade.id, strategyLeg: longExcess ? 'left' : 'right', riskReducing: true,
        clientOrderId: clientOrderId(trade.id, phase, `repair-${longExcess ? 'long' : 'short'}`),
      });
      this.update(trade.id, { repair_order_id: order.id });
      const settled = await this.settle(order);
      const repaired = settled !== null && new Decimal(settled.executedQuantity).gte(quantity);
      this.event(trade.id, repaired ? 'warning' : 'critical', 'funding_exposure_repair',
        repaired ? '裸露敞口已反向减仓' : '裸露敞口修复失败', { requested: quantity.toString(), filled: settled?.executedQuantity ?? '0' });
      return repaired;
    } catch (error) {
      this.event(trade.id, 'critical', 'funding_exposure_repair_failed', '裸露敞口修复单提交失败', {
        error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      });
      return false;
    }
  }

  async close(id: string): Promise<FundingTradeRecord> {
    if (this.busy) throw new FundingArbitrageError('funding_engine_busy', 409);
    const trade = this.get(id);
    if (trade.state === 'CLOSED') return trade;
    if (trade.state !== 'OPEN') throw new FundingArbitrageError('funding_trade_not_open', 409);
    this.busy = true;
    try {
      this.update(id, { state: 'SUBMITTING', phase: 'EXIT' });
      const submitted = await Promise.allSettled([
        this.submitLeg(trade, 'long', 'exit', trade.openQuantity),
        this.submitLeg(trade, 'short', 'exit', trade.openQuantity),
      ]);
      const [longInitial, shortInitial] = await Promise.all([
        this.resolveSubmitted(clientOrderId(id, 'exit', 'long'), submitted[0]!),
        this.resolveSubmitted(clientOrderId(id, 'exit', 'short'), submitted[1]!),
      ]);
      const [longOrder, shortOrder] = await Promise.all([this.settle(longInitial), this.settle(shortInitial)]);
      if (!longOrder || !shortOrder || !isTerminalOrderState(longOrder.state) || !isTerminalOrderState(shortOrder.state)) {
        return this.manual(id, 'exit_order_state_unknown', { longState: longOrder?.state, shortState: shortOrder?.state });
      }
      const remainingLong = new Decimal(trade.openQuantity).minus(longOrder.executedQuantity);
      const remainingShort = new Decimal(trade.openQuantity).minus(shortOrder.executedQuantity);
      const repairs = await Promise.all([
        remainingLong.gt(0) ? this.closeRemainingLeg(trade, 'long', remainingLong) : Promise.resolve(true),
        remainingShort.gt(0) ? this.closeRemainingLeg(trade, 'short', remainingShort) : Promise.resolve(true),
      ]);
      if (!repairs.every(Boolean)) {
        return this.manual(id, 'exit_position_remaining', {
          remainingLong: remainingLong.toString(), remainingShort: remainingShort.toString(),
        });
      }
      const closedAt = new Date(this.now()).toISOString();
      const accounting = this.database.prepare(`SELECT COALESCE(SUM(CAST(fill.fee AS REAL)), 0) AS fees,
        COALESCE(SUM(CAST(fill.realized_pnl AS REAL)), 0) AS pnl
        FROM execution_fills AS fill JOIN execution_orders AS orders ON orders.id = fill.order_id
        WHERE orders.strategy_id = ?`).get(id) as { fees: number; pnl: number };
      this.event(id, 'info', 'funding_position_closed', '两腿 Reduce-only 平仓已确认');
      return this.update(id, { state: 'CLOSED', phase: 'RECONCILED', open_quantity: '0', closed_at: closedAt,
        exit_long_price: longOrder.executedAveragePrice, exit_short_price: shortOrder.executedAveragePrice,
        fees_paid: new Decimal(accounting.fees).toString(), realized_pnl: new Decimal(accounting.pnl).toString() });
    } finally { this.busy = false; }
  }

  private async closeRemainingLeg(trade: FundingTradeRecord, leg: 'long' | 'short', quantity: Decimal): Promise<boolean> {
    const venue = leg === 'long' ? trade.longVenue : trade.shortVenue;
    const side = leg === 'long' ? 'SELL' : 'BUY';
    try {
      const order = await this.runtime.createOrder({ symbol: symbol(venue, trade.asset), side, type: 'MARKET',
        timeInForce: 'IOC', quantity: quantity.toString(), reduceOnly: true }, {
        strategyId: trade.id, strategyLeg: leg === 'long' ? 'left' : 'right', riskReducing: true,
        clientOrderId: clientOrderId(trade.id, 'exit', `remaining-${leg}`),
      });
      const settled = await this.settle(order);
      const complete = settled !== null && new Decimal(settled.executedQuantity).gte(quantity);
      this.event(trade.id, complete ? 'warning' : 'critical', 'funding_exit_repair',
        complete ? '平仓剩余仓位已补充减仓' : '平仓剩余仓位减仓失败', {
          leg, requested: quantity.toString(), filled: settled?.executedQuantity ?? '0',
        });
      return complete;
    } catch { return false; }
  }

  /**
   * 候选扫描器写入最新资金费后调用。空头交易所费率不再高于多头交易所时，优势已经反转，立即减仓退出。
   */
  async observeFundingRates(id: string, raw: unknown): Promise<FundingTradeRecord> {
    const observation = FundingRateObservationSchema.parse(raw);
    const trade = this.get(id);
    if (trade.state !== 'OPEN') return trade;
    const advantage = new Decimal(observation.shortRate).minus(observation.longRate);
    this.event(id, advantage.lte(0) ? 'warning' : 'info', 'funding_rate_observed',
      advantage.lte(0) ? '资金费方向反转，触发退出' : '资金费优势仍为正', {
        ...observation, advantage: advantage.toString(),
      });
    if (advantage.lte(0)) {
      await this.options.alertDispatcher.emit({ eventType: 'funding_rate_reversed', severity: 'warning',
        message: `${trade.asset} 资金费方向反转，正在平仓`, details: { tradeId: id, ...observation } });
      return this.close(id);
    }
    return trade;
  }

  async reconcileFundingSettlement(id: string, raw: unknown): Promise<FundingTradeRecord> {
    const settlement = FundingSettlementSchema.parse(raw);
    const trade = this.get(id);
    if (trade.state !== 'OPEN' && trade.state !== 'CLOSED') {
      throw new FundingArbitrageError('funding_trade_not_reconcilable', 409);
    }
    const difference = new Decimal(settlement.actualFunding).minus(settlement.expectedFunding);
    const anomalous = difference.abs().gt(settlement.toleranceUsd);
    const updated = this.update(id, { expected_funding: settlement.expectedFunding, actual_funding: settlement.actualFunding });
    this.event(id, anomalous ? 'critical' : 'info', 'funding_settlement_reconciled',
      anomalous ? '实际资金费与预期不符' : '实际资金费对账通过', { ...settlement, difference: difference.toString() });
    if (anomalous) await this.options.alertDispatcher.emit({ eventType: 'funding_settlement_anomaly', severity: 'critical',
      message: `${trade.asset} 实际资金费异常`, details: { tradeId: id, ...settlement, difference: difference.toString() },
      dedupKey: `funding-settlement:${id}:${settlement.actualFunding}` });
    return updated;
  }

  /** 最长持仓是硬上限；到期后由后端自动发 Reduce-only 平仓，不依赖浏览器在线。 */
  async monitorHoldingLimits(): Promise<void> {
    const open = this.list(500).filter((trade) => trade.state === 'OPEN' && trade.openedAt !== null);
    if (open.length > 0) {
      const risk = await this.options.accountRiskCheck();
      if (!risk.safe) {
        await this.options.alertDispatcher.emit({ eventType: 'funding_account_risk', severity: 'critical',
          message: `资金费持仓触发账户风控：${risk.code}`, details: { reason: risk.reason } });
        await this.options.onKillSwitch(`funding_account_risk:${risk.code}:${risk.reason}`);
        for (const trade of open) {
          try { await this.close(trade.id); }
          catch (error) { await this.manual(trade.id, 'risk_exit_failed', {
            error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
          }); }
        }
        return;
      }
    }
    for (const trade of open) {
      if (this.now() - Date.parse(trade.openedAt!) <= this.options.limits.maxHoldingMs) continue;
      await this.options.alertDispatcher.emit({ eventType: 'funding_max_holding_exceeded', severity: 'warning',
        message: `${trade.asset} 达到最长持仓时间，正在平仓`, details: { tradeId: trade.id } });
      try { await this.close(trade.id); }
      catch (error) { await this.manual(trade.id, 'max_holding_exit_failed', {
        error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      }); }
    }
  }

  private async manual(id: string, reason: string, details: Record<string, unknown>): Promise<FundingTradeRecord> {
    const trade = this.update(id, { state: 'MANUAL_INTERVENTION', phase: 'LOCKED', manual_reason: reason });
    this.event(id, 'critical', 'funding_manual_intervention', '订单或仓位状态无法自动确认，已停止新单', { reason, ...details });
    await this.options.alertDispatcher.emit({ eventType: 'funding_manual_intervention', severity: 'critical',
      message: `资金费套利 ${trade.asset} 需要人工接管：${reason}`, details: { tradeId: id, ...details }, dedupKey: `manual:${id}:${reason}` });
    await this.options.onKillSwitch(`funding_arbitrage:${id}:${reason}`);
    return trade;
  }

  /**
   * 进程重启后只恢复查询和减仓动作，绝不会补发普通入场单。任何无法证明安全的状态都转人工。
   */
  async recover(): Promise<boolean> {
    const rows = this.database.prepare(`SELECT * FROM funding_arbitrage_trades
      WHERE state NOT IN ('OPEN', 'CLOSED', 'REJECTED', 'MANUAL_INTERVENTION') ORDER BY created_at`).all() as FundingTradeRow[];
    for (const row of rows) {
      const trade = fromRow(row);
      const longOrder = trade.longOrderId ? await this.runtime.refreshOrderFromRemote(trade.longOrderId).catch(() => null) : null;
      const shortOrder = trade.shortOrderId ? await this.runtime.refreshOrderFromRemote(trade.shortOrderId).catch(() => null) : null;
      if (trade.phase === 'ENTRY' && longOrder && shortOrder) await this.finishEntry(trade, longOrder, shortOrder);
      else await this.manual(trade.id, 'restart_reconciliation_uncertain', { phase: trade.phase });
    }
    for (const trade of this.list(500).filter((item) => item.state === 'OPEN')) {
      const positions = this.runtime.listLivePositions();
      const long = positions.find((position) => position.symbol === symbol(trade.longVenue, trade.asset));
      const short = positions.find((position) => position.symbol === symbol(trade.shortVenue, trade.asset));
      const expected = new Decimal(trade.openQuantity);
      const positionsConfirmed = long && short
        && new Decimal(long.quantity).gte(expected)
        && new Decimal(short.quantity).lte(expected.neg());
      if (!positionsConfirmed) await this.manual(trade.id, 'restart_position_mismatch', {
        expected: expected.toString(), longQuantity: long?.quantity ?? null, shortQuantity: short?.quantity ?? null,
      });
    }
    return (this.database.prepare("SELECT COUNT(*) AS count FROM funding_arbitrage_trades WHERE state = 'MANUAL_INTERVENTION'")
      .get() as { count: number }).count > 0;
  }
}
