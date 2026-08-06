import { CANDLE_INTERVAL_MILLISECONDS } from '@gate-crossex/shared-types';
import type { Candle, CandleInterval, LiveMarket, MarketSnapshot } from './api.js';

export const STRATEGY_MARKET_FRESHNESS_MS = 15_000;
export const STRATEGY_MARKET_PAIR_MAX_SKEW_MS = 5_000;
export const STRATEGY_FUTURE_QUOTE_TOLERANCE_MS = 2_000;

export interface FreshMarketPair {
  left: LiveMarket;
  right: LiveMarket;
}

export type MarketPairWaitReason = 'feed' | 'missing' | 'non_live' | 'stale' | 'skew';

export type MarketPairFreshness =
  | { pair: FreshMarketPair; reason: null }
  | { pair: null; reason: MarketPairWaitReason };

/** Explain why a pair is not executable so the UI does not collapse every failure into one hint. */
export function assessMarketPairFreshness(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): MarketPairFreshness {
  if (!snapshot || snapshot.connectionState !== 'healthy') return { pair: null, reason: 'feed' };
  const left = snapshot.markets.find((market) => market.symbol === leftSymbol);
  const right = snapshot.markets.find((market) => market.symbol === rightSymbol);
  if (!left || !right) return { pair: null, reason: 'missing' };
  if (left.source !== 'gate_crossex_websocket' || right.source !== 'gate_crossex_websocket') {
    return { pair: null, reason: 'non_live' };
  }
  const leftUpdatedAt = Date.parse(left.updatedAt);
  const rightUpdatedAt = Date.parse(right.updatedAt);
  const usableTimestamp = (timestamp: number) => Number.isFinite(timestamp)
    && now - timestamp <= STRATEGY_MARKET_FRESHNESS_MS
    && timestamp - now <= STRATEGY_FUTURE_QUOTE_TOLERANCE_MS;
  if (!usableTimestamp(leftUpdatedAt) || !usableTimestamp(rightUpdatedAt)) {
    return { pair: null, reason: 'stale' };
  }
  if (Math.abs(leftUpdatedAt - rightUpdatedAt) > STRATEGY_MARKET_PAIR_MAX_SKEW_MS) {
    return { pair: null, reason: 'skew' };
  }
  return { pair: { left, right }, reason: null };
}

/** Mirror the backend trigger guard so stale UI prices can never look actionable. */
export function freshMarketPair(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): FreshMarketPair | null {
  return assessMarketPairFreshness(snapshot, leftSymbol, rightSymbol, now).pair;
}

/**
 * Venue REST may return persisted candles while a refresh is running. Treat at most the previous
 * completed interval as current, with a small transport allowance, and otherwise keep loading.
 */
export function candleTailIsFresh(
  candles: Candle[],
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  return candleTimestampIsFresh(latest.startTime, interval, now);
}

export function candleTimestampIsFresh(
  startTime: number,
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const intervalMs = CANDLE_INTERVAL_MILLISECONDS[interval];
  return startTime <= now + STRATEGY_FUTURE_QUOTE_TOLERANCE_MS
    && now - startTime <= intervalMs * 2 + 5_000;
}
