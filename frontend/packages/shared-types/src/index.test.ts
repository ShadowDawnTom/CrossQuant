import { describe, expect, it } from 'vitest';
import {
  CrossExInstrumentCatalogSchema,
  CrossExPortfolioActivityResponseSchema,
  CrossExTransferRequestSchema,
  EnvironmentSchema,
  PublicMarketSnapshotResponseSchema,
  StrategyConfigSchema,
  SystemDiscoverySchema,
  TerminalStreamMessageSchema,
  VenueSchema,
  canonicalizeCrossExTransfer,
  contiguousCandleTail,
  crossExTransferRouteError,
  type Candle,
} from './index.js';
describe('shared schemas', () => { it('accepts supported environments and venues', () => { expect(EnvironmentSchema.parse('live')).toBe('live'); expect(VenueSchema.parse('GATE')).toBe('GATE'); }); });

describe('strategy config schema', () => {
  it('preserves a negative paired-position entry threshold', () => {
    const config = StrategyConfigSchema.parse({
      kind: 'position', asset: 'HYPE', leftVenue: 'HYPERLIQUID', rightVenue: 'BYBIT',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '-5', totalAmount: '100',
      perOrderQuantity: '10', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    expect(config.entryBps).toBe('-5');
  });
});

describe('CrossEx transfer request schema', () => {
  it('accepts documented accounts and rejects zero-value or same-account transfers', () => {
    expect(CrossExTransferRequestSchema.parse({
      coin: 'USDT', amount: '25.5', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    })).toMatchObject({ amount: '25.5', from: 'SPOT', to: 'CROSSEX' });
    expect(CrossExTransferRequestSchema.safeParse({ coin: 'USDT', amount: '0', from: 'SPOT', to: 'CROSSEX' }).success).toBe(false);
    expect(CrossExTransferRequestSchema.safeParse({ coin: 'BTC', amount: '1', from: 'CROSSEX_GATE', to: 'CROSSEX_GATE' }).success).toBe(false);
  });

  it('enforces Gate route-specific asset and account restrictions', () => {
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_DERIBIT', to: 'SPOT' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_BINANCE', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE')).toBeNull();
    expect(crossExTransferRouteError({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE'))
      .toBe('HYPERLIQUID_USDC_SPOT_ONLY');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX_KRAKEN', to: 'SPOT' }, 'ISOLATED_EXCHANGE'))
      .toBe('KRAKEN_USDT_ONLY');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX', to: 'SPOT' }, 'CROSS_EXCHANGE'))
      .toBe('EXPLICIT_VENUE_ACCOUNT_REQUIRED');
    expect(crossExTransferRouteError({ coin: 'USDT', from: 'CROSSEX_BINANCE', to: 'CROSSEX_OKX' }, 'CROSS_EXCHANGE'))
      .toBe('USDT_SPOT_CROSSEX_REQUIRED');
    expect(crossExTransferRouteError({ coin: 'BTC', from: 'CROSSEX_DERIBIT', to: 'CROSSEX_GATE' }, 'CROSS_EXCHANGE')).toBeNull();
  });

  it('canonicalizes the documented USDT aliases before balance validation and submission', () => {
    expect(canonicalizeCrossExTransfer({
      coin: 'USDT', amount: '25', from: 'CROSSEX_DERIBIT', to: 'SPOT',
    }, 'CROSS_EXCHANGE')).toMatchObject({ from: 'CROSSEX', to: 'SPOT' });
    expect(canonicalizeCrossExTransfer({
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX',
    }, 'ISOLATED_EXCHANGE')).toMatchObject({ from: 'SPOT', to: 'CROSSEX_GATE' });
    expect(crossExTransferRouteError({
      coin: 'USDT', from: 'SPOT', to: 'CROSSEX',
    }, 'ISOLATED_EXCHANGE')).toBeNull();
  });
});

describe('CrossEx portfolio activity schema', () => {
  it('keeps a dedicated list of funding-fee account entries', () => {
    const fundingFee = {
      id: 'fee-1', businessId: 'settlement-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
      coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '81',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const response = CrossExPortfolioActivityResponseSchema.parse({
      transfers: [], accountBook: [fundingFee], fundingFees: [fundingFee],
      fetchedAt: '2026-08-01T00:00:01.000Z',
    });
    expect(response.fundingFees).toEqual([fundingFee]);
  });
});

function candle(startTime: number, close = String(startTime)): Candle {
  return { startTime, open: close, high: close, low: close, close, volume: '1', closed: true };
}

describe('contiguous candle history', () => {
  it('keeps only the newest run when an interval is missing', () => {
    expect(contiguousCandleTail([
      candle(0),
      candle(60_000),
      candle(600_000),
      candle(660_000),
    ], '1m').map((item) => item.startTime)).toEqual([600_000, 660_000]);
  });

  it('sorts, deduplicates with the newest value, and applies the limit', () => {
    const result = contiguousCandleTail([
      candle(120_000),
      candle(0),
      candle(60_000, 'old'),
      candle(60_000, 'new'),
    ], '1m', 2);
    expect(result.map((item) => item.startTime)).toEqual([60_000, 120_000]);
    expect(result[0]?.close).toBe('new');
  });
});

describe('system discovery schema', () => {
  it('rejects a negative migration count', () => {
    expect(() => SystemDiscoverySchema.parse({
      product: 'CrossEx',
      mode: 'live',
      authenticatedTradingEnabled: false,
      tradingMode: 'unset',
      docs: { apiVersion: 'v4', retrievedAt: '2026-07-10' },
      database: { migrationCount: -1, currentMigration: null },
    })).toThrow();
  });
});

describe('CrossEx instrument catalog schema', () => {
  it('preserves decimal values as strings and accepts documented nullable limits', () => {
    const catalog = CrossExInstrumentCatalogSchema.parse({
      items: [{
        symbol: 'GATE_FUTURE_BTC_USDT', exchangeType: 'GATE', businessType: 'FUTURE', state: 'live',
        minSize: '0.0001', minNotional: null, lotSize: '0.0001', tickSize: '0.1',
        maxNumOrders: '50', maxMarketSize: null, maxLimitSize: '1200', contractSize: null,
        liquidationFee: '0.005', defaultLeverage: '5', delistTime: '0',
      }],
      fetchedAt: '2026-07-10T00:00:00.000Z',
      source: 'gate_crossex_public_rest',
      cacheStatus: 'fresh',
      upstreamStatus: 'healthy',
    });
    expect(catalog.items[0]?.minSize).toBe('0.0001');
  });
});

describe('public market snapshot schema', () => {
  it('keeps prices and rates as strings and requires an explicit source', () => {
    const response = PublicMarketSnapshotResponseSchema.parse({
      snapshot: {
        symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', product: 'FUTURE',
        bidPrice: '63952.2', askPrice: '63952.3', lastPrice: '63952.3',
        markPrice: '63952.3', indexPrice: '63968.12', fundingRate: '0.0001',
        predictedFundingRate: '0.0001', nextFundingAt: '2026-07-11T00:00:00.000Z',
        sourceTimestamp: '2026-07-10T18:00:00.000Z', fetchedAt: '2026-07-10T18:00:00.000Z',
        source: 'gate_futures_public_rest',
      },
      cacheStatus: 'fresh', upstreamStatus: 'healthy',
    });
    expect(response.snapshot.fundingRate).toBe('0.0001');
  });
});

describe('terminal stream contract', () => {
  it('accepts a mode update and rejects a malformed market update', () => {
    expect(TerminalStreamMessageSchema.parse({
      type: 'mode.update',
      payload: { mode: 'readonly' },
    })).toEqual({ type: 'mode.update', payload: { mode: 'readonly' } });
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'market.status',
      payload: { connectionState: 'healthy', checkedAt: '2026-08-01T00:00:00.000Z' },
    }).success).toBe(true);
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'market.update',
      payload: { symbol: 42 },
    }).success).toBe(false);
    expect(TerminalStreamMessageSchema.safeParse({
      type: 'trade.batch',
      payload: {
        symbol: 'GATE_FUTURE_BTC_USDT',
        trades: [{
          id: 'trade-1', symbol: 'GATE_FUTURE_BTC_USDT', price: '118500', quantity: '1',
          side: 'BUY', executedAt: '2026-08-01T00:00:00.000Z',
        }],
      },
    }).success).toBe(true);
  });
});
