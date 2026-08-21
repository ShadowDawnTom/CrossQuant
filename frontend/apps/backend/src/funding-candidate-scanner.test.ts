import { describe, expect, it, vi } from 'vitest';
import { FundingCandidateScanner, type FundingScanObservation } from './funding-candidate-scanner.js';
import type { ExecutionMarketReader } from './execution-market-hub.js';
import type { FundingArbitrageEngine } from './funding-arbitrage-engine.js';
import type { TradingCrossExGateway } from './crossex-client.js';

const NOW = 1_000_000;

function market(depth = '10'): ExecutionMarketReader {
  const book = (venue: 'BINANCE' | 'OKX', bids: Array<readonly [string, string]>, asks: Array<readonly [string, string]>) => ({
    venue, symbol: `${venue}_FUTURE_SOL_USDT`, base: 'SOL', quote: 'USDT' as const, bids, asks, sequence: 1,
    quoteToUsd: '1', quoteRateAgeMs: 0, quoteRateState: 'healthy' as const,
    exchangeTimestamp: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), ageMs: 0,
    synchronized: true, connectionState: 'healthy' as const, rebuilds: 0, sequenceGaps: 0, lastError: null,
  });
  const longBook = book('BINANCE', [['99', depth]], [['100', depth]]);
  const shortBook = book('OKX', [['101', depth]], [['102', depth]]);
  return {
    start() {}, stop() {},
    health: () => ({ state: 'healthy', updatedAt: new Date(NOW).toISOString(), symbols: ['SOL'], venues: [] }),
    book: (venue) => venue === 'BINANCE' ? longBook : shortBook,
    pair: () => ({ base: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quality: 'LIVE_SYNCHRONIZED', reasons: [],
      exchangeSkewMs: 0, receiveSkewMs: 0, longBook, shortBook, certifiedAt: new Date(NOW).toISOString() }),
  };
}

function gateway(): TradingCrossExGateway {
  const rule = (venue: string) => ({ symbol: `${venue}_FUTURE_SOL_USDT`, exchange_type: venue, business_type: 'FUTURE',
    state: 'live', min_size: '0.01', min_notional: '5', lot_size: '0.01', tick_size: '0.01', max_num_orders: '10',
    max_market_size: '100', max_limit_size: '100', contract_size: '1', liquidation_fee: '0', delist_time: '0' });
  return {
    querySymbols: async () => [rule('BINANCE'), rule('OKX')],
    queryFeeRates: async () => ['BINANCE', 'OKX'].map((venue) => ({ exchange_type: venue, spot_maker_fee: '0',
      spot_taker_fee: '0', future_maker_fee: '0.0005', future_taker_fee: '0.001' })),
    queryFundingInfo: async () => [
      { symbol: 'BINANCE_FUTURE_SOL_USDT', funding_rate: '0', funding_time: '2000000', funding_interval: '28800' },
      { symbol: 'OKX_FUTURE_SOL_USDT', funding_rate: '0.1', funding_time: '2000000', funding_interval: '28800' },
    ],
  } as unknown as TradingCrossExGateway;
}

