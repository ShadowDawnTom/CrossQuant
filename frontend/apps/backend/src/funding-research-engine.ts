import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GateFeeRate, GateFundingInfo } from './crossex-client.js';
import { crossExFutureSymbol, type ExecutionMarketReader, type ExecutionVenue, usdLevels } from './execution-market-hub.js';
import type { FundingScanObservation } from './funding-candidate-scanner.js';
import { evaluateFundingHolding } from './funding-holding-model.js';
import type { SpotMarketReader } from './spot-market-reader.js';

type Level = readonly [price: string, quantity: string];

interface DepthFill {
  average: Decimal;
  notional: Decimal;
  top: Decimal;
  slippageBps: Decimal;
}

export interface FundingResearchOptions {
  enabled: boolean;
  modelVersion?: string;
  targetNotionalUsd: string;
  maxActualNotionalUsd?: string;
  maxOpenPositions: number;
  minimumSettledEvents: number;
  holdingEventsPerLeg?: number;
  holdingExitConfirmationCount?: number;
  reversalExitConfirmationCount?: number;
  reentryCooldownMs?: number;
  minimumHoldValueUsd?: string;
  settlementGuardMs?: number;
  fundingRetentionFactor?: string;
  stressSlippageBps?: string;
  adverseExitBasisBps?: string;
  rollingSoftReviewMs?: number;
  rollingHardHoldingMs?: number;
  stablecoinRiskBps?: string;
  horizonHours?: number;
  makerFillProbability?: string;
  makerLegRiskBps?: string;
  spotMarket?: SpotMarketReader;
}

export type FundingResearchCohort = 'ONE_SETTLEMENT' | 'ROLLING';

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
  cohort: FundingResearchCohort;
  unprofitable_count: number;
  reversal_count: number;
  research_model_version: string;
  long_quote: string;
  short_quote: string;
  reopen_after: string | null;
}

export interface FundingResearchPosition {
  id: string;
  observationId: string;
  mode: 'RESEARCH';
  cohort: FundingResearchCohort;
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
  unprofitableCount: number;
  reversalCount: number;
  modelVersion: string;
  longQuote: string;
  shortQuote: string;
  reopenAfter: string | null;
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
  amountSource: string;
  settledAt: string | null;
}

export interface FundingResearchSummary {
  enabled: boolean;
  modelVersion: string;
  holdExitConfirmations: number;
  reversalExitConfirmations: number;
  reentryCooldownMs: number;
  targetNotionalUsd: string;
  maxActualNotionalUsd: string;
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
  cohorts: Array<{ cohort: FundingResearchCohort; openCount: number; closedCount: number;
    cumulativePnl: string; cumulativeFunding: string; cumulativeFees: string }>;
  variants: FundingResearchVariant[];
}

