import { describe, expect, it } from 'vitest';
import { marketQuoteForVenue, marketSymbol } from './market-symbol.js';

describe('marketSymbol', () => {
  it('concatenates perpetual futures symbols', () => {
    expect(marketSymbol('ETH', 'USDT', 'perpetual')).toBe('ETHUSDT');
    expect(marketSymbol('ETH', 'USDC', 'perpetual')).toBe('ETHUSDC');
  });

  it('separates spot symbols with a slash', () => {
    expect(marketSymbol('ETH', 'USDT', 'spot')).toBe('ETH/USDT');
  });

  it('uses the active venue quote for the displayed contract', () => {
    const venues = [
      { venue: 'GATE', quote: 'USDT' },
      { venue: 'HYPERLIQUID', quote: 'USDC' },
    ];

    const quote = marketQuoteForVenue(venues, 'HYPERLIQUID');
    expect(marketSymbol('ETH', quote, 'perpetual')).toBe('ETHUSDC');
  });
});
