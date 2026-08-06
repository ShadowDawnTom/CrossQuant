import { describe, expect, it } from 'vitest';
import type { AuthenticatedPortfolioSnapshot, LiveBalance } from './api.js';
import { assessMarginCapacity, balanceFor, balanceUnitFor } from './route-shared.js';

function portfolio(accountMode: string, availableMargin: string): AuthenticatedPortfolioSnapshot {
  return {
    dataStatus: 'fresh',
    remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin, marginBalance: availableMargin, initialMargin: '0', maintenanceMargin: '0',
        initialMarginRate: '0', maintenanceMarginRate: '0', positionMode: 'SINGLE', accountMode,
        exchangeType: accountMode === 'CROSS_EXCHANGE' ? 'CROSSEX' : 'DERIBIT',
        remoteUpdatedAt: '2026-08-05T00:00:00.000Z',
      },
      balances: [{
        venue: 'DERIBIT', coin: 'USDC', balance: '1', unrealizedPnl: '0', equity: '1',
        futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0',
        borrowingMaintenanceMargin: '0', availableBalance: '0.98', liability: '0',
      }],
      futuresPositions: [], marginPositions: [], openOrders: [], recentFills: [],
      fetchedAt: '2026-08-05T00:00:00.000Z', source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation', createdAt: '2026-08-05T00:00:00.000Z', status: 'clean',
      previousFetchedAt: null, currentFetchedAt: '2026-08-05T00:00:00.000Z', issues: [],
    },
  };
}

const streamedDeribitBalance: LiveBalance = {
  venue: 'DERIBIT', coin: 'USDC', balance: '1', availableBalance: '0.98', equity: '1',
  unrealizedPnl: '0', updatedAt: '2026-08-05T00:00:00.000Z',
};

describe('CrossEx margin capacity', () => {
  it('uses the account-level USDT margin in cross-exchange mode instead of a venue asset row', () => {
    const snapshot = portfolio('CROSS_EXCHANGE', '9792.85');
    const balances = { 'DERIBIT:USDC': streamedDeribitBalance };

    expect(balanceFor(balances, snapshot, 'deribit')).toBe('9792.85');
    expect(balanceUnitFor(snapshot, 'deribit')).toBe('USDT');
    expect(assessMarginCapacity('CROSS_EXCHANGE', 9792.85, [
      { venue: 'DERIBIT', required: 302.02, available: 0.98 },
      { venue: 'BYBIT', required: 302.02, available: 0 },
    ])).toEqual({ known: true, insufficient: false });
  });

  it('groups requirements by venue only in isolated mode', () => {
    const snapshot = portfolio('ISOLATED_EXCHANGE', '250');
    expect(balanceFor({ 'DERIBIT:USDC': streamedDeribitBalance }, snapshot, 'deribit')).toBe('250');
    expect(balanceFor({ 'DERIBIT:USDC': streamedDeribitBalance }, snapshot, 'bybit')).toBeNull();
    expect(assessMarginCapacity('ISOLATED_EXCHANGE', 9792.85, [
      { venue: 'DERIBIT', required: 300, available: 100 },
      { venue: 'DERIBIT', required: 50, available: 100 },
      { venue: 'BYBIT', required: 200, available: 500 },
    ])).toEqual({ known: true, insufficient: true });
  });
});
