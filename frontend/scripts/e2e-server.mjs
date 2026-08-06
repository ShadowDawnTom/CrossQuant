import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/backend/dist/app.js';
import { loadConfig } from '../apps/backend/dist/config.js';
import { MemoryCredentialVault } from '../apps/backend/dist/credential-vault.js';
import { openDatabase, prepareDatabaseForClose } from '../apps/backend/dist/database.js';
import { CrossExMarketHub } from '../apps/backend/dist/market-hub.js';
import { TradingSession } from '../apps/backend/dist/trading-session.js';

const PORT = 17_942;
const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'PEPE', 'AAVE', 'LINK', 'ARB', 'HYPE'];
const venues = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'];
const dataDir = mkdtempSync(join(tmpdir(), 'gate-crossex-e2e-'));
const config = loadConfig({
  ...process.env,
  GCT_PORT: String(PORT),
  GCT_FRONTEND_PORT: String(PORT),
  GCT_DATA_DIR: dataDir,
  GCT_CREDENTIAL_ENV_PATH: join(dataDir, 'credentials.env'),
  GCT_GATE_PUBLIC_WS_URL: 'ws://127.0.0.1:9',
  GCT_GATE_PRIVATE_WS_URL: 'ws://127.0.0.1:9',
  GCT_GATE_REST_URL: 'http://127.0.0.1:9',
});

const quoteFor = (venue) => venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' ? 'USDC' : 'USDT';
const symbols = assets.flatMap((asset) => venues.map((venue) => ({
  symbol: `${venue}_FUTURE_${asset}_${quoteFor(venue)}`,
  exchange_type: venue,
  business_type: 'FUTURE',
  state: 'live',
  min_size: '0.001',
  min_notional: '5',
  lot_size: '0.001',
  tick_size: '0.1',
  max_num_orders: '100',
  max_market_size: '100',
  max_limit_size: '1000',
  contract_size: venue === 'GATE' ? '0.0001' : null,
  liquidation_fee: '0.0125',
  default_leverage: '5',
  delist_time: '0',
})));

const crossExGateway = {
  async querySymbols() {
    return symbols;
  },
  async queryRiskLimits(requestedSymbols) {
    return requestedSymbols.map((symbol) => ({
      symbol,
      tiers: [{
        min_risk_limit_value: '0',
        max_risk_limit_value: '3000000',
        quick_cal_amount: '0',
        leverage_max: '20',
        maintenance_rate: '0.0065',
        tier: '1',
      }],
    }));
  },
  async queryAccount() {
    throw new Error('E2E credentials are intentionally unavailable');
  },
  async queryPositions() {
    return [];
  },
  async queryPortfolio() {
    throw new Error('E2E credentials are intentionally unavailable');
  },
  async createOrder() {
    throw new Error('E2E trading is disabled');
  },
  async cancelOrder() {
    throw new Error('E2E trading is disabled');
  },
  async queryOrder() {
    throw new Error('E2E trading is disabled');
  },
  async queryLeverages(_credentials, requestedSymbols) {
    return Object.fromEntries(requestedSymbols.map((symbol) => [symbol, '5']));
  },
  async setLeverage(_credentials, symbol, leverage) {
    return { symbol, leverage };
  },
  async queryFeeRates() {
    return [];
  },
};

