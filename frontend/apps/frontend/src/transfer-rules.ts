import type { CrossExTransferAccount } from './api.js';

const TRANSFER_ACCOUNTS: CrossExTransferAccount[] = [
  'SPOT',
  'CROSSEX',
  'CROSSEX_BINANCE',
  'CROSSEX_OKX',
  'CROSSEX_GATE',
  'CROSSEX_BYBIT',
  'CROSSEX_KRAKEN',
  'CROSSEX_HYPERLIQUID',
  'CROSSEX_DERIBIT',
];

export function transferAccountsFor(coin: string, accountMode: string | undefined): CrossExTransferAccount[] {
  if (coin === 'USDT' && accountMode !== 'ISOLATED_EXCHANGE') return ['SPOT', 'CROSSEX'];
  return TRANSFER_ACCOUNTS.filter((account) => account !== 'CROSSEX'
    && (coin === 'USDC' || account !== 'CROSSEX_HYPERLIQUID')
    && (coin === 'USDT' || account !== 'CROSSEX_KRAKEN'));
}
