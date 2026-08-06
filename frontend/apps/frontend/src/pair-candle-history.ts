import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Candle, type CandleInterval } from './api.js';
import { mergeCandleHistory } from './premium-history.js';

export interface PairCandleHistory {
  key: string;
  left: Candle[];
  right: Candle[];
  status: 'loading' | 'live' | 'failed';
}

/**
 * Loads and paginates aligned candle inputs for a two-market derived chart.
 * The latest page is refreshed so the derived spread keeps moving between stream updates.
 */
export function usePairCandleHistory(
  leftSymbol: string,
  rightSymbol: string,
  interval: CandleInterval,
  enabled: boolean,
): PairCandleHistory & { loadOlder: () => void } {
  const key = `${leftSymbol}:${rightSymbol}:${interval}`;
  const [history, setHistory] = useState<PairCandleHistory & { leftHasMore: boolean; rightHasMore: boolean }>({
    key: '',
    left: [],
    right: [],
    leftHasMore: true,
    rightHasMore: true,
    status: 'loading',
  });
  const loadingRef = useRef<Set<string>>(new Set());
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    setHistory((current) => current.key === key
      ? { ...current, status: current.left.length > 0 && current.right.length > 0 ? 'live' : 'loading' }
      : { key, left: [], right: [], leftHasMore: true, rightHasMore: true, status: 'loading' });

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [leftResponse, rightResponse] = await Promise.all([
          api.candles(leftSymbol, interval, { limit: 300 }),
          api.candles(rightSymbol, interval, { limit: 300 }),
        ]);
        if (!cancelled) setHistory((current) => current.key === key ? {
          key,
          left: mergeCandleHistory(current.left, leftResponse.candles),
          right: mergeCandleHistory(current.right, rightResponse.candles),
          leftHasMore: leftResponse.hasMore,
          rightHasMore: rightResponse.hasMore,
          status: 'live',
        } : current);
      } catch {
        if (!cancelled) setHistory((current) => current.key === key ? { ...current, status: 'failed' } : current);
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), interval === '1m' ? 30_000 : 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, interval, key, leftSymbol, rightSymbol]);

  const loadOlder = useCallback(() => {
    if (!enabled || history.key !== key || loadingRef.current.has(key)) return;
    const oldestLeft = history.left[0];
    const oldestRight = history.right[0];
    const loadLeft = history.leftHasMore && oldestLeft !== undefined;
    const loadRight = history.rightHasMore && oldestRight !== undefined;
    if (!loadLeft && !loadRight) return;
    const requestKey = `${key}:${loadLeft ? oldestLeft.startTime : 'done'}:${loadRight ? oldestRight.startTime : 'done'}`;
    if (requestedRef.current.has(requestKey)) return;
    loadingRef.current.add(key);
    requestedRef.current.add(requestKey);

    void Promise.all([
      loadLeft ? api.candles(leftSymbol, interval, { before: oldestLeft.startTime, limit: 300 }) : null,
      loadRight ? api.candles(rightSymbol, interval, { before: oldestRight.startTime, limit: 300 }) : null,
    ]).then(([leftResponse, rightResponse]) => {
      setHistory((current) => current.key === key ? {
        ...current,
        left: leftResponse ? mergeCandleHistory(current.left, leftResponse.candles) : current.left,
        right: rightResponse ? mergeCandleHistory(current.right, rightResponse.candles) : current.right,
        leftHasMore: leftResponse ? leftResponse.candles.length > 0 && leftResponse.hasMore : current.leftHasMore,
        rightHasMore: rightResponse ? rightResponse.candles.length > 0 && rightResponse.hasMore : current.rightHasMore,
      } : current);
    }).catch(() => {
      requestedRef.current.delete(requestKey);
    }).finally(() => {
      loadingRef.current.delete(key);
    });
  }, [enabled, history, interval, key, leftSymbol, rightSymbol]);

  return {
    key: history.key,
    left: history.left,
    right: history.right,
    status: history.status,
    loadOlder,
  };
}
