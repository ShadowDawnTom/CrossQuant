import { describe, expect, it } from 'vitest';
import type { Candle } from './api.js';
import { buildPriceDifferenceHistory } from './price-difference-history.js';

function candle(startTime: number, close: string): Candle {
  return { startTime, open: close, high: close, low: close, close, volume: '1', closed: true };
}

describe('buildPriceDifferenceHistory', () => {
  it('calculates basis points relative to the buy leg', () => {
    const points = buildPriceDifferenceHistory(
      [candle(1_000, '101'), candle(2_000, '99')],
      [candle(1_000, '100'), candle(2_000, '100')],
      false,
      0,
    );

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ time: 1_000, leftClose: 101, rightClose: 100 });
    expect(points[0].value).toBeCloseTo(100);
    expect(points[1].value).toBeCloseTo(-100);
  });

  it('reverses sell and buy legs when direction is flipped', () => {
    const [point] = buildPriceDifferenceHistory(
      [candle(1_000, '100')],
      [candle(1_000, '101')],
      true,
      0,
    );

    expect(point?.value).toBeCloseTo(100);
  });

  it('keeps only shared timestamps in range with usable prices', () => {
    const points = buildPriceDifferenceHistory(
      [candle(1_000, '100'), candle(2_000, '0'), candle(3_000, '102')],
      [candle(1_000, '99'), candle(2_000, '100'), candle(3_000, '101')],
      false,
      1_500,
    );

    expect(points.map((point) => point.time)).toEqual([3_000]);
  });
});
