import { Decimal } from 'decimal.js';

export type FundingHoldingDecision =
  | 'HOLD'
  | 'REVIEW_REQUIRED'
  | 'SETTLEMENT_GUARD'
  | 'EXIT_PENDING'
  | 'EXIT';

export interface FundingHoldingLeg {
  symbol: string;
  venue: string;
  side: 'LONG' | 'SHORT';
  fundingRate: string;
  fundingTime: string;
  fundingInterval: string;
  notionalUsd: string;
}

export interface FundingSettlementEvent {
  symbol: string;
  venue: string;
  side: 'LONG' | 'SHORT';
  fundingTime: string;
  fundingRate: string;
  expectedAmount: string;
  conservativeAmount: string;
}

export interface FundingHoldingModelInput {
  nowMs: number;
  long: FundingHoldingLeg;
  short: FundingHoldingLeg;
  eventsPerLeg: number;
  fundingRetentionFactor: string;
  stressSlippageBps: string;
  adverseExitBasisBps: string;
  minimumHoldValueUsd: string;
  previousUnprofitableCount: number;
  unprofitableConfirmationCount: number;
  previousReversalCount?: number;
  reversalConfirmationCount?: number;
  settlementGuardMs: number;
  openedAtMs: number;
  softReviewMs: number;
  hardHoldingMs: number;
}

export interface FundingHoldingModelResult {
  decision: FundingHoldingDecision;
  reason: string;
  events: FundingSettlementEvent[];
  nextSettlementAt: string | null;
  rawFunding: string;
  conservativeFunding: string;
  riskBuffer: string;
  holdValue: string;
  fundingEdge: string;
  unprofitableCount: number;
  reversalCount: number;
  inSettlementGuard: boolean;
}

function nextFundingTimes(leg: FundingHoldingLeg, nowMs: number, count: number): number[] {
  const intervalMs = Number(leg.fundingInterval) * 1_000;
  let next = Number(leg.fundingTime);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(next) || next <= 0) return [];
  if (next < nowMs) next += (Math.floor((nowMs - next) / intervalMs) + 1) * intervalMs;
  return Array.from({ length: Math.max(1, count) }, (_unused, index) => next + intervalMs * index);
}

function eventsForLeg(
  leg: FundingHoldingLeg,
  nowMs: number,
  count: number,
  retention: Decimal,
): FundingSettlementEvent[] {
  const direction = leg.side === 'LONG' ? new Decimal(-1) : new Decimal(1);
  const rawAmount = new Decimal(leg.notionalUsd).mul(leg.fundingRate).mul(direction);
  const conservativeAmount = rawAmount.gt(0) ? rawAmount.mul(retention) : rawAmount;
  return nextFundingTimes(leg, nowMs, count).map((fundingTime) => ({
    symbol: leg.symbol,
    venue: leg.venue,
    side: leg.side,
    fundingTime: new Date(fundingTime).toISOString(),
    fundingRate: leg.fundingRate,
    expectedAmount: rawAmount.toString(),
    conservativeAmount: conservativeAmount.toString(),
  }));
}

/**
 * 只计算“继续持有”的边际价值。开仓手续费是沉没成本，不在每轮重复扣除；
 * 当前立即平仓 PnL 由执行层单独计算并展示。
 */
