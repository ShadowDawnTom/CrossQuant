import { describe, expect, it, vi } from 'vitest';
import { FundingCandidateScanner } from './funding-candidate-scanner.js';
import type { ExecutionMarketReader } from './execution-market-hub.js';
import type { FundingArbitrageEngine } from './funding-arbitrage-engine.js';
import type { TradingCrossExGateway } from './crossex-client.js';

const NOW = 1_000_000;

function market(depth = '10'): ExecutionMarketReader {
  const book = (venue: 'BINANCE' | 'OKX', bids: Array<readonly [string, string]>, asks: Array<readonly [string, string]>) => ({
    venue, symbol: `${venue}_FUTURE_SOL_USDT`, base: 'SOL', quote: 'USDT' as const, bids, asks, sequence: 1,
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
        researchMaxSlippageBps: '10', onFundingData: async (_funding, _fees, rows) => { observations.push(...rows); },
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
});
