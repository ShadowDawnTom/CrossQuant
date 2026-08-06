import { describe, expect, it } from 'vitest';
import {
  applyFundingAssetOrder,
  averageAvailableFundingRate,
  cumulativeFundingPercent,
  fundingHistoryRequestKey,
} from './funding-rates.js';

describe('stable funding table order', () => {
  it('keeps refreshed rows in the explicitly applied order and appends new assets deterministically', () => {
    const refreshed = [
      { asset: 'SOL', value: 30 },
      { asset: 'ETH', value: 200 },
      { asset: 'BTC', value: 100 },
      { asset: 'ADA', value: 40 },
    ];

    expect(applyFundingAssetOrder(refreshed, ['BTC', 'ETH']).map((row) => row.asset))
      .toEqual(['BTC', 'ETH', 'ADA', 'SOL']);
  });
});

describe('funding history request identity', () => {
  it('stays stable across live-update array recreation and reordering', () => {
    const first = ['OKX_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT'];
    const liveUpdate = ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'];

    expect(fundingHistoryRequestKey(first)).toBe(fundingHistoryRequestKey(liveUpdate));
  });
});

describe('cumulativeFundingPercent', () => {
  it('displays the realized sum directly without projecting the latest interval', () => {
    expect(cumulativeFundingPercent('0.00123')).toBeCloseTo(0.123);
    expect(cumulativeFundingPercent('-0.0004')).toBeCloseTo(-0.04);
  });

  it('rejects missing and malformed history totals', () => {
    expect(cumulativeFundingPercent(null)).toBeNull();
    expect(cumulativeFundingPercent('not-a-rate')).toBeNull();
  });
});

describe('averageAvailableFundingRate', () => {
  it('averages positive and negative funding across selected tradable venues', () => {
    expect(averageAvailableFundingRate(
      [0.01, -0.02, 0.04],
      [true, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 3 });
  });

  it('excludes unlisted, unselected, and missing venue rates', () => {
    expect(averageAvailableFundingRate(
      [0.01, 0.5, null, 0.03],
      [true, false, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 1 });
  });

  it('returns no average when no selected tradable venue has funding data', () => {
    expect(averageAvailableFundingRate(
      [null, 0.02],
      [true, false],
      [0, 1],
    )).toEqual({ rate: null, venueCount: 0 });
  });
});