export function evaluateFundingHolding(input: FundingHoldingModelInput): FundingHoldingModelResult {
  // 实盘和旧调用方未传新参数时仍保持“一次确认即退出”，避免这次模拟实验暗改实盘语义。
  const previousReversalCount = input.previousReversalCount ?? 0;
  const reversalConfirmationCount = input.reversalConfirmationCount ?? 1;
  const retention = new Decimal(input.fundingRetentionFactor);
  const events = [
    ...eventsForLeg(input.long, input.nowMs, input.eventsPerLeg, retention),
    ...eventsForLeg(input.short, input.nowMs, input.eventsPerLeg, retention),
  ].sort((left, right) => Date.parse(left.fundingTime) - Date.parse(right.fundingTime));
  if (events.length === 0) throw new Error('funding_schedule_unavailable');

  const rawFunding = events.reduce((sum, event) => sum.plus(event.expectedAmount), new Decimal(0));
  const conservativeFunding = events.reduce((sum, event) => sum.plus(event.conservativeAmount), new Decimal(0));
  const capital = new Decimal(input.long.notionalUsd).plus(input.short.notionalUsd).div(2);
  if (!capital.gt(0)) throw new Error('funding_notional_invalid');
  const riskBuffer = capital.mul(new Decimal(input.stressSlippageBps)
    .plus(input.adverseExitBasisBps)).div(10_000);
  const holdValue = conservativeFunding.minus(riskBuffer);
  const fundingEdge = rawFunding.div(capital);
  const minimum = new Decimal(input.minimumHoldValueUsd);
  const nextSettlementAt = events[0]?.fundingTime ?? null;
  const inSettlementGuard = events.some((event) => Math.abs(Date.parse(event.fundingTime) - input.nowMs) <= input.settlementGuardMs);
  const hardExpired = input.nowMs - input.openedAtMs >= input.hardHoldingMs;
  const softExpired = input.nowMs - input.openedAtMs >= input.softReviewMs;

  if (hardExpired) {
    return { decision: 'EXIT', reason: 'hard_holding_limit', events, nextSettlementAt, rawFunding: rawFunding.toString(),
      conservativeFunding: conservativeFunding.toString(), riskBuffer: riskBuffer.toString(), holdValue: holdValue.toString(),
      fundingEdge: fundingEdge.toString(), unprofitableCount: input.previousUnprofitableCount,
      reversalCount: previousReversalCount, inSettlementGuard };
  }
  if (rawFunding.lte(0)) {
    const reversalCount = previousReversalCount + 1;
    const confirmed = reversalCount >= reversalConfirmationCount;
    return { decision: confirmed ? 'EXIT' : 'EXIT_PENDING',
      reason: confirmed ? 'funding_direction_reversed' : 'funding_reversal_confirmation_pending', events, nextSettlementAt,
      rawFunding: rawFunding.toString(), conservativeFunding: conservativeFunding.toString(), riskBuffer: riskBuffer.toString(),
      holdValue: holdValue.toString(), fundingEdge: fundingEdge.toString(), unprofitableCount: 0,
      reversalCount, inSettlementGuard };
  }
  if (inSettlementGuard) {
    return { decision: 'SETTLEMENT_GUARD', reason: 'settlement_guard_active', events, nextSettlementAt,
      rawFunding: rawFunding.toString(), conservativeFunding: conservativeFunding.toString(), riskBuffer: riskBuffer.toString(),
      holdValue: holdValue.toString(), fundingEdge: fundingEdge.toString(),
      unprofitableCount: input.previousUnprofitableCount, reversalCount: 0, inSettlementGuard };
  }

  const unprofitable = holdValue.lte(minimum);
  const unprofitableCount = unprofitable ? input.previousUnprofitableCount + 1 : 0;
  if (unprofitableCount >= input.unprofitableConfirmationCount) {
    return { decision: 'EXIT', reason: 'hold_value_not_positive', events, nextSettlementAt,
      rawFunding: rawFunding.toString(), conservativeFunding: conservativeFunding.toString(), riskBuffer: riskBuffer.toString(),
      holdValue: holdValue.toString(), fundingEdge: fundingEdge.toString(), unprofitableCount,
      reversalCount: 0, inSettlementGuard };
  }
  if (unprofitable) {
    return { decision: 'EXIT_PENDING', reason: 'hold_value_confirmation_pending', events, nextSettlementAt,
      rawFunding: rawFunding.toString(), conservativeFunding: conservativeFunding.toString(), riskBuffer: riskBuffer.toString(),
      holdValue: holdValue.toString(), fundingEdge: fundingEdge.toString(), unprofitableCount,
      reversalCount: 0, inSettlementGuard };
  }
  return { decision: softExpired ? 'REVIEW_REQUIRED' : 'HOLD', reason: softExpired ? 'soft_review_due' : 'hold_value_positive',
    events, nextSettlementAt, rawFunding: rawFunding.toString(), conservativeFunding: conservativeFunding.toString(),
    riskBuffer: riskBuffer.toString(), holdValue: holdValue.toString(), fundingEdge: fundingEdge.toString(),
    unprofitableCount, reversalCount: 0, inSettlementGuard };
}
