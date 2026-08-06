import { describe, expect, it } from 'vitest';
import type { PortfolioFuturesPosition } from '@gate-crossex/shared-types';
import { aggregatePositionFundingFee, positionFundingFee } from './position-funding-fees.js';

function portfolioPosition(
  positionId: string,
  symbol: string,
  fundingFee: string,
): PortfolioFuturesPosition {
  return {
    positionId, symbol, fundingFee, positionSide: 'LONG', initialMargin: '0', maintenanceMargin: '0',
    quantity: '1', value: '1', unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '1', markPrice: '1',
    leverage: '1', maxLeverage: '1', riskLimit: '0', fee: '0', fundingTime: '0', createdAt: '', updatedAt: '',
    realizedPnl: '0',
  };
}

describe('position funding fees', () => {
  it('matches by position id before symbol and sums complete venue legs', () => {
    const sources = [
      portfolioPosition('long-1', 'BINANCE_FUTURE_BTC_USDT', '1.25'),
      portfolioPosition('short-1', 'BINANCE_FUTURE_BTC_USDT', '-0.4'),
      portfolioPosition('gate-1', 'GATE_FUTURE_BTC_USDT', '0.2'),
    ];
    expect(positionFundingFee({ position_id: 'short-1', symbol: 'BINANCE_FUTURE_BTC_USDT' }, sources)).toBe(-0.4);
    expect(aggregatePositionFundingFee([
      { position_id: 'long-1', symbol: 'BINANCE_FUTURE_BTC_USDT' },
      { position_id: 'gate-1', symbol: 'GATE_FUTURE_BTC_USDT' },
    ], sources)).toBe(1.45);
  });

  it('sums the funding fees carried by refreshed execution positions without a portfolio snapshot', () => {
    expect(aggregatePositionFundingFee([
      { position_id: 'hyperliquid-1', symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', funding_fee: '1.2345' },
      { position_id: 'bybit-1', symbol: 'BYBIT_FUTURE_HYPE_USDT', funding_fee: '-0.2345' },
    ], [])).toBe(1);
  });

  it('uses a unique symbol fallback but never guesses between dual-side positions', () => {
    const unique = [portfolioPosition('remote-1', 'GATE_FUTURE_ETH_USDT', '0.003')];
    expect(positionFundingFee({ position_id: 'local-1', symbol: 'GATE_FUTURE_ETH_USDT' }, unique)).toBe(0.003);

    const ambiguous = [
      portfolioPosition('long-1', 'OKX_FUTURE_ETH_USDT', '0.1'),
      portfolioPosition('short-1', 'OKX_FUTURE_ETH_USDT', '-0.1'),
    ];
    expect(positionFundingFee({ position_id: 'missing', symbol: 'OKX_FUTURE_ETH_USDT' }, ambiguous)).toBeNull();
  });
});
