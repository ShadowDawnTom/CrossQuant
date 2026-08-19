import { describe, expect, it } from 'vitest';
import { evaluateFundingHolding, type FundingHoldingModelInput } from './funding-holding-model.js';

const now = Date.parse('2026-08-14T00:00:00.000Z');

function input(overrides: Partial<FundingHoldingModelInput> = {}): FundingHoldingModelInput {
  return {
    nowMs: now,
    long: { symbol: 'GATE_FUTURE_SOL_USDT', venue: 'GATE', side: 'LONG', fundingRate: '-0.0002',
      fundingTime: String(now + 4 * 60 * 60_000), fundingInterval: '14400', notionalUsd: '10' },
    short: { symbol: 'BYBIT_FUTURE_SOL_USDT', venue: 'BYBIT', side: 'SHORT', fundingRate: '0.0004',
      fundingTime: String(now + 8 * 60 * 60_000), fundingInterval: '28800', notionalUsd: '10' },
    eventsPerLeg: 2,
    fundingRetentionFactor: '0.5',
    stressSlippageBps: '1',
    adverseExitBasisBps: '1',
    minimumHoldValueUsd: '0',
    previousUnprofitableCount: 0,
    unprofitableConfirmationCount: 3,
    previousReversalCount: 0,
    reversalConfirmationCount: 15,
    settlementGuardMs: 30_000,
    openedAtMs: now - 60_000,
    softReviewMs: 72 * 60 * 60_000,
    hardHoldingMs: 7 * 24 * 60 * 60_000,
    ...overrides,
  };
}

describe('evaluateFundingHolding', () => {
  it('按两边真实结算时点逐事件计算，并只折扣正向资金费收入', () => {
    const result = evaluateFundingHolding(input());
    expect(result.events.map((event) => event.fundingTime)).toEqual([
      '2026-08-14T04:00:00.000Z', '2026-08-14T08:00:00.000Z',
      '2026-08-14T08:00:00.000Z', '2026-08-14T16:00:00.000Z',
    ]);
    expect(result.rawFunding).toBe('0.012');
    expect(result.conservativeFunding).toBe('0.006');
    expect(result.riskBuffer).toBe('0.002');
    expect(result.holdValue).toBe('0.004');
    expect(result.decision).toBe('HOLD');
  });

  it('边际价值连续三次不足才触发普通退出', () => {
    const first = evaluateFundingHolding(input({ stressSlippageBps: '5', adverseExitBasisBps: '5' }));
    expect(first).toMatchObject({ decision: 'EXIT_PENDING', unprofitableCount: 1 });
    const third = evaluateFundingHolding(input({ stressSlippageBps: '5', adverseExitBasisBps: '5', previousUnprofitableCount: 2 }));
    expect(third).toMatchObject({ decision: 'EXIT', reason: 'hold_value_not_positive', unprofitableCount: 3 });
  });

  it('资金费总方向反转必须经过独立的连续确认，恢复后清零', () => {
    const first = evaluateFundingHolding(input({
      long: { ...input().long, fundingRate: '0.0005', fundingTime: String(now + 10_000) },
      short: { ...input().short, fundingRate: '0.0001', fundingTime: String(now + 10_000) },
    }));
    expect(first).toMatchObject({ decision: 'EXIT_PENDING', reason: 'funding_reversal_confirmation_pending',
      reversalCount: 1, unprofitableCount: 0 });
    const confirmed = evaluateFundingHolding(input({
      long: { ...input().long, fundingRate: '0.0005', fundingTime: String(now + 10_000) },
      short: { ...input().short, fundingRate: '0.0001', fundingTime: String(now + 10_000) },
      previousReversalCount: 14,
    }));
    expect(confirmed).toMatchObject({ decision: 'EXIT', reason: 'funding_direction_reversed', reversalCount: 15 });
    expect(evaluateFundingHolding(input({ previousReversalCount: 8 }))).toMatchObject({ decision: 'HOLD', reversalCount: 0 });
  });

  it('结算保护窗口内不执行普通收益退出', () => {
    const result = evaluateFundingHolding(input({
      long: { ...input().long, fundingTime: String(now + 10_000), fundingRate: '0.001' },
      short: { ...input().short, fundingTime: String(now + 10_000), fundingRate: '0.0011' },
    }));
    expect(result).toMatchObject({ decision: 'SETTLEMENT_GUARD', inSettlementGuard: true });
  });

  it('软上限只提醒，硬上限才要求退出', () => {
    expect(evaluateFundingHolding(input({ openedAtMs: now - 73 * 60 * 60_000 })).decision).toBe('REVIEW_REQUIRED');
    expect(evaluateFundingHolding(input({ openedAtMs: now - 8 * 24 * 60 * 60_000 })))
      .toMatchObject({ decision: 'EXIT', reason: 'hard_holding_limit' });
  });
});
