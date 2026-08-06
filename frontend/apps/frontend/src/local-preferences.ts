const FAVORITE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;

/**
 * Browser storage is user-editable and can outlive older application versions. Treat it as
 * untrusted input so one corrupt preference cannot prevent the terminal from rendering.
 */
export function parseStoredFavorites(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (entry): entry is string => typeof entry === 'string' && FAVORITE_SYMBOL.test(entry),
    ))];
  } catch {
    return [];
  }
}
