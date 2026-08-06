import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import type { PortfolioOrder, PortfolioSnapshot } from '@gate-crossex/shared-types';
import { DomainDecimalError, decimalNotional, reconcilePortfolioSnapshots, roundDownToStep, stalePortfolioReconciliation } from './index.js';

function order(orderId: string): PortfolioOrder {
  return {
    orderId, clientOrderId: `client-${orderId}`, state: 'OPEN', symbol: 'BINANCE_FUTURE_BTC_USDT',
    side: 'BUY', type: 'LIMIT', attribute: 'COMMON', venue: 'BINANCE', product: 'FUTURE',
    quantity: '0.01', quoteQuantity: '0', price: '63000', timeInForce: 'GTC',
    executedQuantity: '0', executedAmount: '0', executedAveragePrice: '0', feeCoin: 'USDT',
    fee: '0', reduceOnly: 'false', leverage: '3', reason: '', positionSide: 'NONE',
    createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-10T10:00:00.000Z',
  };
}

function snapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    account: {
      availableMargin: '100', marginBalance: '120', initialMargin: '20', maintenanceMargin: '5',
      initialMarginRate: '6', maintenanceMarginRate: '24', positionMode: 'SINGLE',
      accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: '2026-07-10T10:00:00.000Z',
    },
    balances: [], futuresPositions: [], marginPositions: [], openOrders: [], recentFills: [],
    fetchedAt: '2026-07-10T10:00:01.000Z', source: 'gate_crossex_authenticated_rest',
    ...overrides,
  };
}

describe('decimal finance helpers', () => {
  it('avoids binary floating errors', () => { expect(decimalNotional('0.1', '0.2')).toBe('0.02'); });
  it('rounds down to exchange step', () => { expect(roundDownToStep('1.239', '0.01')).toBe('1.23'); });

  it('never rounds up across a step boundary at high significant-digit counts', () => {
    expect(roundDownToStep('1.9999999999999999999999', '1')).toBe('1');
    expect(roundDownToStep('0.2999999999999999999999999', '0.1')).toBe('0.2');
  });

  it('keeps exact multiples exact', () => {
    expect(roundDownToStep('0.30', '0.1')).toBe('0.3');
    expect(roundDownToStep('100', '0.001')).toBe('100');
    expect(roundDownToStep('0', '0.5')).toBe('0');
  });

  it('computes long notionals exactly instead of rounding at 20 significant digits', () => {
    expect(decimalNotional('63952.123456789012', '0.123456789012345678')).toBe('7895.323812496283995616232056090136');
  });

  it('rejects invalid inputs instead of emitting NaN into order payloads', () => {
    expect(() => roundDownToStep('1', '0')).toThrow(DomainDecimalError);
    expect(() => roundDownToStep('1', '-0.1')).toThrow(DomainDecimalError);
    expect(() => roundDownToStep('-1', '0.1')).toThrow(DomainDecimalError);
    expect(() => roundDownToStep('abc', '0.1')).toThrow(DomainDecimalError);
    expect(() => decimalNotional('', '1')).toThrow(DomainDecimalError);
    expect(() => decimalNotional('1', 'Infinity')).toThrow(DomainDecimalError);
  });

  it('is immune to other modules mutating the shared decimal.js singleton', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 5, rounding: Decimal.ROUND_UP });
      expect(roundDownToStep('1.9999999999999999999999', '1')).toBe('1');
      expect(decimalNotional('63952.123456789012', '0.123456789012345678')).toBe('7895.323812496283995616232056090136');
    } finally {
      Decimal.set(previous);
    }
  });
});

describe('portfolio reconciliation', () => {
  it('creates a baseline and reports identical subsequent state as clean', () => {
    const current = snapshot();
    expect(reconcilePortfolioSnapshots('r1', current.fetchedAt, null, current).status).toBe('baseline');
    expect(reconcilePortfolioSnapshots('r2', current.fetchedAt, current, current)).toMatchObject({ status: 'clean', issues: [] });
  });

  it('flags newly observed remote orders as unknown', () => {
    const before = snapshot();
    const after = snapshot({ fetchedAt: '2026-07-10T10:00:16.000Z', openOrders: [order('o1')] });
    const report = reconcilePortfolioSnapshots('r1', after.fetchedAt, before, after);
    expect(report.status).toBe('changes_detected');
    expect(report.issues).toEqual([expect.objectContaining({ code: 'unknown_order_detected', entityId: 'o1' })]);
  });

  it('explains a disappeared order only when a matching fill is present', () => {
    const before = snapshot({ openOrders: [order('o1')] });
    const withFill = snapshot({
      fetchedAt: '2026-07-10T10:00:16.000Z',
      recentFills: [{
        transactionId: 't1', orderId: 'o1', clientOrderId: 'client-o1', symbol: 'BINANCE_FUTURE_BTC_USDT',
        venue: 'BINANCE', product: 'FUTURE', side: 'BUY', quantity: '0.01', price: '63000',
        fee: '0.1', feeCoin: 'USDT', feeRate: '0.0005', matchRole: 'TAKER', realizedPnl: '0',
        positionMode: 'BOTH', positionSide: 'LONG', createdAt: '2026-07-10T10:00:15.000Z',
      }],
    });
    const explained = reconcilePortfolioSnapshots('r1', withFill.fetchedAt, before, withFill);
    const ambiguous = reconcilePortfolioSnapshots('r2', withFill.fetchedAt, before, snapshot({ fetchedAt: withFill.fetchedAt }));
    expect(explained.issues.map((entry) => entry.code)).toEqual(['new_fill_detected', 'order_resolved_by_fill']);
    expect(explained.status).toBe('changes_detected');
    expect(ambiguous).toMatchObject({ status: 'ambiguous', issues: [expect.objectContaining({ code: 'order_missing_without_fill' })] });
  });

  it('marks failed remote refreshes as stale', () => {
    expect(stalePortfolioReconciliation('r1', '2026-07-10T10:01:00.000Z', snapshot()))
      .toMatchObject({ status: 'stale', issues: [{ code: 'remote_refresh_failed' }] });
  });
});
