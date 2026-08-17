import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GateFeeRate, GateFundingInfo } from './crossex-client.js';
import { openDatabase } from './database.js';
import type { ExecutionMarketReader } from './execution-market-hub.js';
import type { FundingScanObservation } from './funding-candidate-scanner.js';
import { FundingResearchEngine } from './funding-research-engine.js';

const resources: Array<{ directory: string; database: { close(): void } }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function market(now: () => number): ExecutionMarketReader {
  const book = (venue: 'BINANCE' | 'GATE', bids: Array<readonly [string, string]>, asks: Array<readonly [string, string]>) => ({
    venue, symbol: `${venue}_FUTURE_SOL_USDT`, base: 'SOL', quote: 'USDT' as const, bids, asks, sequence: 1,
    quoteToUsd: '1', quoteRateAgeMs: 0, quoteRateState: 'healthy' as const,
    exchangeTimestamp: new Date(now()).toISOString(), receivedAt: new Date(now()).toISOString(), ageMs: 0,
    synchronized: true, connectionState: 'healthy' as const, rebuilds: 0, sequenceGaps: 0, lastError: null,
  });
  const longBook = () => book('BINANCE', [['99.9', '10']], [['100', '10']]);
  const shortBook = () => book('GATE', [['100.2', '10']], [['100.3', '10']]);
  return {
    start() {}, stop() {},
    health: () => ({ state: 'healthy', updatedAt: new Date(now()).toISOString(), symbols: ['SOL'], venues: [] }),
    book: (venue) => venue === 'BINANCE' ? longBook() : shortBook(),
    pair: () => ({ base: 'SOL', longVenue: 'BINANCE', shortVenue: 'GATE', quality: 'LIVE_SYNCHRONIZED',
      reasons: [], exchangeSkewMs: 2, receiveSkewMs: 3, longBook: longBook(), shortBook: shortBook(),
      certifiedAt: new Date(now()).toISOString() }),
  };
}

function funding(now: number): GateFundingInfo[] {
  return [
    { symbol: 'BINANCE_FUTURE_SOL_USDT', funding_rate: '-0.00005', funding_time: String(now + 60_000), funding_interval: '60' },
    { symbol: 'GATE_FUTURE_SOL_USDT', funding_rate: '0.00003', funding_time: String(now + 60_000), funding_interval: '60' },
  ];
}

const fees: GateFeeRate[] = ['BINANCE', 'GATE'].map((venue) => ({ exchange_type: venue,
  spot_maker_fee: '0', spot_taker_fee: '0', future_maker_fee: '0.0002', future_taker_fee: '0.0005' }));

function observation(now: number): FundingScanObservation {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scanId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    observedAt: new Date(now).toISOString(), asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'GATE',
    quantity: '0.05', status: 'RESEARCH_ELIGIBLE', strictEligible: false, researchEligible: true,
    primaryReason: 'funding_net_return_below_threshold',
    reasons: ['funding_net_return_below_threshold', 'research_liquidity_passed'], marketQuality: 'LIVE_SYNCHRONIZED',
    longRate: '-0.00005', shortRate: '0.00003', longEvents: 1, shortEvents: 1,
    entryLongPrice: '100', entryShortPrice: '100.2', exitLongPrice: '99.9', exitShortPrice: '100.3',
    entryLongNotional: '5', entryShortNotional: '5.01', rawFundingPnl: '0.0004003',
    conservativeFundingPnl: '0.00020015', immediateRoundTripPnl: '-0.01', entryFees: '0.005005',
    exitFees: '0.005005', tradingFees: '0.01001', stressBuffer: '0.0075', netPnl: '-0.02730985',
    rawAnnualized: '0.0292', netAnnualized: '-1.99', breakEvenHours: '1349',
    entrySlippageBps: '0', exitSlippageBps: '0', basisBps: '19.98',
    longQuote: 'USDT', shortQuote: 'USDT', longQuoteToUsd: '1', shortQuoteToUsd: '1',
    liquidityUsd: '1000', executionSupport: 'LIVE_READY',
    stablecoinRiskBuffer: '0',
  };
}

describe('FundingResearchEngine', () => {
  it('允许负净收益研究仓位，但必须经历至少一次模拟结算后才平仓', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-research-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    let currentTime = Date.parse('2026-08-15T00:00:00.000Z');
    const engine = new FundingResearchEngine(database, market(() => currentTime), {
      enabled: true, targetNotionalUsd: '5', maxOpenPositions: 1, minimumSettledEvents: 1,
      stressSlippageBps: '0', adverseExitBasisBps: '0', fundingRetentionFactor: '0.5',
    }, () => currentTime);

    expect(await engine.observe([observation(currentTime)], funding(currentTime), fees)).toBe(2);
    expect(engine.list()).toHaveLength(2);
    expect(engine.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ cohort: 'ONE_SETTLEMENT', state: 'OPEN', monitorState: 'HOLD', settledEvents: 0 }),
      expect.objectContaining({ cohort: 'ROLLING', state: 'OPEN', monitorState: 'HOLD', settledEvents: 0 }),
    ]));
    expect(engine.summary()).toMatchObject({ enabled: true, openCount: 2, scan24h: {
      observations: 1, liveEligible: 0, researchEligible: 1, rejected: 0,
    } });

    currentTime += 61_000;
    await engine.observe([observation(currentTime)], funding(currentTime), fees);
    const oneSettlement = engine.list().find((item) => item.cohort === 'ONE_SETTLEMENT')!;
    const rolling = engine.list().find((item) => item.cohort === 'ROLLING')!;
    expect(oneSettlement).toMatchObject({ state: 'CLOSED', monitorState: 'EXIT', settledEvents: 2,
      lastReason: 'research_minimum_settlement_completed' });
    expect(rolling).toMatchObject({ state: 'OPEN', monitorState: 'HOLD', settledEvents: 2 });
    expect(Number(oneSettlement.fundingPnl)).toBeGreaterThan(0);
    expect(engine.details(oneSettlement.id)?.settlements.filter((item) => item.state === 'SETTLED')).toHaveLength(2);
    expect(engine.details(oneSettlement.id)?.evaluations.some((item) => item.decision === 'EXIT')).toBe(true);
  });

  it('关闭探索模拟时仍保存拒绝原因，但不会创建持仓', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-research-disabled-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    const currentTime = Date.parse('2026-08-15T00:00:00.000Z');
    const engine = new FundingResearchEngine(database, market(() => currentTime), {
      enabled: false, targetNotionalUsd: '5', maxOpenPositions: 1, minimumSettledEvents: 1,
    }, () => currentTime);
    const rejected = { ...observation(currentTime), status: 'REJECTED' as const, researchEligible: false,
      primaryReason: 'market_not_synchronized', reasons: ['market_not_synchronized'] };

    expect(await engine.observe([rejected], funding(currentTime), fees)).toBe(0);
    expect(engine.list()).toEqual([]);
    expect(engine.summary()).toMatchObject({ enabled: false, scan24h: { observations: 1, rejected: 1 },
      rejectionReasons: [{ reason: 'market_not_synchronized', count: 1 }] });
  });
});
