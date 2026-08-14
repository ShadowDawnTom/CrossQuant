import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GateFeeRate, GateFundingInfo } from './crossex-client.js';
import { openDatabase } from './database.js';
import type { ExecutionMarketReader } from './execution-market-hub.js';
import type { FundingCandidateRecord } from './funding-arbitrage-engine.js';
import { FundingPaperEngine } from './funding-paper-engine.js';

const resources: Array<{ directory: string; database: { close(): void } }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function market(now: () => number, quality: () => 'LIVE_SYNCHRONIZED' | 'LIVE_UNSYNCHRONIZED' = () => 'LIVE_SYNCHRONIZED'): ExecutionMarketReader {
  const book = (venue: 'BINANCE' | 'OKX', bids: Array<readonly [string, string]>, asks: Array<readonly [string, string]>) => ({
    venue, symbol: `${venue}:SOL`, base: 'SOL', quote: 'USDT' as const, bids, asks, sequence: 1,
    exchangeTimestamp: new Date(now()).toISOString(), receivedAt: new Date(now()).toISOString(), ageMs: 1,
    synchronized: true, connectionState: 'healthy' as const, rebuilds: 0, sequenceGaps: 0, lastError: null,
  });
  return {
    start() {}, stop() {},
    health: () => ({ state: 'healthy', updatedAt: new Date(now()).toISOString(), symbols: ['SOL'], venues: [] }),
    book: (venue) => venue === 'BINANCE'
      ? book('BINANCE', [['99.9', '10']], [['100', '10']])
      : book('OKX', [['100.2', '10']], [['100.3', '10']]),
    pair: () => ({ base: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quality: quality(),
      reasons: quality() === 'LIVE_SYNCHRONIZED' ? [] : ['book_stale'],
      exchangeSkewMs: 1, receiveSkewMs: 1,
      longBook: book('BINANCE', [['99.9', '10']], [['100', '10']]),
      shortBook: book('OKX', [['100.2', '10']], [['100.3', '10']]),
      certifiedAt: new Date(now()).toISOString() }),
  };
}

function funding(now: number, longRate = '-0.001', shortRate = '0.001'): GateFundingInfo[] {
  return [
    { symbol: 'BINANCE_FUTURE_SOL_USDT', funding_rate: longRate,
      funding_time: String(now + 60_000), funding_interval: '60' },
    { symbol: 'OKX_FUTURE_SOL_USDT', funding_rate: shortRate,
      funding_time: String(now + 60_000), funding_interval: '60' },
  ];
}

const fees: GateFeeRate[] = ['BINANCE', 'OKX'].map((venue) => ({ exchange_type: venue,
  spot_maker_fee: '0', spot_taker_fee: '0', future_maker_fee: '0.0002', future_taker_fee: '0.0005' }));

