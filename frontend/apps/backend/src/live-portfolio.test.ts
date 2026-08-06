import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshotResponse } from '@gate-crossex/shared-types';
import { LivePortfolioStore } from './live-portfolio.js';
import type { PrivateStreamStatus } from './private-stream.js';

const stream: PrivateStreamStatus = {
  state: 'live',
  lastEventAt: '2026-07-26T10:00:01.000Z',
  lastReadyAt: '2026-07-26T10:00:00.000Z',
  retryAttempt: 0,
  lastError: null,
};

function response(): PortfolioSnapshotResponse {
  return {
    snapshot: {
      account: {
        availableMargin: '1000',
        marginBalance: '1200',
        initialMargin: '200',
        maintenanceMargin: '50',
        initialMarginRate: '0.1',
        maintenanceMarginRate: '0.05',
        positionMode: 'SINGLE',
        accountMode: 'CROSS_EXCHANGE',
        exchangeType: 'CROSSEX',
        remoteUpdatedAt: '2026-07-26T09:59:00.000Z',
      },
      balances: [{
        venue: 'BINANCE',
        coin: 'USDT',
        balance: '1000',
        unrealizedPnl: '10',
        equity: '1010',
        futuresInitialMargin: '200',
        futuresMaintenanceMargin: '50',
        borrowingInitialMargin: '0',
        borrowingMaintenanceMargin: '0',
        availableBalance: '800',
        liability: '0',
      }],
      futuresPositions: [{
        positionId: 'position-1',
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        positionSide: 'LONG',
        initialMargin: '200',
        maintenanceMargin: '50',
        quantity: '0.01',
        value: '640',
        unrealizedPnl: '20',
        unrealizedPnlRate: '0.03',
        entryPrice: '62000',
        markPrice: '64000',
        leverage: '3',
        maxLeverage: '20',
        riskLimit: '1',
        fee: '0.5',
        fundingFee: '1.2',
        fundingTime: '2026-07-26T16:00:00.000Z',
        createdAt: '2026-07-25T10:00:00.000Z',
        updatedAt: '2026-07-26T09:59:00.000Z',
        realizedPnl: '4',
      }],
      marginPositions: [],
      openOrders: [],
      recentFills: [],
      fetchedAt: '2026-07-26T09:59:00.000Z',
      source: 'gate_crossex_authenticated_rest',
    },
    dataStatus: 'fresh',
    remoteStatus: 'healthy',
    reconciliation: {
      id: 'reconcile-1',
      createdAt: '2026-07-26T09:59:00.000Z',
      status: 'clean',
      previousFetchedAt: '2026-07-26T09:54:00.000Z',
      currentFetchedAt: '2026-07-26T09:59:00.000Z',
      issues: [],
    },
  };
}

