import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GateFeeRate, GateFundingInfo } from './crossex-client.js';
import type { ExecutionMarketReader, ExecutionVenue } from './execution-market-hub.js';
import type { FundingCandidateRecord } from './funding-arbitrage-engine.js';
import { evaluateFundingHolding, type FundingSettlementEvent } from './funding-holding-model.js';

type Level = readonly [price: string, quantity: string];

interface DepthFill {
  average: Decimal;
  notional: Decimal;
  top: Decimal;
}

export interface FundingPaperOptions {
  enabled: boolean;
  maxOpenPositions: number;
  confirmationWindowMs: number;
  holdingEventsPerLeg: number;
  holdingExitConfirmationCount: number;
  minimumHoldValueUsd: string;
  settlementGuardMs: number;
  maxHoldingMs: number;
  softReviewMs: number;
  fundingRetentionFactor: string;
  stressSlippageBps: string;
  adverseExitBasisBps: string;
}

interface FundingPaperPositionRow {
  id: string;
  candidate_id: string;
  asset: string;
  long_venue: ExecutionVenue;
  short_venue: ExecutionVenue;
  quantity: string;
  state: string;
  monitor_state: string;
  entry_net_annualized: string;
  entry_long_price: string;
  entry_short_price: string;
  entry_long_notional: string;
  entry_short_notional: string;
  exit_long_price: string | null;
  exit_short_price: string | null;
  entry_fees: string;
  exit_fees: string;
  funding_pnl: string;
  price_pnl: string;
  total_pnl: string;
  current_exit_pnl: string | null;
  hold_value: string | null;
  current_basis_bps: string | null;
  funding_edge: string | null;
  long_rate: string | null;
  short_rate: string | null;
  unprofitable_count: number;
  data_failure_count: number;
  next_settlement_at: string | null;
  last_reason: string | null;
  opened_at: string;
  closed_at: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FundingPaperPositionRecord {
  id: string;
  candidateId: string;
  asset: string;
  longVenue: ExecutionVenue;
  shortVenue: ExecutionVenue;
  quantity: string;
  state: string;
  monitorState: string;
  entryNetAnnualized: string;
  entryLongPrice: string;
  entryShortPrice: string;
  exitLongPrice: string | null;
  exitShortPrice: string | null;
  entryFees: string;
  exitFees: string;
  fundingPnl: string;
  pricePnl: string;
  totalPnl: string;
  currentExitPnl: string | null;
  holdValue: string | null;
  currentBasisBps: string | null;
  fundingEdge: string | null;
  longRate: string | null;
  shortRate: string | null;
  unprofitableCount: number;
  dataFailureCount: number;
  nextSettlementAt: string | null;
  lastReason: string | null;
  openedAt: string;
  closedAt: string | null;
  lastEvaluatedAt: string | null;
  updatedAt: string;
}

export interface FundingPaperEvaluationRecord {
  id: string;
  positionId: string;
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

export interface FundingPaperSettlementRecord {
  id: string;
  positionId: string;
  symbol: string;
  venue: string;
  side: string;
  fundingTime: string;
  fundingRate: string;
  expectedAmount: string;
  amount: string | null;
  state: string;
  settledAt: string | null;
}

export interface FundingPaperSummary {
  enabled: boolean;
  openCount: number;
  closedCount: number;
  winRate: string;
  cumulativePnl: string;
  cumulativeFunding: string;
  cumulativeFees: string;
  fundingSnapshotCount: number;
  latestFundingSnapshotAt: string | null;
  executionSampleCount: number;
  latestExecutionSampleAt: string | null;
  positions: FundingPaperPositionRecord[];
}

function symbol(venue: ExecutionVenue, asset: string): string {
  return `${venue}_FUTURE_${asset}_USDT`;
}

function feeFor(fees: readonly GateFeeRate[], venue: ExecutionVenue, marketSymbol: string): Decimal | null {
  const row = fees.find((item) => item.exchange_type === venue);
  if (!row) return null;
  try {
    return new Decimal(row.special_fee_list?.find((item) => item.symbol === marketSymbol)?.taker_fee_rate
      ?? row.future_taker_fee);
  } catch {
    return null;
  }
}

function depthFill(levels: readonly Level[], quantityText: string): DepthFill | null {
  const quantity = new Decimal(quantityText);
  let remaining = quantity;
  let notional = new Decimal(0);
  const top = new Decimal(levels[0]?.[0] ?? '0');
  if (!quantity.gt(0) || !top.gt(0)) return null;
  for (const [priceText, sizeText] of levels) {
    const price = new Decimal(priceText);
    const size = new Decimal(sizeText);
    if (!price.gt(0) || !size.gt(0)) continue;
    const filled = Decimal.min(remaining, size);
    notional = notional.plus(filled.mul(price));
    remaining = remaining.minus(filled);
    if (remaining.lte(0)) return { average: notional.div(quantity), notional, top };
  }
  return null;
}

function fromPositionRow(row: FundingPaperPositionRow): FundingPaperPositionRecord {
  return {
    id: row.id, candidateId: row.candidate_id, asset: row.asset, longVenue: row.long_venue,
    shortVenue: row.short_venue, quantity: row.quantity, state: row.state, monitorState: row.monitor_state,
    entryNetAnnualized: row.entry_net_annualized, entryLongPrice: row.entry_long_price,
    entryShortPrice: row.entry_short_price, exitLongPrice: row.exit_long_price, exitShortPrice: row.exit_short_price,
    entryFees: row.entry_fees, exitFees: row.exit_fees, fundingPnl: row.funding_pnl,
    pricePnl: row.price_pnl, totalPnl: row.total_pnl, currentExitPnl: row.current_exit_pnl,
    holdValue: row.hold_value, currentBasisBps: row.current_basis_bps, fundingEdge: row.funding_edge,
    longRate: row.long_rate, shortRate: row.short_rate, unprofitableCount: row.unprofitable_count,
    dataFailureCount: row.data_failure_count, nextSettlementAt: row.next_settlement_at,
    lastReason: row.last_reason, openedAt: row.opened_at, closedAt: row.closed_at,
    lastEvaluatedAt: row.last_evaluated_at, updatedAt: row.updated_at,
  };
}

function sum(values: readonly string[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

/**
 * 资金费模拟盘只读真实行情，不调用任何订单或账户接口。
 * 所有成交都按同一时刻的多档盘口计算，重启后继续读取 OPEN 记录，不会重复创建候选持仓。
 */
export class FundingPaperEngine {
  private active: Promise<number> | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly market: ExecutionMarketReader,
    private readonly candidates: () => FundingCandidateRecord[],
    private readonly options: FundingPaperOptions,
    private readonly now: () => number = Date.now,
  ) {}

  list(limit = 100): FundingPaperPositionRecord[] {
    const rows = this.database.prepare(`SELECT * FROM funding_paper_positions
      ORDER BY CASE state WHEN 'OPEN' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, limit))) as FundingPaperPositionRow[];
    return rows.map(fromPositionRow);
  }

  summary(): FundingPaperSummary {
    const positions = this.list(100);
    const ledger = this.database.prepare(`SELECT state, total_pnl, funding_pnl, entry_fees, exit_fees
      FROM funding_paper_positions`).all() as Array<{ state: string; total_pnl: string; funding_pnl: string;
        entry_fees: string; exit_fees: string }>;
    const open = ledger.filter((position) => position.state === 'OPEN');
    const closed = ledger.filter((position) => position.state === 'CLOSED');
    const cumulativePnl = sum(closed.map((position) => position.total_pnl));
    const cumulativeFunding = sum(ledger.map((position) => position.funding_pnl));
    const cumulativeFees = sum(ledger.map((position) => new Decimal(position.entry_fees).plus(position.exit_fees).toString()));
    const winners = closed.filter((position) => new Decimal(position.total_pnl).gt(0)).length;
    const fundingData = this.database.prepare(`SELECT COUNT(*) AS count, MAX(observed_at) AS latest
      FROM funding_rate_snapshots`).get() as { count: number; latest: string | null };
    const executionData = this.database.prepare(`SELECT COUNT(*) AS count, MAX(sampled_at) AS latest
      FROM execution_market_samples`).get() as { count: number; latest: string | null };
    return {
      enabled: this.options.enabled, openCount: open.length, closedCount: closed.length,
      winRate: closed.length === 0 ? '0' : new Decimal(winners).div(closed.length).toString(),
      cumulativePnl: cumulativePnl.toString(), cumulativeFunding: cumulativeFunding.toString(),
      cumulativeFees: cumulativeFees.toString(), fundingSnapshotCount: fundingData.count,
      latestFundingSnapshotAt: fundingData.latest, executionSampleCount: executionData.count,
      latestExecutionSampleAt: executionData.latest, positions,
    };
  }

  details(id: string): { position: FundingPaperPositionRecord; evaluations: FundingPaperEvaluationRecord[];
    settlements: FundingPaperSettlementRecord[] } | null {
    const positionRow = this.database.prepare('SELECT * FROM funding_paper_positions WHERE id = ?')
      .get(id) as FundingPaperPositionRow | undefined;
    if (!positionRow) return null;
    const evaluationRows = this.database.prepare(`SELECT * FROM funding_paper_evaluations
      WHERE position_id = ? ORDER BY observed_at DESC LIMIT 200`).all(id) as Array<Record<string, unknown>>;
    const evaluations = evaluationRows.map((row): FundingPaperEvaluationRecord => {
      let settlementEvents: FundingSettlementEvent[] = [];
      let details: Record<string, unknown> = {};
      try { settlementEvents = JSON.parse(String(row.settlement_events_json)) as FundingSettlementEvent[]; } catch { /* 单条损坏不影响模拟盘总览。 */ }
      try { details = JSON.parse(String(row.details_json)) as Record<string, unknown>; } catch { /* 同上。 */ }
      return {
        id: String(row.id), positionId: String(row.position_id), observedAt: String(row.observed_at),
        decision: String(row.decision), reason: String(row.reason), marketQuality: String(row.market_quality),
        longRate: row.long_rate === null ? null : String(row.long_rate),
        shortRate: row.short_rate === null ? null : String(row.short_rate),
        fundingEdge: row.funding_edge === null ? null : String(row.funding_edge),
        conservativeFunding: row.conservative_funding === null ? null : String(row.conservative_funding),
        riskBuffer: row.risk_buffer === null ? null : String(row.risk_buffer),
        holdValue: row.hold_value === null ? null : String(row.hold_value),
        currentExitPnl: row.current_exit_pnl === null ? null : String(row.current_exit_pnl),
        basisBps: row.basis_bps === null ? null : String(row.basis_bps),
        exitSlippageBps: row.exit_slippage_bps === null ? null : String(row.exit_slippage_bps),
        unprofitableCount: Number(row.unprofitable_count),
        nextSettlementAt: row.next_settlement_at === null ? null : String(row.next_settlement_at),
        settlementEvents, details,
      };
    });
    const settlements = (this.database.prepare(`SELECT * FROM funding_paper_settlements
      WHERE position_id = ? ORDER BY funding_time DESC LIMIT 200`).all(id) as Array<Record<string, unknown>>)
      .map((row): FundingPaperSettlementRecord => ({
        id: String(row.id), positionId: String(row.position_id), symbol: String(row.symbol), venue: String(row.venue),
        side: String(row.side), fundingTime: String(row.funding_time), fundingRate: String(row.funding_rate),
        expectedAmount: String(row.expected_amount), amount: row.amount === null ? null : String(row.amount),
        state: String(row.state), settledAt: row.settled_at === null ? null : String(row.settled_at),
      }));
    return { position: fromPositionRow(positionRow), evaluations, settlements };
  }

  observe(funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[]): Promise<number> {
    if (!this.options.enabled) return Promise.resolve(0);
    if (this.active) return this.active;
    this.active = this.run(funding, fees).finally(() => { this.active = null; });
    return this.active;
  }

  private async run(funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[]): Promise<number> {
    const nowMs = this.now();
    const observedAt = new Date(nowMs).toISOString();
    this.settleDue(observedAt);
    let changed = 0;
    for (const position of this.list(500).filter((item) => item.state === 'OPEN')) {
      await this.evaluate(position.id, funding, fees, observedAt, nowMs);
      changed += 1;
    }
    changed += await this.openFreshCandidates(funding, fees, observedAt, nowMs);
    return changed;
  }

  /** 到点后使用结算前最后一次保存的费率快照记账；它是模拟到账，不冒充 Gate 真实流水。 */
  private settleDue(observedAt: string): void {
    const due = this.database.prepare(`SELECT * FROM funding_paper_settlements
      WHERE state = 'PENDING' AND funding_time <= ? ORDER BY funding_time`).all(observedAt) as Array<Record<string, unknown>>;
    const affected = new Set<string>();
    this.database.transaction(() => {
      for (const row of due) {
        this.database.prepare(`UPDATE funding_paper_settlements SET state = 'SETTLED', amount = expected_amount,
          settled_at = ?, updated_at = ? WHERE id = ? AND state = 'PENDING'`).run(observedAt, observedAt, row.id);
        affected.add(String(row.position_id));
      }
      for (const positionId of affected) {
        const amounts = this.database.prepare(`SELECT amount FROM funding_paper_settlements
          WHERE position_id = ? AND state = 'SETTLED'`).all(positionId) as Array<{ amount: string }>;
        this.database.prepare(`UPDATE funding_paper_positions SET funding_pnl = ?, updated_at = ? WHERE id = ?`)
          .run(sum(amounts.map((item) => item.amount)).toString(), observedAt, positionId);
      }
    })();
  }

  private async openFreshCandidates(
    funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[],
    observedAt: string,
    nowMs: number,
  ): Promise<number> {
    let openCount = (this.database.prepare("SELECT COUNT(*) AS count FROM funding_paper_positions WHERE state = 'OPEN'")
      .get() as { count: number }).count;
    if (openCount >= this.options.maxOpenPositions) return 0;
    const candidates = this.candidates().filter((candidate) => candidate.state === 'CONFIRMED'
      && nowMs - Date.parse(candidate.lastSeenAt) <= this.options.confirmationWindowMs)
      .sort((left, right) => new Decimal(right.netAnnualized).cmp(left.netAnnualized));
    let opened = 0;
    for (const candidate of candidates) {
      if (openCount >= this.options.maxOpenPositions) break;
      const used = this.database.prepare('SELECT 1 FROM funding_paper_positions WHERE candidate_id = ?').get(candidate.id);
      const duplicate = this.database.prepare(`SELECT 1 FROM funding_paper_positions
        WHERE state = 'OPEN' AND asset = ? AND long_venue = ? AND short_venue = ?`)
        .get(candidate.asset, candidate.longVenue, candidate.shortVenue);
      if (used || duplicate) continue;
      if (this.open(candidate, funding, fees, observedAt)) {
        await this.evaluateById(candidate.id, funding, fees, observedAt, nowMs);
        openCount += 1;
        opened += 1;
      }
    }
    return opened;
  }

  private open(
    candidate: FundingCandidateRecord,
    funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[],
    observedAt: string,
  ): boolean {
    const longSymbol = symbol(candidate.longVenue, candidate.asset);
    const shortSymbol = symbol(candidate.shortVenue, candidate.asset);
    if (!funding.some((item) => item.symbol === longSymbol) || !funding.some((item) => item.symbol === shortSymbol)) return false;
    const longFee = feeFor(fees, candidate.longVenue, longSymbol);
    const shortFee = feeFor(fees, candidate.shortVenue, shortSymbol);
    if (!longFee || !shortFee) return false;
    let pair;
    try { pair = this.market.pair(candidate.asset, candidate.longVenue, candidate.shortVenue, Date.parse(observedAt)); }
    catch { return false; }
    if (pair.quality !== 'LIVE_SYNCHRONIZED') return false;
    const longEntry = depthFill(pair.longBook.asks, candidate.quantity);
    const shortEntry = depthFill(pair.shortBook.bids, candidate.quantity);
    if (!longEntry || !shortEntry) return false;
    const entryFees = longEntry.notional.mul(longFee).plus(shortEntry.notional.mul(shortFee));
    const id = randomUUID();
    try {
      this.database.prepare(`INSERT INTO funding_paper_positions
        (id, candidate_id, asset, long_venue, short_venue, quantity, state, monitor_state,
         entry_net_annualized, entry_long_price, entry_short_price, entry_long_notional, entry_short_notional,
         entry_fees, opened_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, candidate.id, candidate.asset, candidate.longVenue, candidate.shortVenue, candidate.quantity,
          candidate.netAnnualized, longEntry.average.toString(), shortEntry.average.toString(),
          longEntry.notional.toString(), shortEntry.notional.toString(), entryFees.toString(),
          observedAt, observedAt, observedAt);
      return true;
    } catch (error) {
      // 唯一索引是最后一道幂等保护；只有约束冲突可以当作并发撞车，磁盘或数据库错误必须向外抛出。
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code.startsWith('SQLITE_CONSTRAINT')) return false;
      throw error;
    }
  }

  private async evaluateById(
    candidateId: string,
    funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[],
    observedAt: string,
    nowMs: number,
  ): Promise<void> {
    const row = this.database.prepare('SELECT id FROM funding_paper_positions WHERE candidate_id = ?').get(candidateId) as { id: string } | undefined;
    if (row) await this.evaluate(row.id, funding, fees, observedAt, nowMs);
  }

  private async evaluate(
    id: string,
    funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[],
    observedAt: string,
    nowMs: number,
  ): Promise<void> {
    const position = this.database.prepare("SELECT * FROM funding_paper_positions WHERE id = ? AND state = 'OPEN'")
      .get(id) as FundingPaperPositionRow | undefined;
    if (!position) return;
    const longSymbol = symbol(position.long_venue, position.asset);
    const shortSymbol = symbol(position.short_venue, position.asset);
    const fundingBySymbol = new Map(funding.map((item) => [item.symbol, item]));
    const longFunding = fundingBySymbol.get(longSymbol);
    const shortFunding = fundingBySymbol.get(shortSymbol);
    const longFee = feeFor(fees, position.long_venue, longSymbol);
    const shortFee = feeFor(fees, position.short_venue, shortSymbol);
    if (!longFunding || !shortFunding || !longFee || !shortFee) {
      this.recordUnavailable(position, observedAt, 'funding_or_fee_missing', {
        longFunding: Boolean(longFunding), shortFunding: Boolean(shortFunding), longFee: Boolean(longFee), shortFee: Boolean(shortFee),
      });
      return;
    }
    let pair;
    try { pair = this.market.pair(position.asset, position.long_venue, position.short_venue, nowMs); }
    catch {
      this.recordUnavailable(position, observedAt, 'execution_pair_unavailable');
      return;
    }
    if (pair.quality !== 'LIVE_SYNCHRONIZED') {
      this.recordUnavailable(position, observedAt, 'market_not_live_synchronized', { quality: pair.quality, reasons: pair.reasons });
      return;
    }
    const longExit = depthFill(pair.longBook.bids, position.quantity);
    const shortExit = depthFill(pair.shortBook.asks, position.quantity);
    if (!longExit || !shortExit) {
      this.recordUnavailable(position, observedAt, 'exit_depth_insufficient');
      return;
    }

    const quantity = new Decimal(position.quantity);
    const fundingPnl = new Decimal(position.funding_pnl);
    const pricePnl = quantity.mul(longExit.average.minus(position.entry_long_price)
      .plus(new Decimal(position.entry_short_price).minus(shortExit.average)));
    const exitFees = longExit.notional.mul(longFee).plus(shortExit.notional.mul(shortFee));
    const currentExitPnl = pricePnl.plus(fundingPnl).minus(position.entry_fees).minus(exitFees);
    const averageNotional = longExit.notional.plus(shortExit.notional).div(2);
    const basisBps = shortExit.average.minus(longExit.average).div(longExit.average.plus(shortExit.average).div(2)).mul(10_000);
    const longSlippage = longExit.top.minus(longExit.average).div(longExit.top).mul(10_000);
    const shortSlippage = shortExit.average.minus(shortExit.top).div(shortExit.top).mul(10_000);
    const exitSlippageBps = Decimal.max(longSlippage, shortSlippage);

    // 行情连续失败三次后，恢复到可成交状态的第一刻按当前盘口退出，模拟真实系统的延迟减仓结果。
    if (position.data_failure_count >= 3) {
      this.persistEvaluation(position.id, observedAt, 'EXIT', 'market_data_degraded', pair.quality, {
        longRate: longFunding.funding_rate, shortRate: shortFunding.funding_rate,
        currentExitPnl: currentExitPnl.toString(), basisBps: basisBps.toString(), exitSlippageBps: exitSlippageBps.toString(),
        details: { previousDataFailures: position.data_failure_count },
      });
      this.close(position, observedAt, 'market_data_degraded', longExit.average, shortExit.average,
        exitFees, pricePnl, currentExitPnl);
      return;
    }

    let model;
    try {
      model = evaluateFundingHolding({
        nowMs,
        long: { symbol: longSymbol, venue: position.long_venue, side: 'LONG', fundingRate: longFunding.funding_rate,
          fundingTime: String(longFunding.funding_time), fundingInterval: String(longFunding.funding_interval),
          notionalUsd: longExit.notional.toString() },
        short: { symbol: shortSymbol, venue: position.short_venue, side: 'SHORT', fundingRate: shortFunding.funding_rate,
          fundingTime: String(shortFunding.funding_time), fundingInterval: String(shortFunding.funding_interval),
          notionalUsd: shortExit.notional.toString() },
        eventsPerLeg: this.options.holdingEventsPerLeg,
        fundingRetentionFactor: this.options.fundingRetentionFactor,
        stressSlippageBps: this.options.stressSlippageBps,
        adverseExitBasisBps: this.options.adverseExitBasisBps,
        minimumHoldValueUsd: this.options.minimumHoldValueUsd,
        previousUnprofitableCount: position.unprofitable_count,
        unprofitableConfirmationCount: this.options.holdingExitConfirmationCount,
        settlementGuardMs: this.options.settlementGuardMs,
        openedAtMs: Date.parse(position.opened_at),
        softReviewMs: this.options.softReviewMs,
        hardHoldingMs: this.options.maxHoldingMs,
      });
    } catch {
      this.recordUnavailable(position, observedAt, 'funding_schedule_unavailable');
      return;
    }
    this.upsertSettlements(position.id, model.events, averageNotional, observedAt);
    this.persistEvaluation(position.id, observedAt, model.decision, model.reason, pair.quality, {
      longRate: longFunding.funding_rate, shortRate: shortFunding.funding_rate, fundingEdge: model.fundingEdge,
      conservativeFunding: model.conservativeFunding, riskBuffer: model.riskBuffer, holdValue: model.holdValue,
      currentExitPnl: currentExitPnl.toString(), basisBps: basisBps.toString(), exitSlippageBps: exitSlippageBps.toString(),
      unprofitableCount: model.unprofitableCount, nextSettlementAt: model.nextSettlementAt,
      settlementEvents: model.events,
      details: { exchangeSkewMs: pair.exchangeSkewMs, receiveSkewMs: pair.receiveSkewMs },
    });
    this.database.prepare(`UPDATE funding_paper_positions SET monitor_state = ?, current_exit_pnl = ?, price_pnl = ?, exit_fees = ?, hold_value = ?,
      current_basis_bps = ?, funding_edge = ?, long_rate = ?, short_rate = ?, unprofitable_count = ?,
      data_failure_count = 0, next_settlement_at = ?, last_reason = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
      .run(model.decision, currentExitPnl.toString(), pricePnl.toString(), exitFees.toString(), model.holdValue, basisBps.toString(), model.fundingEdge,
        longFunding.funding_rate, shortFunding.funding_rate, model.unprofitableCount, model.nextSettlementAt,
        model.reason, observedAt, observedAt, position.id);
    if (model.decision === 'EXIT') {
      this.close(position, observedAt, model.reason, longExit.average, shortExit.average, exitFees, pricePnl, currentExitPnl);
    }
  }

  private recordUnavailable(
    position: FundingPaperPositionRow,
    observedAt: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): void {
    const count = position.data_failure_count + 1;
    this.persistEvaluation(position.id, observedAt, 'DEGRADED', reason, 'UNAVAILABLE', { details, unprofitableCount: position.unprofitable_count });
    this.database.prepare(`UPDATE funding_paper_positions SET monitor_state = 'DEGRADED', data_failure_count = ?,
      last_reason = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
      .run(count, reason, observedAt, observedAt, position.id);
  }

  private persistEvaluation(
    positionId: string,
    observedAt: string,
    decision: string,
    reason: string,
    marketQuality: string,
    values: {
      longRate?: string; shortRate?: string; fundingEdge?: string; conservativeFunding?: string;
      riskBuffer?: string; holdValue?: string; currentExitPnl?: string; basisBps?: string;
      exitSlippageBps?: string; unprofitableCount?: number; nextSettlementAt?: string | null;
      settlementEvents?: FundingSettlementEvent[]; details?: Record<string, unknown>;
    } = {},
  ): void {
    this.database.prepare(`INSERT INTO funding_paper_evaluations
      (id, position_id, observed_at, decision, reason, market_quality, long_rate, short_rate, funding_edge,
       conservative_funding, risk_buffer, hold_value, current_exit_pnl, basis_bps, exit_slippage_bps,
       unprofitable_count, next_settlement_at, settlement_events_json, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), positionId, observedAt, decision, reason, marketQuality,
        values.longRate ?? null, values.shortRate ?? null, values.fundingEdge ?? null,
        values.conservativeFunding ?? null, values.riskBuffer ?? null, values.holdValue ?? null,
        values.currentExitPnl ?? null, values.basisBps ?? null, values.exitSlippageBps ?? null,
        values.unprofitableCount ?? 0, values.nextSettlementAt ?? null,
        JSON.stringify(values.settlementEvents ?? []), JSON.stringify(values.details ?? {}));
  }

  private upsertSettlements(
    positionId: string,
    events: readonly FundingSettlementEvent[],
    averageNotional: Decimal,
    observedAt: string,
  ): void {
    const statement = this.database.prepare(`INSERT INTO funding_paper_settlements
      (id, position_id, symbol, venue, side, funding_time, funding_rate, notional_usd,
       expected_amount, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      ON CONFLICT(position_id, symbol, funding_time) DO UPDATE SET
        funding_rate = excluded.funding_rate, notional_usd = excluded.notional_usd,
        expected_amount = excluded.expected_amount, updated_at = excluded.updated_at
      WHERE funding_paper_settlements.state = 'PENDING'`);
    this.database.transaction(() => {
      for (const event of events) {
        statement.run(randomUUID(), positionId, event.symbol, event.venue, event.side, event.fundingTime,
          event.fundingRate, averageNotional.toString(), event.expectedAmount, observedAt, observedAt);
      }
    })();
  }

  private close(
    position: FundingPaperPositionRow,
    observedAt: string,
    reason: string,
    longExitPrice: Decimal,
    shortExitPrice: Decimal,
    exitFees: Decimal,
    pricePnl: Decimal,
    totalPnl: Decimal,
  ): void {
    this.database.transaction(() => {
      this.database.prepare(`UPDATE funding_paper_positions SET state = 'CLOSED', monitor_state = 'EXIT',
        exit_long_price = ?, exit_short_price = ?, exit_fees = ?, price_pnl = ?, total_pnl = ?,
        current_exit_pnl = ?, last_reason = ?, closed_at = ?, last_evaluated_at = ?, updated_at = ?
        WHERE id = ? AND state = 'OPEN'`)
        .run(longExitPrice.toString(), shortExitPrice.toString(), exitFees.toString(), pricePnl.toString(),
          totalPnl.toString(), totalPnl.toString(), reason, observedAt, observedAt, observedAt, position.id);
      this.database.prepare(`UPDATE funding_paper_settlements SET state = 'CANCELLED', updated_at = ?
        WHERE position_id = ? AND state = 'PENDING'`).run(observedAt, position.id);
    })();
  }
}