export interface FundingResearchVariant {
  id: string;
  observationId: string;
  evaluatedAt: string;
  asset: string;
  longVenue: string;
  shortVenue: string;
  variant: 'TAKER_TAKER' | 'MAKER_TAKER' | 'SPOT_PERP';
  hedgeModel: 'PERP_PERP' | 'SPOT_PERP';
  state: 'PRICED' | 'UNAVAILABLE';
  expectedNetPnl: string | null;
  expectedNetAnnualized: string | null;
  tradingFees: string | null;
  fillProbability: string | null;
  breakEvenHours: string | null;
  reason: string;
  details: Record<string, unknown>;
  modelVersion: string;
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

function makerFeeFor(fees: readonly GateFeeRate[], venue: ExecutionVenue, marketSymbol: string): Decimal | null {
  const row = fees.find((item) => item.exchange_type === venue);
  if (!row) return null;
  try {
    return new Decimal(row.special_fee_list?.find((item) => item.symbol === marketSymbol)?.maker_fee_rate
      ?? row.future_maker_fee);
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
    id: row.id, observationId: row.observation_id, mode: 'RESEARCH', cohort: row.cohort, asset: row.asset,
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
    unprofitableCount: row.unprofitable_count,
    reversalCount: row.reversal_count,
    modelVersion: row.research_model_version,
    longQuote: row.long_quote, shortQuote: row.short_quote,
    reopenAfter: row.reopen_after,
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
    longQuote: String(row.long_quote ?? 'USDT'), shortQuote: String(row.short_quote ?? 'USDT'),
    longQuoteToUsd: row.long_quote_to_usd === null ? null : String(row.long_quote_to_usd),
    shortQuoteToUsd: row.short_quote_to_usd === null ? null : String(row.short_quote_to_usd),
    liquidityUsd: row.liquidity_usd === null ? null : String(row.liquidity_usd),
    executionSupport: String(row.execution_support ?? 'LIVE_READY') as FundingScanObservation['executionSupport'],
    cohortClone: Number(row.cohort_clone ?? 0) === 1,
    stablecoinRiskBuffer: row.stablecoin_risk_buffer === null ? null : String(row.stablecoin_risk_buffer),
    dataValid: Number(row.data_valid ?? 1) === 1,
    invalidReason: row.invalid_reason === null ? null : String(row.invalid_reason),
    persistenceProbability: row.persistence_probability === null ? null : String(row.persistence_probability),
    persistenceSamples: Number(row.persistence_samples ?? 0),
    retentionFactorUsed: row.retention_factor_used === null ? undefined : String(row.retention_factor_used),
    historicalEdgeP10: row.historical_edge_p10 === null ? null : String(row.historical_edge_p10),
    historicalEdgeMedian: row.historical_edge_median === null ? null : String(row.historical_edge_median),
    requestedNotionalUsd: row.requested_notional_usd === null ? undefined : String(row.requested_notional_usd),
  };
}

interface FundingScanSummaryRow {
  scan_id: string;
  observed_at: string;
  observations: number;
  live_eligible: number;
  research_eligible: number;
  rejected: number;
  rejection_reasons_json: string;
  observation_ids_json: string;
}

function rankedObservations(observations: readonly FundingScanObservation[]): FundingScanObservation[] {
  return [...observations].sort((left, right) => {
    if (left.researchEligible !== right.researchEligible) return right.researchEligible ? 1 : -1;
    if (left.strictEligible !== right.strictEligible) return right.strictEligible ? 1 : -1;
    if (left.netAnnualized === null) return right.netAnnualized === null ? 0 : 1;
    if (right.netAnnualized === null) return -1;
    return new Decimal(right.netAnnualized).cmp(left.netAnnualized);
  });
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function parseReasonCounts(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch { return {}; }
}

/**
 * 探索模拟只消费扫描器给出的纸面机会并写本地账本。
 * 它没有交易运行时或账户依赖，因此无法调用下单接口，也不会改变实盘候选状态。
 */
export class FundingResearchEngine {
  private active: Promise<number> | null = null;

  private get modelVersion(): string {
    return this.options.modelVersion ?? 'rolling_v5';
  }

  constructor(
    private readonly database: Database.Database,
    private readonly market: ExecutionMarketReader,
    private readonly options: FundingResearchOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.archiveLegacyOpenPositions();
  }

  /**
   * 每个研究模型使用独立账本。版本切换时保留历史，只关闭旧模型的模拟仓位和未到期模拟结算；
   * 这里不接触真实订单表，后续再切模型版本也不会把不同实验口径混在一起。
   */
  private archiveLegacyOpenPositions(): void {
    const observedAt = new Date(this.now()).toISOString();
    this.database.transaction(() => {
      this.database.prepare(`UPDATE funding_research_settlements SET state = 'CANCELLED', updated_at = ?
        WHERE state = 'PENDING' AND position_id IN (
          SELECT id FROM funding_research_positions WHERE state = 'OPEN' AND research_model_version <> ?
        )`).run(observedAt, this.modelVersion);
      this.database.prepare(`UPDATE funding_research_positions SET state = 'CLOSED', monitor_state = 'EXIT',
        total_pnl = COALESCE(current_exit_pnl, total_pnl), last_reason = 'research_model_restarted',
        closed_at = ?, last_evaluated_at = ?, updated_at = ?
        WHERE state = 'OPEN' AND research_model_version <> ?`)
        .run(observedAt, observedAt, observedAt, this.modelVersion);
    })();
  }

  observe(observations: readonly FundingScanObservation[], funding: readonly GateFundingInfo[],
    fees: readonly GateFeeRate[]): Promise<number> {
    if (this.active) return this.active;
    this.active = this.run(observations, funding, fees).finally(() => { this.active = null; });
    return this.active;
  }

  list(limit = 50): FundingResearchPosition[] {
    return (this.database.prepare(`SELECT * FROM funding_research_positions
      WHERE research_model_version = ? ORDER BY opened_at DESC LIMIT ?`)
      .all(this.modelVersion, Math.max(1, Math.min(500, limit))) as ResearchPositionRow[]).map(fromPosition);
  }

  private latestScanSummary(): FundingScanSummaryRow | undefined {
    return this.database.prepare(`SELECT * FROM funding_scan_summaries
      WHERE research_model_version = ? ORDER BY observed_at DESC LIMIT 1`)
      .get(this.modelVersion) as FundingScanSummaryRow | undefined;
  }

  private summaryObservations(summary: FundingScanSummaryRow, limit = 60): FundingScanObservation[] {
    const ids = parseStringArray(summary.observation_ids_json).slice(0, Math.max(1, Math.min(60, limit)));
    if (ids.length === 0) return [];
    const rows = this.database.prepare(`SELECT * FROM funding_scan_observations
      WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [String(row.id), observationFromRow(row)]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  latestExecutionObservations(): FundingScanObservation[] {
    const latest = this.latestScanSummary();
    if (!latest) return [];
    const rows = this.summaryObservations(latest);
    const seen = new Set<string>();
    return rows.filter((item) => !seen.has(item.asset) && Boolean(seen.add(item.asset)));
  }

  summary(): FundingResearchSummary {
    const dayAgo = new Date(this.now() - 24 * 60 * 60_000).toISOString();
    const scanRows = this.database.prepare(`SELECT * FROM funding_scan_summaries
      WHERE research_model_version = ? AND observed_at >= ? ORDER BY observed_at DESC`)
      .all(this.modelVersion, dayAgo) as FundingScanSummaryRow[];
    const lastScan = scanRows[0] ?? this.latestScanSummary();
    const scan24h = scanRows.reduce((total, row) => ({
      observations: total.observations + row.observations,
      liveEligible: total.liveEligible + row.live_eligible,
      researchEligible: total.researchEligible + row.research_eligible,
      rejected: total.rejected + row.rejected,
    }), { observations: 0, liveEligible: 0, researchEligible: 0, rejected: 0 });
    const reasonCounts = new Map<string, number>();
    for (const row of scanRows) {
      for (const [reason, count] of Object.entries(parseReasonCounts(row.rejection_reasons_json))) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + count);
      }
    }
    const rejectionReasons = [...reasonCounts].map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)).slice(0, 20);
    const latestObservations = !lastScan ? [] : this.summaryObservations(lastScan, 40)
      .map((item) => this.withHistoryStats(item, dayAgo));
    const positions = this.list(100);
    const ledger = this.database.prepare(`SELECT cohort, state, funding_pnl, entry_fees, exit_fees, total_pnl
      FROM funding_research_positions WHERE research_model_version = ?`).all(this.modelVersion) as Array<{ cohort: FundingResearchCohort; state: string; funding_pnl: string;
        entry_fees: string; exit_fees: string; total_pnl: string }>;
    const closed = ledger.filter((position) => position.state === 'CLOSED');
    const fees = ledger.reduce((total, position) => total.plus(position.entry_fees).plus(position.exit_fees), new Decimal(0));
    const cohorts = (['ONE_SETTLEMENT', 'ROLLING'] as const).map((cohort) => {
      const rows = ledger.filter((item) => item.cohort === cohort);
      const cohortClosed = rows.filter((item) => item.state === 'CLOSED');
      return { cohort, openCount: rows.filter((item) => item.state === 'OPEN').length,
        closedCount: cohortClosed.length,
        cumulativePnl: cohortClosed.reduce((total, item) => total.plus(item.total_pnl), new Decimal(0)).toString(),
        cumulativeFunding: rows.reduce((total, item) => total.plus(item.funding_pnl), new Decimal(0)).toString(),
        cumulativeFees: rows.reduce((total, item) => total.plus(item.entry_fees).plus(item.exit_fees), new Decimal(0)).toString() };
    });
    return {
      enabled: this.options.enabled, modelVersion: this.modelVersion,
      holdExitConfirmations: this.options.holdingExitConfirmationCount ?? 60,
      reversalExitConfirmations: this.options.reversalExitConfirmationCount ?? 30,
      reentryCooldownMs: this.options.reentryCooldownMs ?? 12 * 60 * 60_000,
      targetNotionalUsd: this.options.targetNotionalUsd,
      maxActualNotionalUsd: this.options.maxActualNotionalUsd ?? '10',
      maxOpenPositions: this.options.maxOpenPositions, minimumSettledEvents: this.options.minimumSettledEvents,
      lastScanAt: lastScan?.observed_at ?? null,
      scan24h,
      rejectionReasons, latestObservations,
      openCount: ledger.filter((position) => position.state === 'OPEN').length,
      closedCount: closed.length,
      cumulativePnl: closed.reduce((total, position) => total.plus(position.total_pnl), new Decimal(0)).toString(),
      cumulativeFunding: ledger.reduce((total, position) => total.plus(position.funding_pnl), new Decimal(0)).toString(),
      cumulativeFees: fees.toString(), positions, cohorts, variants: this.latestVariants(),
    };
  }

  private latestVariants(): FundingResearchVariant[] {
    const rows = this.database.prepare(`SELECT variants.*, observations.asset, observations.long_venue,
      observations.short_venue FROM funding_research_variants variants
      JOIN funding_scan_observations observations ON observations.id = variants.observation_id
      WHERE variants.research_model_version = ?
      ORDER BY variants.evaluated_at DESC LIMIT 60`).all(this.modelVersion) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), observationId: String(row.observation_id), evaluatedAt: String(row.evaluated_at),
      asset: String(row.asset), longVenue: String(row.long_venue), shortVenue: String(row.short_venue),
      variant: String(row.variant) as FundingResearchVariant['variant'],
      hedgeModel: String(row.hedge_model) as FundingResearchVariant['hedgeModel'],
      state: String(row.state) as FundingResearchVariant['state'],
      expectedNetPnl: row.expected_net_pnl === null ? null : String(row.expected_net_pnl),
      expectedNetAnnualized: row.expected_net_annualized === null ? null : String(row.expected_net_annualized),
      tradingFees: row.trading_fees === null ? null : String(row.trading_fees),
      fillProbability: row.fill_probability === null ? null : String(row.fill_probability),
      breakEvenHours: row.break_even_hours === null ? null : String(row.break_even_hours),
      reason: String(row.reason), details: JSON.parse(String(row.details_json)) as Record<string, unknown>,
      modelVersion: String(row.research_model_version),
    }));
  }

  private withHistoryStats(observation: FundingScanObservation, dayAgo: string): FundingScanObservation {
    const readDirection = (longVenue: string, shortVenue: string) => this.database.prepare(`
      SELECT observed_at, long_venue, short_venue, raw_funding_pnl
      FROM funding_scan_observations
      WHERE asset = ? AND long_venue = ? AND short_venue = ? AND observed_at >= ?
        AND cohort_clone = 0 AND data_valid = 1
      ORDER BY observed_at DESC LIMIT 750`).all(observation.asset, longVenue, shortVenue, dayAgo) as Array<{
        observed_at: string; long_venue: string; short_venue: string; raw_funding_pnl: string | null;
      }>;
    // 精确命中现有 pair-time 索引并限制返回量；旧 OR 查询会为前端每张卡片扫描整天原始明细。
    const directions = [
      ...readDirection(observation.longVenue, observation.shortVenue),
      ...readDirection(observation.shortVenue, observation.longVenue),
    ].sort((left, right) => right.observed_at.localeCompare(left.observed_at)).slice(0, 1_500);
    let flips = 0;
    let previous: string | null = null;
    let edgeStart = observation.observedAt;
    let edgeIsContinuous = true;
    const currentDirection = `${observation.longVenue}:${observation.shortVenue}`;
    for (const row of directions) {
      const direction = `${row.long_venue}:${row.short_venue}`;
      if (previous !== null && direction !== previous) flips += 1;
      previous = direction;
      if (!edgeIsContinuous) continue;
      if (direction === currentDirection && row.raw_funding_pnl !== null && new Decimal(row.raw_funding_pnl).gt(0)) {
        edgeStart = row.observed_at;
      } else {
        edgeIsContinuous = false;
      }
    }
    return { ...observation,
      edgeDurationMinutes: Math.max(0, Math.round((Date.parse(observation.observedAt) - Date.parse(edgeStart)) / 60_000)),
      directionFlips24h: flips,
      // 命中率来自交易所真实历史结算窗口，不再拿模拟到账结果冒充真实流水。
      settlementHitRate: observation.persistenceProbability ?? null,
      settlementSamples: observation.persistenceSamples ?? 0 };
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
        amountSource: String(item.amount_source ?? 'PREDICTED_SNAPSHOT'),
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
    const maxActualNotional = new Decimal(this.options.maxActualNotionalUsd ?? '10');
    const candidates = [...observations].filter((item) => item.researchEligible && item.quantity !== null
      && item.entryLongPrice !== null && item.entryShortPrice !== null && item.entryLongNotional !== null
      && item.entryShortNotional !== null && item.entryFees !== null && item.rawAnnualized !== null
      && item.netAnnualized !== null
      // 扫描器已检查一次，这里再做账本边界防御，配置错误也不能把 5U 目标放大成几十 U。
      && new Decimal(item.entryLongNotional).lte(maxActualNotional)
      && new Decimal(item.entryShortNotional).lte(maxActualNotional))
      .sort((left, right) => new Decimal(right.netAnnualized!).cmp(left.netAnnualized!));
    if (candidates.length === 0) return changed;
    await this.recordVariants(candidates[0]!, fees, observedAt);
    for (const cohort of ['ONE_SETTLEMENT', 'ROLLING'] as const) {
      let openCount = (this.database.prepare(`SELECT COUNT(*) AS count FROM funding_research_positions
        WHERE state = 'OPEN' AND cohort = ? AND research_model_version = ?`)
        .get(cohort, this.modelVersion) as { count: number }).count;
      for (const candidate of candidates) {
        if (openCount >= this.options.maxOpenPositions) break;
        const latestClosed: { reopen_after: string | null } | undefined = this.database.prepare(`SELECT reopen_after FROM funding_research_positions
          WHERE state = 'CLOSED' AND cohort = ? AND research_model_version = ? AND asset = ?
            AND long_venue = ? AND short_venue = ? ORDER BY closed_at DESC LIMIT 1`)
          .get(cohort, this.modelVersion, candidate.asset, candidate.longVenue, candidate.shortVenue) as
          { reopen_after: string | null } | undefined;
        if (latestClosed?.reopen_after && latestClosed.reopen_after > observedAt) continue;
        // observation_id 有唯一约束；滚动组复制同一快照，但同组同方向组合由数据库索引继续防重。
        const cohortObservation = cohort === 'ONE_SETTLEMENT'
          ? candidate : { ...candidate, id: randomUUID(), cohortClone: true };
        if (cohort === 'ROLLING') this.persistObservations([cohortObservation]);
        const openedId = this.open(cohortObservation, funding, observedAt, cohort);
        if (!openedId) continue;
        this.evaluate(openedId, funding, fees, observedAt);
        openCount += 1;
        changed += 1;
      }
    }
    return changed;
  }

  private persistObservations(observations: readonly FundingScanObservation[]): void {
    const statement = this.database.prepare(`INSERT OR IGNORE INTO funding_scan_observations
      (id, scan_id, observed_at, asset, long_venue, short_venue, quantity, status, strict_eligible,
       research_eligible, primary_reason, reasons_json, market_quality, long_rate, short_rate, long_events,
       short_events, entry_long_price, entry_short_price, exit_long_price, exit_short_price,
       entry_long_notional, entry_short_notional, raw_funding_pnl, conservative_funding_pnl,
       immediate_round_trip_pnl, entry_fees, exit_fees, trading_fees, stress_buffer, net_pnl,
       raw_annualized, net_annualized, break_even_hours, entry_slippage_bps, exit_slippage_bps, basis_bps,
       long_quote, short_quote, long_quote_to_usd, short_quote_to_usd, liquidity_usd, execution_support,
       cohort_clone, stablecoin_risk_buffer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const summaryStatement = this.database.prepare(`INSERT INTO funding_scan_summaries
      (scan_id, research_model_version, observed_at, observations, live_eligible, research_eligible,
       rejected, rejection_reasons_json, observation_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scan_id) DO UPDATE SET research_model_version = excluded.research_model_version,
        observed_at = excluded.observed_at, observations = excluded.observations,
        live_eligible = excluded.live_eligible, research_eligible = excluded.research_eligible,
        rejected = excluded.rejected, rejection_reasons_json = excluded.rejection_reasons_json,
        observation_ids_json = excluded.observation_ids_json`);
    const summaryGroups = new Map<string, FundingScanObservation[]>();
    for (const item of observations) {
      if (item.cohortClone || item.dataValid === false) continue;
      const group = summaryGroups.get(item.scanId) ?? [];
      group.push(item);
      summaryGroups.set(item.scanId, group);
    }
    this.database.transaction(() => {
      for (const item of observations) {
        statement.run(item.id, item.scanId, item.observedAt, item.asset,
        item.longVenue, item.shortVenue, item.quantity, item.status, item.strictEligible ? 1 : 0,
        item.researchEligible ? 1 : 0, item.primaryReason, JSON.stringify(item.reasons), item.marketQuality,
        item.longRate, item.shortRate, item.longEvents, item.shortEvents, item.entryLongPrice,
        item.entryShortPrice, item.exitLongPrice, item.exitShortPrice, item.entryLongNotional,
        item.entryShortNotional, item.rawFundingPnl, item.conservativeFundingPnl,
        item.immediateRoundTripPnl, item.entryFees, item.exitFees, item.tradingFees, item.stressBuffer,
        item.netPnl, item.rawAnnualized, item.netAnnualized, item.breakEvenHours,
        item.entrySlippageBps, item.exitSlippageBps, item.basisBps, item.longQuote, item.shortQuote,
        item.longQuoteToUsd, item.shortQuoteToUsd, item.liquidityUsd, item.executionSupport, item.cohortClone ? 1 : 0,
          item.stablecoinRiskBuffer);
        this.database.prepare(`UPDATE funding_scan_observations SET data_valid = ?, invalid_reason = ?,
          persistence_probability = ?, persistence_samples = ?, retention_factor_used = ?,
          historical_edge_p10 = ?, historical_edge_median = ?, requested_notional_usd = ?,
          research_model_version = ? WHERE id = ?`)
          .run(item.dataValid === false ? 0 : 1, item.invalidReason ?? null, item.persistenceProbability ?? null,
            item.persistenceSamples ?? 0, item.retentionFactorUsed ?? null, item.historicalEdgeP10 ?? null,
            item.historicalEdgeMedian ?? null, item.requestedNotionalUsd ?? null, this.modelVersion, item.id);
      }
      for (const [scanId, items] of summaryGroups) {
        const rejectionReasons: Record<string, number> = {};
        for (const item of items.filter((entry) => entry.status === 'REJECTED')) {
          rejectionReasons[item.primaryReason] = (rejectionReasons[item.primaryReason] ?? 0) + 1;
        }
        const rankedIds = rankedObservations(items).slice(0, 60).map((item) => item.id);
        summaryStatement.run(scanId, this.modelVersion, items[0]!.observedAt, items.length,
          items.filter((item) => item.strictEligible).length,
          items.filter((item) => item.researchEligible).length,
          items.filter((item) => item.status === 'REJECTED').length,
          JSON.stringify(rejectionReasons), JSON.stringify(rankedIds));
      }
    })();
  }

  private persistVariant(observation: FundingScanObservation, observedAt: string,
    values: Omit<FundingResearchVariant, 'id' | 'observationId' | 'evaluatedAt' | 'asset' | 'longVenue' | 'shortVenue'
      | 'modelVersion'>): void {
    this.database.prepare(`INSERT INTO funding_research_variants
      (id, observation_id, evaluated_at, variant, hedge_model, state, expected_net_pnl,
       expected_net_annualized, trading_fees, fill_probability, break_even_hours, reason, details_json,
       research_model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_id, variant) DO UPDATE SET evaluated_at = excluded.evaluated_at,
        state = excluded.state, expected_net_pnl = excluded.expected_net_pnl,
        expected_net_annualized = excluded.expected_net_annualized, trading_fees = excluded.trading_fees,
        fill_probability = excluded.fill_probability, break_even_hours = excluded.break_even_hours,
        reason = excluded.reason, details_json = excluded.details_json,
        research_model_version = excluded.research_model_version`)
      .run(randomUUID(), observation.id, observedAt, values.variant, values.hedgeModel, values.state,
        values.expectedNetPnl, values.expectedNetAnnualized, values.tradingFees, values.fillProbability,
        values.breakEvenHours, values.reason, JSON.stringify(values.details), this.modelVersion);
  }

  /**
   * 同一候选同时保存三种执行口径。Maker 和现货组合都是反事实研究，绝不会创建交易订单。
   */
  private async recordVariants(observation: FundingScanObservation, fees: readonly GateFeeRate[], observedAt: string): Promise<void> {
    if (!observation.netPnl || !observation.tradingFees || !observation.entryLongNotional
      || !observation.entryShortNotional || !observation.conservativeFundingPnl || !observation.quantity) return;
    const capital = new Decimal(observation.entryLongNotional).plus(observation.entryShortNotional).div(2);
    const horizonHours = this.options.horizonHours ?? 24;
    const annualized = (pnl: Decimal, basis: Decimal = capital) => pnl.div(basis).mul(8760).div(horizonHours);
    this.persistVariant(observation, observedAt, {
      variant: 'TAKER_TAKER', hedgeModel: 'PERP_PERP', state: 'PRICED',
      expectedNetPnl: observation.netPnl, expectedNetAnnualized: observation.netAnnualized,
      tradingFees: observation.tradingFees, fillProbability: '1', breakEvenHours: observation.breakEvenHours,
      reason: 'executable_taker_baseline', details: { cohortModels: ['ONE_SETTLEMENT', 'ROLLING'] },
    });

    const longSymbol = crossExFutureSymbol(observation.longVenue, observation.asset);
    const shortSymbol = crossExFutureSymbol(observation.shortVenue, observation.asset);
    const longMaker = makerFeeFor(fees, observation.longVenue, longSymbol);
    const shortMaker = makerFeeFor(fees, observation.shortVenue, shortSymbol);
    const longTaker = feeFor(fees, observation.longVenue, longSymbol);
    const shortTaker = feeFor(fees, observation.shortVenue, shortSymbol);
    if (longMaker && shortMaker && longTaker && shortTaker && observation.exitLongPrice && observation.exitShortPrice) {
      const quantity = new Decimal(observation.quantity);
      const longTurnover = new Decimal(observation.entryLongNotional).plus(quantity.mul(observation.exitLongPrice));
      const shortTurnover = new Decimal(observation.entryShortNotional).plus(quantity.mul(observation.exitShortPrice));
      const makerLongFees = longTurnover.mul(longMaker).plus(shortTurnover.mul(shortTaker));
      const makerShortFees = longTurnover.mul(longTaker).plus(shortTurnover.mul(shortMaker));
      const mixedFees = Decimal.min(makerLongFees, makerShortFees);
      const conditionalNet = new Decimal(observation.netPnl).plus(observation.tradingFees).minus(mixedFees);
      const fillProbability = new Decimal(this.options.makerFillProbability ?? '0.35');
      const failedHedgePenalty = capital.mul(this.options.makerLegRiskBps ?? '5').div(10_000);
      const expectedNet = conditionalNet.mul(fillProbability)
        .minus(failedHedgePenalty.mul(new Decimal(1).minus(fillProbability)));
      const friction = mixedFees.plus(failedHedgePenalty).minus(new Decimal(observation.immediateRoundTripPnl ?? '0'));
      const breakEven = new Decimal(observation.conservativeFundingPnl).gt(0)
        ? Decimal.max(0, friction).mul(horizonHours).div(observation.conservativeFundingPnl) : null;
      this.persistVariant(observation, observedAt, {
        variant: 'MAKER_TAKER', hedgeModel: 'PERP_PERP', state: 'PRICED',
        expectedNetPnl: expectedNet.toString(), expectedNetAnnualized: annualized(expectedNet).toString(),
        tradingFees: mixedFees.toString(), fillProbability: fillProbability.toString(),
        breakEvenHours: breakEven?.toString() ?? null, reason: 'counterfactual_fill_adjusted',
        details: { conditionalNetPnl: conditionalNet.toString(), failedHedgePenalty: failedHedgePenalty.toString(),
          makerLeg: makerLongFees.lte(makerShortFees) ? 'LONG' : 'SHORT' },
      });
    } else {
      this.persistVariant(observation, observedAt, { variant: 'MAKER_TAKER', hedgeModel: 'PERP_PERP', state: 'UNAVAILABLE',
        expectedNetPnl: null, expectedNetAnnualized: null, tradingFees: null, fillProbability: null,
        breakEvenHours: null, reason: 'maker_fee_missing', details: {} });
    }

    await this.recordSpotPerpVariant(observation, fees, observedAt, capital, horizonHours);
  }

  private async recordSpotPerpVariant(observation: FundingScanObservation, fees: readonly GateFeeRate[],
    observedAt: string, fallbackCapital: Decimal, horizonHours: number): Promise<void> {
    const unavailable = (reason: string, details: Record<string, unknown> = {}) => this.persistVariant(observation, observedAt, {
      variant: 'SPOT_PERP', hedgeModel: 'SPOT_PERP', state: 'UNAVAILABLE', expectedNetPnl: null,
      expectedNetAnnualized: null, tradingFees: null, fillProbability: null, breakEvenHours: null, reason, details,
    });
    if (!this.options.spotMarket || !new Decimal(observation.shortRate).gt(0)
      || !['GATE', 'BINANCE', 'OKX'].includes(observation.shortVenue)) {
      unavailable('spot_perp_not_supported_for_candidate');
      return;
    }
    try {
      const spot = await this.options.spotMarket.query(observation.shortVenue, observation.asset);
      const quantity = new Decimal(observation.quantity!);
      if (new Decimal(spot.askSize).lt(quantity) || new Decimal(spot.bidSize).lt(quantity)) {
        unavailable('spot_bbo_depth_insufficient', { availableBuy: spot.askSize, availableSell: spot.bidSize });
        return;
      }
      const feeRow = fees.find((item) => item.exchange_type === observation.shortVenue);
      const futureSymbol = crossExFutureSymbol(observation.shortVenue, observation.asset);
      const futureFee = feeFor(fees, observation.shortVenue, futureSymbol);
      if (!feeRow || !futureFee || !observation.entryShortPrice || !observation.exitShortPrice
        || !observation.entryShortNotional) {
        unavailable('spot_perp_fee_or_price_missing');
        return;
      }
      const spotFee = new Decimal(feeRow.spot_taker_fee);
      const spotEntry = quantity.mul(spot.askPrice);
      const spotExit = quantity.mul(spot.bidPrice);
      const futureEntry = new Decimal(observation.entryShortNotional);
      const futureExit = quantity.mul(observation.exitShortPrice);
      const pricePnl = spotExit.minus(spotEntry).plus(futureEntry).minus(futureExit);
      const funding = futureEntry.mul(observation.shortRate).mul(observation.shortEvents)
        .mul(observation.retentionFactorUsed ?? this.options.fundingRetentionFactor ?? '0.5');
      const tradingFees = spotEntry.plus(spotExit).mul(spotFee).plus(futureEntry.plus(futureExit).mul(futureFee));
      const capital = Decimal.max(spotEntry, fallbackCapital);
      const risk = capital.mul(new Decimal(this.options.stressSlippageBps ?? '5')
        .plus(this.options.adverseExitBasisBps ?? '10')).div(10_000);
      const net = funding.plus(pricePnl).minus(tradingFees).minus(risk);
      const friction = tradingFees.plus(risk).minus(pricePnl);
      const breakEven = funding.gt(0) ? Decimal.max(0, friction).mul(horizonHours).div(funding) : null;
      this.persistVariant(observation, observedAt, {
        variant: 'SPOT_PERP', hedgeModel: 'SPOT_PERP', state: 'PRICED', expectedNetPnl: net.toString(),
        expectedNetAnnualized: net.div(capital).mul(8760).div(horizonHours).toString(), tradingFees: tradingFees.toString(),
        fillProbability: '1', breakEvenHours: breakEven?.toString() ?? null, reason: 'same_venue_cash_and_carry',
        details: { venue: observation.shortVenue, spotEntry: spot.askPrice, spotExit: spot.bidPrice,
          perpEntry: observation.entryShortPrice, perpExit: observation.exitShortPrice,
          fundingPnl: funding.toString(), pricePnl: pricePnl.toString(), riskBuffer: risk.toString() },
      });
    } catch (error) {
      unavailable('spot_book_unavailable', { error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  private open(observation: FundingScanObservation, funding: readonly GateFundingInfo[], observedAt: string,
    cohort: FundingResearchCohort): string | null {
    const id = randomUUID();
    try {
      this.database.prepare(`INSERT INTO funding_research_positions
        (id, observation_id, asset, long_venue, short_venue, quantity, target_notional_usd, state,
         monitor_state, entry_raw_annualized, entry_net_annualized, entry_long_price, entry_short_price,
         entry_long_notional, entry_short_notional, entry_fees, entry_slippage_bps, opened_at, created_at, updated_at,
         cohort, long_quote, short_quote, research_model_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, observation.id, observation.asset, observation.longVenue, observation.shortVenue,
          observation.quantity, this.options.targetNotionalUsd, observation.rawAnnualized,
          observation.netAnnualized, observation.entryLongPrice, observation.entryShortPrice,
          observation.entryLongNotional, observation.entryShortNotional, observation.entryFees,
          observation.entrySlippageBps, observedAt, observedAt, observedAt, cohort,
          observation.longQuote, observation.shortQuote, this.modelVersion);
      this.refreshSettlements(id, observation.asset, observation.longVenue, observation.shortVenue,
        new Decimal(observation.entryLongNotional!), new Decimal(observation.entryShortNotional!), funding, observedAt);
      return id;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code.startsWith('SQLITE_CONSTRAINT')) return null;
      throw error;
    }
  }

  private evaluate(id: string, funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[], observedAt: string): void {
    const position = this.database.prepare("SELECT * FROM funding_research_positions WHERE id = ? AND state = 'OPEN'")
      .get(id) as ResearchPositionRow | undefined;
    if (!position) return;
    const longSymbol = crossExFutureSymbol(position.long_venue, position.asset);
    const shortSymbol = crossExFutureSymbol(position.short_venue, position.asset);
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
    const longBids = usdLevels(pair.longBook, pair.longBook.bids);
    const shortAsks = usdLevels(pair.shortBook, pair.shortBook.asks);
    if (!longBids || !shortAsks) { this.unavailable(position, observedAt, 'quote_fx_unavailable'); return; }
    const longExit = depthFill(longBids, position.quantity, 'SELL');
    const shortExit = depthFill(shortAsks, position.quantity, 'BUY');
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
    const settledLegs = (this.database.prepare(`SELECT COUNT(DISTINCT symbol) AS count FROM funding_research_settlements
      WHERE position_id = ? AND state = 'SETTLED'`).get(position.id) as { count: number }).count;
    const nextSettlement = this.database.prepare(`SELECT MIN(funding_time) AS next FROM funding_research_settlements
      WHERE position_id = ? AND state = 'PENDING'`).get(position.id) as { next: string | null };
    const nextPairSettlement = this.database.prepare(`SELECT MAX(first_funding_time) AS next FROM (
      SELECT MIN(funding_time) AS first_funding_time FROM funding_research_settlements
      WHERE position_id = ? AND state = 'PENDING' GROUP BY symbol
    )`).get(position.id) as { next: string | null };
    let decision: string;
    let reason: string;
    let unprofitableCount = position.unprofitable_count;
    let reversalCount = position.reversal_count;
    let holdingDetails: Record<string, unknown> = {};
    if (position.cohort === 'ONE_SETTLEMENT') {
      // “一次结算”必须两条腿都真正跨过结算点，不能一所先结算就把另一条待验证事件取消。
      const shouldExit = settledLegs === 2 && settledEvents >= this.options.minimumSettledEvents * 2;
      decision = shouldExit ? 'EXIT' : 'HOLD';
      reason = shouldExit ? 'research_minimum_settlement_completed' : 'research_waiting_first_settlement';
    } else {
      try {
        const holding = evaluateFundingHolding({
          nowMs: Date.parse(observedAt),
          long: { symbol: longSymbol, venue: position.long_venue, side: 'LONG',
            fundingRate: longFunding.funding_rate, fundingTime: longFunding.funding_time,
            fundingInterval: longFunding.funding_interval, notionalUsd: position.entry_long_notional },
          short: { symbol: shortSymbol, venue: position.short_venue, side: 'SHORT',
            fundingRate: shortFunding.funding_rate, fundingTime: shortFunding.funding_time,
            fundingInterval: shortFunding.funding_interval, notionalUsd: position.entry_short_notional },
          eventsPerLeg: this.options.holdingEventsPerLeg ?? 2,
          fundingRetentionFactor: this.options.fundingRetentionFactor ?? '0.5',
          stressSlippageBps: this.options.stressSlippageBps ?? '5',
          adverseExitBasisBps: new Decimal(this.options.adverseExitBasisBps ?? '10')
            .plus(position.long_quote === position.short_quote ? 0 : this.options.stablecoinRiskBps ?? '5').toString(),
          minimumHoldValueUsd: this.options.minimumHoldValueUsd ?? '0',
          previousUnprofitableCount: position.unprofitable_count,
          unprofitableConfirmationCount: this.options.holdingExitConfirmationCount ?? 60,
          previousReversalCount: position.reversal_count,
          reversalConfirmationCount: this.options.reversalExitConfirmationCount ?? 30,
          settlementGuardMs: this.options.settlementGuardMs ?? 30_000,
          openedAtMs: Date.parse(position.opened_at),
          softReviewMs: this.options.rollingSoftReviewMs ?? 3 * 24 * 60 * 60_000,
          hardHoldingMs: this.options.rollingHardHoldingMs ?? 7 * 24 * 60 * 60_000,
        });
        decision = holding.decision;
        reason = holding.reason;
        unprofitableCount = holding.unprofitableCount;
        reversalCount = holding.reversalCount;
        if (settledLegs < 2 && (reason === 'hold_value_not_positive' || reason === 'hold_value_confirmation_pending')) {
          // 第一次双腿结算前不累计普通收益退出计数；否则一到账就会带着历史计数立即平仓，无法验证长持表现。
          decision = 'EXIT_PENDING';
          reason = 'research_waiting_first_settlement';
          unprofitableCount = 0;
        }
        holdingDetails = { rawHoldingFunding: holding.rawFunding,
          conservativeHoldingFunding: holding.conservativeFunding, holdRiskBuffer: holding.riskBuffer,
          holdValue: holding.holdValue, fundingEdge: holding.fundingEdge,
          inSettlementGuard: holding.inSettlementGuard,
          unprofitableCount,
          unprofitableRequired: this.options.holdingExitConfirmationCount ?? 60,
          reversalCount,
          reversalRequired: this.options.reversalExitConfirmationCount ?? 30 };
      } catch {
        this.unavailable(position, observedAt, 'funding_schedule_unavailable');
        return;
      }
    }
    this.persistEvaluation(position.id, observedAt, decision, reason, pair.quality, {
      currentExitPnl: totalPnl.toString(), pricePnl: pricePnl.toString(), fundingPnl: fundingPnl.toString(),
      exitFees: exitFees.toString(), basisBps: basisBps.toString(), exitSlippageBps: exitSlippageBps.toString(),
      settledEvents, nextSettlementAt: nextSettlement.next,
      details: { exchangeSkewMs: pair.exchangeSkewMs, receiveSkewMs: pair.receiveSkewMs,
        longRate: longFunding.funding_rate, shortRate: shortFunding.funding_rate, cohort: position.cohort,
        ...holdingDetails },
    });
    this.database.prepare(`UPDATE funding_research_positions SET monitor_state = ?, current_exit_pnl = ?,
      price_pnl = ?, exit_fees = ?, current_basis_bps = ?, exit_slippage_bps = ?, settled_events = ?,
      data_failure_count = 0, next_settlement_at = ?, last_reason = ?, unprofitable_count = ?, reversal_count = ?,
      last_evaluated_at = ?, updated_at = ?
      WHERE id = ?`).run(decision, totalPnl.toString(), pricePnl.toString(), exitFees.toString(),
      basisBps.toString(), exitSlippageBps.toString(), settledEvents, nextSettlement.next, reason, unprofitableCount, reversalCount,
      observedAt, observedAt, position.id);
    if (decision === 'EXIT') this.close(position, observedAt, reason, longExit.average, shortExit.average,
      exitFees, pricePnl, totalPnl, settledEvents, nextPairSettlement.next);
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
        const marketSymbol = crossExFutureSymbol(leg.venue, asset);
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
    totalPnl: Decimal, settledEvents: number, nextSettlementAt: string | null): void {
    // 关闭后至少冷却到下一次结算，避免同一负收益快照一分钟后再次开仓烧手续费。
    const cooldown = new Date(Date.parse(observedAt) + (this.options.reentryCooldownMs ?? 12 * 60 * 60_000)).toISOString();
    const reopenAfter = nextSettlementAt && nextSettlementAt > cooldown ? nextSettlementAt : cooldown;
    this.database.transaction(() => {
      this.database.prepare(`UPDATE funding_research_positions SET state = 'CLOSED', monitor_state = 'EXIT',
        exit_long_price = ?, exit_short_price = ?, exit_fees = ?, price_pnl = ?, total_pnl = ?,
        current_exit_pnl = ?, settled_events = ?, last_reason = ?, reopen_after = ?, closed_at = ?, last_evaluated_at = ?, updated_at = ?
        WHERE id = ? AND state = 'OPEN'`).run(longExitPrice.toString(), shortExitPrice.toString(),
        exitFees.toString(), pricePnl.toString(), totalPnl.toString(), totalPnl.toString(), settledEvents,
        reason, reopenAfter, observedAt, observedAt, observedAt, position.id);
      this.database.prepare(`UPDATE funding_research_settlements SET state = 'CANCELLED', updated_at = ?
        WHERE position_id = ? AND state = 'PENDING'`).run(observedAt, position.id);
    })();
  }
}
