import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GateFeeRate, GateFundingInfo } from './crossex-client.js';
import type { ExecutionMarketReader, ExecutionVenue } from './execution-market-hub.js';
import type { FundingScanObservation } from './funding-candidate-scanner.js';

type Level = readonly [price: string, quantity: string];

interface DepthFill {
  average: Decimal;
  notional: Decimal;
  top: Decimal;
  slippageBps: Decimal;
}

export interface FundingResearchOptions {
  enabled: boolean;
  targetNotionalUsd: string;
  maxOpenPositions: number;
  minimumSettledEvents: number;
}

interface ResearchPositionRow {
  id: string;
  observation_id: string;
  asset: string;
  long_venue: ExecutionVenue;
  short_venue: ExecutionVenue;
  quantity: string;
  target_notional_usd: string;
  state: string;
  monitor_state: string;
  entry_raw_annualized: string;
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
  current_basis_bps: string | null;
  entry_slippage_bps: string | null;
  exit_slippage_bps: string | null;
  settled_events: number;
  data_failure_count: number;
  next_settlement_at: string | null;
  last_reason: string | null;
  opened_at: string;
  closed_at: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FundingResearchPosition {
  id: string;
  observationId: string;
  mode: 'RESEARCH';
  asset: string;
  longVenue: ExecutionVenue;
  shortVenue: ExecutionVenue;
  quantity: string;
  targetNotionalUsd: string;
  state: string;
  monitorState: string;
  entryRawAnnualized: string;
  entryNetAnnualized: string;
  entryLongPrice: string;
  entryShortPrice: string;
  entryLongNotional: string;
  entryShortNotional: string;
  exitLongPrice: string | null;
  exitShortPrice: string | null;
  entryFees: string;
  exitFees: string;
  fundingPnl: string;
  pricePnl: string;
  totalPnl: string;
  currentExitPnl: string | null;
  currentBasisBps: string | null;
  entrySlippageBps: string | null;
  exitSlippageBps: string | null;
  settledEvents: number;
  dataFailureCount: number;
  nextSettlementAt: string | null;
  lastReason: string | null;
  openedAt: string;
  closedAt: string | null;
  lastEvaluatedAt: string | null;
  updatedAt: string;
}

export interface FundingResearchEvaluation {
  id: string;
  positionId: string;
  observedAt: string;
  decision: string;
  reason: string;
  marketQuality: string;
  currentExitPnl: string | null;
  pricePnl: string | null;
  fundingPnl: string | null;
  exitFees: string | null;
  basisBps: string | null;
  exitSlippageBps: string | null;
  settledEvents: number;
  nextSettlementAt: string | null;
  details: Record<string, unknown>;
}

export interface FundingResearchSettlement {
  id: string;
  positionId: string;
  symbol: string;
  venue: string;
  side: string;
  fundingTime: string;
  fundingRate: string;
  notionalUsd: string;
  expectedAmount: string;
  amount: string | null;
  state: string;
  settledAt: string | null;
}

export interface FundingResearchSummary {
  enabled: boolean;
  targetNotionalUsd: string;
  maxOpenPositions: number;
  minimumSettledEvents: number;
  lastScanAt: string | null;
  scan24h: { observations: number; liveEligible: number; researchEligible: number; rejected: number };
  rejectionReasons: Array<{ reason: string; count: number }>;
  latestObservations: FundingScanObservation[];
  openCount: number;
  closedCount: number;
  cumulativePnl: string;
  cumulativeFunding: string;
  cumulativeFees: string;
  positions: FundingResearchPosition[];
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

function depthFill(levels: readonly Level[], quantityText: string, side: 'BUY' | 'SELL'): DepthFill | null {
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
    if (remaining.lte(0)) {
      const average = notional.div(quantity);
      const slippage = side === 'BUY' ? average.minus(top).div(top) : top.minus(average).div(top);
      return { average, notional, top, slippageBps: Decimal.max(0, slippage.mul(10_000)) };
    }
  }
  return null;
}

function fromPosition(row: ResearchPositionRow): FundingResearchPosition {
  return {
    id: row.id, observationId: row.observation_id, mode: 'RESEARCH', asset: row.asset,
    longVenue: row.long_venue, shortVenue: row.short_venue, quantity: row.quantity,
    targetNotionalUsd: row.target_notional_usd, state: row.state, monitorState: row.monitor_state,
    entryRawAnnualized: row.entry_raw_annualized, entryNetAnnualized: row.entry_net_annualized,
    entryLongPrice: row.entry_long_price, entryShortPrice: row.entry_short_price,
    entryLongNotional: row.entry_long_notional, entryShortNotional: row.entry_short_notional,
    exitLongPrice: row.exit_long_price, exitShortPrice: row.exit_short_price,
    entryFees: row.entry_fees, exitFees: row.exit_fees, fundingPnl: row.funding_pnl,
    pricePnl: row.price_pnl, totalPnl: row.total_pnl, currentExitPnl: row.current_exit_pnl,
    currentBasisBps: row.current_basis_bps, entrySlippageBps: row.entry_slippage_bps,
    exitSlippageBps: row.exit_slippage_bps, settledEvents: row.settled_events,
    dataFailureCount: row.data_failure_count, nextSettlementAt: row.next_settlement_at,
    lastReason: row.last_reason, openedAt: row.opened_at, closedAt: row.closed_at,
    lastEvaluatedAt: row.last_evaluated_at, updatedAt: row.updated_at,
  };
}

function observationFromRow(row: Record<string, unknown>): FundingScanObservation {
  return {
    id: String(row.id), scanId: String(row.scan_id), observedAt: String(row.observed_at), asset: String(row.asset),
    longVenue: String(row.long_venue) as ExecutionVenue, shortVenue: String(row.short_venue) as ExecutionVenue,
    quantity: row.quantity === null ? null : String(row.quantity), status: String(row.status) as FundingScanObservation['status'],
    strictEligible: Number(row.strict_eligible) === 1, researchEligible: Number(row.research_eligible) === 1,
    primaryReason: String(row.primary_reason), reasons: JSON.parse(String(row.reasons_json)) as string[],
    marketQuality: row.market_quality === null ? null : String(row.market_quality),
    longRate: String(row.long_rate), shortRate: String(row.short_rate), longEvents: Number(row.long_events),
    shortEvents: Number(row.short_events), entryLongPrice: row.entry_long_price === null ? null : String(row.entry_long_price),
    entryShortPrice: row.entry_short_price === null ? null : String(row.entry_short_price),
    exitLongPrice: row.exit_long_price === null ? null : String(row.exit_long_price),
    exitShortPrice: row.exit_short_price === null ? null : String(row.exit_short_price),
    entryLongNotional: row.entry_long_notional === null ? null : String(row.entry_long_notional),
    entryShortNotional: row.entry_short_notional === null ? null : String(row.entry_short_notional),
    rawFundingPnl: row.raw_funding_pnl === null ? null : String(row.raw_funding_pnl),
    conservativeFundingPnl: row.conservative_funding_pnl === null ? null : String(row.conservative_funding_pnl),
    immediateRoundTripPnl: row.immediate_round_trip_pnl === null ? null : String(row.immediate_round_trip_pnl),
    entryFees: row.entry_fees === null ? null : String(row.entry_fees), exitFees: row.exit_fees === null ? null : String(row.exit_fees),
    tradingFees: row.trading_fees === null ? null : String(row.trading_fees),
    stressBuffer: row.stress_buffer === null ? null : String(row.stress_buffer), netPnl: row.net_pnl === null ? null : String(row.net_pnl),
    rawAnnualized: row.raw_annualized === null ? null : String(row.raw_annualized),
    netAnnualized: row.net_annualized === null ? null : String(row.net_annualized),
    breakEvenHours: row.break_even_hours === null ? null : String(row.break_even_hours),
    entrySlippageBps: row.entry_slippage_bps === null ? null : String(row.entry_slippage_bps),
    exitSlippageBps: row.exit_slippage_bps === null ? null : String(row.exit_slippage_bps),
    basisBps: row.basis_bps === null ? null : String(row.basis_bps),
  };
}

/**
 * 探索模拟只消费扫描器给出的纸面机会并写本地账本。
 * 它没有交易运行时或账户依赖，因此无法调用下单接口，也不会改变实盘候选状态。
 */
export class FundingResearchEngine {
  private active: Promise<number> | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly market: ExecutionMarketReader,
    private readonly options: FundingResearchOptions,
    private readonly now: () => number = Date.now,
  ) {}