describe('live portfolio store', () => {
  it('keeps full account-wide portfolio rows current from private pushes', () => {
    const store = new LivePortfolioStore(response(), stream);

    store.ingest({
      channel: 'position',
      payload: {
        position_id: 'position-1',
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        position_side: 'LONG',
        initial_margin: '210',
        maintenance_margin: '55',
        position_qty: '0.02',
        position_value: '1300',
        upnl: '45',
        upnl_rate: '0.04',
        entry_price: '62500',
        mark_price: '65000',
        leverage: '4',
        max_leverage: '25',
        risk_limit: '2',
        fee: '0.7',
        funding_fee: '1.5',
        funding_time: '1785081600000',
        create_time: '1784995200000',
        update_time: '1785079200000',
        closed_pnl: '6',
      },
    });
    store.ingest({
      channel: 'margin_position',
      payload: {
        position_id: 'margin-1',
        symbol: 'GATE_MARGIN_ETH_USDT',
        position_side: 'LONG',
        initial_margin: '100',
        maintenance_margin: '20',
        asset_qty: '1',
        asset_coin: 'ETH',
        position_value: '3200',
        liability: '1000',
        liability_coin: 'USDT',
        interest: '0.2',
        max_position_qty: '5',
        entry_price: '3100',
        index_price: '3200',
        upnl: '100',
        upnl_rate: '0.03',
        leverage: '2',
        max_leverage: '5',
        create_time: '1784995200000',
        update_time: '1785079200000',
      },
    });
    store.ingest({
      channel: 'asset',
      payload: {
        coin: 'USDT',
        exchange_type: 'BINANCE',
        available_balance: '760',
        equity: '1025',
        upnl: '25',
        futures_initial_margin: '240',
      },
    });
    store.ingest({
      channel: 'order',
      payload: {
        order_id: 'external-order',
        text: 'placed-elsewhere',
        state: 'OPEN',
        symbol: 'OKX_FUTURE_BTC_USDT',
        side: 'SELL',
        type: 'LIMIT',
        exchange_type: 'OKX',
        business_type: 'FUTURE',
        qty: '0.01',
        price: '66000',
        time_in_force: 'GTC',
        executed_qty: '0',
        create_time: '1785079000000',
        update_time: '1785079000000',
      },
    });
    store.ingest({
      channel: 'usertrades',
      payload: {
        transaction_id: 'external-fill',
        order_id: 'external-order',
        text: 'placed-elsewhere',
        symbol: 'OKX_FUTURE_BTC_USDT',
        exchange_type: 'OKX',
        business_type: 'FUTURE',
        side: 'SELL',
        qty: '0.002',
        price: '66000',
        fee: '0.04',
        fee_coin: 'USDT',
        fee_rate: '0.0002',
        match_role: 'MAKER',
        rpnl: '3',
        position_mode: 'BOTH',
        position_side: 'SHORT',
        create_time: '1785079100000',
      },
    });

    const current = store.snapshot();
    expect(current?.live).toMatchObject({ source: 'websocket', stream: { state: 'live' } });
    expect(current?.snapshot.futuresPositions[0]).toMatchObject({
      quantity: '0.02',
      value: '1300',
      leverage: '4',
      fundingFee: '1.5',
      realizedPnl: '6',
    });
    expect(current?.snapshot.marginPositions[0]).toMatchObject({
      positionId: 'margin-1',
      assetQuantity: '1',
      liability: '1000',
    });
    expect(current?.snapshot.balances[0]).toMatchObject({
      availableBalance: '760',
      equity: '1025',
      futuresInitialMargin: '240',
      futuresMaintenanceMargin: '50',
    });
    expect(current?.snapshot.account).toMatchObject({
      availableMargin: '1000',
      marginBalance: '1200',
      initialMargin: '200',
      maintenanceMargin: '50',
      remoteUpdatedAt: '2026-07-26T09:59:00.000Z',
    });
    expect(current?.snapshot.openOrders[0]).toMatchObject({
      orderId: 'external-order',
      clientOrderId: 'placed-elsewhere',
    });
    expect(current?.snapshot.recentFills[0]).toMatchObject({
      transactionId: 'external-fill',
      orderId: 'external-order',
    });

    store.ingest({ channel: 'order', payload: { order_id: 'external-order', state: 'FILLED' } });
    store.ingest({
      channel: 'position',
      payload: {
        position_id: 'position-1',
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        position_side: 'NONE',
        position_qty: '0',
      },
    });
    expect(store.snapshot()?.snapshot.openOrders).toEqual([]);
    expect(store.snapshot()?.snapshot.futuresPositions).toEqual([]);
    store.stop();
  });

  it('buffers early websocket events until the REST bootstrap arrives', () => {
    const store = new LivePortfolioStore(null, stream);
    store.ingest({
      channel: 'asset',
      payload: { coin: 'USDT', exchange_type: 'BINANCE', available_balance: '777' },
    });
    const reconciled = store.reconcile(response());
    expect(reconciled.snapshot.balances[0]?.availableBalance).toBe('777');
    expect(reconciled.live.source).toBe('websocket');
    store.stop();
  });

  it('replays websocket changes that race an in-flight REST reconciliation', () => {
    const store = new LivePortfolioStore(response(), stream);
    const checkpoint = store.checkpoint();
    store.ingest({
      channel: 'position',
      payload: {
        position_id: 'position-1',
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        position_side: 'LONG',
        position_qty: '0.03',
        position_value: '1950',
        entry_price: '62500',
        mark_price: '65000',
        update_time: '1785079200000',
      },
    });

    const reconciled = store.reconcile(response(), 'rest', checkpoint);
    expect(reconciled.snapshot.futuresPositions[0]).toMatchObject({
      quantity: '0.03',
      value: '1950',
      markPrice: '65000',
    });
    expect(reconciled.live.source).toBe('websocket');
    store.stop();
  });
});
