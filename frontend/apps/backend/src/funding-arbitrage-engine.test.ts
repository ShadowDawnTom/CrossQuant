import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { AlertDispatcher } from './alert-dispatcher.js';
import { FundingArbitrageEngine } from './funding-arbitrage-engine.js';
import type { ExecutionMarketReader } from './execution-market-hub.js';
import type { ExecutionOrder, TradingRuntime } from './trading-runtime.js';

const harnesses: Array<{ directory: string; database: { close(): void } }> = [];

function order(id: string, side: 'BUY' | 'SELL', quantity = '0.1', state = 'FILLED'): ExecutionOrder {
  return { id, remoteOrderId: `remote-${id}`, clientOrderId: `client-${id}`, symbol: 'BINANCE_FUTURE_SOL_USDT',
    venue: 'BINANCE', side, type: 'MARKET', timeInForce: 'FOK', quantity, price: null, reduceOnly: false,
    state, executedQuantity: state === 'FILLED' ? quantity : '0', executedAveragePrice: '100', failureReason: null,
    strategyId: null, strategyLeg: null, strategyClip: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function market(): ExecutionMarketReader {
  const book = (venue: 'BINANCE' | 'OKX') => ({ venue, symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT' as const,
    bids: [['99.9', '100'] as const], asks: [['100', '100'] as const], sequence: 1,
    exchangeTimestamp: new Date().toISOString(), receivedAt: new Date().toISOString(), ageMs: 1,
    synchronized: true, connectionState: 'healthy' as const, rebuilds: 0, sequenceGaps: 0, lastError: null });
  return {
    start() {}, stop() {},
    health: () => ({ state: 'healthy', updatedAt: new Date().toISOString(), symbols: ['SOL'], venues: [] }),
    book: (venue) => book(venue as 'BINANCE' | 'OKX'),
    pair: () => ({ base: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quality: 'LIVE_SYNCHRONIZED', reasons: [],
      exchangeSkewMs: 1, receiveSkewMs: 1, longBook: book('BINANCE'), shortBook: book('OKX'), certifiedAt: new Date().toISOString() }),
  };
}

function harness(states: string[] = ['FILLED', 'FILLED'], minimumNotional = '5') {
  const directory = mkdtempSync(join(tmpdir(), 'funding-engine-'));
  const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
  harnesses.push({ directory, database });
  let sequence = 0;
  let plannedGrossExposure: string | undefined;
  const orders = new Map<string, ExecutionOrder>();
  const runtime = {
    prepareStrategyMargin: async () => ({ requiredMargin: '1', availableMargin: '100' }),
    createOrder: async (input: { side: 'BUY' | 'SELL'; quantity: string; type: 'LIMIT' | 'MARKET'; price?: string }, metadata: { clientOrderId: string }) => {
      sequence += 1;
      if (states[sequence - 1] === 'THROW') throw new Error('definitive submit rejection');
      const created = order(String(sequence), input.side, input.quantity, states[sequence - 1] ?? 'FILLED');
      created.type = input.type;
      created.price = input.price ?? null;
      created.clientOrderId = metadata.clientOrderId;
      created.executedQuantity = created.state === 'FILLED' ? input.quantity : '0';
      orders.set(created.id, created);
      return created;
    },
    getOrderByClientOrderId: (clientId: string) => [...orders.values()].find((item) => item.clientOrderId === clientId) ?? null,
    refreshOrderFromRemote: async (id: string) => orders.get(id) ?? null,
    awaitTerminalOrder: async (id: string) => orders.get(id)!,
    cancelOrder: async (id: string) => orders.get(id)!,
  } as unknown as TradingRuntime;
  const killReasons: string[] = [];
  const engine = new FundingArbitrageEngine(database, runtime, market(), {
    limits: { enabled: true, maxNotionalPerLegUsd: '20', maxConcurrentTrades: 1, maxUnhedgedMs: 20,
      maxNetBaseExposure: '1', maxEntrySlippageBps: '5', maxBasisBps: '30', maxHoldingMs: 60_000,
      confirmationCount: 2, confirmationWindowMs: 10_000, minNetAnnualized: '0.1', leverage: '1' },
    accountRiskCheck: (planned) => { plannedGrossExposure = planned; return { safe: true }; }, alertDispatcher: new AlertDispatcher(database, { webhookUrl: null }),
    loadInstrumentRules: async (symbols) => symbols.map((symbol) => ({ symbol, state: 'live', minSize: '0.01',
      minNotional: minimumNotional, lotSize: '0.01', tickSize: '0.01', maxMarketSize: '1000', maxLimitSize: '1000' })),
    onKillSwitch: (reason) => { killReasons.push(reason); }, orderTimeoutMs: 20,
  });
  return { engine, database, killReasons, orders, plannedGrossExposure: () => plannedGrossExposure };
}

async function confirmed(engine: FundingArbitrageEngine) {
  const observation = { asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1',
    longRate: '0.0001', shortRate: '0.0003', netAnnualized: '0.2' };
  await engine.observeAuthoritativeCandidate(observation);
  return engine.observeAuthoritativeCandidate(observation);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

describe('FundingArbitrageEngine', () => {
  it('并发成交两腿后持久化等量 OPEN 仓位，并保证请求幂等', async () => {
    const { engine, orders } = harness();
    const candidate = await confirmed(engine);
    const input = { idempotencyKey: 'funding:test:1', candidateId: candidate.id, asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1' };
    const opened = await engine.start(input);
    expect(opened.state).toBe('OPEN');
    expect(opened.openQuantity).toBe('0.1');
    expect((await engine.start(input)).id).toBe(opened.id);
    expect(orders.size).toBe(2);
    expect([...orders.values()].every((item) => item.type === 'LIMIT' && item.price !== null)).toBe(true);
  });

  it('一腿未成交时用 reduce-only IOC 反向清掉已成交腿', async () => {
    const { engine, orders, killReasons } = harness(['FILLED', 'FAIL', 'FILLED']);
    const candidate = await confirmed(engine);
    const result = await engine.start({ idempotencyKey: 'funding:test:2', candidateId: candidate.id, asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1', timeInForce: 'IOC' });
    expect(result.state).toBe('REJECTED');
    expect(orders.size).toBe(3);
    expect([...orders.values()][2]?.side).toBe('SELL');
    expect(killReasons).toEqual([]);
  });

  it('敞口修复也失败时进入人工接管并触发全局 Kill Switch', async () => {
    const { engine, killReasons } = harness(['FILLED', 'FAIL', 'FAIL']);
    const candidate = await confirmed(engine);
    const result = await engine.start({ idempotencyKey: 'funding:test:3', candidateId: candidate.id, asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1' });
    expect(result.state).toBe('MANUAL_INTERVENTION');
    expect(result.manualReason).toBe('entry_residual_unresolved');
    expect(killReasons).toHaveLength(1);
  });

  it('第二腿明确拒绝且没有本地订单时仍自动清掉第一腿', async () => {
    const { engine, orders, killReasons } = harness(['FILLED', 'THROW', 'FILLED']);
    const candidate = await confirmed(engine);
    const result = await engine.start({ idempotencyKey: 'funding:test:4', candidateId: candidate.id,
      asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1' });
    expect(result.state).toBe('REJECTED');
    expect([...orders.values()].at(-1)?.side).toBe('SELL');
    expect(killReasons).toEqual([]);
  });

  it('入场前把两腿预计名义敞口传给账户硬风控', async () => {
    const { engine, plannedGrossExposure } = harness();
    const candidate = await confirmed(engine);
    await engine.start({ idempotencyKey: 'funding:test:risk', candidateId: candidate.id,
      asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1' });
    expect(plannedGrossExposure()).toBe('19.99');
  });

  it('任一腿不满足最小名义金额时在创建订单前拒绝', async () => {
    const { engine, orders } = harness(['FILLED', 'FILLED'], '50');
    const candidate = await confirmed(engine);
    await expect(engine.start({ idempotencyKey: 'funding:test:min-notional', candidateId: candidate.id,
      asset: 'SOL', longVenue: 'BINANCE', shortVenue: 'OKX', quantity: '0.1' }))
      .rejects.toMatchObject({ code: 'order_below_minimum_notional' });
    expect(orders.size).toBe(0);
  });

  it('重启后无法确认的入场状态转人工并触发 Kill Switch', async () => {
    const { engine, database, killReasons } = harness();
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO funding_arbitrage_trades
      (id, idempotency_key, asset, long_venue, short_venue, requested_quantity, state, phase, execution_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('restart-uncertain', 'funding:restart:uncertain', 'SOL', 'BINANCE', 'OKX', '0.1', 'SUBMITTING', 'ENTRY', 'FOK', now, now);
    expect(await engine.recover()).toBe(true);
    expect(engine.get('restart-uncertain').state).toBe('MANUAL_INTERVENTION');
    expect(killReasons).toEqual(['funding_arbitrage:restart-uncertain:restart_reconciliation_uncertain']);
  });
});
