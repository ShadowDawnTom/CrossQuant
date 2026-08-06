import type { Candle } from './api.js';

export interface PriceDifferenceHistoryPoint {
  time: number;
  value: number;
  leftClose: number;
  rightClose: number;
}

/**
 * Builds a direction-aware price-difference series from timestamp-aligned closes.
 *
 * The strategy expresses its entry edge in basis points relative to the buy leg:
 * (sell price - buy price) / buy price × 10,000.
 */
export function buildPriceDifferenceHistory(
  leftCandles: Candle[],
  rightCandles: Candle[],
  directionFlipped: boolean,
  since: number,
): PriceDifferenceHistoryPoint[] {
  const rightByTime = new Map(rightCandles.map((candle) => [candle.startTime, Number(candle.close)]));
  const points: PriceDifferenceHistoryPoint[] = [];

  for (const candle of leftCandles) {
    if (candle.startTime < since) continue;
    const leftClose = Number(candle.close);
    const rightClose = rightByTime.get(candle.startTime);
    if (!Number.isFinite(leftClose) || leftClose <= 0 || rightClose === undefined || !Number.isFinite(rightClose) || rightClose <= 0) continue;
    const sellClose = directionFlipped ? rightClose : leftClose;
    const buyClose = directionFlipped ? leftClose : rightClose;
    points.push({
      time: candle.startTime,
      value: ((sellClose - buyClose) / buyClose) * 10_000,
      leftClose,
      rightClose,
    });
  }

  return points.sort((left, right) => left.time - right.time);
}