const publicMarketGateway = {
  async querySnapshot(symbol) {
    const venue = symbol.split('_')[0] ?? 'GATE';
    return {
      symbol,
      venue,
      product: 'FUTURE',
      bidPrice: '63999.9',
      askPrice: '64000.1',
      lastPrice: '64000',
      markPrice: '64000',
      indexPrice: '64000',
      fundingRate: '0.0001',
      predictedFundingRate: null,
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      sourceTimestamp: '2030-01-01T00:00:00.000Z',
      fetchedAt: '2030-01-01T00:00:00.000Z',
      source: venue === 'OKX' ? 'okx_public_rest' : venue === 'BINANCE' ? 'binance_futures_public_rest' : 'gate_futures_public_rest',
    };
  },
  async queryCandles(_symbol, interval, limit, before) {
    const intervalMs = interval === '1m' ? 60_000 : interval === '5m' ? 300_000 : 3_600_000;
    const end = before ?? Date.parse('2030-01-01T00:00:00.000Z');
    return Array.from({ length: Math.min(limit, 120) }, (_, index) => {
      const startTime = end - ((Math.min(limit, 120) - index) * intervalMs);
      const offset = (index % 12) - 6;
      return {
        startTime,
        open: String(64_000 + offset),
        high: String(64_010 + offset),
        low: String(63_990 + offset),
        close: String(64_004 + offset),
        volume: String(200 + index),
        closed: true,
      };
    });
  },
  async queryContractSizes(venue) {
    return venue === 'GATE'
      ? [{ base: 'BTC', quote: 'USDT', multiplier: '0.0001' }]
      : [{ base: 'BTC', quote: 'USDT', multiplier: '0.01' }];
  },
  async queryVenueFundingStats(venue) {
    if (venue === 'GATE' || venue === 'BINANCE') return [{
      venue,
      base: 'BTC',
      quote: 'USDT',
      fundingRate8h: venue === 'GATE' ? '0.00013' : '0.0001',
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      openInterestValue: venue === 'GATE' ? '2500000' : '2200000',
      lastPrice: venue === 'GATE' ? '64000' : '64010',
      change24h: venue === 'GATE' ? '0.0125' : '-0.01',
    }];
    if (venue === 'HYPERLIQUID' || venue === 'BYBIT') return [{
      venue,
      base: 'HYPE',
      quote: venue === 'HYPERLIQUID' ? 'USDC' : 'USDT',
      fundingRate8h: venue === 'HYPERLIQUID' ? '0.0002' : '-0.0001',
      nextFundingAt: '2030-01-01T08:00:00.000Z',
      openInterestValue: venue === 'HYPERLIQUID' ? '15000000' : '12000000',
      lastPrice: venue === 'HYPERLIQUID' ? '36.55' : '36.50',
      change24h: venue === 'HYPERLIQUID' ? '0.015' : '0.014',
    }];
    return [];
  },
  async queryFundingHistory() {
    const now = Date.now();
    return [
      { timestamp: now - 16 * 60 * 60 * 1_000, rate: '0.0001' },
      { timestamp: now - 8 * 60 * 60 * 1_000, rate: '0.00012' },
    ];
  },
};

const database = openDatabase(config.databasePath, config.migrationsDir);
const insertPosition = database.prepare(`INSERT INTO live_positions
  (position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, funding_fee, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const app = await buildApp({
  config,
  database,
  credentialVault: new MemoryCredentialVault(),
  crossExGateway,
  publicMarketGateway,
  marketHub: new CrossExMarketHub(config.gatePublicWebSocketUrl),
  tradingSession: new TradingSession(),
  startMarketStream: false,
  logger: false,
  rateLimitMax: 10_000,
});

app.post('/__e2e/grouped-positions', async () => {
  database.prepare('DELETE FROM live_positions').run();
  insertPosition.run(
    'e2e-hype-hyperliquid', 'HYPERLIQUID_FUTURE_HYPE_USDC', 'HYPERLIQUID', '100',
    '51.80', '51.82', '0', '1.25', '2030-01-01T00:00:00.000Z',
  );
  insertPosition.run(
    'e2e-hype-bybit', 'BYBIT_FUTURE_HYPE_USDT', 'BYBIT', '-100',
    '51.84', '51.82', '0', '-0.25', '2030-01-01T00:00:00.000Z',
  );
  return { ok: true };
});

app.delete('/__e2e/grouped-positions', async () => {
  database.prepare('DELETE FROM live_positions').run();
  return { ok: true };
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  prepareDatabaseForClose(database);
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