describe('FundingCandidateScanner', () => {
  it('后端按真实结算次数、双向盘口与四笔手续费生成候选', async () => {
    const candidates: Array<{ quantity: string; netAnnualized: string }> = [];
    const observe = vi.fn(async (input: { quantity: string; netAnnualized: string }) => { candidates.push(input); });
    const onFundingData = vi.fn(async () => undefined);
    const scanner = new FundingCandidateScanner(gateway(), async () => ({ apiKey: 'key', apiSecret: 'secret' }), market(),
      { observeAuthoritativeCandidate: observe } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], targetNotionalUsd: '5', horizonHours: 24, fundingRetentionFactor: '0.5',
        stressSlippageBps: '5', adverseExitBasisBps: '10', onFundingData, now: () => NOW });
    expect(await scanner.scan()).toBe(1);
    expect(observe).toHaveBeenCalledOnce();
    expect(onFundingData).toHaveBeenCalledOnce();
    expect(candidates[0]).toMatchObject({ quantity: '0.05' });
    // 当前盘口立即往返亏 0.1 USDT；资金费只保留 50%，再扣 15bp 压力缓冲和四笔手续费。
    expect(Number(candidates[0]?.netAnnualized)).toBeCloseTo(45.7512, 3);
  });

  it('目标数量的任一进出场盘口深度不足时不生成候选', async () => {
    const observe = vi.fn(async () => undefined);
    const scanner = new FundingCandidateScanner(gateway(), async () => ({ apiKey: 'key', apiSecret: 'secret' }), market('0.01'),
      { observeAuthoritativeCandidate: observe } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], targetNotionalUsd: '5', horizonHours: 24, fundingRetentionFactor: '0.5',
        stressSlippageBps: '5', adverseExitBasisBps: '10', now: () => NOW });
    expect(await scanner.scan()).toBe(0);
    expect(observe).not.toHaveBeenCalled();
  });

  it('实盘净收益不达标时仍输出带完整成本拆解的研究机会', async () => {
    const strictObserve = vi.fn(async () => undefined);
    const observations: unknown[] = [];
    const lowEdgeGateway = gateway();
    lowEdgeGateway.queryFundingInfo = async () => [
      { symbol: 'BINANCE_FUTURE_SOL_USDT', funding_rate: '0', funding_time: '2000000', funding_interval: '28800' },
      { symbol: 'OKX_FUTURE_SOL_USDT', funding_rate: '0.0001', funding_time: '2000000', funding_interval: '28800' },
    ];
    const scanner = new FundingCandidateScanner(lowEdgeGateway,
      async () => ({ apiKey: 'key', apiSecret: 'secret' }), market(),
      { observeAuthoritativeCandidate: strictObserve } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], strictAssets: ['SOL'], researchAssets: ['SOL'], targetNotionalUsd: '5',
        researchTargetNotionalUsd: '5', horizonHours: 24, fundingRetentionFactor: '0.5',
        stressSlippageBps: '5', adverseExitBasisBps: '10', minNetAnnualized: '0.1',
        researchMaxSlippageBps: '10', minLiquidityUsd: '900',
        onFundingData: async (_funding, _fees, rows) => { observations.push(...rows); },
        now: () => NOW },
    );

    expect(await scanner.scan()).toBe(0);
    expect(strictObserve).not.toHaveBeenCalled();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ status: 'RESEARCH_ELIGIBLE', strictEligible: false,
      researchEligible: true, primaryReason: 'funding_net_return_below_threshold', quantity: '0.05',
      marketQuality: 'LIVE_SYNCHRONIZED' });
    expect(Number((observations[0] as { rawAnnualized: string }).rawAnnualized)).toBeGreaterThan(0);
    expect(Number((observations[0] as { netAnnualized: string }).netAnnualized)).toBeLessThan(0);
    expect(Number((observations[0] as { tradingFees: string }).tradingFees)).toBeGreaterThan(0);
  });

  it('规则取整后任一腿超过模拟金额上限时保留拆解但拒绝开仓', async () => {
    const observations: FundingScanObservation[] = [];
    const testGateway = gateway();
    const originalRules = testGateway.querySymbols.bind(testGateway);
    testGateway.querySymbols = async () => (await originalRules()).map((rule) => ({
      ...rule, min_size: '1', lot_size: '1', min_notional: '5',
    }));
    const scanner = new FundingCandidateScanner(testGateway,
      async () => ({ apiKey: 'key', apiSecret: 'secret' }), market(),
      { observeAuthoritativeCandidate: vi.fn() } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], strictAssets: [], researchAssets: ['SOL'], targetNotionalUsd: '5',
        researchTargetNotionalUsd: '5', researchMaxActualNotionalUsd: '10', horizonHours: 24,
        fundingRetentionFactor: '0.5', stressSlippageBps: '5', adverseExitBasisBps: '10',
        researchMaxSlippageBps: '10', minLiquidityUsd: '900',
        onFundingData: async (_funding, _fees, rows) => { observations.push(...rows); }, now: () => NOW },
    );

    expect(await scanner.scan()).toBe(0);
    expect(observations[0]).toMatchObject({ researchEligible: false,
      primaryReason: 'research_actual_notional_exceeded', quantity: '1' });
    expect(Number(observations[0]?.entryLongNotional)).toBeGreaterThan(10);
  });

  it('共同数量超过任一合约市价单上限时 fail-closed', async () => {
    const observations: FundingScanObservation[] = [];
    const testGateway = gateway();
    const originalRules = testGateway.querySymbols.bind(testGateway);
    testGateway.querySymbols = async () => (await originalRules()).map((rule) => ({
      ...rule, max_market_size: '0.01',
    }));
    const scanner = new FundingCandidateScanner(testGateway,
      async () => ({ apiKey: 'key', apiSecret: 'secret' }), market(),
      { observeAuthoritativeCandidate: vi.fn() } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], strictAssets: [], researchAssets: ['SOL'], targetNotionalUsd: '5',
        researchTargetNotionalUsd: '5', researchMaxActualNotionalUsd: '10', horizonHours: 24,
        fundingRetentionFactor: '0.5', stressSlippageBps: '5', adverseExitBasisBps: '10',
        onFundingData: async (_funding, _fees, rows) => { observations.push(...rows); }, now: () => NOW },
    );

    expect(await scanner.scan()).toBe(0);
    expect(observations[0]).toMatchObject({ researchEligible: false,
      primaryReason: 'quantity_exceeds_market_limit' });
  });

  it('毛费率最优组合不可用时继续评估已同步的执行器组合', async () => {
    const symbols = {
      BINANCE: 'BINANCE_FUTURE_SOL_USDT', OKX: 'OKX_FUTURE_SOL_USDT',
      KRAKEN: 'KRAKEN_FUTURE_SOL_USD', HYPERLIQUID: 'HYPERLIQUID_FUTURE_SOL_USDC',
    } as const;
    const rule = (venue: keyof typeof symbols) => ({ symbol: symbols[venue], exchange_type: venue,
      business_type: 'FUTURE', state: 'live', min_size: '0.01', min_notional: '5', lot_size: '0.01',
      tick_size: '0.01', max_num_orders: '10', max_market_size: '100', max_limit_size: '100',
      contract_size: '1', liquidation_fee: '0', delist_time: '0' });
    const testGateway = {
      querySymbols: async () => (Object.keys(symbols) as Array<keyof typeof symbols>).map(rule),
      queryFeeRates: async () => Object.keys(symbols).map((venue) => ({ exchange_type: venue,
        spot_maker_fee: '0', spot_taker_fee: '0', future_maker_fee: '0.0002', future_taker_fee: '0.0005' })),
      queryFundingInfo: async () => [
        { symbol: symbols.KRAKEN, funding_rate: '-0.01', funding_time: '2000000', funding_interval: '28800' },
        { symbol: symbols.HYPERLIQUID, funding_rate: '0.01', funding_time: '2000000', funding_interval: '28800' },
        { symbol: symbols.BINANCE, funding_rate: '-0.0001', funding_time: '2000000', funding_interval: '28800' },
        { symbol: symbols.OKX, funding_rate: '0.0002', funding_time: '2000000', funding_interval: '28800' },
      ],
    } as unknown as TradingCrossExGateway;
    const liveMarket = market();
    const marketReader = {
      ...liveMarket,
      pair: (_asset: string, longVenue: string, shortVenue: string) => {
        const pair = liveMarket.pair('SOL', 'BINANCE', 'OKX', NOW);
        return [longVenue, shortVenue].some((venue) => venue === 'KRAKEN' || venue === 'HYPERLIQUID')
          ? { ...pair, longVenue, shortVenue, quality: 'BOOTSTRAPPING' as const, reasons: ['venue_not_live'] }
          : { ...pair, longVenue, shortVenue };
      },
    } as unknown as ExecutionMarketReader;
    const observations: FundingScanObservation[] = [];
    const scanner = new FundingCandidateScanner(testGateway,
      async () => ({ apiKey: 'key', apiSecret: 'secret' }), marketReader,
      { observeAuthoritativeCandidate: vi.fn() } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], strictAssets: [], researchAssets: ['SOL'], targetNotionalUsd: '5',
        researchTargetNotionalUsd: '5', horizonHours: 24, fundingRetentionFactor: '0.5',
        stressSlippageBps: '5', adverseExitBasisBps: '10', minNetAnnualized: '0.1',
        researchMaxSlippageBps: '10', minLiquidityUsd: '900', maxPairsPerAsset: 1,
        onFundingData: async (_funding, _fees, rows) => { observations.push(...rows); }, now: () => NOW },
    );

    expect(await scanner.scan()).toBe(0);
    expect(observations).toHaveLength(2);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ longVenue: 'KRAKEN', shortVenue: 'HYPERLIQUID',
        status: 'REJECTED', primaryReason: 'market_not_synchronized' }),
      expect.objectContaining({ longVenue: 'BINANCE', shortVenue: 'OKX',
        status: 'RESEARCH_ELIGIBLE', researchEligible: true, marketQuality: 'LIVE_SYNCHRONIZED' }),
    ]));
  });

  it('跨 USD/USDC 报价先换算汇率、计提稳定币风险并保持仅研究标记', async () => {
    const makeBook = (venue: 'KRAKEN' | 'HYPERLIQUID', quote: 'USD' | 'USDC', rate: string) => ({
      venue, symbol: venue === 'KRAKEN' ? 'PF_SOLUSD' : 'SOL', base: 'SOL', quote,
      quoteToUsd: rate, quoteRateAgeMs: 0, quoteRateState: 'healthy' as const,
      bids: [['99', '100'] as const], asks: [['100', '100'] as const], sequence: 1,
      exchangeTimestamp: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), ageMs: 0,
      synchronized: true, connectionState: 'healthy' as const, rebuilds: 0, sequenceGaps: 0, lastError: null,
    });
    const kraken = makeBook('KRAKEN', 'USD', '1');
    const hyper = makeBook('HYPERLIQUID', 'USDC', '0.999');
    const marketReader = {
      start() {}, stop() {}, health: () => ({ state: 'healthy' as const, updatedAt: new Date(NOW).toISOString(), symbols: ['SOL'], venues: [] }),
      book: (venue: 'KRAKEN' | 'HYPERLIQUID') => venue === 'KRAKEN' ? kraken : hyper,
      pair: () => ({ base: 'SOL', longVenue: 'KRAKEN' as const, shortVenue: 'HYPERLIQUID' as const,
        quality: 'LIVE_SYNCHRONIZED' as const, reasons: [], exchangeSkewMs: 0, receiveSkewMs: 0,
        longBook: kraken, shortBook: hyper, certifiedAt: new Date(NOW).toISOString() }),
    } as unknown as ExecutionMarketReader;
    const rule = (symbol: string, venue: string) => ({ symbol, exchange_type: venue, business_type: 'FUTURE',
      state: 'live', min_size: '0.01', min_notional: '5', lot_size: '0.01', tick_size: '0.01', max_num_orders: '10',
      max_market_size: '100', max_limit_size: '100', contract_size: '1', liquidation_fee: '0', delist_time: '0' });
    const testGateway = { querySymbols: async () => [rule('KRAKEN_FUTURE_SOL_USD', 'KRAKEN'),
      rule('HYPERLIQUID_FUTURE_SOL_USDC', 'HYPERLIQUID')],
      queryFeeRates: async () => ['KRAKEN', 'HYPERLIQUID'].map((venue) => ({ exchange_type: venue,
        spot_maker_fee: '0', spot_taker_fee: '0', future_maker_fee: '0.0002', future_taker_fee: '0.0005' })),
      queryFundingInfo: async () => [
        { symbol: 'KRAKEN_FUTURE_SOL_USD', funding_rate: '-0.001', funding_time: '2000000', funding_interval: '28800' },
        { symbol: 'HYPERLIQUID_FUTURE_SOL_USDC', funding_rate: '0.001', funding_time: '2000000', funding_interval: '28800' },
      ] } as unknown as TradingCrossExGateway;
    let row: FundingScanObservation | undefined;
    const scanner = new FundingCandidateScanner(testGateway, async () => ({ apiKey: 'key', apiSecret: 'secret' }),
      marketReader, { observeAuthoritativeCandidate: vi.fn() } as unknown as FundingArbitrageEngine,
      { assets: ['SOL'], strictAssets: ['SOL'], researchAssets: ['SOL'], targetNotionalUsd: '5',
        researchTargetNotionalUsd: '5', horizonHours: 24, fundingRetentionFactor: '0.5', stressSlippageBps: '0',
        adverseExitBasisBps: '0', stablecoinRiskBps: '5', minLiquidityUsd: '900', researchMaxSlippageBps: '10',
        onFundingData: async (_funding, _fees, rows) => { row = rows[0]; }, now: () => NOW });

    expect(await scanner.scan()).toBe(0);
    expect(row).toMatchObject({ executionSupport: 'RESEARCH_ONLY', longQuote: 'USD', shortQuote: 'USDC',
      longQuoteToUsd: '1', shortQuoteToUsd: '0.999', researchEligible: true });
    expect(Number(row?.stablecoinRiskBuffer)).toBeGreaterThan(0);
  });
});
