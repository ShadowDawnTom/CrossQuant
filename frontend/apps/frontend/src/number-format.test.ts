import { describe, expect, it } from 'vitest';
import { compactPrice, decimalPlaces, formatBookAmount, formatGroupStep } from './number-format.js';

describe('trading number formatting', () => {
  it('keeps micro-priced assets visible', () => {
    expect(compactPrice(0.000003)).toBe('0.000003');
    expect(compactPrice(0.00000314159)).toBe('0.00000314159');
  });

  it('preserves sub-1e-8 venue ticks', () => {
    expect(decimalPlaces(0.000000001)).toBe(9);
    expect(formatGroupStep(0.000000001)).toBe('0.000000001');
  });

  it('compacts large order-book quantities', () => {
    expect(formatBookAmount(110_169_000)).toBe('110.17M');
    expect(formatBookAmount(10_960_000)).toBe('10.96M');
  });
});
