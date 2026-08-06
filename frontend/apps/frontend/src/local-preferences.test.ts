import { describe, expect, it } from 'vitest';
import { parseStoredFavorites } from './local-preferences.js';

describe('local preferences', () => {
  it('returns an empty list for missing, corrupt, or wrongly shaped browser storage', () => {
    expect(parseStoredFavorites(null)).toEqual([]);
    expect(parseStoredFavorites('{broken')).toEqual([]);
    expect(parseStoredFavorites('{"symbol":"GATE_FUTURE_BTC_USDT"}')).toEqual([]);
  });

  it('keeps only unique supported CrossEx symbols', () => {
    expect(parseStoredFavorites(JSON.stringify([
      'GATE_FUTURE_BTC_USDT',
      'GATE_FUTURE_BTC_USDT',
      'unknown',
      42,
      'BINANCE_FUTURE_ETH_USDC',
    ]))).toEqual([
      'GATE_FUTURE_BTC_USDT',
      'BINANCE_FUTURE_ETH_USDC',
    ]);
  });
});
