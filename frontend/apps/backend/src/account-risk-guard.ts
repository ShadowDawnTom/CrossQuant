import { Decimal } from 'decimal.js';
import type { LivePortfolioSnapshot } from './live-portfolio.js';

export interface AccountRiskLimits {
  maxGrossExposureUsd: string;
  minAvailableMarginRatio: string;
  maxDailyLossUsd: string;
  maxPortfolioAgeMs: number;
  maxAdlRank: number | null;
}

export interface AccountRiskContext {
  portfolio: LivePortfolioSnapshot | null;
  dailyRealizedPnlUsd: string;
  dailyPnlComplete: boolean;
  adlRanks?: ReadonlyMap<string, number>;
  nowMs: number;
  requirePrivateStream: boolean;
  /** 即将新增的两腿名义敞口；入场前必须和现有仓位一起检查。 */
  plannedGrossExposureUsd?: string;
}

export type AccountRiskDecision = { safe: true } | { safe: false; code: string; reason: string };

/**
 * 统一评估账户级风险。任何核心数据缺失都按不安全处理，避免断线时继续下单。
 */
export function evaluateAccountRisk(context: AccountRiskContext, limits: AccountRiskLimits): AccountRiskDecision {
  const { portfolio } = context;
  if (!portfolio) return { safe: false, code: 'portfolio_missing', reason: 'No authenticated portfolio snapshot is available' };
  const fetchedAt = Date.parse(portfolio.snapshot.fetchedAt);
  const age = context.nowMs - fetchedAt;
  if (!Number.isFinite(fetchedAt) || age < -2_000 || age > limits.maxPortfolioAgeMs) {
    return { safe: false, code: 'portfolio_stale', reason: `Portfolio snapshot age is ${age}ms` };
  }
  if (portfolio.remoteStatus !== 'healthy') {
    return { safe: false, code: 'portfolio_remote_unavailable', reason: 'Authenticated portfolio reconciliation is unavailable' };
  }
  if (context.requirePrivateStream && portfolio.live.stream.state !== 'live') {
    return { safe: false, code: 'private_stream_unavailable', reason: `Private stream state is ${portfolio.live.stream.state}` };
  }
  if (!context.dailyPnlComplete) {
    return { safe: false, code: 'daily_pnl_history_incomplete', reason: 'The authenticated trade page does not cover the full UTC day' };
  }

  try {
    const marginBalance = new Decimal(portfolio.snapshot.account.marginBalance);
    const availableMargin = new Decimal(portfolio.snapshot.account.availableMargin);
  if (!marginBalance.isFinite() || !availableMargin.isFinite() || !marginBalance.gt(0)) {
    return { safe: false, code: 'invalid_margin_data', reason: 'Margin balance or available margin is invalid' };
  }
  const availableRatio = availableMargin.div(marginBalance);
  if (availableRatio.lt(limits.minAvailableMarginRatio)) {
    return { safe: false, code: 'available_margin_low', reason: `Available margin ratio ${availableRatio.toString()} is below ${limits.minAvailableMarginRatio}` };
  }

  const grossExposure = portfolio.snapshot.futuresPositions
    .reduce((sum, position) => sum.plus(new Decimal(position.value).abs()), new Decimal(0));
  const projectedGrossExposure = grossExposure.plus(new Decimal(context.plannedGrossExposureUsd ?? '0'));
  if (!projectedGrossExposure.isFinite() || projectedGrossExposure.gt(limits.maxGrossExposureUsd)) {
    return { safe: false, code: 'gross_exposure_exceeded', reason: `Projected gross futures exposure is ${projectedGrossExposure.toString()} USD` };
  }

  const unrealizedPnl = portfolio.snapshot.balances
    .reduce((sum, balance) => sum.plus(new Decimal(balance.unrealizedPnl)), new Decimal(0));
  const dailyPnl = new Decimal(context.dailyRealizedPnlUsd).plus(unrealizedPnl);
  if (!dailyPnl.isFinite()) return { safe: false, code: 'invalid_pnl_data', reason: 'Daily PnL data is invalid' };
  if (dailyPnl.lt(new Decimal(limits.maxDailyLossUsd).neg())) {
    return { safe: false, code: 'daily_loss_exceeded', reason: `Daily PnL is ${dailyPnl.toString()} USD` };
  }

  if (limits.maxAdlRank !== null) {
    for (const position of portfolio.snapshot.futuresPositions.filter((item) => !new Decimal(item.quantity).isZero())) {
      const rank = context.adlRanks?.get(position.symbol);
      if (rank === undefined) return { safe: false, code: 'adl_rank_missing', reason: `ADL rank is missing for ${position.symbol}` };
      if (rank > limits.maxAdlRank) {
        return { safe: false, code: 'adl_rank_exceeded', reason: `${position.symbol} ADL rank ${rank} exceeds ${limits.maxAdlRank}` };
      }
    }
  }
    return { safe: true };
  } catch (error) {
    return {
      safe: false,
      code: 'invalid_risk_data',
      reason: error instanceof Error ? error.message.slice(0, 160) : 'Risk data could not be parsed',
    };
  }
}
