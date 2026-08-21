import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, connectTerminalStream } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local API request coordination', () => {
  it('coalesces concurrent reads of the same execution snapshot', async () => {
    let release: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);

    const first = api.tradingSnapshot();
    const second = api.tradingSnapshot();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    release?.(new Response(JSON.stringify({
      mode: 'live', orders: [], positions: [], fills: [], balances: [],
    })));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the upstream Gate label when a leverage update is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
    }), { status: 400 })));

    await expect(api.startStrategy({} as never)).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
      message: 'strategy leverage rejected (INVALID_LEVERAGE)',
    }));
  });

  it('rejects a successful response that violates the shared runtime contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      mode: 'live',
      orders: 'not-an-array',
    }))));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(200, 'invalid_backend_response'));
  });

  it('turns an expired request deadline into an actionable timeout error', async () => {
    const timeout = AbortSignal.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout);
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}');
    }));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(0, 'request_timeout'));
  });

  it('uses explicit intents and shared contracts for portfolio funding operations', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/crossex/transfer-coins') return new Response(JSON.stringify({
        items: [{ coin: 'USDT', minimumAmount: '1', estimatedFee: '0', precision: 6, disabled: false }],
        fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
      }));
      if (path === '/api/crossex/transfer-balances') return new Response(JSON.stringify({
        items: [{ account: 'SPOT', coin: 'USDT', available: '25.125' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path.startsWith('/api/crossex/portfolio-activity?')) return new Response(JSON.stringify({
        transfers: [], accountBook: [], fundingFees: [], fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path === '/api/crossex/transfers' && init?.method === 'POST') return new Response(JSON.stringify({
        transactionId: 'tx-1', text: 'portfolio_1',
      }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.transferCoins()).resolves.toMatchObject({ items: [{ coin: 'USDT', precision: 6 }] });
    await expect(api.transferBalances()).resolves.toMatchObject({ items: [{ account: 'SPOT', available: '25.125' }] });
    await expect(api.portfolioActivity('USDT')).resolves.toMatchObject({ transfers: [], accountBook: [], fundingFees: [] });
    await expect(api.transferFunds({
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    })).resolves.toEqual({ transactionId: 'tx-1', text: 'portfolio_1' });

    const activityInit = fetchMock.mock.calls.find(([path]) => String(path).startsWith('/api/crossex/portfolio-activity?'))?.[1];
    const balancesInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfer-balances')?.[1];
    const transferInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfers')?.[1];
    expect(new Headers(activityInit?.headers).get('x-gct-read-intent')).toBe('portfolio-activity');
    expect(new Headers(balancesInit?.headers).get('x-gct-read-intent')).toBe('transfer-balances');
    expect(new Headers(transferInit?.headers).get('x-gct-trading-intent')).toBe('transfer-funds');
    expect(transferInit?.body).toBe('{"coin":"USDT","amount":"25","from":"SPOT","to":"CROSSEX","text":"portfolio_1"}');
  });

  it('requests one validated SQLite snapshot for global funding rankings', async () => {
    const fetchedAt = '2026-08-02T00:00:00.000Z';
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify({
        entries: [{
          symbol: 'BINANCE_FUTURE_BTC_USDT', status: 'ok', rate24h: '0.001', rate7d: '0.002',
          rate30d: '0.003', settlementCount30d: 90, oldestFundingAt: fetchedAt,
          newestFundingAt: fetchedAt, fetchedAt,
        }],
        fetchedAt,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fundingRankings(['BINANCE_FUTURE_BTC_USDT'], 30)).resolves.toMatchObject({
      entries: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', rate30d: '0.003' }],
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/markets/funding-rankings');
    expect(new Headers(init?.headers).get('x-gct-read-intent')).toBe('funding-history');
    expect(init?.body).toBe('{"symbols":["BINANCE_FUTURE_BTC_USDT"],"durationDays":30}');
  });

  it('validates the funding paper summary and position detail endpoints', async () => {
    const position = { id: 'paper-1', candidateId: 'candidate-1', asset: 'SOL', longVenue: 'BINANCE',
      shortVenue: 'OKX', quantity: '0.1', state: 'OPEN', monitorState: 'HOLD' };
    const fetchMock = vi.fn(async (path: string) => path === '/api/funding-paper'
      ? new Response(JSON.stringify({ enabled: true, openCount: 1, closedCount: 0, winRate: '0',
        cumulativePnl: '0', cumulativeFunding: '0', cumulativeFees: '0.01', fundingSnapshotCount: 10,
        latestFundingSnapshotAt: '2026-08-14T00:00:00.000Z', executionSampleCount: 20,
        latestExecutionSampleAt: '2026-08-14T00:00:00.000Z', positions: [position] }))
      : new Response(JSON.stringify({ position, evaluations: [], settlements: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fundingPaperSummary()).resolves.toMatchObject({ enabled: true, openCount: 1,
      positions: [{ asset: 'SOL', state: 'OPEN' }] });
    await expect(api.fundingPaperDetails('paper-1')).resolves.toMatchObject({ position: { id: 'paper-1' },
      evaluations: [], settlements: [] });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/funding-paper', '/api/funding-paper/paper-1']);
  });

  it('validates isolated funding research summaries and details', async () => {
    const position = { id: 'research-1', observationId: 'observation-1', mode: 'RESEARCH', asset: 'SOL',
      longVenue: 'BINANCE', shortVenue: 'GATE', quantity: '0.05', state: 'OPEN', monitorState: 'HOLD',
      modelVersion: 'rolling_v2', reversalCount: 0 };
    const fetchMock = vi.fn(async (path: string) => path === '/api/funding-research'
      ? new Response(JSON.stringify({ enabled: true, modelVersion: 'rolling_v2', holdExitConfirmations: 30,
        reversalExitConfirmations: 15, minimumHoldingMs: 86_400_000, reentryCooldownMs: 28_800_000,
        targetNotionalUsd: '5', maxOpenPositions: 1,
        minimumSettledEvents: 1, lastScanAt: '2026-08-15T00:00:00.000Z',
        scan24h: { observations: 18, liveEligible: 0, researchEligible: 12, rejected: 6 },
        rejectionReasons: [{ reason: 'market_not_synchronized', count: 6 }], latestObservations: [],
        openCount: 1, closedCount: 0, cumulativePnl: '0', cumulativeFunding: '0',
        cumulativeFees: '0.005', positions: [position], cohorts: [], variants: [] }))
      : new Response(JSON.stringify({ position, evaluations: [], settlements: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fundingResearchSummary()).resolves.toMatchObject({ enabled: true, modelVersion: 'rolling_v2', openCount: 1,
      scan24h: { researchEligible: 12 }, positions: [{ mode: 'RESEARCH' }] });
    await expect(api.fundingResearchDetails('research-1')).resolves.toMatchObject({
      position: { id: 'research-1', mode: 'RESEARCH' }, evaluations: [], settlements: [],
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/funding-research', '/api/funding-research/research-1']);
  });

  it('ignores malformed websocket messages and delivers only validated stream events', () => {
    type Listener = (event: { data?: unknown }) => void;
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static latest: FakeWebSocket | null = null;
      readyState = FakeWebSocket.OPEN;
      readonly sent: string[] = [];
      private readonly listeners = new Map<string, Listener[]>();
      constructor(readonly url: string) { FakeWebSocket.latest = this; }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string) { this.sent.push(data); }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        for (const listener of this.listeners.get('close') ?? []) listener({});
      }
      emit(type: string, event: { data?: unknown } = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:17840' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const messages: unknown[] = [];
    const handle = connectTerminalStream((message) => messages.push(message), () => undefined);
    const socket = FakeWebSocket.latest;
    socket?.emit('open');
    socket?.emit('message', { data: JSON.stringify({ type: 'market.update', payload: { symbol: 42 } }) });
    socket?.emit('message', { data: JSON.stringify({ type: 'mode.update', payload: { mode: 'readonly' } }) });
    handle.watchQuotes(['OKX_FUTURE_ETH_USDT', 'GATE_FUTURE_ETH_USDT']);
    handle.watchMarket('GATE_FUTURE_BTC_USDT', '1m');

    expect(messages).toEqual([{ type: 'mode.update', payload: { mode: 'readonly' } }]);
    expect(socket?.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'watch.quotes', symbols: [] },
      { type: 'watch.quotes', symbols: ['GATE_FUTURE_ETH_USDT', 'OKX_FUTURE_ETH_USDT'] },
      { type: 'watch.market', symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m' },
    ]);
    handle.close();
  });
});
