import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { AccountRiskDecision } from './account-risk-guard.js';
import type { AlertDispatcher } from './alert-dispatcher.js';
import type { ExecutionMarketReader, ExecutionPairSnapshot, ExecutionVenue } from './execution-market-hub.js';
import { evaluateFundingHolding, type FundingSettlementEvent } from './funding-holding-model.js';
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
  maxExitSlippageBps: string;
  maxBasisBps: string;
  maxHoldingMs: number;
  softReviewMs: number;
  holdingMonitorIntervalMs: number;
  holdingStaleMs: number;
  holdingEventsPerLeg: number;
  holdingExitConfirmationCount: number;
  minimumHoldValueUsd: string;
  settlementGuardMs: number;
  settlementGraceMs: number;
  settlementMaxErrorUsd: string;
  settlementMaxErrorRatio: string;
  fundingRetentionFactor: string;
  stressSlippageBps: string;
  adverseExitBasisBps: string;
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
  entryLongPrice: string | null;
  entryShortPrice: string | null;
  monitorState: string;
  lastMonitorAt: string | null;
  softReviewAt: string | null;
  hardDeadlineAt: string | null;
  nextSettlementAt: string | null;
  currentExitPnl: string | null;
  holdValue: string | null;
  currentBasisBps: string | null;
  fundingEdge: string | null;
  unprofitableCount: number;
  lastMonitorReason: string | null;
  cumulativeActualFunding: string;
}

export interface FundingHoldingObservation {
  observedAt: string;
  long: { fundingRate: string; fundingTime: string; fundingInterval: string; takerFeeRate: string };
  short: { fundingRate: string; fundingTime: string; fundingInterval: string; takerFeeRate: string };
}

export interface FundingHoldingEvaluationRecord {
  id: string;
  tradeId: string;
  observedAt: string;
  decision: string;
  reason: string;
  marketQuality: string;
  longRate: string | null;
  shortRate: string | null;
  fundingEdge: string | null;
  conservativeFunding: string | null;
  riskBuffer: string | null;
  holdValue: string | null;
  currentExitPnl: string | null;
  basisBps: string | null;
  exitSlippageBps: string | null;
  unprofitableCount: number;
  nextSettlementAt: string | null;
  settlementEvents: FundingSettlementEvent[];
  details: Record<string, unknown>;
}

export interface FundingExpectedSettlementRecord {
  id: string;
  tradeId: string;
  symbol: string;
  venue: string;
  fundingTime: string;
  expectedAmount: string;
  state: string;
  actualAmount: string | null;
  reconciledAt: string | null;
}

export interface FundingLedgerRecord {
  id: string;
  symbol: string;
  venue: string;
  change: string;
  createdAt: string;
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
  entry_long_price: string | null; entry_short_price: string | null;
  monitor_state: string; last_monitor_at: string | null; soft_review_at: string | null; hard_deadline_at: string | null;
  next_settlement_at: string | null; current_exit_pnl: string | null; hold_value: string | null;
  current_basis_bps: string | null; funding_edge: string | null; unprofitable_count: number;
  last_monitor_reason: string | null; cumulative_actual_funding: string;
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
    entryLongPrice: row.entry_long_price, entryShortPrice: row.entry_short_price,
    monitorState: row.monitor_state, lastMonitorAt: row.last_monitor_at, softReviewAt: row.soft_review_at,
    hardDeadlineAt: row.hard_deadline_at, nextSettlementAt: row.next_settlement_at,
    currentExitPnl: row.current_exit_pnl, holdValue: row.hold_value, currentBasisBps: row.current_basis_bps,
    fundingEdge: row.funding_edge, unprofitableCount: row.unprofitable_count,
    lastMonitorReason: row.last_monitor_reason, cumulativeActualFunding: row.cumulative_actual_funding,
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

