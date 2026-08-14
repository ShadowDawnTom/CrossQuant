import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { FundingHoldingMonitor } from './funding-holding-monitor.js';
import type { FundingArbitrageEngine } from './funding-arbitrage-engine.js';
import type { GateFeeRate, GateFundingInfo, PortfolioOperationsCrossExGateway } from './crossex-client.js';

const resources: Array<{ directory: string; database: { close(): void } }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('FundingHoldingMonitor', () => {
  it('复用扫描数据落快照、限频评估持仓并对账账户流水', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-monitor-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    let currentTime = Date.parse('2026-08-14T00:00:00.000Z');
    const funding: GateFundingInfo[] = [
      { symbol: 'BINANCE_FUTURE_SOL_USDT', funding_rate: '-0.001',
        funding_time: String(currentTime + 28_800_000), funding_interval: '28800' },
      { symbol: 'OKX_FUTURE_SOL_USDT', funding_rate: '0.001',
        funding_time: String(currentTime + 28_800_000), funding_interval: '28800' },
    ];
    const fees: GateFeeRate[] = ['BINANCE', 'OKX'].map((venue) => ({ exchange_type: venue,
      spot_maker_fee: '0', spot_taker_fee: '0', future_maker_fee: '0.0002', future_taker_fee: '0.0005' }));
    const evaluateOpenTrade = vi.fn(async () => undefined);
    const markHoldingDataUnavailable = vi.fn(async () => undefined);
    const reconcileFundingLedger = vi.fn(async () => 1);
    const engine = { list: () => [{ id: 'trade-1', state: 'OPEN', asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX' }],
      evaluateOpenTrade, markHoldingDataUnavailable, reconcileFundingLedger } as unknown as FundingArbitrageEngine;
    const queryAccountBook = vi.fn(async () => [{ id: 'book-1', business_id: 'settlement-1', statement_type: 'FUNDING_FEE',
      exchange_type: 'okx', coin: 'USDT', symbol: 'okx_future_sol_usdt', change: '0.01', balance: '100',
      create_time: new Date(currentTime).toISOString() }]);
    const gateway = { queryAccountBook } as unknown as PortfolioOperationsCrossExGateway;
    const monitor = new FundingHoldingMonitor(database, gateway, async () => ({ apiKey: 'key', apiSecret: 'secret' }),
      engine, 60_000, () => currentTime);

    expect(await monitor.observe(funding, fees)).toBe(1);
    expect(evaluateOpenTrade).toHaveBeenCalledOnce();
    expect(reconcileFundingLedger).toHaveBeenCalledWith([expect.objectContaining({
      symbol: 'OKX_FUTURE_SOL_USDT', venue: 'OKX', change: '0.01',
    })]);
    expect((database.prepare('SELECT COUNT(*) AS count FROM funding_rate_snapshots').get() as { count: number }).count).toBe(2);

    expect(await monitor.observe(funding, fees)).toBe(0);
    expect(evaluateOpenTrade).toHaveBeenCalledOnce();
    currentTime += 60_000;
    expect(await monitor.observe(funding.slice(0, 1), fees)).toBe(0);
    expect(markHoldingDataUnavailable).toHaveBeenCalledWith('trade-1', 'funding_or_fee_missing', expect.any(Object));
  });
});
