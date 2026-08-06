import { describe, expect, it } from 'vitest';
import { canonicalMarketAsset, nativeMarketAsset } from './market-asset-aliases.js';

describe('market asset aliases', () => {
  it('maps Hyperliquid SKHX to the canonical SKHYNIX identity in both directions', () => {
    expect(canonicalMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHX')).toBe('SKHYNIX');
    expect(nativeMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHYNIX')).toBe('SKHX');
  });

  it('keeps the distinct SKHY instrument and other venues unchanged', () => {
    expect(canonicalMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHY')).toBe('SKHY');
    expect(canonicalMarketAsset('GATE', 'FUTURE', 'SKHX')).toBe('SKHX');
    expect(nativeMarketAsset('GATE', 'FUTURE', 'SKHYNIX')).toBe('SKHYNIX');
  });
});