  listHoldingEvaluations(tradeId: string, limit = 100): FundingHoldingEvaluationRecord[] {
    const rows = this.database.prepare(`SELECT * FROM funding_holding_evaluations
      WHERE trade_id = ? ORDER BY observed_at DESC LIMIT ?`).all(tradeId, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let settlementEvents: FundingSettlementEvent[] = [];
      let details: Record<string, unknown> = {};
      try { settlementEvents = JSON.parse(String(row.settlement_events_json)) as FundingSettlementEvent[]; } catch { /* 损坏记录不能拖垮只读页面。 */ }
      try { details = JSON.parse(String(row.details_json)) as Record<string, unknown>; } catch { /* 同上。 */ }
      return { id: String(row.id), tradeId: String(row.trade_id), observedAt: String(row.observed_at),
        decision: String(row.decision), reason: String(row.reason), marketQuality: String(row.market_quality),
        longRate: row.long_rate === null ? null : String(row.long_rate), shortRate: row.short_rate === null ? null : String(row.short_rate),
        fundingEdge: row.funding_edge === null ? null : String(row.funding_edge),
        conservativeFunding: row.conservative_funding === null ? null : String(row.conservative_funding),
        riskBuffer: row.risk_buffer === null ? null : String(row.risk_buffer), holdValue: row.hold_value === null ? null : String(row.hold_value),
        currentExitPnl: row.current_exit_pnl === null ? null : String(row.current_exit_pnl),
        basisBps: row.basis_bps === null ? null : String(row.basis_bps),
        exitSlippageBps: row.exit_slippage_bps === null ? null : String(row.exit_slippage_bps),
        unprofitableCount: Number(row.unprofitable_count),
        nextSettlementAt: row.next_settlement_at === null ? null : String(row.next_settlement_at), settlementEvents, details };
    });
  }

  listExpectedSettlements(tradeId: string): FundingExpectedSettlementRecord[] {
    const rows = this.database.prepare(`SELECT * FROM funding_expected_settlements
      WHERE trade_id = ? ORDER BY funding_time DESC LIMIT 100`).all(tradeId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), tradeId: String(row.trade_id), symbol: String(row.symbol),
      venue: String(row.venue), fundingTime: String(row.funding_time), expectedAmount: String(row.expected_amount),
      state: String(row.state), actualAmount: row.actual_amount === null ? null : String(row.actual_amount),
      reconciledAt: row.reconciled_at === null ? null : String(row.reconciled_at) }));
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

  private persistHoldingEvaluation(input: Omit<FundingHoldingEvaluationRecord, 'id'>): FundingHoldingEvaluationRecord {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO funding_holding_evaluations
      (id, trade_id, observed_at, decision, reason, market_quality, long_rate, short_rate, funding_edge,
       conservative_funding, risk_buffer, hold_value, current_exit_pnl, basis_bps, exit_slippage_bps,
       unprofitable_count, next_settlement_at, settlement_events_json, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.tradeId, input.observedAt, input.decision, input.reason, input.marketQuality,
        input.longRate, input.shortRate, input.fundingEdge, input.conservativeFunding, input.riskBuffer,
        input.holdValue, input.currentExitPnl, input.basisBps, input.exitSlippageBps,
        input.unprofitableCount, input.nextSettlementAt, JSON.stringify(input.settlementEvents), JSON.stringify(input.details));
    return { id, ...input };
  }

  private upsertExpectedSettlements(tradeId: string, events: readonly FundingSettlementEvent[], observedAt: string): void {
    const statement = this.database.prepare(`INSERT INTO funding_expected_settlements
      (id, trade_id, symbol, venue, funding_time, expected_amount, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
      ON CONFLICT(trade_id, symbol, funding_time) DO UPDATE SET
        expected_amount = CASE WHEN funding_expected_settlements.state = 'PENDING'
          THEN excluded.expected_amount ELSE funding_expected_settlements.expected_amount END`);
    this.database.transaction(() => {
      for (const event of events) statement.run(randomUUID(), tradeId, event.symbol, event.venue,
        event.fundingTime, event.expectedAmount, observedAt);
      const currentKeys = new Set(events.map((event) => `${event.symbol}:${event.fundingTime}`));
      const futurePending = this.database.prepare(`SELECT id, symbol, funding_time FROM funding_expected_settlements
        WHERE trade_id = ? AND state = 'PENDING' AND funding_time > ?`).all(tradeId, observedAt) as Array<{
          id: string; symbol: string; funding_time: string;
        }>;
      for (const row of futurePending) {
        if (!currentKeys.has(`${row.symbol}:${row.funding_time}`)) {
          // 交易所调整结算时间或周期后，旧的未来事件不能再被误判成“资金费未到账”。
          this.database.prepare("UPDATE funding_expected_settlements SET state = 'SUPERSEDED' WHERE id = ? AND state = 'PENDING'")
            .run(row.id);
        }
      }
    })();
  }

  private update(id: string, fields: Record<string, string | null>): FundingTradeRecord {
    const allowed = new Set(['state', 'phase', 'open_quantity', 'long_order_id', 'short_order_id', 'repair_order_id',
      'failure_reason', 'manual_reason', 'entry_long_price', 'entry_short_price', 'exit_long_price', 'exit_short_price',
      'opened_at', 'closed_at', 'monitor_state', 'last_monitor_at', 'soft_review_at', 'hard_deadline_at',
      'next_settlement_at', 'current_exit_pnl', 'hold_value', 'current_basis_bps', 'funding_edge',
      'unprofitable_count', 'last_monitor_reason', 'cumulative_actual_funding']);
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
      const sameAsset = this.database.prepare(`SELECT COUNT(*) AS count FROM funding_arbitrage_trades
        WHERE asset = ? AND state NOT IN ('CLOSED', 'REJECTED')`).get(input.asset) as { count: number };
      // 账户资金费流水按交易所和合约聚合，同一币种并发组合会让自动对账无法唯一归属。
      if (sameAsset.count > 0) throw new FundingArbitrageError('funding_asset_already_active', 409);
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
    const softReviewAt = new Date(this.now() + this.options.limits.softReviewMs).toISOString();
    const hardDeadlineAt = new Date(this.now() + this.options.limits.maxHoldingMs).toISOString();
    this.event(trade.id, 'info', 'funding_position_opened', '两腿等量仓位已确认', { quantity: matched.toString() });
    return this.update(trade.id, { state: 'OPEN', phase: 'HOLDING', open_quantity: matched.toString(),
      entry_long_price: longOrder?.executedAveragePrice ?? null,
      entry_short_price: shortOrder?.executedAveragePrice ?? null, opened_at: openedAt,
      monitor_state: 'WAITING_FOR_DATA', soft_review_at: softReviewAt, hard_deadline_at: hardDeadlineAt });
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
    return this.closeQuantities(id);
  }

  private async closeQuantities(
    id: string,
    actualQuantities?: { long: Decimal; short: Decimal },
  ): Promise<FundingTradeRecord> {
    if (this.busy) throw new FundingArbitrageError('funding_engine_busy', 409);
    const trade = this.get(id);
    if (trade.state === 'CLOSED') return trade;
    if (trade.state !== 'OPEN') throw new FundingArbitrageError('funding_trade_not_open', 409);
    this.busy = true;
    try {
      this.update(id, { state: 'SUBMITTING', phase: 'EXIT' });
      const longTarget = actualQuantities?.long ?? new Decimal(trade.openQuantity);
      const shortTarget = actualQuantities?.short ?? new Decimal(trade.openQuantity);
      const submitted = await Promise.allSettled([
        longTarget.gt(0) ? this.submitLeg(trade, 'long', 'exit', longTarget.toString()) : Promise.resolve(null),
        shortTarget.gt(0) ? this.submitLeg(trade, 'short', 'exit', shortTarget.toString()) : Promise.resolve(null),
      ]);
      const [longInitial, shortInitial] = await Promise.all([
        longTarget.gt(0)
          ? this.resolveSubmitted(clientOrderId(id, 'exit', 'long'), submitted[0] as PromiseSettledResult<ExecutionOrder>)
          : Promise.resolve(null),
        shortTarget.gt(0)
          ? this.resolveSubmitted(clientOrderId(id, 'exit', 'short'), submitted[1] as PromiseSettledResult<ExecutionOrder>)
          : Promise.resolve(null),
      ]);
      const [longOrder, shortOrder] = await Promise.all([this.settle(longInitial), this.settle(shortInitial)]);
      const longUnknown = longTarget.gt(0) && (!longOrder || !isTerminalOrderState(longOrder.state));
      const shortUnknown = shortTarget.gt(0) && (!shortOrder || !isTerminalOrderState(shortOrder.state));
      if (longUnknown || shortUnknown) {
        return this.manual(id, 'exit_order_state_unknown', { longState: longOrder?.state, shortState: shortOrder?.state });
      }
      const remainingLong = longTarget.minus(longOrder?.executedQuantity ?? '0');
      const remainingShort = shortTarget.minus(shortOrder?.executedQuantity ?? '0');
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
        exit_long_price: longOrder?.executedAveragePrice ?? null, exit_short_price: shortOrder?.executedAveragePrice ?? null,
        fees_paid: new Decimal(accounting.fees).toString(), realized_pnl: new Decimal(accounting.pnl).toString(),
        monitor_state: 'CLOSED' });
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

  private async closeFromHoldingMonitor(
    trade: FundingTradeRecord,
    reason: string,
    actualQuantities?: { long: Decimal; short: Decimal },
  ): Promise<FundingTradeRecord> {
    await this.options.alertDispatcher.emit({ eventType: 'funding_holding_exit_triggered', severity: 'warning',
      message: `${trade.asset} 滚动持仓触发退出：${reason}`, details: { tradeId: trade.id, reason },
      dedupKey: `funding-holding-exit:${trade.id}:${reason}` });
    const maxBusyRetries = Math.ceil(Math.max(2_000, this.options.limits.maxUnhedgedMs + 500) / 100);
    let busyRetries = 0;
    while (true) {
      try { return await this.closeQuantities(trade.id, actualQuantities); }
      catch (error) {
        if (error instanceof FundingArbitrageError && error.code === 'funding_engine_busy' && busyRetries < maxBusyRetries) {
          // 另一条腿的修复或退出可能还在收尾；短暂等待后必须重试，不能把安全退出静默丢掉。
          busyRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        return this.manual(trade.id, 'holding_monitor_exit_failed', {
          reason, error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
        });
      }
    }
  }

  async markHoldingDataUnavailable(id: string, reason: string, details: Record<string, unknown> = {}): Promise<FundingTradeRecord> {
    const trade = this.get(id);
    if (trade.state !== 'OPEN') return trade;
    const observedAt = new Date(this.now()).toISOString();
    const degradedCount = trade.unprofitableCount + 1;
    const mustExit = degradedCount >= this.options.limits.holdingExitConfirmationCount;
    this.persistHoldingEvaluation({ tradeId: id, observedAt, decision: mustExit ? 'EXIT' : 'DEGRADED', reason,
      marketQuality: 'UNKNOWN', longRate: null, shortRate: null, fundingEdge: null,
      conservativeFunding: null, riskBuffer: null, holdValue: null, currentExitPnl: null,
      basisBps: null, exitSlippageBps: null, unprofitableCount: degradedCount,
      nextSettlementAt: null, settlementEvents: [], details });
    const updated = this.update(id, { monitor_state: mustExit ? 'EXIT' : 'DEGRADED', last_monitor_at: observedAt,
      last_monitor_reason: reason, unprofitable_count: String(degradedCount) });
    await this.options.alertDispatcher.emit({ eventType: 'funding_holding_data_degraded', severity: mustExit ? 'critical' : 'warning',
      message: `${trade.asset} 持仓监控数据不可用：${reason}${mustExit ? '，连续超限正在退出' : ''}`,
      details: { tradeId: id, degradedCount, ...details },
      dedupKey: `funding-holding-data:${id}:${reason}:${mustExit ? 'exit' : 'warning'}` });
    if (mustExit) {
      await this.options.onKillSwitch(`funding_holding_data_degraded:${id}:${reason}`);
      return this.closeFromHoldingMonitor(updated, reason);
    }
    return updated;
  }

  /**
   * 使用最新费率、同步盘口和真实仓位计算继续持有价值。普通收益退出需要连续确认；
   * 仓位漂移属于紧急风险，直接触发 Kill Switch 和减仓。
   */
  async evaluateOpenTrade(id: string, observation: FundingHoldingObservation): Promise<FundingTradeRecord> {
    const trade = this.get(id);
    if (trade.state !== 'OPEN' || !trade.openedAt) return trade;
    const observedAt = observation.observedAt;
    const quantity = new Decimal(trade.openQuantity);
    const expectedLong = symbol(trade.longVenue, trade.asset);
    const expectedShort = symbol(trade.shortVenue, trade.asset);
    const positions = this.runtime.listLivePositions();
    const longPosition = positions.find((position) => position.symbol === expectedLong);
    const shortPosition = positions.find((position) => position.symbol === expectedShort);
    const longQuantity = new Decimal(longPosition?.quantity ?? '0');
    const shortQuantity = new Decimal(shortPosition?.quantity ?? '0');
    const tolerance = new Decimal(this.options.limits.maxNetBaseExposure);
    const quantityDrift = Decimal.max(longQuantity.minus(quantity).abs(), shortQuantity.plus(quantity).abs(), longQuantity.plus(shortQuantity).abs());
    if (!longPosition || !shortPosition || quantityDrift.gt(tolerance)) {
      this.persistHoldingEvaluation({ tradeId: id, observedAt, decision: 'EMERGENCY_EXIT', reason: 'position_drift',
        marketQuality: 'UNKNOWN', longRate: observation.long.fundingRate, shortRate: observation.short.fundingRate,
        fundingEdge: null, conservativeFunding: null, riskBuffer: null, holdValue: null, currentExitPnl: null,
        basisBps: null, exitSlippageBps: null, unprofitableCount: trade.unprofitableCount,
        nextSettlementAt: null, settlementEvents: [], details: { expected: quantity.toString(),
          longQuantity: longQuantity.toString(), shortQuantity: shortQuantity.toString(), tolerance: tolerance.toString() } });
      this.update(id, { monitor_state: 'EMERGENCY_EXIT', last_monitor_at: observedAt,
        last_monitor_reason: 'position_drift' });
      await this.options.alertDispatcher.emit({ eventType: 'funding_position_drift', severity: 'critical',
        message: `${trade.asset} 两腿数量不再匹配，正在紧急减仓`, details: { tradeId: id,
          longQuantity: longQuantity.toString(), shortQuantity: shortQuantity.toString() },
        dedupKey: `funding-position-drift:${id}` });
      await this.options.onKillSwitch(`funding_position_drift:${id}`);
      if (longQuantity.lt(0) || shortQuantity.gt(0)) {
        return this.manual(id, 'position_direction_unexpected', {
          longQuantity: longQuantity.toString(), shortQuantity: shortQuantity.toString(),
        });
      }
      return this.closeFromHoldingMonitor(trade, 'position_drift', {
        long: Decimal.max(longQuantity, 0), short: Decimal.max(shortQuantity.neg(), 0),
      });
    }

    let pair: ExecutionPairSnapshot;
    try { pair = this.market.pair(trade.asset, trade.longVenue, trade.shortVenue, this.now()); }
    catch {
      return this.markHoldingDataUnavailable(id, 'market_snapshot_unavailable', {
        longRate: observation.long.fundingRate, shortRate: observation.short.fundingRate,
      });
    }
    if (pair.quality !== 'LIVE_SYNCHRONIZED') {
      return this.markHoldingDataUnavailable(id, 'market_not_synchronized', {
        marketQuality: pair.quality, reasons: pair.reasons,
        longRate: observation.long.fundingRate, shortRate: observation.short.fundingRate,
      });
    }

    const longExit = executablePrice(pair.longBook.bids, quantity);
    const shortExit = executablePrice(pair.shortBook.asks, quantity);
    const longTop = new Decimal(pair.longBook.bids[0]?.[0] ?? '0');
    const shortTop = new Decimal(pair.shortBook.asks[0]?.[0] ?? '0');
    if (!longExit || !shortExit || !longTop.gt(0) || !shortTop.gt(0) || !trade.entryLongPrice || !trade.entryShortPrice) {
      return this.markHoldingDataUnavailable(id, 'exit_valuation_unavailable', {
        longRate: observation.long.fundingRate, shortRate: observation.short.fundingRate,
      });
    }

    const longNotional = longExit.average.mul(quantity);
    const shortNotional = shortExit.average.mul(quantity);
    const longSlippage = longTop.minus(longExit.average).div(longTop).mul(10_000);
    const shortSlippage = shortExit.average.minus(shortTop).div(shortTop).mul(10_000);
    const exitSlippage = Decimal.max(longSlippage, shortSlippage);
    const basis = longExit.average.minus(shortExit.average).abs()
      .div(longExit.average.plus(shortExit.average).div(2)).mul(10_000);
    const pricePnl = longExit.average.minus(trade.entryLongPrice).mul(quantity)
      .plus(new Decimal(trade.entryShortPrice).minus(shortExit.average).mul(quantity));
    const feeRows = this.database.prepare(`SELECT fill.fee FROM execution_fills AS fill
      JOIN execution_orders AS orders ON orders.id = fill.order_id WHERE orders.strategy_id = ?`).all(id) as Array<{ fee: string }>;
    const entryFees = feeRows.reduce((sum, row) => sum.plus(new Decimal(row.fee).abs()), new Decimal(0));
    const exitFees = longNotional.mul(observation.long.takerFeeRate)
      .plus(shortNotional.mul(observation.short.takerFeeRate));
    const currentExitPnl = pricePnl.plus(trade.cumulativeActualFunding).minus(entryFees).minus(exitFees);
    const model = evaluateFundingHolding({ nowMs: this.now(),
      long: { symbol: expectedLong, venue: trade.longVenue, side: 'LONG', fundingRate: observation.long.fundingRate,
        fundingTime: observation.long.fundingTime, fundingInterval: observation.long.fundingInterval,
        notionalUsd: longNotional.toString() },
      short: { symbol: expectedShort, venue: trade.shortVenue, side: 'SHORT', fundingRate: observation.short.fundingRate,
        fundingTime: observation.short.fundingTime, fundingInterval: observation.short.fundingInterval,
        notionalUsd: shortNotional.toString() },
      eventsPerLeg: this.options.limits.holdingEventsPerLeg,
      fundingRetentionFactor: this.options.limits.fundingRetentionFactor,
      stressSlippageBps: this.options.limits.stressSlippageBps,
      adverseExitBasisBps: this.options.limits.adverseExitBasisBps,
      minimumHoldValueUsd: this.options.limits.minimumHoldValueUsd,
      previousUnprofitableCount: trade.unprofitableCount,
      unprofitableConfirmationCount: this.options.limits.holdingExitConfirmationCount,
      settlementGuardMs: this.options.limits.settlementGuardMs,
      openedAtMs: Date.parse(trade.openedAt), softReviewMs: this.options.limits.softReviewMs,
      hardHoldingMs: this.options.limits.maxHoldingMs });
    let decision = model.decision;
    let reason = model.reason;
    if (basis.gt(this.options.limits.maxBasisBps)) { decision = 'EXIT'; reason = 'holding_basis_exceeded'; }
    if (exitSlippage.gt(this.options.limits.maxExitSlippageBps)) { decision = 'EXIT'; reason = 'exit_slippage_exceeded'; }
    this.upsertExpectedSettlements(id, model.events, observedAt);
    this.persistHoldingEvaluation({ tradeId: id, observedAt, decision, reason, marketQuality: pair.quality,
      longRate: observation.long.fundingRate, shortRate: observation.short.fundingRate,
      fundingEdge: model.fundingEdge, conservativeFunding: model.conservativeFunding,
      riskBuffer: model.riskBuffer, holdValue: model.holdValue, currentExitPnl: currentExitPnl.toString(),
      basisBps: basis.toString(), exitSlippageBps: exitSlippage.toString(),
      unprofitableCount: model.unprofitableCount, nextSettlementAt: model.nextSettlementAt,
      settlementEvents: model.events, details: { pricePnl: pricePnl.toString(), entryFees: entryFees.toString(),
        estimatedExitFees: exitFees.toString(), exchangeSkewMs: pair.exchangeSkewMs, receiveSkewMs: pair.receiveSkewMs } });
    this.update(id, { monitor_state: decision, last_monitor_at: observedAt, next_settlement_at: model.nextSettlementAt,
      current_exit_pnl: currentExitPnl.toString(), hold_value: model.holdValue, current_basis_bps: basis.toString(),
      funding_edge: model.fundingEdge, unprofitable_count: String(model.unprofitableCount), last_monitor_reason: reason });
    this.event(id, decision === 'EXIT' ? 'warning' : 'info', 'funding_holding_evaluated',
      decision === 'EXIT' ? '滚动持仓触发退出' : '滚动持仓评估完成', { decision, reason,
        holdValue: model.holdValue, currentExitPnl: currentExitPnl.toString(), basisBps: basis.toString() });
    if (decision === 'REVIEW_REQUIRED') {
      await this.options.alertDispatcher.emit({ eventType: 'funding_holding_review_due', severity: 'warning',
        message: `${trade.asset} 已达到软观察时间，资金费仍为正但需要人工复核`, details: { tradeId: id,
          holdValue: model.holdValue, currentExitPnl: currentExitPnl.toString() }, dedupKey: `funding-review:${id}` });
    }
    if (decision === 'EXIT') return this.closeFromHoldingMonitor(this.get(id), reason);
    return this.get(id);
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

  /**
   * 把 Gate 账户流水匹配到预期结算事件。账户流水 ID 全局去重，避免每分钟轮询重复累计。
   * 结算超过宽限期仍没有流水时停止继续持有，并通过状态机安全退出。
   */
  async reconcileFundingLedger(records: readonly FundingLedgerRecord[]): Promise<number> {
    let matched = 0;
    const settlementExits = new Map<string, string>();
    for (const record of records) {
      const createdAtMs = Date.parse(record.createdAt);
      if (!Number.isFinite(createdAtMs)) continue;
      const pending = this.database.prepare(`SELECT * FROM funding_expected_settlements
        WHERE symbol = ? AND venue = ? AND state = 'PENDING'`).all(record.symbol, record.venue) as Array<Record<string, unknown>>;
      const selected = pending.map((row) => ({ row, distance: Math.abs(Date.parse(String(row.funding_time)) - createdAtMs) }))
        .filter((entry) => entry.distance <= this.options.limits.settlementGraceMs)
        .sort((left, right) => left.distance - right.distance)[0]?.row;
      if (!selected) continue;
      const expected = new Decimal(String(selected.expected_amount));
      const actual = new Decimal(record.change);
      const error = actual.minus(expected).abs();
      const relativeError = expected.isZero() ? new Decimal(0) : error.div(expected.abs());
      const anomalous = error.gt(this.options.limits.settlementMaxErrorUsd)
        || (!expected.isZero() && relativeError.gt(this.options.limits.settlementMaxErrorRatio));
      try {
        const result = this.database.prepare(`UPDATE funding_expected_settlements SET state = ?,
          account_book_id = ?, actual_amount = ?, reconciled_at = ? WHERE id = ? AND state = 'PENDING'`)
          .run(anomalous ? 'ANOMALOUS' : 'MATCHED', record.id, record.change,
            new Date(this.now()).toISOString(), String(selected.id));
        if (result.changes === 0) continue;
      } catch { continue; /* 相同账户流水已经由另一条预期事件认领。 */ }
      matched += 1;
      const tradeId = String(selected.trade_id);
      const totals = this.database.prepare(`SELECT COALESCE(SUM(CAST(actual_amount AS REAL)), 0) AS actual,
        COALESCE(SUM(CAST(expected_amount AS REAL)), 0) AS expected
        FROM funding_expected_settlements WHERE trade_id = ? AND state IN ('MATCHED', 'ANOMALOUS')`).get(tradeId) as { actual: number; expected: number };
      this.update(tradeId, { cumulative_actual_funding: new Decimal(totals.actual).toString(),
        actual_funding: new Decimal(totals.actual).toString(), expected_funding: new Decimal(totals.expected).toString() });
      this.event(tradeId, anomalous ? 'critical' : 'info', 'funding_settlement_auto_reconciled',
        anomalous ? '实际资金费流水与预期偏差过大' : '实际资金费流水已自动匹配', {
        symbol: record.symbol, venue: record.venue, expected: selected.expected_amount, actual: record.change,
        accountBookId: record.id, error: error.toString(), relativeError: relativeError.toString(), anomalous,
      });
      if (anomalous) settlementExits.set(tradeId, 'funding_settlement_anomaly');
    }

    const cutoff = new Date(this.now() - this.options.limits.settlementGraceMs).toISOString();
    const missing = this.database.prepare(`SELECT * FROM funding_expected_settlements
      WHERE state = 'PENDING' AND funding_time < ?`).all(cutoff) as Array<Record<string, unknown>>;
    for (const row of missing) {
      this.database.prepare("UPDATE funding_expected_settlements SET state = 'MISSING', reconciled_at = ? WHERE id = ? AND state = 'PENDING'")
        .run(new Date(this.now()).toISOString(), String(row.id));
      settlementExits.set(String(row.trade_id), 'funding_settlement_missing');
      this.event(String(row.trade_id), 'critical', 'funding_settlement_missing', '结算宽限期后仍未找到实际资金费流水', {
        symbol: row.symbol, venue: row.venue, fundingTime: row.funding_time, expectedAmount: row.expected_amount,
      });
    }
    for (const [tradeId, reason] of settlementExits) {
      const trade = this.get(tradeId);
      if (trade.state !== 'OPEN') continue;
      this.update(tradeId, { monitor_state: reason === 'funding_settlement_missing' ? 'SETTLEMENT_MISSING' : 'SETTLEMENT_ANOMALOUS',
        last_monitor_reason: reason });
      await this.options.alertDispatcher.emit({ eventType: reason, severity: 'critical',
        message: `${trade.asset} ${reason === 'funding_settlement_missing' ? '实际资金费未在宽限期内到账' : '实际资金费与预期偏差过大'}，正在退出`,
        details: { tradeId }, dedupKey: `${reason}:${tradeId}` });
      await this.closeFromHoldingMonitor(this.get(tradeId), reason);
    }
    return matched;
  }

  async reconcileFundingSettlement(id: string, raw: unknown): Promise<FundingTradeRecord> {
    const settlement = FundingSettlementSchema.parse(raw);
    const trade = this.get(id);
    if (trade.state !== 'OPEN' && trade.state !== 'CLOSED') {
      throw new FundingArbitrageError('funding_trade_not_reconcilable', 409);
    }
    const difference = new Decimal(settlement.actualFunding).minus(settlement.expectedFunding);
    const anomalous = difference.abs().gt(settlement.toleranceUsd);
    const updated = this.update(id, { expected_funding: settlement.expectedFunding, actual_funding: settlement.actualFunding,
      cumulative_actual_funding: settlement.actualFunding });
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
      const monitoringAnchor = trade.lastMonitorAt ?? trade.openedAt!;
      if (this.now() - Date.parse(monitoringAnchor) > this.options.limits.holdingStaleMs) {
        this.update(trade.id, { monitor_state: 'DEGRADED', last_monitor_reason: 'holding_monitor_stale' });
        await this.options.alertDispatcher.emit({ eventType: 'funding_holding_monitor_stale', severity: 'critical',
          message: `${trade.asset} 持仓监控长时间未更新，正在安全退出`, details: { tradeId: trade.id, monitoringAnchor },
          dedupKey: `funding-monitor-stale:${trade.id}` });
        await this.options.onKillSwitch(`funding_holding_monitor_stale:${trade.id}`);
        await this.closeFromHoldingMonitor(this.get(trade.id), 'holding_monitor_stale');
        continue;
      }
      if (this.now() - Date.parse(trade.openedAt!) <= this.options.limits.maxHoldingMs) continue;
      await this.options.alertDispatcher.emit({ eventType: 'funding_max_holding_exceeded', severity: 'warning',
        message: `${trade.asset} 达到最长持仓时间，正在平仓`, details: { tradeId: trade.id } });
      try { await this.close(trade.id); }
      catch (error) { await this.manual(trade.id, 'max_holding_exit_failed', {
        error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      }); }
    }
  }

  /** 私有订单流掉线后不再允许新单；已有组合通过 REST 状态机按 reduce-only 退出。 */
  async exitAllForSafety(reason: string): Promise<void> {
    const open = this.list(500).filter((trade) => trade.state === 'OPEN');
    await this.options.onKillSwitch(`funding_safety_exit:${reason}`);
    for (const trade of open) {
      this.update(trade.id, { monitor_state: 'EMERGENCY_EXIT', last_monitor_reason: reason });
      await this.options.alertDispatcher.emit({ eventType: 'funding_safety_exit', severity: 'critical',
        message: `${trade.asset} 触发安全退出：${reason}`, details: { tradeId: trade.id, reason },
        dedupKey: `funding-safety-exit:${trade.id}:${reason}` });
      await this.closeFromHoldingMonitor(this.get(trade.id), reason);
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
      const tolerance = new Decimal(this.options.limits.maxNetBaseExposure);
      const positionsConfirmed = long && short
        && new Decimal(long.quantity).minus(expected).abs().lte(tolerance)
        && new Decimal(short.quantity).plus(expected).abs().lte(tolerance)
        && new Decimal(long.quantity).plus(short.quantity).abs().lte(tolerance);
      if (!positionsConfirmed) await this.manual(trade.id, 'restart_position_mismatch', {
        expected: expected.toString(), longQuantity: long?.quantity ?? null, shortQuantity: short?.quantity ?? null,
      });
    }
    return (this.database.prepare("SELECT COUNT(*) AS count FROM funding_arbitrage_trades WHERE state = 'MANUAL_INTERVENTION'")
      .get() as { count: number }).count > 0;
  }
}