  observe(observations: readonly FundingScanObservation[], funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[]): Promise<number> {
    if (this.active) return this.active;
    this.active = this.run(observations, funding, fees).finally(() => { this.active = null; });
    return this.active;
  }

  list(limit = 50): FundingResearchPosition[] {
    return (this.database.prepare('SELECT * FROM funding_research_positions ORDER BY opened_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as ResearchPositionRow[]).map(fromPosition);
  }

  summary(): FundingResearchSummary {
    const dayAgo = new Date(this.now() - 24 * 60 * 60_000).toISOString();
    const lastScan = this.database.prepare(`SELECT scan_id, observed_at FROM funding_scan_observations
      ORDER BY observed_at DESC, id DESC LIMIT 1`).get() as { scan_id: string; observed_at: string } | undefined;
    const scan24h = this.database.prepare(`SELECT COUNT(*) AS observations,
      COALESCE(SUM(strict_eligible), 0) AS liveEligible,
      COALESCE(SUM(research_eligible), 0) AS researchEligible,
      COALESCE(SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END), 0) AS rejected
      FROM funding_scan_observations WHERE observed_at >= ?`).get(dayAgo) as Record<string, number>;
    const rejectionReasons = this.database.prepare(`SELECT primary_reason AS reason, COUNT(*) AS count
      FROM funding_scan_observations WHERE observed_at >= ? AND status = 'REJECTED'
      GROUP BY primary_reason ORDER BY count DESC, reason LIMIT 20`).all(dayAgo) as Array<{ reason: string; count: number }>;
    const latestObservations = !lastScan ? [] : (this.database.prepare(`SELECT * FROM funding_scan_observations
      WHERE scan_id = ? ORDER BY research_eligible DESC, strict_eligible DESC,
      CASE WHEN net_annualized IS NULL THEN 1 ELSE 0 END, CAST(net_annualized AS REAL) DESC LIMIT 40`)
      .all(lastScan.scan_id) as Array<Record<string, unknown>>).map(observationFromRow);
    const positions = this.list(100);
    const ledger = this.database.prepare(`SELECT state, funding_pnl, entry_fees, exit_fees, total_pnl
      FROM funding_research_positions`).all() as Array<{ state: string; funding_pnl: string;
        entry_fees: string; exit_fees: string; total_pnl: string }>;
    const closed = ledger.filter((position) => position.state === 'CLOSED');
    const fees = ledger.reduce((total, position) => total.plus(position.entry_fees).plus(position.exit_fees), new Decimal(0));
    return {
      enabled: this.options.enabled, targetNotionalUsd: this.options.targetNotionalUsd,
      maxOpenPositions: this.options.maxOpenPositions, minimumSettledEvents: this.options.minimumSettledEvents,
      lastScanAt: lastScan?.observed_at ?? null,
      scan24h: { observations: Number(scan24h.observations), liveEligible: Number(scan24h.liveEligible),
        researchEligible: Number(scan24h.researchEligible), rejected: Number(scan24h.rejected) },
      rejectionReasons, latestObservations,
      openCount: ledger.filter((position) => position.state === 'OPEN').length,
      closedCount: closed.length,
      cumulativePnl: closed.reduce((total, position) => total.plus(position.total_pnl), new Decimal(0)).toString(),
      cumulativeFunding: ledger.reduce((total, position) => total.plus(position.funding_pnl), new Decimal(0)).toString(),
      cumulativeFees: fees.toString(), positions,
    };
  }

  details(id: string): { position: FundingResearchPosition; evaluations: FundingResearchEvaluation[];
    settlements: FundingResearchSettlement[] } | null {
    const row = this.database.prepare('SELECT * FROM funding_research_positions WHERE id = ?').get(id) as ResearchPositionRow | undefined;
    if (!row) return null;
    const evaluations = (this.database.prepare(`SELECT * FROM funding_research_evaluations
      WHERE position_id = ? ORDER BY observed_at DESC LIMIT 500`).all(id) as Array<Record<string, unknown>>).map((item) => ({
        id: String(item.id), positionId: String(item.position_id), observedAt: String(item.observed_at),
        decision: String(item.decision), reason: String(item.reason), marketQuality: String(item.market_quality),
        currentExitPnl: item.current_exit_pnl === null ? null : String(item.current_exit_pnl),
        pricePnl: item.price_pnl === null ? null : String(item.price_pnl),
        fundingPnl: item.funding_pnl === null ? null : String(item.funding_pnl),
        exitFees: item.exit_fees === null ? null : String(item.exit_fees),
        basisBps: item.basis_bps === null ? null : String(item.basis_bps),
        exitSlippageBps: item.exit_slippage_bps === null ? null : String(item.exit_slippage_bps),
        settledEvents: Number(item.settled_events), nextSettlementAt: item.next_settlement_at === null ? null : String(item.next_settlement_at),
        details: JSON.parse(String(item.details_json)) as Record<string, unknown>,
      }));
    const settlements = (this.database.prepare(`SELECT * FROM funding_research_settlements
      WHERE position_id = ? ORDER BY funding_time DESC`).all(id) as Array<Record<string, unknown>>).map((item) => ({
        id: String(item.id), positionId: String(item.position_id), symbol: String(item.symbol), venue: String(item.venue),
        side: String(item.side), fundingTime: String(item.funding_time), fundingRate: String(item.funding_rate),
        notionalUsd: String(item.notional_usd), expectedAmount: String(item.expected_amount),
        amount: item.amount === null ? null : String(item.amount), state: String(item.state),
        settledAt: item.settled_at === null ? null : String(item.settled_at),
      }));
    return { position: fromPosition(row), evaluations, settlements };
  }

  private async run(observations: readonly FundingScanObservation[], funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[]): Promise<number> {
    const observedAt = new Date(this.now()).toISOString();
    this.persistObservations(observations);
    this.settleDue(observedAt);
    let changed = 0;
    for (const position of this.list(10).filter((item) => item.state === 'OPEN')) {
      this.evaluate(position.id, funding, fees, observedAt);
      changed += 1;
    }
    if (!this.options.enabled) return changed;
    const openCount = (this.database.prepare("SELECT COUNT(*) AS count FROM funding_research_positions WHERE state = 'OPEN'")
      .get() as { count: number }).count;
    if (openCount >= Math.min(1, this.options.maxOpenPositions)) return changed;
    const best = [...observations].filter((item) => item.researchEligible && item.quantity !== null
      && item.entryLongPrice !== null && item.entryShortPrice !== null && item.entryLongNotional !== null
      && item.entryShortNotional !== null && item.entryFees !== null && item.rawAnnualized !== null
      && item.netAnnualized !== null).sort((left, right) => new Decimal(right.netAnnualized!).cmp(left.netAnnualized!))[0];
    if (!best || !this.open(best, funding, observedAt)) return changed;
    const opened = this.database.prepare('SELECT id FROM funding_research_positions WHERE observation_id = ?')
      .get(best.id) as { id: string } | undefined;
    if (opened) this.evaluate(opened.id, funding, fees, observedAt);
    return changed + 1;
  }

  private persistObservations(observations: readonly FundingScanObservation[]): void {
    const statement = this.database.prepare(`INSERT OR IGNORE INTO funding_scan_observations
      (id, scan_id, observed_at, asset, long_venue, short_venue, quantity, status, strict_eligible,
       research_eligible, primary_reason, reasons_json, market_quality, long_rate, short_rate, long_events,
       short_events, entry_long_price, entry_short_price, exit_long_price, exit_short_price,
       entry_long_notional, entry_short_notional, raw_funding_pnl, conservative_funding_pnl,
       immediate_round_trip_pnl, entry_fees, exit_fees, trading_fees, stress_buffer, net_pnl,
       raw_annualized, net_annualized, break_even_hours, entry_slippage_bps, exit_slippage_bps, basis_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.database.transaction(() => {
      for (const item of observations) statement.run(item.id, item.scanId, item.observedAt, item.asset,
        item.longVenue, item.shortVenue, item.quantity, item.status, item.strictEligible ? 1 : 0,
        item.researchEligible ? 1 : 0, item.primaryReason, JSON.stringify(item.reasons), item.marketQuality,
        item.longRate, item.shortRate, item.longEvents, item.shortEvents, item.entryLongPrice,
        item.entryShortPrice, item.exitLongPrice, item.exitShortPrice, item.entryLongNotional,
        item.entryShortNotional, item.rawFundingPnl, item.conservativeFundingPnl,
        item.immediateRoundTripPnl, item.entryFees, item.exitFees, item.tradingFees, item.stressBuffer,
        item.netPnl, item.rawAnnualized, item.netAnnualized, item.breakEvenHours,
        item.entrySlippageBps, item.exitSlippageBps, item.basisBps);
    })();
  }

  private open(observation: FundingScanObservation, funding: readonly GateFundingInfo[], observedAt: string): boolean {
    const id = randomUUID();
    try {
      this.database.prepare(`INSERT INTO funding_research_positions
        (id, observation_id, asset, long_venue, short_venue, quantity, target_notional_usd, state,
         monitor_state, entry_raw_annualized, entry_net_annualized, entry_long_price, entry_short_price,
         entry_long_notional, entry_short_notional, entry_fees, entry_slippage_bps, opened_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, observation.id, observation.asset, observation.longVenue, observation.shortVenue,
          observation.quantity, this.options.targetNotionalUsd, observation.rawAnnualized,
          observation.netAnnualized, observation.entryLongPrice, observation.entryShortPrice,
          observation.entryLongNotional, observation.entryShortNotional, observation.entryFees,
          observation.entrySlippageBps, observedAt, observedAt, observedAt);
      this.refreshSettlements(id, observation.asset, observation.longVenue, observation.shortVenue,
        new Decimal(observation.entryLongNotional!), new Decimal(observation.entryShortNotional!), funding, observedAt);
      return true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code.startsWith('SQLITE_CONSTRAINT')) return false;
      throw error;
    }
  }

  private evaluate(id: string, funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[], observedAt: string): void {
    const position = this.database.prepare("SELECT * FROM funding_research_positions WHERE id = ? AND state = 'OPEN'")
      .get(id) as ResearchPositionRow | undefined;
    if (!position) return;
    const longSymbol = symbol(position.long_venue, position.asset);
    const shortSymbol = symbol(position.short_venue, position.asset);
    const fundingBySymbol = new Map(funding.map((item) => [item.symbol, item]));
    const longFunding = fundingBySymbol.get(longSymbol);
    const shortFunding = fundingBySymbol.get(shortSymbol);
    const longFee = feeFor(fees, position.long_venue, longSymbol);
    const shortFee = feeFor(fees, position.short_venue, shortSymbol);
    if (!longFunding || !shortFunding || !longFee || !shortFee) {
      this.unavailable(position, observedAt, 'funding_or_fee_missing');
      return;
    }
    this.refreshSettlements(position.id, position.asset, position.long_venue, position.short_venue,
      new Decimal(position.entry_long_notional), new Decimal(position.entry_short_notional), funding, observedAt);
    let pair;
    try { pair = this.market.pair(position.asset, position.long_venue, position.short_venue, Date.parse(observedAt)); }
    catch { this.unavailable(position, observedAt, 'execution_pair_unavailable'); return; }
    if (pair.quality !== 'LIVE_SYNCHRONIZED') {
      this.unavailable(position, observedAt, 'market_not_live_synchronized', { reasons: pair.reasons });
      return;
    }
    const longExit = depthFill(pair.longBook.bids, position.quantity, 'SELL');
    const shortExit = depthFill(pair.shortBook.asks, position.quantity, 'BUY');
    if (!longExit || !shortExit) { this.unavailable(position, observedAt, 'exit_depth_insufficient'); return; }
    const quantity = new Decimal(position.quantity);
    const fundingPnl = new Decimal(position.funding_pnl);
    const pricePnl = quantity.mul(longExit.average.minus(position.entry_long_price)
      .plus(new Decimal(position.entry_short_price).minus(shortExit.average)));
    const exitFees = longExit.notional.mul(longFee).plus(shortExit.notional.mul(shortFee));
    const totalPnl = pricePnl.plus(fundingPnl).minus(position.entry_fees).minus(exitFees);
    const basisBps = shortExit.average.minus(longExit.average)
      .div(longExit.average.plus(shortExit.average).div(2)).mul(10_000);
    const exitSlippageBps = longExit.slippageBps.plus(shortExit.slippageBps);
    const settledEvents = (this.database.prepare(`SELECT COUNT(*) AS count FROM funding_research_settlements
      WHERE position_id = ? AND state = 'SETTLED'`).get(position.id) as { count: number }).count;
    const nextSettlement = this.database.prepare(`SELECT MIN(funding_time) AS next FROM funding_research_settlements
      WHERE position_id = ? AND state = 'PENDING'`).get(position.id) as { next: string | null };
    const shouldExit = settledEvents >= this.options.minimumSettledEvents;
    const decision = shouldExit ? 'EXIT' : 'HOLD';
    const reason = shouldExit ? 'research_minimum_settlement_completed' : 'research_waiting_first_settlement';
    this.persistEvaluation(position.id, observedAt, decision, reason, pair.quality, {
      currentExitPnl: totalPnl.toString(), pricePnl: pricePnl.toString(), fundingPnl: fundingPnl.toString(),
      exitFees: exitFees.toString(), basisBps: basisBps.toString(), exitSlippageBps: exitSlippageBps.toString(),
      settledEvents, nextSettlementAt: nextSettlement.next,
      details: { exchangeSkewMs: pair.exchangeSkewMs, receiveSkewMs: pair.receiveSkewMs,
        longRate: longFunding.funding_rate, shortRate: shortFunding.funding_rate },
    });
    this.database.prepare(`UPDATE funding_research_positions SET monitor_state = ?, current_exit_pnl = ?,
      price_pnl = ?, exit_fees = ?, current_basis_bps = ?, exit_slippage_bps = ?, settled_events = ?,
      data_failure_count = 0, next_settlement_at = ?, last_reason = ?, last_evaluated_at = ?, updated_at = ?
      WHERE id = ?`).run(decision, totalPnl.toString(), pricePnl.toString(), exitFees.toString(),
      basisBps.toString(), exitSlippageBps.toString(), settledEvents, nextSettlement.next, reason,
      observedAt, observedAt, position.id);
    if (shouldExit) this.close(position, observedAt, reason, longExit.average, shortExit.average,
      exitFees, pricePnl, totalPnl, settledEvents);
  }

  private refreshSettlements(positionId: string, asset: string, longVenue: ExecutionVenue,
    shortVenue: ExecutionVenue, longNotional: Decimal, shortNotional: Decimal,
    funding: readonly GateFundingInfo[], observedAt: string): void {
    const bySymbol = new Map(funding.map((item) => [item.symbol, item]));
    const legs = [
      { venue: longVenue, side: 'LONG', notional: longNotional },
      { venue: shortVenue, side: 'SHORT', notional: shortNotional },
    ] as const;
    const statement = this.database.prepare(`INSERT INTO funding_research_settlements
      (id, position_id, symbol, venue, side, funding_time, funding_rate, notional_usd,
       expected_amount, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      ON CONFLICT(position_id, symbol, funding_time) DO UPDATE SET funding_rate = excluded.funding_rate,
        notional_usd = excluded.notional_usd, expected_amount = excluded.expected_amount,
        updated_at = excluded.updated_at WHERE funding_research_settlements.state = 'PENDING'`);
    this.database.transaction(() => {
      for (const leg of legs) {
        const marketSymbol = symbol(leg.venue, asset);
        const item = bySymbol.get(marketSymbol);
        if (!item) continue;
        const fundingTime = new Date(Number(item.funding_time)).toISOString();
        const amount = leg.notional.mul(item.funding_rate).mul(leg.side === 'LONG' ? -1 : 1);
        statement.run(randomUUID(), positionId, marketSymbol, leg.venue, leg.side, fundingTime,
          item.funding_rate, leg.notional.toString(), amount.toString(), observedAt, observedAt);
      }
    })();
  }

  /** 研究账本使用结算前最后一条预测费率模拟到账，不把它标成交易所真实资金流水。 */
  private settleDue(observedAt: string): void {
    const due = this.database.prepare(`SELECT * FROM funding_research_settlements
      WHERE state = 'PENDING' AND funding_time <= ? ORDER BY funding_time`).all(observedAt) as Array<Record<string, unknown>>;
    const affected = new Set<string>();
    this.database.transaction(() => {
      for (const row of due) {
        this.database.prepare(`UPDATE funding_research_settlements SET state = 'SETTLED', amount = expected_amount,
          settled_at = ?, updated_at = ? WHERE id = ? AND state = 'PENDING'`).run(observedAt, observedAt, row.id);
        affected.add(String(row.position_id));
      }
      for (const positionId of affected) {
        // SQLite 的 REAL 会把高精度小额资金费转成浮点数；账本统一在 Decimal 中求和后再落盘。
        const settled = this.database.prepare(`SELECT amount FROM funding_research_settlements
          WHERE position_id = ? AND state = 'SETTLED'`).all(positionId) as Array<{ amount: string }>;
        const funding = settled.reduce((total, item) => total.plus(item.amount), new Decimal(0));
        this.database.prepare(`UPDATE funding_research_positions SET funding_pnl = ?, settled_events = ?, updated_at = ?
          WHERE id = ?`).run(funding.toString(), settled.length, observedAt, positionId);
      }
    })();
  }

  private unavailable(position: ResearchPositionRow, observedAt: string, reason: string,
    details: Record<string, unknown> = {}): void {
    const failures = position.data_failure_count + 1;
    this.persistEvaluation(position.id, observedAt, 'DEGRADED', reason, 'UNAVAILABLE', {
      fundingPnl: position.funding_pnl, settledEvents: position.settled_events,
      nextSettlementAt: position.next_settlement_at, details,
    });
    this.database.prepare(`UPDATE funding_research_positions SET monitor_state = 'DEGRADED',
      data_failure_count = ?, last_reason = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
      .run(failures, reason, observedAt, observedAt, position.id);
  }

  private persistEvaluation(positionId: string, observedAt: string, decision: string, reason: string,
    marketQuality: string, values: { currentExitPnl?: string; pricePnl?: string; fundingPnl?: string;
      exitFees?: string; basisBps?: string; exitSlippageBps?: string; settledEvents?: number;
      nextSettlementAt?: string | null; details?: Record<string, unknown> } = {}): void {
    this.database.prepare(`INSERT INTO funding_research_evaluations
      (id, position_id, observed_at, decision, reason, market_quality, current_exit_pnl, price_pnl,
       funding_pnl, exit_fees, basis_bps, exit_slippage_bps, settled_events, next_settlement_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), positionId, observedAt, decision, reason, marketQuality,
        values.currentExitPnl ?? null, values.pricePnl ?? null, values.fundingPnl ?? null,
        values.exitFees ?? null, values.basisBps ?? null, values.exitSlippageBps ?? null,
        values.settledEvents ?? 0, values.nextSettlementAt ?? null, JSON.stringify(values.details ?? {}));
  }

  private close(position: ResearchPositionRow, observedAt: string, reason: string,
    longExitPrice: Decimal, shortExitPrice: Decimal, exitFees: Decimal, pricePnl: Decimal,
    totalPnl: Decimal, settledEvents: number): void {
    this.database.transaction(() => {
      this.database.prepare(`UPDATE funding_research_positions SET state = 'CLOSED', monitor_state = 'EXIT',
        exit_long_price = ?, exit_short_price = ?, exit_fees = ?, price_pnl = ?, total_pnl = ?,
        current_exit_pnl = ?, settled_events = ?, last_reason = ?, closed_at = ?, last_evaluated_at = ?, updated_at = ?
        WHERE id = ? AND state = 'OPEN'`).run(longExitPrice.toString(), shortExitPrice.toString(),
        exitFees.toString(), pricePnl.toString(), totalPnl.toString(), totalPnl.toString(), settledEvents,
        reason, observedAt, observedAt, observedAt, position.id);
      this.database.prepare(`UPDATE funding_research_settlements SET state = 'CANCELLED', updated_at = ?
        WHERE position_id = ? AND state = 'PENDING'`).run(observedAt, position.id);
    })();
  }
}
