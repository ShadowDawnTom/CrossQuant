import { describe, expect, it } from 'vitest';
import type { LivePortfolioSnapshot } from './live-portfolio.js';
import { evaluateAccountRisk, type AccountRiskLimits } from './account-risk-guard.js';

const now = Date.parse('2026-08-08T00:01:00.000Z');
const limits: AccountRiskLimits = {
  maxGrossExposureUsd: '10000',
  minAvailableMarginRatio: '0.25',
  maxDailyLossUsd: '200',
  maxPortfolioAgeMs: 360_000,
  maxAdlRank: null,
};

function portfolio(overrides: {
  availableMargin?: string;
  marginBalance?: string;
  value?: string;
  unrealizedPnl?: string;
  fetchedAt?: string;
  streamState?: 'live' | 'connecting' | 'reconnecting' | 'disconnected';
} = {}): LivePortfolioSnapshot {
  return {
    snapshot: {
      account: {
        availableMargin: overrides.availableMargin ?? '800', marginBalance: overrides.marginBalance ?? '1000',
        initialMargin: '200', maintenanceMargin: '50', initialMarginRate: '0.2', maintenanceMarginRate: '0.05',
        positionMode: 'SINGLE', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: new Date(now).toISOString(),
      },
      balances: [{
        venue: 'GATE', coin: 'USDT', balance: '1000', unrealizedPnl: overrides.unrealizedPnl ?? '0', equity: '1000',
        futuresInitialMargin: '200', futuresMaintenanceMargin: '50', borrowingInitialMargin: '0',
        borrowingMaintenanceMargin: '0', availableBalance: '800', liability: '0',
      }],
      futuresPositions: overrides.value === undefined ? [] : [{
        positionId: 'p1', symbol: 'GATE_FUTURE_BTC_USDT', positionSide: 'LONG', initialMargin: '100',
        maintenanceMargin: '20', quantity: '0.1', value: overrides.value, unrealizedPnl: '0', unrealizedPnlRate: '0',
        entryPrice: '100000', markPrice: '100000', leverage: '2', maxLeverage: '25', riskLimit: '100000',
        fee: '0', fundingFee: '0', fundingTime: '0', createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(), realizedPnl: '0',
      }],
      marginPositions: [], openOrders: [], recentFills: [],
      fetchedAt: overrides.fetchedAt ?? new Date(now - 1_000).toISOString(), source: 'gate_crossex_authenticated_rest',
    },
    dataStatus: 'fresh', remoteStatus: 'healthy', reconciliation: {
      id: 'r1', createdAt: new Date(now).toISOString(), status: 'clean', previousFetchedAt: null,
      currentFetchedAt: new Date(now).toISOString(), issues: [],
    },
    live: {
      source: 'rest', sequence: 1, lastEventAt: new Date(now).toISOString(), lastReconciledAt: new Date(now).toISOString(),
      stream: {
        state: overrides.streamState ?? 'live', lastEventAt: new Date(now).toISOString(),
        lastReadyAt: new Date(now).toISOString(), retryAttempt: 0, lastError: null,
      },
    },
  };
}

describe('account risk guard', () => {
  it('fails closed when authenticated state is missing or disconnected', () => {
    expect(evaluateAccountRisk({ portfolio: null, dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'portfolio_missing' });
    expect(evaluateAccountRisk({ portfolio: portfolio({ streamState: 'disconnected' }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'private_stream_unavailable' });
  });

  it('trips on margin, exposure, daily loss, and stale state', () => {
    expect(evaluateAccountRisk({ portfolio: portfolio({ availableMargin: '100' }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'available_margin_low' });
    expect(evaluateAccountRisk({ portfolio: portfolio({ value: '10001' }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'gross_exposure_exceeded' });
    expect(evaluateAccountRisk({ portfolio: portfolio({ unrealizedPnl: '-201' }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'daily_loss_exceeded' });
    expect(evaluateAccountRisk({ portfolio: portfolio({ fetchedAt: new Date(now - 360_001).toISOString() }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true }, limits))
      .toMatchObject({ safe: false, code: 'portfolio_stale' });
  });

  it('requires ADL data when an ADL threshold is enabled', () => {
    const decision = evaluateAccountRisk(
      { portfolio: portfolio({ value: '1000' }), dailyRealizedPnlUsd: '0', dailyPnlComplete: true, nowMs: now, requirePrivateStream: true },
      { ...limits, maxAdlRank: 3 },
    );
    expect(decision).toMatchObject({ safe: false, code: 'adl_rank_missing' });
  });

  it('fails closed when the daily trade page may be truncated', () => {
    expect(evaluateAccountRisk({
      portfolio: portfolio(), dailyRealizedPnlUsd: '0', dailyPnlComplete: false,
      nowMs: now, requirePrivateStream: true,
    }, limits)).toMatchObject({ safe: false, code: 'daily_pnl_history_incomplete' });
  });
});
