import { describe, expect, it } from 'vitest';
import { maximumTransferAmount } from './transfer-amount.js';
import { transferAccountsFor } from './transfer-rules.js';

describe('maximumTransferAmount', () => {
  it('preserves whole amounts and truncates fractional excess without rounding above the balance', () => {
    expect(maximumTransferAmount('100', 8)).toBe('100');
    expect(maximumTransferAmount('4.856863219', 8)).toBe('4.85686321');
    expect(maximumTransferAmount('4.85000000', 8)).toBe('4.85');
  });

  it('does not offer an amount that becomes zero at the supported precision', () => {
    expect(maximumTransferAmount('0.000000009', 8)).toBeNull();
    expect(maximumTransferAmount('not-a-balance', 8)).toBeNull();
  });
});

describe('transferAccountsFor', () => {
  it('offers every documented explicit venue for USDC while excluding generic CrossEx and Kraken', () => {
    expect(transferAccountsFor('USDC', 'CROSS_EXCHANGE')).toEqual([
      'SPOT',
      'CROSSEX_BINANCE',
      'CROSSEX_OKX',
      'CROSSEX_GATE',
      'CROSSEX_BYBIT',
      'CROSSEX_HYPERLIQUID',
      'CROSSEX_DERIBIT',
    ]);
  });

  it('keeps unsupported venue/currency combinations out of the selectors', () => {
    expect(transferAccountsFor('BTC', 'ISOLATED_EXCHANGE')).not.toContain('CROSSEX_KRAKEN');
    expect(transferAccountsFor('BTC', 'ISOLATED_EXCHANGE')).not.toContain('CROSSEX_HYPERLIQUID');
    expect(transferAccountsFor('USDT', 'CROSS_EXCHANGE')).toEqual(['SPOT', 'CROSSEX']);
  });
});