describe('FundingPaperEngine', () => {
  it('按同步盘口幂等开仓、模拟结算，并在费率反转时自动平仓', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-paper-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    let currentTime = Date.parse('2026-08-14T00:00:00.000Z');
    const candidate: FundingCandidateRecord = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', candidateKey: 'SOL:BINANCE:OKX:0.1', asset: 'SOL',
      longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1', longRate: '-0.001', shortRate: '0.001',
      netAnnualized: '0.5', confirmationCount: 3, state: 'CONFIRMED',
      firstSeenAt: new Date(currentTime).toISOString(), lastSeenAt: new Date(currentTime).toISOString(), consumedAt: null,
    };
    database.prepare(`INSERT INTO funding_arbitrage_candidates
      (id, candidate_key, asset, long_venue, short_venue, quantity, long_rate, short_rate, net_annualized,
       confirmation_count, state, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidate.id, candidate.candidateKey, candidate.asset, candidate.longVenue, candidate.shortVenue,
        candidate.quantity, candidate.longRate, candidate.shortRate, candidate.netAnnualized,
        candidate.confirmationCount, candidate.state, candidate.firstSeenAt, candidate.lastSeenAt);
    const engine = new FundingPaperEngine(database, market(() => currentTime), () => [candidate], {
      enabled: true, maxOpenPositions: 1, confirmationWindowMs: 180_000,
      holdingEventsPerLeg: 2, holdingExitConfirmationCount: 3, minimumHoldValueUsd: '0',
      settlementGuardMs: 1_000, maxHoldingMs: 3_600_000, softReviewMs: 1_800_000,
      fundingRetentionFactor: '0.5', stressSlippageBps: '0', adverseExitBasisBps: '0',
    }, () => currentTime);

    expect(await engine.observe(funding(currentTime), fees)).toBe(1);
    expect(engine.summary()).toMatchObject({ enabled: true, openCount: 1, closedCount: 0 });
    expect(engine.list()).toHaveLength(1);
    expect(Number(engine.list()[0]!.pricePnl)).toBeLessThan(0);
    expect(Number(engine.list()[0]!.exitFees)).toBeGreaterThan(0);
    expect(engine.details(engine.list()[0]!.id)?.settlements).toHaveLength(4);

    // 进程重启使用同一个候选时不能再开第二笔；到点结算使用最后保存的预测费率模拟到账。
    currentTime += 61_000;
    const restarted = new FundingPaperEngine(database, market(() => currentTime), () => [candidate], {
      enabled: true, maxOpenPositions: 1, confirmationWindowMs: 180_000,
      holdingEventsPerLeg: 2, holdingExitConfirmationCount: 3, minimumHoldValueUsd: '0',
      settlementGuardMs: 1_000, maxHoldingMs: 3_600_000, softReviewMs: 1_800_000,
      fundingRetentionFactor: '0.5', stressSlippageBps: '0', adverseExitBasisBps: '0',
    }, () => currentTime);
    await restarted.observe(funding(currentTime), fees);
    expect(restarted.list()).toHaveLength(1);
    expect(Number(restarted.list()[0]!.fundingPnl)).toBeGreaterThan(0);

    currentTime += 60_000;
    await restarted.observe(funding(currentTime, '0.001', '-0.001'), fees);
    const closed = restarted.list()[0]!;
    expect(closed.state).toBe('CLOSED');
    expect(closed.lastReason).toBe('funding_direction_reversed');
    expect(closed.exitLongPrice).toBe('99.9');
    expect(closed.exitShortPrice).toBe('100.3');
    expect(restarted.details(closed.id)?.evaluations.some((item) => item.decision === 'EXIT')).toBe(true);
    expect(restarted.details(closed.id)?.settlements.some((item) => item.state === 'SETTLED')).toBe(true);
  });

  it('连续三轮行情降级后，在恢复可成交的第一轮按当前盘口退出', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-paper-degraded-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    let currentTime = Date.parse('2026-08-14T00:00:00.000Z');
    let synchronized = true;
    const candidate: FundingCandidateRecord = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', candidateKey: 'SOL:BINANCE:OKX:0.1', asset: 'SOL',
      longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1', longRate: '-0.001', shortRate: '0.001',
      netAnnualized: '0.5', confirmationCount: 3, state: 'CONFIRMED',
      firstSeenAt: new Date(currentTime).toISOString(), lastSeenAt: new Date(currentTime).toISOString(), consumedAt: null,
    };
    database.prepare(`INSERT INTO funding_arbitrage_candidates
      (id, candidate_key, asset, long_venue, short_venue, quantity, long_rate, short_rate, net_annualized,
       confirmation_count, state, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidate.id, candidate.candidateKey, candidate.asset, candidate.longVenue, candidate.shortVenue,
        candidate.quantity, candidate.longRate, candidate.shortRate, candidate.netAnnualized,
        candidate.confirmationCount, candidate.state, candidate.firstSeenAt, candidate.lastSeenAt);
    const engine = new FundingPaperEngine(database, market(() => currentTime,
      () => synchronized ? 'LIVE_SYNCHRONIZED' : 'LIVE_UNSYNCHRONIZED'), () => [candidate], {
      enabled: true, maxOpenPositions: 1, confirmationWindowMs: 180_000,
      holdingEventsPerLeg: 2, holdingExitConfirmationCount: 3, minimumHoldValueUsd: '0',
      settlementGuardMs: 1_000, maxHoldingMs: 3_600_000, softReviewMs: 1_800_000,
      fundingRetentionFactor: '0.5', stressSlippageBps: '0', adverseExitBasisBps: '0',
    }, () => currentTime);
    await engine.observe(funding(currentTime), fees);

    synchronized = false;
    for (let scan = 0; scan < 3; scan += 1) {
      currentTime += 60_000;
      await engine.observe(funding(currentTime), fees);
    }
    expect(engine.list()[0]).toMatchObject({ state: 'OPEN', monitorState: 'DEGRADED', dataFailureCount: 3 });

    synchronized = true;
    currentTime += 60_000;
    await engine.observe(funding(currentTime), fees);
    expect(engine.list()[0]).toMatchObject({ state: 'CLOSED', lastReason: 'market_data_degraded' });
  });

  it('不为观察中或已经过期的候选创建模拟仓位', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-paper-stale-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    const currentTime = Date.parse('2026-08-14T00:10:00.000Z');
    const candidate = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', candidateKey: 'SOL:BINANCE:OKX:0.1',
      asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1', longRate: '-0.001',
      shortRate: '0.001', netAnnualized: '0.5', confirmationCount: 2, state: 'OBSERVING',
      firstSeenAt: new Date(currentTime - 600_000).toISOString(), lastSeenAt: new Date(currentTime - 600_000).toISOString(),
      consumedAt: null } as FundingCandidateRecord;
    const engine = new FundingPaperEngine(database, market(() => currentTime), () => [candidate], {
      enabled: true, maxOpenPositions: 1, confirmationWindowMs: 180_000,
      holdingEventsPerLeg: 2, holdingExitConfirmationCount: 3, minimumHoldValueUsd: '0',
      settlementGuardMs: 1_000, maxHoldingMs: 3_600_000, softReviewMs: 1_800_000,
      fundingRetentionFactor: '0.5', stressSlippageBps: '0', adverseExitBasisBps: '0',
    }, () => currentTime);
    expect(await engine.observe(funding(currentTime), fees)).toBe(0);
    expect(engine.list()).toEqual([]);
  });
});
