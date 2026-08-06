import { describe, expect, it } from 'vitest';
import { cumulativeFundingHistory, cumulativeFundingPnl } from './cumulative-funding-history.js';

describe('cumulativeFundingHistory', () => {
  it('sorts settlements, converts fractions to percent, and accumulates them', () => {
    expect(cumulativeFundingHistory([
      { timestamp: 300, rate: '-0.0001' },
      { timestamp: 200, rate: '0.0002' },
    ], 100)).toEqual([
      { time: 100, value: 0 },
      { time: 200, value: 0.02 },
      { time: 300, value: 0.01 },
    ]);
  });

  it('ignores malformed settlements and does not add a baseline without data', () => {
    expect(cumulativeFundingHistory([
      { timestamp: 200, rate: 'invalid' },
    ], 100)).toEqual([]);
  });
});

describe('cumulativeFundingPnl', () => {
  it('subtracts the long funding history from the short history at every settlement', () => {
    expect(cumulativeFundingPnl([
      { time: 100_000, value: 0 },
      { time: 200_006, value: 0.02 },
      { time: 300_006, value: 0.03 },
    ], [
      { time: 100_000, value: 0 },
      { time: 250_000, value: 0.01 },
      { time: 300_000, value: 0.04 },
    ])).toEqual([
      { time: 100_000, value: 0 },
      { time: 200_000, value: -0.02 },
      { time: 250_000, value: -0.01 },
      { time: 300_000, value: 0.01 },
    ]);
  });

  it('waits until both venue histories have a value', () => {
    expect(cumulativeFundingPnl([
      { time: 200_000, value: 0.02 },
    ], [
      { time: 100_000, value: 0.01 },
      { time: 300_000, value: 0.03 },
    ])).toEqual([
      { time: 200_000, value: -0.01 },
      { time: 300_000, value: 0.01 },
    ]);
    expect(cumulativeFundingPnl([], [{ time: 100_000, value: 0 }])).toEqual([]);
  });
});
