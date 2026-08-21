import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingOverviewResponse } from '@gate-crossex/shared-types';
import type { GateCrossExSymbol, GateFundingInfo } from './crossex-client.js';
import { openDatabase } from './database.js';
import { FundingDiscoveryService } from './funding-discovery-service.js';

const resources: Array<{ directory: string; database: { close(): void } }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('FundingDiscoveryService', () => {
  it('只把规则、Ticker、持仓量和持续性都通过的资产提升到盘口热池', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-discovery-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    const now = Date.parse('2026-08-21T00:00:00.000Z');
    const changed = vi.fn(async () => undefined);
    const service = new FundingDiscoveryService(database, {
      assets: ['SOL', 'DOGE'], initialHotAssets: ['SOL'], requiredAssets: ['SOL'], hotPoolSize: 2,
      minOpenInterestUsd: '1000000', promotionConfirmations: 1, snapshotIntervalMs: 1,
      minEdgeDurationMs: 0, maxDirectionFlips24h: 3, minHotDwellMs: 1_000,
      onHotPoolChanged: changed, now: () => now,
    });
    const funding = ['SOL', 'DOGE'].flatMap((asset): GateFundingInfo[] => [
      { symbol: `BINANCE_FUTURE_${asset}_USDT`, funding_rate: '-0.0001',
        funding_time: String(now + 3_600_000), funding_interval: '28800' },
      { symbol: `OKX_FUTURE_${asset}_USDT`, funding_rate: asset === 'DOGE' ? '0.001' : '0.0002',
        funding_time: String(now + 3_600_000), funding_interval: '28800' },
    ]);
    const rules = funding.map((item) => ({ symbol: item.symbol, state: 'live', lot_size: '0.1',
      min_size: '0.1', min_notional: '5', max_market_size: '100000' })) as GateCrossExSymbol[];
    const overview = {
      assets: ['SOL', 'DOGE'].map((asset) => ({ asset, bestExecution: null, venues: [
        { venue: 'BINANCE', symbol: `BINANCE_FUTURE_${asset}_USDT`, quote: 'USDT', fundingRate: '-0.0001',
          nextFundingAt: new Date(now + 3_600_000).toISOString(), openInterestValue: '5000000',
          lastPrice: '100', change24h: '0.01', fetchedAt: new Date(now).toISOString(), executionSupport: 'live_ready' },
        { venue: 'OKX', symbol: `OKX_FUTURE_${asset}_USDT`, quote: 'USDT', fundingRate: '0.0002',
          nextFundingAt: new Date(now + 3_600_000).toISOString(),
          openInterestValue: asset === 'DOGE' ? '3000000' : '4000000', lastPrice: '100', change24h: '0.02',
          fetchedAt: new Date(now).toISOString(), executionSupport: 'live_ready' },
      ] })), venueStatus: [], fetchedAt: new Date(now).toISOString(), cacheStatus: 'fresh',
    } as FundingOverviewResponse;

    expect(await service.observe(funding, rules, overview)).toEqual(['DOGE', 'SOL']);
    expect(changed).toHaveBeenCalledWith(['SOL', 'DOGE']);
    expect(service.summary()).toMatchObject({ universeSize: 2, hotPoolSize: 2, eligibleCount: 2,
      hotAssets: ['SOL', 'DOGE'] });
    expect(service.summary().assets[0]).toMatchObject({ asset: 'DOGE', inHotPool: true,
      eligibleForHotPool: true, primaryReason: 'discovery_hot_pool_eligible' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM funding_discovery_snapshots').get())
      .toEqual({ count: 2 });

    const missingOi = structuredClone(overview);
    (missingOi.assets.find((item) => item.asset === 'DOGE')!.venues[1] as { openInterestValue: string | null })
      .openInterestValue = null;
    expect(await service.observe(funding, rules, missingOi)).toEqual(['SOL']);
    expect(service.summary().assets.find((item) => item.asset === 'DOGE')).toMatchObject({
      inHotPool: true, eligibleForHotPool: false, primaryReason: 'discovery_open_interest_missing',
    });
  });
});
