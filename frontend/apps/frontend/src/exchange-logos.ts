import binanceLogo from './assets/exchanges/binance.svg';
import bybitLogo from './assets/exchanges/bybit.svg';
import deribitLogo from './assets/exchanges/deribit.svg';
import gateLogo from './assets/exchanges/gate.svg';
import hyperliquidLogo from './assets/exchanges/hyperliquid.svg';
import krakenLogo from './assets/exchanges/kraken.svg';
import okxLogo from './assets/exchanges/okx.svg';

export type ExchangeLogoId = 'gate' | 'binance' | 'okx' | 'bybit' | 'kraken' | 'hyperliquid' | 'deribit';

export const EXCHANGE_LOGOS: Record<ExchangeLogoId, string> = {
  gate: gateLogo,
  binance: binanceLogo,
  okx: okxLogo,
  bybit: bybitLogo,
  kraken: krakenLogo,
  hyperliquid: hyperliquidLogo,
  deribit: deribitLogo,
};

export function exchangeLogoFor(exchangeId: string): string | undefined {
  return EXCHANGE_LOGOS[exchangeId.toLowerCase() as ExchangeLogoId];
}
